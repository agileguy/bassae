// Code-execution analysis for one template. Parse-only: nothing here renders a
// template. Satisfies ISC-12, ISC-12.1, ISC-12.2, ISC-13, ISC-13.1, ISC-14,
// ISC-14.1, ISC-15, ISC-15.1, ISC-16, and ISC-26.1 (every span comes from the
// pre-lexer).

import type { AnalysisContext, Finding, RuleResult } from "../types.ts";
import { parseTemplate } from "../parse/parse.ts";
import { collectBoundNames, type Node } from "../parse/support.ts";
import { runCodeExec, type RuleCtx } from "./codeexec.ts";
import { runFold } from "./fold.ts";
import { runRawText } from "./rawtext.ts";
import { runUnanalyzable } from "./unanalyzable.ts";

export function analyzeCodeExec(ctx: AnalysisContext): RuleResult {
  const t = ctx.template;
  const base = { file: t.source.path, templateName: t.source.name, sha256: t.sha256 };
  const outcome = parseTemplate(t.text);

  const findings: Finding[] = [];

  // ISC-12 / ISC-12.1 / ISC-12.2 — coverage.
  findings.push(...runUnanalyzable(outcome, ctx.knownGood, base));

  if (outcome.program) {
    const ruleCtx: RuleCtx = {
      outcome,
      text: t.text,
      bound: collectBoundNames(outcome.program as Node),
      ...base,
    };
    findings.push(...runCodeExec(ruleCtx)); // ISC-13, 13.1, 14.1, 15, 15.1, 16
    findings.push(...runFold(ruleCtx)); //      ISC-14
  } else {
    // No AST: the raw-text forms of ISC-13 to ISC-16 still run (ISC-12).
    findings.push(...runRawText(outcome.pre.regions, outcome.lines, t.text, base));
  }

  // Fail closed on coverage (ISC-42.1): incomplete whenever we could not parse,
  // or the template uses any construct @huggingface/jinja does not implement —
  // we cannot vouch for a branch we cannot even render.
  const complete = !outcome.parseError && !outcome.tooLarge && outcome.unsupported.length === 0;

  return { findings: dedupe(findings), complete };
}

// Two rules can legitimately name the same span (e.g. an unparseable template
// also matched by a raw-text pattern). Keep one finding per (ruleId, span).
function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const key = `${f.ruleId}:${f.span?.start ?? -1}:${f.span?.end ?? -1}:${f.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}
