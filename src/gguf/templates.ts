import { makeTemplate } from "../template.ts";
import type { ExtractedTemplate, Finding } from "../types.ts";
import type { RawTemplate } from "./reader.ts";

/** Every key an engine may load a chat template from (ISC-4). The s flag lets a name hold a newline. */
export const CHAT_TEMPLATE_KEY = /^tokenizer\.chat_template(?:\.(.+))?$/s;

/** The name list gguf-py writes beside named templates. It never lists the bare key. */
export const TEMPLATE_LIST_KEY = "tokenizer.chat_templates";

const BARE_KEY = "tokenizer.chat_template";

/** "default" for the bare key, otherwise the suffix. */
export function templateName(key: string): string {
  return CHAT_TEMPLATE_KEY.exec(key)?.[1] ?? "default";
}

export function extractTemplates(raw: RawTemplate[], path: string, realPath: string): ExtractedTemplate[] {
  return raw.map((r) => makeTemplate({ kind: "gguf", path, realPath, name: templateName(r.key), key: r.key }, r.bytes));
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
    if (key === BARE_KEY || listed.has(name) || reported.has(name)) continue;
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
