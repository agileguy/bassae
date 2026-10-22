// analyzeCodeExec must return a RuleResult for any input the readers can
// produce (up to 16 MiB), with a result that does not depend on stack size and
// in bounded time (round-1 review items 1-3).

import { expect, test } from "bun:test";
import { analyzeCodeExec } from "../../src/rules/index.ts";
import { isJsWhitespace } from "../../src/parse/parse.ts";
import { LineMap } from "../../src/parse/support.ts";
import { makeTemplateFromString } from "../../src/template.ts";
import type { RuleResult } from "../../src/types.ts";

function scan(src: string): RuleResult {
  const t = makeTemplateFromString({ kind: "bare", path: "/t", realPath: "/t", name: "default" }, src);
  return analyzeCodeExec({ template: t, scaffolding: new Set(), knownGood: false });
}

function timed(label: string, src: string): { r: RuleResult; ms: number } {
  const t0 = performance.now();
  const r = scan(src);
  const ms = performance.now() - t0;
  console.log(`  ${label}: ${ms.toFixed(0)} ms (${src.length} code units)`);
  return { r, ms };
}

const isHighUnanalyzable = (r: RuleResult) =>
  r.findings.some((f) => f.ruleId === "unanalyzable" && f.severity === "HIGH") && r.complete === false;

// Item 1/2 — inputs that overflowed the stack. Each is a deterministic HIGH unanalyzable.
test("deep member chain (50k .b) is HIGH unanalyzable, not a RangeError", () => {
  expect(isHighUnanalyzable(scan("{{ a" + ".b".repeat(50_000) + " }}"))).toBe(true);
});

test("deep filter chain (30k |trim) is HIGH unanalyzable, not a RangeError", () => {
  expect(isHighUnanalyzable(scan("{{ a" + "|trim".repeat(30_000) + " }}"))).toBe(true);
});

test("300 KB of 'a' ~ 'a' ~ ... is HIGH unanalyzable, not a RangeError", () => {
  const n = Math.ceil((300 * 1024) / 6);
  expect(isHighUnanalyzable(scan("{{ 'a'" + " ~ 'a'".repeat(n) + " }}"))).toBe(true);
});

test("if nested 10k deep is HIGH unanalyzable, not a RangeError", () => {
  expect(isHighUnanalyzable(scan("{% if x %}".repeat(10_000) + "y" + "{% endif %}".repeat(10_000)))).toBe(true);
});

test("moderate nesting under the caps still parses and analyzes", () => {
  const r = scan("{% if x %}".repeat(50) + "{{ m.__class__ }}" + "{% endif %}".repeat(50));
  expect(r.findings.some((f) => f.ruleId === "dunder_access")).toBe(true);
});

// Item 3 — bounded time at the caps.
const BUDGET_MS = 1000;

test("512K spaces finish within budget", () => {
  const { r, ms } = timed("512K spaces", "{{ x }}" + " ".repeat(512 * 1024) + "{{ y }}");
  expect(ms).toBeLessThan(BUDGET_MS);
  expect(isHighUnanalyzable(r)).toBe(true);
});

test("200k newlines finish within budget", () => {
  const { r, ms } = timed("200k newlines", "{{ x }}" + "\n".repeat(200_000) + "{{ y }}");
  expect(ms).toBeLessThan(BUDGET_MS);
  expect(isHighUnanalyzable(r)).toBe(true);
});

test("16 MiB single-line string of dunders finishes within budget through the raw-text path", () => {
  const body = "__a__".repeat(Math.floor((16 * 1024 * 1024 - 10) / 5));
  const { r, ms } = timed("16 MiB dunders", "{{ '" + body + "' }}");
  expect(ms).toBeLessThan(BUDGET_MS);
  expect(isHighUnanalyzable(r)).toBe(true);
  expect(r.findings.some((f) => f.ruleId === "dunder_access")).toBe(true);
});

test("{{a}} repeated 40k times on one line finishes within budget", () => {
  const { ms } = timed("40k {{a}}", "{{a}}".repeat(40_000));
  expect(ms).toBeLessThan(BUDGET_MS);
});

// Over the size cap, the streaming raw-text scan must stay O(text) in the NUMBER
// of tags: a benign template of many tiny tags must not rescan the file per tag.
test("an over-cap template of many tiny tags finishes within budget (streaming is O(text))", () => {
  const body = "{{ messages[0]['content'] }}\n".repeat(55_000); // ~1.5 MiB, over the 512 KiB cap
  const src = body + "{{ x.__class__ }}"; // one dunder at the very end
  expect(src.length).toBeGreaterThan(512 * 1024);
  const { r, ms } = timed("1.5 MiB many-tag", src);
  expect(ms).toBeLessThan(BUDGET_MS);
  expect(isHighUnanalyzable(r)).toBe(true);
  expect(r.findings.some((f) => f.ruleId === "dunder_access")).toBe(true);
});

