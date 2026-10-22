import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { makeTemplate, makeTemplateFromString } from "../template.ts";
import type { ExtractedTemplate, Finding, ModelRecord, RuleId, Severity, SourceKind } from "../types.ts";

/** Entry names that make a directory an HF/MLX model directory (ISC-2). */
export const HF_SOURCE_NAMES: ReadonlySet<string> = new Set([
  "tokenizer_config.json",
  "chat_template.jinja",
  "chat_template.json",
  "additional_chat_templates",
  "processor_config.json",
]);

// Real tokenizer.json files reach ~35 MB; anything past this is refused rather than read into memory.
export const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

// Fatal and BOM-preserving, so a file Python's json.load would reject is rejected here too.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface Sources {
  templates: ExtractedTemplate[];
  hints: ModelRecord["hints"];
  /** Parsed tokenizer_config.json, when it parsed, for the added-token decoder. */
  tokenizerConfig?: unknown;
}

/** Reads every template source in `dir`, in a fixed order. Problems become findings; nothing throws. */
export async function readTemplateSources(dir: string, findings: Finding[]): Promise<Sources> {
  const templates: ExtractedTemplate[] = [];
  const hints: ModelRecord["hints"] = {};

  const tc = await loadJson(join(dir, "tokenizer_config.json"), findings, "HIGH");
  if (tc) {
    templates.push(...templatesFromJson(tc, "tokenizer_config", findings));
    if (isObject(tc.value)) {
      if (typeof tc.value.chat_template_type === "string") hints.chatTemplateType = tc.value.chat_template_type;
      if (typeof tc.value.tool_parser_type === "string") hints.toolParserType = tc.value.tool_parser_type;
    }
  }

  const jinja = await loadFile(join(dir, "chat_template.jinja"), findings, "HIGH");
  if (jinja) templates.push(makeTemplate(sourceOf("chat_template_jinja", jinja, "default"), jinja.bytes));

  const legacy = await loadJson(join(dir, "chat_template.json"), findings, "HIGH");
  if (legacy) templates.push(...templatesFromJson(legacy, "chat_template_json", findings));

  templates.push(...(await readAdditional(join(dir, "additional_chat_templates"), findings)));

  const pc = await loadJson(join(dir, "processor_config.json"), findings, "HIGH");
  if (pc) templates.push(...templatesFromJson(pc, "processor_config", findings));

  return { templates, hints, tokenizerConfig: tc?.value };
}

// Like the runtimes: regular files ending in .jinja, named by what precedes the suffix. Subdirectories are ignored.
async function readAdditional(dir: string, findings: Finding[]): Promise<ExtractedTemplate[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".jinja")).sort();
  } catch (e) {
    if (!(await isAbsent(e, dir))) findings.push(problem("scanner_error", "MEDIUM", dir, "cannot list additional_chat_templates", e));
    return [];
  }
  const out: ExtractedTemplate[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const st = await stat(path).catch(() => undefined);
    if (st?.isDirectory()) continue;
    const file = await loadFile(path, findings, "HIGH");
    if (file) out.push(makeTemplate(sourceOf("additional_chat_templates", file, name.slice(0, -".jinja".length)), file.bytes));
  }
  return out;
}

interface Loaded {
  path: string;
  realPath: string;
  bytes: Uint8Array;
}

interface LoadedJson extends Loaded {
  value: unknown;
}

/**
 * Reads one file read-only. An absent file is silently undefined; one that exists but cannot be
 * read (dangling link, not a regular file, over the size cap) becomes a finding.
 */
export async function loadFile(path: string, findings: Finding[], oversize: Severity): Promise<Loaded | undefined> {
  try {
    // stat before open: opening a FIFO planted under a source name would block the scan.
    const st = await stat(path);
    if (!st.isFile()) {
      findings.push(problem("scanner_error", "MEDIUM", path, "not a regular file"));
      return undefined;
    }
    if (st.size > MAX_SOURCE_BYTES) {
      findings.push(problem("parse_error", oversize, path, `larger than the ${MAX_SOURCE_BYTES}-byte cap; not analyzed`, undefined, { size: st.size }));
      return undefined;
    }
    const bytes = new Uint8Array(await readFile(path));
    return { path, realPath: await realpath(path), bytes };
  } catch (e) {
    if (!(await isAbsent(e, path))) findings.push(problem("scanner_error", "MEDIUM", path, "cannot read", e));
    return undefined;
  }
}

/** loadFile plus a strict JSON parse; a malformed file is a MEDIUM parse_error. */
export async function loadJson(path: string, findings: Finding[], oversize: Severity): Promise<LoadedJson | undefined> {
  const file = await loadFile(path, findings, oversize);
  if (!file) return undefined;
  try {
    return { ...file, value: JSON.parse(strictUtf8.decode(file.bytes)) };
  } catch (e) {
    findings.push(problem("parse_error", "MEDIUM", path, "not valid UTF-8 JSON", e));
    return undefined;
  }
}

// `chat_template` may be a string or a list of {name, template}; each list entry stands alone.
function templatesFromJson(file: LoadedJson, kind: SourceKind, findings: Finding[]): ExtractedTemplate[] {
  if (!isObject(file.value)) {
    findings.push(problem("parse_error", "MEDIUM", file.path, "expected a JSON object"));
    return [];
  }
  const ct = file.value.chat_template;
  if (ct === undefined || ct === null) return [];
  if (typeof ct === "string") return [makeTemplateFromString(sourceOf(kind, file, "default", "chat_template"), ct)];
  if (!Array.isArray(ct)) {
    findings.push(problem("parse_error", "MEDIUM", file.path, "chat_template is neither a string nor a list", undefined, { key: "chat_template" }));
    return [];
  }
  const out: ExtractedTemplate[] = [];
  ct.forEach((entry: unknown, i) => {
    if (isObject(entry) && typeof entry.name === "string" && typeof entry.template === "string") {
      out.push(makeTemplateFromString(sourceOf(kind, file, entry.name, `chat_template[${i}].template`), entry.template));
    } else {
      findings.push(problem("parse_error", "MEDIUM", file.path, "chat_template entry is not {name, template} strings", undefined, { key: `chat_template[${i}]` }));
    }
  });
  return out;
}

function sourceOf(kind: SourceKind, file: Loaded, name: string, key?: string) {
  return { kind, path: file.path, realPath: file.realPath, name, ...(key === undefined ? {} : { key }) };
}

// ENOENT on a path that lstat cannot see either means the source is simply not there.
async function isAbsent(e: unknown, path: string): Promise<boolean> {
  if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") return false;
  return lstat(path).then(
    () => false,
    () => true,
  );
}

export function problem(
  ruleId: RuleId,
  severity: Severity,
  file: string,
  message: string,
  error?: unknown,
  detail?: Record<string, unknown>,
): Finding {
  const why = error === undefined ? undefined : error instanceof Error ? error.message : String(error);
  const d = { ...detail, ...(why === undefined ? {} : { error: why }) };
  return { ruleId, severity, message, file, ...(Object.keys(d).length ? { detail: d } : {}) };
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
