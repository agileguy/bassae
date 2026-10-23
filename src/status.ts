// The one status each template gets (ISC-42, ISC-42.1) and the exit code a scan gives (ISC-28).
// The scan pipeline sets them through here and the CLI ranks and prints them, so the two can never disagree.

import type { ExitCode, Finding, RegistryMatch, ScanReport, Severity, TemplateStatus } from "./types.ts";
import { SEVERITY_RANK } from "./types.ts";

/** Worst first. A model with templates takes the first of its templates' statuses in this order. */
export const STATUS_ORDER: readonly TemplateStatus[] = ["findings", "incomplete", "clean-unverified", "known-good-variant", "known-good", "no_template"];

export function highestSeverity(findings: readonly Finding[]): Severity | undefined {
  let top: Severity | undefined;
  for (const f of findings) if (!top || SEVERITY_RANK[f.severity] > SEVERITY_RANK[top]) top = f.severity;
  return top;
}

/**
 * In order:
 * 1. any HIGH finding gives `findings`: nothing left unchecked could make the verdict better, and the gaps are still listed;
 * 2. any gap gives `incomplete` (ISC-42.1). An exact registry match does not outrank a gap: the bytes are upstream's,
 *    but the scanner could not show what they do;
 * 3. any MEDIUM or LOW finding gives `findings`;
 * 4. an exact registry match gives `known-good` (ISC-24), a whitespace-only one `known-good-variant` (ISC-24.2);
 * 5. anything else is `clean-unverified`.
 */
export function statusOf(findings: readonly Finding[], gaps: readonly string[], match: RegistryMatch["kind"]): Exclude<TemplateStatus, "no_template"> {
  const top = highestSeverity(findings);
  if (top === "HIGH") return "findings";
  if (gaps.length > 0) return "incomplete";
  if (top) return "findings";
  if (match === "exact") return "known-good";
  if (match === "whitespace") return "known-good-variant";
  return "clean-unverified";
}

// Rules that say the scanner could not read something, rather than that something is wrong with it.
const SCANNER_ERRORS: ReadonlySet<Finding["ruleId"]> = new Set(["scanner_error", "parse_error"]);

/**
 * The worst of the model's own standing and its templates' statuses (ISC-42). The model's own findings are the ones
 * no template took: a HIGH among them gives `findings`, a scanner or parse error or an unfinished extraction gives
 * `incomplete`, any other gives `findings`, in statusOf's order. A model with no template and nothing of its own is
 * `no_template`, never clean.
 */
export function modelStatus(templates: readonly { status: TemplateStatus }[], extractionComplete: boolean, findings: readonly Finding[] = []): TemplateStatus {
  const top = highestSeverity(findings);
  const own: TemplateStatus | undefined =
    top === "HIGH" ? "findings" : !extractionComplete || findings.some((f) => SCANNER_ERRORS.has(f.ruleId)) ? "incomplete" : top ? "findings" : undefined;
  const statuses = [...(own ? [own] : []), ...templates.map((t) => t.status)];
  if (statuses.length === 0) return "no_template";
  let worst = statuses[0]!;
  for (const s of statuses) if (STATUS_ORDER.indexOf(s) < STATUS_ORDER.indexOf(worst)) worst = s;
  return worst;
}

/** ISC-28: 2 for any HIGH; else 3 for any scanner or parse error or any `incomplete` status; else 1 for any MEDIUM; else 0, LOW included. */
export function exitCodeOf(report: Pick<ScanReport, "models" | "findings">): ExitCode {
  const all: Finding[] = [...report.findings];
  let incomplete = false;
  for (const m of report.models) {
    all.push(...m.findings);
    if (m.status === "incomplete") incomplete = true;
    for (const t of m.templates) {
      all.push(...t.findings);
      if (t.status === "incomplete") incomplete = true;
    }
  }
  if (all.some((f) => f.severity === "HIGH")) return 2;
  if (incomplete || all.some((f) => SCANNER_ERRORS.has(f.ruleId))) return 3;
  if (all.some((f) => f.severity === "MEDIUM")) return 1;
  return 0;
}
