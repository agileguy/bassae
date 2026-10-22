// Hidden-instruction rules: injected text, content triggers, nondeterminism,
// URLs, encoded blobs and invisible characters (ISC-17 to ISC-21).
// Phase 2 seam: signatures are fixed; bodies belong to the InjectionRules engineer.

import type { AnalysisContext, InjectedText, KnownGoodTemplate, ModelRecord, RuleResult } from "../types.ts";

/** Scaffolding for one template: the model's special tokens that do not read as prose (ISC-17.3), role names, whitespace and delimiters, and every literal in `known`. */
export function buildScaffolding(model: ModelRecord, known?: KnownGoodTemplate): Set<string> {
  throw new Error("not implemented");
}

/** Every literal the template can emit that is not in `ctx.scaffolding`, with its span and the test it depends on (ISC-17). */
export function extractInjectedText(ctx: AnalysisContext): InjectedText[] {
  throw new Error("not implemented");
}

/** unbaselined_text, prefill_injection, content_trigger, nondeterministic_trigger, url_in_text, encoded_blob and invisible_char. The raw-text forms of ISC-19 to ISC-21 still run when the template does not parse (ISC-12). */
export function analyzeInjection(ctx: AnalysisContext): RuleResult {
  throw new Error("not implemented");
}