// M6 — the whitespace cap counts every code unit matching the library's `\s`
// preprocess class, not just ASCII. A run of U+00A0, U+3000, or any mix of them
// over the cap is a deterministic HIGH unanalyzable within the time budget.
test("M6: a run of non-ASCII Unicode whitespace over the cap is HIGH unanalyzable in budget", () => {
  const over = 512 + 1;
  const cases: [string, string][] = [
    ["NBSP only", " ".repeat(over)],
    ["U+3000 only", "　".repeat(over)],
    ["space/NBSP alternating", "  ".repeat(over)], // 1026 units, all whitespace -> one run
  ];
  for (const [label, run] of cases) {
    const { r, ms } = timed(`M6 ${label}`, `{{ x }}${run}{{ y }}`);
    expect({ label, high: isHighUnanalyzable(r) }).toEqual({ label, high: true });
    expect({ label, inBudget: ms < BUDGET_MS }).toEqual({ label, inBudget: true });
  }
  // A run at or under the cap is NOT flagged as a whitespace overrun.
  const atCap = scan(`{{ x }}${" ".repeat(512)}{{ y }}`);
  expect(atCap.findings.some((f) => /whitespace run/.test(f.message))).toBe(false);
});

// M6 — isJsWhitespace must match JavaScript's /\s/ exactly across the BMP, so the
// run counter and the library's preprocess regex can never disagree.
test("M6: isJsWhitespace agrees with /\\s/ for every BMP code unit", () => {
  const ws = /\s/;
  const mismatches: number[] = [];
  for (let c = 0; c <= 0xffff; c++) {
    if (isJsWhitespace(c) !== ws.test(String.fromCharCode(c))) mismatches.push(c);
  }
  expect(mismatches).toEqual([]);
});

// M8 — `elif` and block `{% set %}...{% endset %}` count toward the nesting cap.
// Just above the cap, both shapes yield the same deterministic HIGH unanalyzable,
// whatever the host stack size (the decision is an integer count, not recursion).
test("M8: an elif chain over the nesting cap is HIGH unanalyzable", () => {
  const over = 128 + 5;
  // One `if` plus `over` elifs nests `1 + over` deep in the parser.
  const elifs = "{% if a0 %}x" + Array.from({ length: over }, (_, i) => `{% elif a${i + 1} %}x`).join("") + "{% endif %}";
  expect(isHighUnanalyzable(scan(elifs))).toBe(true);
});

test("M8: nested block sets over the nesting cap are HIGH unanalyzable", () => {
  const over = 128 + 5;
  // `{% set v %}` with no `=` is a block closed by `{% endset %}`; nest them.
  const blocks = "{% set v %}".repeat(over) + "x" + "{% endset %}".repeat(over);
  expect(isHighUnanalyzable(scan(blocks))).toBe(true);
});

test("M8: an inline `set x = ...` is NOT a block and does not deepen nesting", () => {
  // 200 inline sets in sequence (not nested) stay well under the cap and parse.
  const inline = Array.from({ length: 200 }, (_, i) => `{% set x${i} = ${i} %}`).join("") + "{{ x0 }}";
  const r = scan(inline);
  expect(r.findings.some((f) => f.ruleId === "unanalyzable")).toBe(false);
});

test("findings are capped at 100 per rule, plus one finding carrying the remaining count", () => {
  const r = scan("{{ x.__a__ }}".repeat(250));
  const dunder = r.findings.filter((f) => f.ruleId === "dunder_access");
  expect(dunder).toHaveLength(101);
  const summary = dunder[100]!;
  expect(summary.detail?.suppressed).toBe(150);
  expect(summary.message).toContain("150 more");
});

// LineMap: O(log n) lookups with code-point columns, CR and CRLF as line breaks.
test("LineMap counts columns in code points and breaks lines on \\r, \\n and \\r\\n", () => {
  const lm = new LineMap("a\rb\r{{ x }}");
  expect(lm.at(4)).toEqual({ line: 3, col: 1 });
  const crlf = new LineMap("a\r\nb");
  expect(crlf.at(3)).toEqual({ line: 2, col: 1 });
  const astral = new LineMap("😀😀x");
  expect(astral.at(4)).toEqual({ line: 1, col: 3 });
});

test("a lone CR moves a finding's line (Codex R4)", () => {
  const src = "a\rb\r{{ x.__class__ }}";
  const f = scan(src).findings.find((x) => x.ruleId === "dunder_access");
  expect(f?.span?.line).toBe(3);
  expect(f?.span?.col).toBe(src.indexOf("__class__") - src.lastIndexOf("\r"));
});
