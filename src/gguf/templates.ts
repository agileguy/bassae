import { LineMap } from "../parse/support.ts";
import { makeTemplate } from "../template.ts";
import type { ExtractedTemplate, Finding } from "../types.ts";
import type { RawTemplate } from "./reader.ts";

/** Every key an engine may load a chat template from (ISC-4). The s flag lets a name hold a newline. */
export const CHAT_TEMPLATE_KEY = /^tokenizer\.chat_template(?:\.(.+))?$/s;

/** The name list gguf-py writes beside named templates. It never lists the bare key. */
export const TEMPLATE_LIST_KEY = "tokenizer.chat_templates";

const BARE_KEY = "tokenizer.chat_template";

/** The key as llama.cpp resolves it. Its lookups compare C strings, so a NUL ends the key. */
export function cKey(key: string): string {
  const nul = key.indexOf("\0");
  return nul < 0 ? key : key.slice(0, nul);
}

export function isTemplateKey(key: string): boolean {
  return CHAT_TEMPLATE_KEY.test(cKey(key));
}

/** "default" for the bare key, otherwise the suffix. */
export function templateName(key: string): string {
  return CHAT_TEMPLATE_KEY.exec(cKey(key))?.[1] ?? "default";
}

/** The key a llama.cpp view is recorded under: the stored key, then how many bytes of its value llama.cpp sees. */
export const viewKey = (key: string, n: number) => `${key}[:${n}]`;

export interface Extraction {
  /** Each value as stored. */
  templates: ExtractedTemplate[];
  /** For a value holding a NUL, the bytes before it: what llama.cpp renders. */
  views: ExtractedTemplate[];
  findings: Finding[];
}

export function extractTemplates(raw: RawTemplate[], path: string, realPath: string): Extraction {
  const out: Extraction = { templates: [], views: [], findings: [] };
  for (const r of raw) {
    const source = { kind: "gguf", path, realPath, name: templateName(r.key), key: r.key } as const;
    const t = makeTemplate(source, r.bytes);
    out.templates.push(t);
    const n = r.bytes.indexOf(0);
    if (n < 0) continue;
    // llama.cpp reads string values through c_str(), so it renders only the bytes before the NUL while
    // gguf-py and HF tooling show the whole value. Both get analyzed.
    const view = makeTemplate({ ...source, key: viewKey(r.key, n) }, r.bytes.slice(0, n));
    out.views.push(view);
    const at = t.text.indexOf("\0");
    out.findings.push({
      ruleId: "parse_error",
      severity: "HIGH",
      message: `${JSON.stringify(r.key)} holds a NUL at byte ${n}; llama.cpp renders only the ${n} bytes before it`,
      file: path,
      templateName: source.name,
      templateSha256: t.sha256,
      span: new LineMap(t.text).span(at, at + 1),
      detail: { key: r.key, byteOffset: n, fileOffset: r.offset + n, viewSha256: view.sha256 },
    });
  }
  return out;
}

/** ISC-4.1: names listed with no key, and named keys missing from the list. Only checked when the list exists. */
export function checkTemplateList(templates: ExtractedTemplate[], list: string[] | undefined, file: string): Finding[] {
  if (!list) return [];
  const listed = new Set(list);
  const present = new Set(templates.map((t) => t.source.name));
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
    if (cKey(key!) === BARE_KEY || listed.has(name) || reported.has(name)) continue;
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
