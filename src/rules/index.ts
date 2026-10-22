// Code-execution analysis for one template. Parse-only: nothing here renders a
// template. Satisfies ISC-12, ISC-12.1, ISC-12.2, ISC-13, ISC-13.1, ISC-14,
// ISC-14.1, ISC-15, ISC-15.1, ISC-16, and ISC-26.1 (every span comes from the
// pre-lexer).
//
// analyzeCodeExec never throws and always returns a RuleResult: any input up to
// the readers' 16 MiB ceiling is answered (round-1 review item 1). Its result
// does not depend on stack size (item 2: pre-parse shape caps in parse.ts plus
// explicit-stack walkers) and is bounded in time (item 3: linear pre-checks, a
// per-rule finding cap, and a bounded raw-text fallback).

import type { AnalysisContext, Finding, RuleId, RuleResult } from "../types.ts";
import { parseTemplate } from "../parse/parse.ts";
import { collectBoundNames, hasDunderName, type Node } from "../parse/support.ts";
import { runCodeExec, type RuleCtx } from "./codeexec.ts";
import { runFold } from "./fold.ts";
import { runRawText } from "./rawtext.ts";
import { runUnanalyzable } from "./unanalyzable.ts";

interface Base {
  file: string;
  templateName: string;
  sha256: string;
}

// At most this many findings per rule survive; one summary finding then carries
// the suppressed count (round-1 review item 3).
const FINDING_CAP = 100;

// Longest excerpt we keep on a finding, so a 16 MiB string literal can never be
// copied into the output (ISC-44 escaping already assumes short excerpts).
const MAX_EXCERPT = 200;

export function analyzeCodeExec(ctx: AnalysisContext): RuleResult {
  const t = ctx.template;
  const base: Base = { file: t.source.path, templateName: t.source.name, sha256: t.sha256 };
  try {
    return analyze(ctx, base);
  } catch (e) {
    // Item 1 — an internal failure is reported, never thrown. The template is
    // HIGH unanalyzable and incomplete, exactly as an unparseable one would be.
    const message = e instanceof Error ? e.message : String(e);
    return {
      findings: [{ ruleId: "unanalyzable", severity: "HIGH", message: `internal error analyzing template: ${message}`, ...base }],
      complete: false,
    };
  }
}

function analyze(ctx: AnalysisContext, base: Base): RuleResult {
  const t = ctx.template;
  const outcome = parseTemplate(t.text);
  const findings: Finding[] = [];

  // ISC-12 / ISC-12.1 / ISC-12.2 — coverage.
  pushAll(findings, runUnanalyzable(outcome, ctx.knownGood, base, t.text));

  if (outcome.program) {
    const ruleCtx: RuleCtx = {
      outcome,
      text: t.text,
      bound: collectBoundNames(outcome.program as Node),
      scaffolding: ctx.scaffolding,
      ...base,
    };
    pushAll(findings, runCodeExec(ruleCtx)); //                     ISC-13, 13.1, 14.1, 15, 15.1, 16
    pushAll(findings, runFold(ruleCtx)); //                         ISC-14
    pushAll(findings, runStringLiteralDunder(outcome, ctx, base)); // ISC-13 catch-all (item 5)
  } else {
    // No AST: the raw-text forms of ISC-13 to ISC-16 still run (ISC-12).
    pushAll(findings, runRawText(outcome.pre.regions, outcome.lines, t.text, base));
  }

  // Fail closed on coverage (ISC-42.1): incomplete whenever we could not parse,
  // or the template uses any construct @huggingface/jinja does not implement —
  // we cannot vouch for a branch we cannot even render.
  const complete = !outcome.parseError && !outcome.tooLarge && outcome.unsupported.length === 0;

  return { findings: capPerRule(dedupe(findings), base), complete };
}

// ISC-13 (item 5) — any string literal inside a tag that contains a complete
// dunder is HIGH dunder_access, whatever its position: a map() attribute, a
// subscript key, a selectattr argument. The folder handles split fragments.
function runStringLiteralDunder(outcome: ReturnType<typeof parseTemplate>, ctx: AnalysisContext, base: Base): Finding[] {
  const out: Finding[] = [];
  for (const lit of outcome.pre.stringLiterals) {
    if (!hasDunderName(lit.value) || ctx.scaffolding.has(lit.value)) continue;
    const span = outcome.lines.span(lit.start, lit.end);
    out.push({
      ruleId: "dunder_access",
      severity: "HIGH",
      message: `string literal names a dunder '${clip(lit.value)}'`,
      ...base,
      span,
      excerpt: clip(ctx.template.text.slice(lit.start, lit.end)),
    });
  }
  return out;
}

function clip(s: string): string {
  return s.length > MAX_EXCERPT ? `${s.slice(0, MAX_EXCERPT)}…` : s;
}

function pushAll(into: Finding[], from: Finding[]): void {
  for (const f of from) into.push(f);
}

// Two rules can legitimately name the same span (e.g. an unparseable template
// also matched by a raw-text pattern). Keep one finding per (ruleId, span, message).
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

// Keep at most FINDING_CAP findings per rule; append one summary per over-cap
// rule carrying the suppressed count (item 3).
function capPerRule(findings: Finding[], base: Base): Finding[] {
  const kept: Finding[] = [];
  const counts = new Map<RuleId, number>();
  const suppressed = new Map<RuleId, number>();
  const severity = new Map<RuleId, Finding["severity"]>();
  for (const f of findings) {
    const c = counts.get(f.ruleId) ?? 0;
    if (!severity.has(f.ruleId)) severity.set(f.ruleId, f.severity);
    if (c < FINDING_CAP) {
      kept.push(f);
      counts.set(f.ruleId, c + 1);
    } else {
      suppressed.set(f.ruleId, (suppressed.get(f.ruleId) ?? 0) + 1);
    }
  }
  for (const [ruleId, n] of suppressed) {
    kept.push({
      ruleId,
      severity: severity.get(ruleId) ?? "HIGH",
      message: `${n} more ${ruleId} findings suppressed`,
      ...base,
      detail: { suppressed: n },
    });
  }
  return kept;
}
