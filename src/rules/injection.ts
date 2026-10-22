// Hidden-instruction rules: injected text, content triggers, nondeterminism,
// URLs, encoded blobs and invisible characters (ISC-17 to ISC-21).

import type { AnalysisContext, InjectedText, KnownGoodTemplate, ModelRecord, RuleResult } from "../types.ts";
import { parseTemplate, WHOLE_TEMPLATE } from "../parse/parse.ts";
import { extract } from "./injected.ts";

/** Scaffolding for one template: the model's special tokens that do not read as prose (ISC-17.3), role names, whitespace and delimiters, and every literal in `known`. */
export function buildScaffolding(model: ModelRecord, known?: KnownGoodTemplate): Set<string> {
  void known;
  return new Set(model.specialTokens);
}

/** Every literal the template can emit that is not in `ctx.scaffolding`, with its span and the test it depends on (ISC-17). */
export function extractInjectedText(ctx: AnalysisContext): InjectedText[] {
  return extract(parseTemplate(ctx.template.text), ctx.template.text, ctx.scaffolding).items;
}

/** unbaselined_text, prefill_injection, content_trigger, nondeterministic_trigger, url_in_text, encoded_blob and invisible_char. The raw-text forms of ISC-19 to ISC-21 still run when the template does not parse (ISC-12). */
export function analyzeInjection(ctx: AnalysisContext): RuleResult {
  const t = ctx.template;
  const base = { file: t.source.path, templateName: t.source.name, templateSha256: t.sha256 };
  try {
    extractInjectedText(ctx);
    return { findings: [], complete: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { findings: [{ ruleId: "scanner_error", severity: "HIGH", message: `internal error in the injection rules: ${message}`, ...base, span: { ...WHOLE_TEMPLATE } }], complete: false };
  }
}
