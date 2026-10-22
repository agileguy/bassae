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

function highs(src: string): string[] {
  return scan(src).findings.filter((f) => f.severity === "HIGH").map((f) => f.ruleId);
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

// Item 3 — bounded time. Each timing check asserts GROWTH, never wall-clock
// against a budget, so a slow or loaded host cannot fail it while a return to
// quadratic behaviour still does (round-2 timing flake: 1663 ms against a
// 1000 ms budget in Docker). A shape is scanned at size n and GROWTH * n on the
// same code path: linear work grows about 4x, quadratic about 16x, and the limit
// sits between them. The best of three runs after a full GC damps scheduler
// noise, and a small floor added to both sides keeps millisecond-scale jitter
// from reading as growth. Sizes are chosen so the small run is tens of
// milliseconds here; a quadratic regression at these sizes takes seconds.
const GROWTH = 4;
const MAX_RATIO = 8;
const FLOOR_MS = 5;
const TIMING_TIMEOUT_MS = 120_000;

function best(src: string, runs = 3): { r: RuleResult; ms: number } {
  let out: { r: RuleResult; ms: number } | undefined;
  for (let i = 0; i < runs; i++) {
    Bun.gc(true);
    const t0 = performance.now();
    const r = scan(src);
    const ms = performance.now() - t0;
    if (!out || ms < out.ms) out = { r, ms };
  }
  return out!;
}

/** Scan build(n) and build(GROWTH * n); fail when time grows faster than linear allows. Returns the larger scan's result. */
function expectLinear(label: string, build: (n: number) => string, n: number): RuleResult {
  const small = build(n);
  const large = build(n * GROWTH);
  scan(small); // warm-up: JIT tiers and first-touch allocation
  const a = best(small);
  const b = best(large);
  const ratio = (b.ms + FLOOR_MS) / (a.ms + FLOOR_MS);
  console.log(`  ${label}: ${a.ms.toFixed(1)} ms -> ${b.ms.toFixed(1)} ms at ${GROWTH}x size (${small.length} -> ${large.length} units), ratio ${ratio.toFixed(1)}`);
  expect({ label, linear: ratio < MAX_RATIO }).toEqual({ label, linear: true });
  return b.r;
}

test("a long run of spaces grows linearly (whitespace-cap path)", () => {
  const r = expectLinear("spaces", (n) => "{{ x }}" + " ".repeat(n) + "{{ y }}", 120_000);
  expect(isHighUnanalyzable(r)).toBe(true);
}, TIMING_TIMEOUT_MS);

test("a long run of newlines grows linearly (whitespace-cap path)", () => {
  const r = expectLinear("newlines", (n) => "{{ x }}" + "\n".repeat(n) + "{{ y }}", 50_000);
  expect(isHighUnanalyzable(r)).toBe(true);
}, TIMING_TIMEOUT_MS);

test("a single-line string of dunders grows linearly to 16 MiB (raw-text path)", () => {
  const build = (units: number) => "{{ '" + "__a__".repeat(Math.floor((units - 10) / 5)) + "' }}";
  const r = expectLinear("dunders 4 -> 16 MiB", build, 4 * 1024 * 1024);
  expect(isHighUnanalyzable(r)).toBe(true);
  expect(r.findings.some((f) => f.ruleId === "dunder_access")).toBe(true);
}, TIMING_TIMEOUT_MS);

test("{{a}} repeated on one line grows linearly (full parse path)", () => {
  expectLinear("{{a}} x n", (n) => "{{a}}".repeat(n), 10_000);
}, TIMING_TIMEOUT_MS);

// Over the size cap, the streaming raw-text scan must stay O(text) in the NUMBER
// of tags: a benign template of many tiny tags must not rescan the file per tag.
test("an over-cap template of many tiny tags grows linearly (streaming is O(text))", () => {
  const build = (lines: number) => "{{ messages[0]['content'] }}\n".repeat(lines) + "{{ x.__class__ }}"; // one dunder at the very end
  expect(build(20_000).length).toBeGreaterThan(512 * 1024);
  const r = expectLinear("many tiny tags", build, 20_000);
  expect(isHighUnanalyzable(r)).toBe(true);
  expect(r.findings.some((f) => f.ruleId === "dunder_access")).toBe(true);
}, TIMING_TIMEOUT_MS);

// The raw-text select/reject probe pattern once used an unbounded lazy gap that
// rescanned to the end from every `select(` with no `)`: 119K units took 582 ms
// and 476K took 9.4 s. A long run of them inside one tag now scans linearly.
test("a long run of unclosed select( grows linearly (raw-text regex)", () => {
  const r = expectLinear("select( x n", (n) => "{{ " + "select(".repeat(n) + " }}", 17_000);
  expect(isHighUnanalyzable(r)).toBe(true);
}, TIMING_TIMEOUT_MS);

// The binding fixpoint runs at most MAX_BINDING_ROUNDS passes and indexes each
// call's arguments once, so it stays linear in a macro's width and in a chain of
// macros that demote one another one round at a time.
test("the macro-parameter fixpoint grows linearly in macro width and chain length", () => {
  const wide = (params: number) => {
    const names = Array.from({ length: params }, (_, i) => `p${i}`);
    const args = Array.from({ length: params }, () => "messages").join(", ");
    return `{% macro f(${names.join(", ")}) %}{{ p0[messages[0].role] }}{% endmacro %}` + `{{ f(${args}) }}`.repeat(40);
  };
  expect(highs(wide(10))).toHaveLength(0);
  expectLinear("wide macro", wide, 250);
  // Each macro passes its parameter to the previous one; the top call passes a
  // literal, so demotion walks down the chain. Past the round cap, nothing local
  // is exempt, and the innermost subscript is flagged either way.
  const chain = (len: number) => {
    let src = "{% macro m0(o0) %}{{ o0[messages[0].role] }}{% endmacro %}";
    for (let i = 1; i < len; i++) src += `{% macro m${i}(o${i}) %}{{ m${i - 1}(o${i}) }}{% endmacro %}`;
    return src + `{{ m${len - 1}('abc') }}`;
  };
  expect(highs(chain(8))).toContain("dynamic_attribute"); // settles within the cap
  const r = expectLinear("macro chain", chain, 500);
  expect(r.findings.some((f) => f.ruleId === "dynamic_attribute")).toBe(true); // hits the cap
}, TIMING_TIMEOUT_MS);

// M6 — the whitespace cap counts every code unit matching the library's `\s`
// preprocess class, not just ASCII. A run of U+00A0, U+3000, or any mix of them
// over the cap is a deterministic HIGH unanalyzable.
test("M6: a run of non-ASCII Unicode whitespace over the cap is HIGH unanalyzable", () => {
  const over = 512 + 1;
  const cases: [string, string][] = [
    ["NBSP only", " ".repeat(over)],
    ["U+3000 only", "　".repeat(over)],
    ["space/NBSP alternating", "  ".repeat(over)], // 1026 units, all whitespace -> one run
  ];
  for (const [label, run] of cases) {
    expect({ label, high: isHighUnanalyzable(scan(`{{ x }}${run}{{ y }}`)) }).toEqual({ label, high: true });
  }
  // A run at or under the cap is NOT flagged as a whitespace overrun.
  const atCap = scan(`{{ x }}${" ".repeat(512)}{{ y }}`);
  expect(atCap.findings.some((f) => /whitespace run/.test(f.message))).toBe(false);
});

// M6 — the reported shape: a long run of U+2003 or U+00A0 inside a tag. HIGH,
// and linear in the run length.
test("M6: a long non-ASCII whitespace run inside a tag grows linearly and is HIGH", () => {
  for (const [label, ch] of [["U+2003", " "], ["U+00A0", " "]] as const) {
    const r = expectLinear(`M6 ${label} in a tag`, (n) => "{{ x" + ch.repeat(n) + "}}", 25_000);
    expect({ label, high: isHighUnanalyzable(r) }).toEqual({ label, high: true });
  }
}, TIMING_TIMEOUT_MS);

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

// M8 — the library parser recurses on block nesting, brackets and unary chains
// (member, filter, `~` and subscript chains are iterative), so the caps must keep
// every input they admit well inside the stack, or the result would depend on the
// host. The deepest mix the caps admit is 128 nested block sets around one
// 2048-token tag of 100 parens wrapping 1847 `not`s. On macOS arm64 with an 8 MB
// stack the warmed-up parser overflows only at 13985 `not`s in that mix (7.6x);
// alone, set blocks overflow at 8193 deep, an elif chain at 16770, parens at 1635.
// This pins that the capped worst case parses on every host CI runs on.
test("M8: the deepest shapes the caps admit parse without overflow", () => {
  const worst = "{% set v %}".repeat(128) + "{{ " + "(".repeat(100) + "not ".repeat(1847) + "x" + ")".repeat(100) + " }}" + "{% endset %}".repeat(128);
  const r = scan(worst);
  expect(r.complete).toBe(true);
  expect(r.findings.filter((f) => f.ruleId === "unanalyzable")).toEqual([]);
  // At exactly the block cap, an elif chain and nested ifs parse too.
  const elifs = "{% if a0 %}x" + Array.from({ length: 127 }, (_, i) => `{% elif a${i + 1} %}x`).join("") + "{% endif %}";
  expect(scan(elifs).complete).toBe(true);
  expect(scan("{% if x %}".repeat(128) + "y" + "{% endif %}".repeat(128)).complete).toBe(true);
  // One token over the tag cap is HIGH unanalyzable before the parser runs.
  expect(isHighUnanalyzable(scan(worst.replace("not x", "not not x")))).toBe(true);
});

test("M8: an inline `set x = ...` is NOT a block and does not deepen nesting", () => {
  // 200 inline sets in sequence (not nested) stay well under the cap and parse.
  const inline = Array.from({ length: 200 }, (_, i) => `{% set x${i} = ${i} %}`).join("") + "{{ x0 }}";
  const r = scan(inline);
  expect(r.findings.some((f) => f.ruleId === "unanalyzable")).toBe(false);
});

// M5 / ISC-26.1 — a shape-cap finding is spanned where the cap tripped: the
// whitespace run itself, the token that took block or bracket depth over its
// limit, or the whole tag that passed the token limit. Each span's line:col is
// checked against an offset computed without LineMap, and the excerpt is the
// spanned text, clipped. The over-size finding is the whole-template case, at
// offset 0 with length 0.
test("M5: every shape-cap unanalyzable finding is spanned on the offending text", () => {
  const nth = (src: string, needle: string, n: number): number => {
    let i = -1;
    for (let k = 0; k < n; k++) i = src.indexOf(needle, i + 1);
    return i;
  };
  // Offset of a 1-based line and column, breaking lines as jinja2 does (BMP text, so a column is a code unit).
  const offsetOf = (src: string, line: number, col: number): number => {
    const re = /\r\n|\r|\n/g;
    let start = 0;
    for (let l = 1; l < line; l++) {
      const m = re.exec(src);
      if (!m) return -1;
      start = m.index + m[0].length;
    }
    return start + col - 1;
  };
  const clipped = (s: string): string => (s.length > 200 ? `${s.slice(0, 200)}…` : s);
  const NL = "x\r\n"; // the variants start on line 2
  const cases: { label: string; src: string; start: number; end: number }[] = [];
  const add = (label: string, src: string, start: number, end: number): void => void cases.push({ label, src, start, end });

  // Whitespace runs: the run itself, ASCII or not (M6).
  for (const [name, ch] of [["U+2003", " "], ["U+00A0", " "], ["space", " "]] as const) {
    add(`100k ${name} in a tag`, "{{ x" + ch.repeat(100_000) + "}}", 4, 100_004);
    add(`600 ${name}, line 2`, NL + "{{ x" + ch.repeat(600) + "}}", NL.length + 4, NL.length + 604);
  }
  // Block depth: the keyword that opens level 129.
  const elifs = "{% if a %}" + "{% elif b %}".repeat(300) + "{% endif %}";
  add("300 elifs", elifs, nth(elifs, "elif", 128), nth(elifs, "elif", 128) + 4);
  const sets = "{% set a %}".repeat(200) + "x" + "{% endset %}".repeat(200);
  add("200 nested set blocks", sets, nth(sets, "set a", 129), nth(sets, "set a", 129) + 3);
  const ifs = NL + "{% if x %}".repeat(140) + "y" + "{% endif %}".repeat(140);
  add("140 nested ifs, line 2", ifs, nth(ifs, "if x", 129), nth(ifs, "if x", 129) + 2);
  // Bracket depth: the 101st open bracket.
  add("150 parens, line 2", NL + "{{ " + "(".repeat(150) + "x" + ")".repeat(150) + " }}", NL.length + 103, NL.length + 104);
  // Tag tokens: the whole tag, opener to closer, closed or not.
  const tag = NL + "{{ " + "a+".repeat(1100) + "a }}";
  add("2201-token tag, line 2", tag, NL.length, tag.length);
  const open = NL + "{% set y = 1 %}{{ " + "a+".repeat(1100) + "a";
  add("2201-token unclosed tag, line 2", open, open.indexOf("{{"), open.length);

  for (const c of cases) {
    const caps = scan(c.src).findings.filter((f) => f.ruleId === "unanalyzable" && f.severity === "HIGH");
    expect({ label: c.label, count: caps.length }).toEqual({ label: c.label, count: 1 });
    const f = caps[0]!;
    expect({ label: c.label, start: f.span?.start, end: f.span?.end }).toEqual({ label: c.label, start: c.start, end: c.end });
    expect({ label: c.label, at: offsetOf(c.src, f.span!.line, f.span!.col) }).toEqual({ label: c.label, at: c.start });
    expect({ label: c.label, excerpt: f.excerpt }).toEqual({ label: c.label, excerpt: clipped(c.src.slice(c.start, c.end)) });
  }

  // Over the size cap: the whole template, at offset 0 with length 0.
  const big = scan("{{ x }}" + "a".repeat(512 * 1024)).findings.filter((f) => f.ruleId === "unanalyzable" && f.severity === "HIGH");
  expect(big.map((f) => ({ span: f.span, excerpt: f.excerpt }))).toEqual([{ span: { start: 0, end: 0, line: 1, col: 1 }, excerpt: undefined }]);
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
