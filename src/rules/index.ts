// Code-execution analysis for one template. Parse-only: nothing here renders a
// template. Satisfies ISC-12, ISC-12.1, ISC-12.2, ISC-13, ISC-13.1, ISC-14,
// ISC-14.1, ISC-15, ISC-15.1, ISC-16, and ISC-26.1 (every span comes from the
// pre-lexer).
//
// analyzeCodeExec never throws and always returns a RuleResult: any input the
// readers can hand us — up to the 64 MiB per-file limit (hf/sources.ts) — is
// answered (round-1 review item 1). Its result does not depend on stack size
// (item 2: pre-parse shape caps in parse.ts plus explicit-stack walkers), is
// bounded in time (item 3: linear pre-checks, a per-rule finding cap, a bounded
// raw-text fallback) and in memory (round-2 memory review: over the size cap no full token
// array or line map is built; the raw-text fallback streams).

import type { AnalysisContext, Finding, RuleId, RuleResult, Severity, Span } from "../types.ts";
import { SEVERITY_RANK } from "../types.ts";
import { parseTemplate, WHOLE_TEMPLATE } from "../parse/parse.ts";
import { hasDunderName, resolveBindings, type Node } from "../parse/support.ts";
import { runCodeExec, type RuleCtx } from "./codeexec.ts";
import { runFold } from "./fold.ts";
import { runRawText, runRawTextStreaming } from "./rawtext.ts";
import { runUnanalyzable } from "./unanalyzable.ts";

// The finding fields every rule stamps onto its output. Named exactly as on
// Finding so tsc rejects a stray `sha256` (review item M7).
interface Base {
  file: string;
  templateName: string;
  templateSha256: string;
}

// At most this many findings per rule survive; one summary finding then carries
// the suppressed count (round-1 review item 3).
const FINDING_CAP = 100;

// Longest excerpt we keep on a finding, so a 16 MiB string literal can never be
// copied into the output (ISC-44 escaping already assumes short excerpts).
const MAX_EXCERPT = 200;

export function analyzeCodeExec(ctx: AnalysisContext): RuleResult {
  const t = ctx.template;
  const base: Base = { file: t.source.path, templateName: t.source.name, templateSha256: t.sha256 };
  try {
    return analyze(ctx, base);
  } catch (e) {
    // Item 1 — an internal failure is reported, never thrown. The template is
    // HIGH unanalyzable and incomplete, exactly as an unparseable one would be.
    const message = e instanceof Error ? e.message : String(e);
    return {
      findings: [{ ruleId: "unanalyzable", severity: "HIGH", message: `internal error analyzing template: ${message}`, ...base, span: { ...WHOLE_TEMPLATE } }],
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
      env: resolveBindings(outcome.program as Node),
      scaffolding: ctx.scaffolding,
      ...base,
    };
    pushAll(findings, runCodeExec(ruleCtx)); //                     ISC-13, 13.1, 14.1, 15, 15.1, 16
    pushAll(findings, runFold(ruleCtx)); //                         ISC-14
    pushAll(findings, runStringLiteralDunder(outcome, ctx, base)); // ISC-13 catch-all (item 5)
  } else if (outcome.oversized) {
    // Over the size cap: no token array or line map was built (round-2 memory review). The
    // raw-text forms of ISC-13 to ISC-16 still run, as a bounded streaming scan.
    pushAll(findings, runRawTextStreaming(t.text, base));
  } else if (outcome.pre && outcome.lines) {
    // No AST (parse error or a shape cap): the raw-text forms still run (ISC-12).
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
  if (!outcome.pre || !outcome.lines) return out;
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

// Cut to MAX_EXCERPT code units. An astral character straddling the cut is
// dropped whole, so the excerpt never ends in a lone high surrogate, which a
// UTF-8 writer would turn into U+FFFD and a strict consumer could reject.
function clip(s: string): string {
  if (s.length <= MAX_EXCERPT) return s;
  const last = s.charCodeAt(MAX_EXCERPT - 1);
  const cut = last >= 0xd800 && last <= 0xdbff ? MAX_EXCERPT - 1 : MAX_EXCERPT;
  return `${s.slice(0, cut)}…`;
}

// Every finding passes through here, so two things hold for all of them: no
// rule can copy a long span (a cap's whitespace run, a whole tag) into the
// output as its excerpt, and no finding is spanless (ISC-26.1). One a rule
// could not place is the whole-template case.
function pushAll(into: Finding[], from: Finding[]): void {
  for (let f of from) {
    if (f.excerpt && f.excerpt.length > MAX_EXCERPT) f = { ...f, excerpt: clip(f.excerpt) };
    if (!f.span) f = { ...f, span: { ...WHOLE_TEMPLATE } };
    into.push(f);
  }
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
  const severity = new Map<RuleId, Severity>();
  const firstSuppressed = new Map<RuleId, Span | undefined>(); // where the summary points (ISC-26.1)
  for (const f of findings) {
    // The summary carries the HIGHEST severity seen for the rule, not the first
    // (review item C): a suppressed HIGH must not be summarized as MEDIUM.
    const prev = severity.get(f.ruleId);
    if (!prev || SEVERITY_RANK[f.severity] > SEVERITY_RANK[prev]) severity.set(f.ruleId, f.severity);
    const c = counts.get(f.ruleId) ?? 0;
    if (c < FINDING_CAP) {
      kept.push(f);
      counts.set(f.ruleId, c + 1);
    } else {
      suppressed.set(f.ruleId, (suppressed.get(f.ruleId) ?? 0) + 1);
      if (!firstSuppressed.has(f.ruleId)) firstSuppressed.set(f.ruleId, f.span);
    }
  }
  for (const [ruleId, n] of suppressed) {
    kept.push({
      ruleId,
      severity: severity.get(ruleId) ?? "HIGH",
      message: `${n} more ${ruleId} findings suppressed`,
      ...base,
      span: firstSuppressed.get(ruleId) ?? { ...WHOLE_TEMPLATE },
      detail: { suppressed: n },
    });
  }
  return kept;
}
