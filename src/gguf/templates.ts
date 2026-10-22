import { LineMap } from "../parse/support.ts";
import { makeTemplate } from "../template.ts";
import type { ExtractedTemplate, Finding } from "../types.ts";
import type { RawTemplate } from "./reader.ts";

/** Every key an engine may load a chat template from (ISC-4). The s flag lets a name hold a newline. */
export const CHAT_TEMPLATE_KEY = /^tokenizer\.chat_template(?:\.(.+))?$/s;

/** The name list gguf-py writes beside named templates. It never lists the bare key. */
export const TEMPLATE_LIST_KEY = "tokenizer.chat_templates";

const BARE_KEY = "tokenizer.chat_template";
const DOTTED_DEFAULT = `${BARE_KEY}.default`;

/** The key as llama.cpp resolves it. Its lookups compare C strings, so a NUL ends the key. */
export function cKey(key: string): string {
  const nul = key.indexOf("\0");
  return nul < 0 ? key : key.slice(0, nul);
}

export function isTemplateKey(key: string): boolean {
  return CHAT_TEMPLATE_KEY.test(cKey(key));
}

/** The part after "tokenizer.chat_template.", which is what gguf-py lists. Undefined for the bare key. */
function suffix(key: string): string | undefined {
  return CHAT_TEMPLATE_KEY.exec(cKey(key))?.[1];
}

/** "default" for the bare key, otherwise the suffix. tokenizer.chat_template.default is named by its key, so it can't pass for the bare one. */
export function templateName(key: string): string {
  const name = suffix(key);
  if (name === undefined) return "default";
  return name === "default" ? DOTTED_DEFAULT : name;
}

/** The key, or name, a llama.cpp view is recorded under: the stored one, then how many bytes of its value llama.cpp sees. */
export const viewKey = (key: string, n: number) => `${key}[:${n}]`;

export interface Extraction {
  /** Each value as stored. */
  templates: ExtractedTemplate[];
  /** For a value holding a NUL, the bytes before it: what llama.cpp renders. */
  views: ExtractedTemplate[];
  findings: Finding[];
}

export function extractTemplates(raw: RawTemplate[], path: string, realPath: string): Extraction {
  const templates = raw.map((r) => makeTemplate({ kind: "gguf", path, realPath, name: templateName(r.key), key: r.key }, r.bytes));
  const out: Extraction = { templates, views: [], findings: [] };
  raw.forEach((r, i) => {
    const t = templates[i]!;
    const n = r.bytes.indexOf(0);
    if (n < 0) return;
    // llama.cpp reads string values through c_str(), so it renders only the bytes before the NUL while
    // gguf-py and HF tooling show the whole value. Both get analyzed. The view gets its own name as well as
    // its own key, so nothing keyed by name merges it with the full value.
    const view = makeTemplate({ ...t.source, name: viewKey(t.source.name, n), key: viewKey(r.key, n) }, r.bytes.slice(0, n));
    out.views.push(view);
    const at = t.text.indexOf("\0");
    out.findings.push({
      ruleId: "parse_error",
      severity: "HIGH",
      message: `${JSON.stringify(r.key)} holds a NUL at byte ${n}; llama.cpp renders only the ${n} bytes before it`,
      file: path,
      templateName: t.source.name,
      templateSha256: t.sha256,
      span: new LineMap(t.text).span(at, at + 1),
      detail: { key: r.key, byteOffset: n, fileOffset: r.offset + n, viewSha256: view.sha256 },
    });
    // A stored key can be spelled like a view, e.g. tokenizer.chat_template.x[:3], and then the two share a name or key.
    const clash = templates.find((s) => s.source.name === view.source.name || s.source.key === view.source.key);
    if (!clash) return;
    out.findings.push({
      ruleId: "parse_error",
      severity: "HIGH",
      message: `${JSON.stringify(clash.source.key)} is recorded under the same name or key as the llama.cpp view of ${JSON.stringify(r.key)}`,
      file: path,
      templateName: clash.source.name,
      templateSha256: clash.sha256,
      detail: { key: clash.source.key, viewKey: view.source.key, viewName: view.source.name, viewSha256: view.sha256 },
    });
  });
  return out;
}

/** ISC-4.1: names listed with no key, and named keys missing from the list. Only checked when the list exists. */
export function checkTemplateList(templates: ExtractedTemplate[], list: string[] | undefined, file: string): Finding[] {
  if (!list) return [];
  const listed = new Set(list);
  // Listed names are key suffixes, and "default" also stands for the bare key.
  const present = new Set(templates.map((t) => suffix(t.source.key!) ?? "default"));
  const findings: Finding[] = [];
  for (const name of listed) {
    if (present.has(name)) continue;
    findings.push({
      ruleId: "template_list_mismatch",
      severity: "MEDIUM",
      message: `${TEMPLATE_LIST_KEY} lists ${JSON.stringify(name)}, but the file has no template by that name`,
      file,
      templateName: name,
    });
  }
  const reported = new Set<string>();
  for (const t of templates) {
    const { key, name } = t.source;
    const listedAs = suffix(key!);
    if (listedAs === undefined || listed.has(listedAs) || reported.has(name)) continue;
    reported.add(name);
    findings.push({
      ruleId: "template_list_mismatch",
      severity: "MEDIUM",
      message: `${JSON.stringify(key)} is not listed in ${TEMPLATE_LIST_KEY}`,
      file,
      templateName: name,
      templateSha256: t.sha256,
    });
  }
  return findings;
}

/**
 * tokenizer.chat_template.default beside the bare key. No writer makes both. llama.cpp renders the bare key, while a tool
 * that turns named keys into an HF template list would make the other one the default.
 */
export function checkDefaultPair(templates: ExtractedTemplate[], file: string): Finding[] {
  const bare = templates.find((t) => cKey(t.source.key!) === BARE_KEY);
  if (!bare) return [];
  return templates
    .filter((t) => cKey(t.source.key!) === DOTTED_DEFAULT)
    .map((t) => {
      const pair = `${JSON.stringify(t.source.key)} and ${JSON.stringify(bare.source.key)}`;
      const f: Finding = {
        ruleId: "intra_model_divergence",
        severity: "LOW",
        message: `${pair} hold the same template`,
        file,
        templateName: t.source.name,
        templateSha256: t.sha256,
        detail: { key: t.source.key, otherKey: bare.source.key, otherSha256: bare.sha256 },
      };
      const byte = firstDifference(t.bytes, bare.bytes);
      if (byte === undefined) return f;
      f.severity = "HIGH";
      f.message = `${pair} both hold a default template, and they differ`;
      f.detail!.firstDifference = byte;
      // Bytes can differ where the text doesn't: invalid UTF-8 all decodes to U+FFFD.
      const at = firstDifference(t.text, bare.text);
      if (at !== undefined) f.span = new LineMap(t.text).span(at, Math.min(at + 1, t.text.length));
      return f;
    });
}

/** The first index where a and b differ, counting the end of the shorter one. Undefined when they are equal. */
function firstDifference(a: ArrayLike<unknown>, b: ArrayLike<unknown>): number | undefined {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? undefined : n;
}
