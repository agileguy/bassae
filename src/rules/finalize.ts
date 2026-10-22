// What every rule's findings pass through before they leave a rule module:
// excerpts clipped, no finding spanless, duplicates dropped, and at most
// FINDING_CAP per rule. Shared by the code-execution and injection rules.

import type { Finding, FindingBase, RuleId, Severity, Span } from "../types.ts";
import { SEVERITY_RANK } from "../types.ts";
import { WHOLE_TEMPLATE } from "../parse/parse.ts";

// At most this many findings per rule survive; one summary finding then carries
// the suppressed count (round-1 review item 3).
export const FINDING_CAP = 100;

// Longest excerpt we keep on a finding, so a 16 MiB string literal can never be
// copied into the output (ISC-44 escaping already assumes short excerpts).
export const MAX_EXCERPT = 200;

// Cut to MAX_EXCERPT code units. An astral character straddling the cut is
// dropped whole, so the excerpt never ends in a lone high surrogate, which a
// UTF-8 writer would turn into U+FFFD and a strict consumer could reject.
export function clip(s: string): string {
  if (s.length <= MAX_EXCERPT) return s;
  const last = s.charCodeAt(MAX_EXCERPT - 1);
  const cut = last >= 0xd800 && last <= 0xdbff ? MAX_EXCERPT - 1 : MAX_EXCERPT;
  return `${s.slice(0, cut)}…`;
}

// Every finding passes through here, so two things hold for all of them: no
// rule can copy a long span (a cap's whitespace run, a whole tag) into the
// output as its excerpt, and no finding is spanless (ISC-26.1). One a rule
// could not place is the whole-template case.
export function pushAll(into: Finding[], from: Finding[]): void {
  for (let f of from) {
    if (f.excerpt && f.excerpt.length > MAX_EXCERPT) f = { ...f, excerpt: clip(f.excerpt) };
    if (!f.span) f = { ...f, span: { ...WHOLE_TEMPLATE } };
    into.push(f);
  }
}

// Two rules can legitimately name the same span (e.g. an unparseable template
// also matched by a raw-text pattern). Keep one finding per (ruleId, span, message).
export function dedupe(findings: Finding[]): Finding[] {
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
export function capPerRule(findings: Finding[], base: FindingBase): Finding[] {
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
