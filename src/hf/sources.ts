import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, readdir, realpath, stat } from "node:fs/promises";
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

/** What one model may read. Going past either is a finding, never a silent stop. */
export interface ReadLimits {
  /** Bytes across every source the model reads, tokenizer.json included. */
  maxBytes: number;
  /** additional_chat_templates/*.jinja files read; the directory is the one source with no natural bound. */
  maxAdditional: number;
}

export const DEFAULT_READ_LIMITS: ReadLimits = { maxBytes: 128 * 1024 * 1024, maxAdditional: 1000 };

// Fatal and BOM-preserving, so a file Python's json.load would reject is rejected here too.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * What a source can carry. A template-bearing source that fails to load or parse might have
 * hidden a template, so the failure is HIGH and extraction is incomplete. tokenizer.json only
 * feeds scaffolding, so its failure is MEDIUM.
 */
export type Role = "template" | "tokens";

export interface Sources {
  templates: ExtractedTemplate[];
  hints: ModelRecord["hints"];
  /** Parsed tokenizer_config.json, when it parsed, for the added-token decoder. */
  tokenizerConfig?: unknown;
}

/** Reads every template source in `dir`, in a fixed order. Problems become findings; nothing throws. */
export async function readTemplateSources(dir: string, reader: SourceReader): Promise<Sources> {
  const templates: ExtractedTemplate[] = [];
  const hints: ModelRecord["hints"] = {};

  const tc = await reader.json(join(dir, "tokenizer_config.json"), "template");
  if (tc) {
    templates.push(...templatesFromJson(tc, "tokenizer_config", reader));
    if (isObject(tc.value)) {
      if (typeof tc.value.chat_template_type === "string") hints.chatTemplateType = tc.value.chat_template_type;
      if (typeof tc.value.tool_parser_type === "string") hints.toolParserType = tc.value.tool_parser_type;
    }
  }

  const jinja = await reader.file(join(dir, "chat_template.jinja"), "template");
  if (jinja) templates.push(makeTemplate(sourceOf("chat_template_jinja", jinja, "default"), jinja.bytes));

  const legacy = await reader.json(join(dir, "chat_template.json"), "template");
  if (legacy) templates.push(...templatesFromJson(legacy, "chat_template_json", reader));

  templates.push(...(await readAdditional(join(dir, "additional_chat_templates"), reader)));

  const pc = await reader.json(join(dir, "processor_config.json"), "template");
  if (pc) templates.push(...templatesFromJson(pc, "processor_config", reader));

  return { templates, hints, tokenizerConfig: tc?.value };
}

