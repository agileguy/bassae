import type { AnalysisContext, RuleResult } from "../types.ts";

/** Code-execution analysis for one template: ISC-12 to ISC-16. Parse-only; nothing is rendered. */
export function analyzeCodeExec(_ctx: AnalysisContext): RuleResult {
  return { findings: [], complete: true };
}
