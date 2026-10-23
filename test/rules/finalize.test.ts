import { describe, expect, test } from "bun:test";
import { capPerRule, clip, dedupe, FINDING_CAP, MAX_EXCERPT, pushAll } from "../../src/rules/finalize.ts";
import type { Finding, FindingBase, Severity } from "../../src/types.ts";

const base: FindingBase = { file: "/m/tokenizer_config.json", templateName: "default", templateSha256: "0".repeat(64) };

function finding(i: number, severity: Severity = "MEDIUM", ruleId: Finding["ruleId"] = "unbaselined_text"): Finding {
  return { ruleId, severity, message: `hit ${i}`, ...base, span: { start: i, end: i + 1, line: 1, col: i + 1 } };
}

describe("capPerRule", () => {
  test("keeps FINDING_CAP per rule and adds one summary at the first suppressed span", () => {
    const many = Array.from({ length: FINDING_CAP + 7 }, (_, i) => finding(i));
    const out = capPerRule([...many, finding(0, "HIGH", "url_in_text")], base);
    const unb = out.filter((f) => f.ruleId === "unbaselined_text");
    expect(unb).toHaveLength(FINDING_CAP + 1);
    const summary = unb.at(-1)!;
    expect(summary.detail).toEqual({ suppressed: 7 });
    expect(summary.span?.start).toBe(FINDING_CAP);
    expect(out.filter((f) => f.ruleId === "url_in_text")).toHaveLength(1);
  });

  test("the summary carries the highest severity of the rule, even when only a suppressed finding had it", () => {
    const many = Array.from({ length: FINDING_CAP }, (_, i) => finding(i));
    const out = capPerRule([...many, finding(FINDING_CAP, "HIGH")], base);
    expect(out.at(-1)!.severity).toBe("HIGH");
  });

  test("at or under the cap nothing is added", () => {
    const exact = Array.from({ length: FINDING_CAP }, (_, i) => finding(i));
    expect(capPerRule(exact, base)).toEqual(exact);
  });
});

describe("pushAll and dedupe", () => {
  test("a spanless finding gets the whole-template span and a long excerpt is clipped", () => {
    const into: Finding[] = [];
    const { span: _, ...spanless } = finding(1);
    pushAll(into, [{ ...spanless, excerpt: "x".repeat(MAX_EXCERPT * 2) }]);
    expect(into[0]!.span).toEqual({ start: 0, end: 0, line: 1, col: 1 });
    expect(into[0]!.excerpt).toBe(clip("x".repeat(MAX_EXCERPT * 2)));
  });

  test("dedupe keeps one finding per rule, span and message", () => {
    expect(dedupe([finding(1), finding(1), finding(2)])).toHaveLength(2);
  });
});