// Like the runtimes: regular files ending in .jinja, named by what precedes the suffix. Subdirectories are ignored.
async function readAdditional(dir: string, reader: SourceReader): Promise<ExtractedTemplate[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".jinja")).sort();
  } catch (e) {
    if (!(await isAbsent(e, dir))) reader.fail("template", dir, "cannot list additional_chat_templates", e);
    return [];
  }
  const max = reader.limits.maxAdditional;
  if (names.length > max) {
    const rest = names.slice(max);
    reader.fail("template", dir, `${names.length} .jinja files, over the limit of ${max}; the rest were not read`, undefined, {
      skipped: rest.slice(0, 20),
      skippedCount: rest.length,
    });
    names = names.slice(0, max);
  }
  const out: ExtractedTemplate[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const st = await stat(path).catch(() => undefined);
    if (st?.isDirectory()) continue;
    const file = await reader.file(path, "template");
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

// A FIFO planted under a source name opens at once instead of waiting for a writer, and a terminal
// device cannot become the scanner's controlling tty. O_NONBLOCK changes nothing for regular files.
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY;

/** Why a file that exists was not read. */
export class ReadFailure extends Error {
  constructor(
    message: string,
    readonly size?: number,
  ) {
    super(message);
  }
}

/**
 * Reads a regular file of at most `maxBytes`, or undefined when nothing is at `path`. The checks
 * run on the open descriptor, so nothing can be swapped in between a check and the read.
 */
export async function readRegularFile(path: string, maxBytes: number): Promise<{ bytes: Uint8Array; realPath: string } | undefined> {
  let fh: FileHandle;
  try {
    fh = await open(path, OPEN_FLAGS);
  } catch (e) {
    if (await isAbsent(e, path)) return undefined;
    throw e;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new ReadFailure(`not a regular file (${fileType(st)})`);
    if (st.size > maxBytes) throw new ReadFailure(`${st.size} bytes, over the ${maxBytes}-byte limit; not read`, st.size);
    const bytes = new Uint8Array(st.size);
    let got = 0;
    while (got < bytes.length) {
      const { bytesRead } = await fh.read(bytes, got, bytes.length - got, got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return { bytes: got === bytes.length ? bytes : bytes.slice(0, got), realPath: await realpath(path) };
  } finally {
    await fh.close();
  }
}

function fileType(st: Stats): string {
  if (st.isDirectory()) return "directory";
  if (st.isFIFO()) return "FIFO";
  if (st.isSocket()) return "socket";
  if (st.isCharacterDevice()) return "character device";
  if (st.isBlockDevice()) return "block device";
  return "special file";
}

/** Reads one model's sources read-only, recording findings and whether every template-bearing source was read. */
export class SourceReader {
  readonly findings: Finding[] = [];
  complete = true;
  readonly limits: ReadLimits;
  private bytesRead = 0;

  constructor(limits: Partial<ReadLimits> = {}) {
    this.limits = { ...DEFAULT_READ_LIMITS, ...limits };
  }

  /** An absent file is silently undefined; one that exists but cannot be read is a finding. */
  async file(path: string, role: Role): Promise<Loaded | undefined> {
    const left = Math.max(0, this.limits.maxBytes - this.bytesRead);
    try {
      const got = await readRegularFile(path, Math.min(MAX_SOURCE_BYTES, left));
      if (!got) return undefined;
      this.bytesRead += got.bytes.length;
      return { path, ...got };
    } catch (e) {
      if (!(e instanceof ReadFailure)) this.fail(role, path, "cannot read", e);
      else if (e.size === undefined) this.fail(role, path, e.message);
      else {
        const why = e.size > MAX_SOURCE_BYTES ? `over the ${MAX_SOURCE_BYTES}-byte limit for one file` : `over the model's byte budget (${left} of ${this.limits.maxBytes} left)`;
        this.fail(role, path, `${e.size} bytes, ${why}; not read`, undefined, { size: e.size });
      }
      return undefined;
    }
  }

  /** file() plus a parse that accepts what Python's json.load accepts. */
  async json(path: string, role: Role): Promise<LoadedJson | undefined> {
    const file = await this.file(path, role);
    if (!file) return undefined;
    const parsed = parseJsonLikePython(file.bytes);
    if ("value" in parsed) return { ...file, value: parsed.value };
    this.fail(role, path, parsed.message, parsed.error);
    return undefined;
  }

  fail(role: Role, path: string, message: string, error?: unknown, detail?: Record<string, unknown>): void {
    if (role === "template") this.complete = false;
    this.findings.push(problem("parse_error", role === "template" ? "HIGH" : "MEDIUM", path, message, error, detail));
  }
}

/**
 * Parses JSON the way transformers loads it: open(encoding="utf-8") then json.load. That rejects
 * invalid UTF-8 and a leading byte order mark, and accepts bare NaN, Infinity and -Infinity.
 */
export function parseJsonLikePython(bytes: Uint8Array): { value: unknown } | { message: string; error?: unknown } {
  let text: string;
  try {
    text = strictUtf8.decode(bytes);
  } catch (e) {
    return { message: "not valid UTF-8", error: e };
  }
  if (text.charCodeAt(0) === 0xfeff) return { message: "starts with a UTF-8 byte order mark, which Python's json.load rejects" };
  try {
    return { value: JSON.parse(text) };
  } catch (e) {
    // Rewrite only on failure, so ordinary files pay nothing; report the original error if it still fails.
    try {
      return { value: JSON.parse(rewriteNonFinite(text)) };
    } catch {
      return { message: "not valid JSON", error: e };
    }
  }
}

const VALUE_START = new Set(["", ":", "[", ","]);
const VALUE_END = new Set([undefined, " ", "\t", "\n", "\r", ",", "]", "}"]);

// Replaces each NaN, Infinity or -Infinity that stands as a value outside a string with 0. Anywhere
// else Python rejects them too, so they are left for JSON.parse to reject. Numbers are never read.
function rewriteNonFinite(text: string): string {
  let out = "";
  let last = 0;
  let prev = ""; // last non-whitespace character outside strings
  for (let i = 0; i < text.length; ) {
    const c = text[i]!;
    if (c === '"') {
      i = endOfString(text, i);
      prev = '"';
      continue;
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    const token = ["NaN", "Infinity", "-Infinity"].find((t) => text.startsWith(t, i));
    if (token && VALUE_START.has(prev) && VALUE_END.has(text[i + token.length])) {
      out += text.slice(last, i) + "0";
      i += token.length;
      last = i;
      prev = "0";
      continue;
    }
    prev = c;
    i++;
  }
  return out + text.slice(last);
}

// Index just past the closing quote of the string that opens at `start`.
function endOfString(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i + 1;
  }
  return text.length;
}

// `chat_template` may be a string or a list of {name, template}; each list entry stands alone.
function templatesFromJson(file: LoadedJson, kind: SourceKind, reader: SourceReader): ExtractedTemplate[] {
  if (!isObject(file.value)) {
    reader.fail("template", file.path, "expected a JSON object");
    return [];
  }
  const ct = file.value.chat_template;
  if (ct === undefined || ct === null) return [];
  if (typeof ct === "string") return [makeTemplateFromString(sourceOf(kind, file, "default", "chat_template"), ct)];
  if (!Array.isArray(ct)) {
    reader.fail("template", file.path, "chat_template is neither a string nor a list", undefined, { key: "chat_template" });
    return [];
  }
  const out: ExtractedTemplate[] = [];
  ct.forEach((entry: unknown, i) => {
    if (isObject(entry) && typeof entry.name === "string" && typeof entry.template === "string") {
      out.push(makeTemplateFromString(sourceOf(kind, file, entry.name, `chat_template[${i}].template`), entry.template));
    } else {
      reader.fail("template", file.path, "chat_template entry is not {name, template} strings", undefined, { key: `chat_template[${i}]` });
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
