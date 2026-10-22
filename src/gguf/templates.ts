import type { ExtractedTemplate, Finding } from "../types.ts";
import type { RawTemplate } from "./reader.ts";

/** Every key an engine may load a chat template from (ISC-4). */
export const CHAT_TEMPLATE_KEY = /^tokenizer\.chat_template(?:\.(.+))?$/s;

/** The name list gguf-py writes beside named templates. */
export const TEMPLATE_LIST_KEY = "tokenizer.chat_templates";

/** "default" for the bare key, otherwise the suffix. */
export function templateName(key: string): string {
  return CHAT_TEMPLATE_KEY.exec(key)?.[1] ?? "default";
}

export function extractTemplates(_raw: RawTemplate[], _path: string, _realPath: string): ExtractedTemplate[] {
  return [];
}

export function checkTemplateList(_templates: ExtractedTemplate[], _list: string[] | undefined, _file: string): Finding[] {
  return [];
}
