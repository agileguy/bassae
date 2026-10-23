// analyzeCodeExec must return a RuleResult for any input the readers can
// produce (up to 16 MiB), with a result that does not depend on stack size and
// in bounded time (round-1 review items 1-3).

import { expect, test } from "bun:test";
import { join } from "node:path";
import { analyzeCodeExec } from "../../src/rules/index.ts";
import { isJsWhitespace } from "../../src/parse/parse.ts";
import { LineMap } from "../../src/parse/support.ts";
import { makeTemplateFromString } from "../../src/template.ts";
import type { RuleResult } from "../../src/types.ts";
import { analyze, verdict } from "./stack-probe.ts";

function scan(src: string): RuleResult {
  const t = makeTemplateFromString({ kind: "bare", path: "/t", realPath: "/t", name: "default" }, src);
  return analyzeCodeExec({ template: t, scaffolding: new Set(), knownGood: false });
}

function highs(src: string): string[] {
  return scan(src).findings.filter((f) => f.severity === "HIGH").map((f) => f.ruleId);
}

// Offset of the nth occurrence of needle in src (1-based n).
function nth(src: string, needle: string, n: number): number {
  let i = -1;
  for (let k = 0; k < n; k++) i = src.indexOf(needle, i + 1);
  return i;
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

// Round 4 — finding a raw block's endraw stays one forward pass: an unclosed raw
// whose body is full of near-miss `{%   endraw x` tags, and many small raw blocks.
test("over the size cap, raw blocks grow linearly", () => {
  const unclosed = (n: number) => "{% raw %}" + "{%   endraw x".repeat(n) + "{{ x.__class__ }}";
  expect(unclosed(50_000).length).toBeGreaterThan(512 * 1024);
  expect(expectLinear("unclosed raw, near-miss endraws", unclosed, 50_000).findings.some((f) => f.ruleId === "dunder_access")).toBe(false);
  const blocks = (n: number) => "{% raw %}{#{% endraw %}{{ x }}".repeat(n) + "{{ y.__class__ }}";
  expect(expectLinear("many raw blocks", blocks, 25_000).findings.some((f) => f.ruleId === "dunder_access")).toBe(true);
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

// M8 / ISC-31 (runtime N-a) — only the closer of a block the count opened pops it.
// The library strips `{% endgeneration %}` before it parses, so counting that as
// a close let 8000 nested ifs through to a parser that overflows a 1 MiB stack.
const ENDGENERATION = "{% if a %}{% endgeneration %}".repeat(8000) + "{% endif %}".repeat(8000);

// The library's preprocess can also make an opener the pre-lexer never sees. It
// strips a generation tag lying between `{` and `% if`, and trim_blocks drops the
// newline in `-}\n}`, closing an expression the pre-lexer reads as still open.
// Each group of reps ends in `}}`, which closes the pre-lexer's expression (so no
// one tag passes the token cap) and is plain text to the library.
function hiddenIfs(rep: string, depth: number): string {
  let s = "";
  for (let i = 0; i < depth; i += 120) s += rep.repeat(Math.min(120, depth - i)) + "}}";
  return s + "{% endif %}".repeat(depth);
}
const HIDE_BY_GENERATION = "{{%generation%}% if a %}";
const HIDE_BY_TRIM = "{{ x -}\n} {% if a %}";

test("M8: a closer pops only the block it closes; {% endgeneration %} pops nothing", () => {
  const r = scan(ENDGENERATION);
  const caps = r.findings.filter((f) => f.ruleId === "unanalyzable");
  expect(r.complete).toBe(false);
  expect(caps.map((f) => [f.severity, f.message])).toEqual([["HIGH", "block nesting deeper than 128"]]);
  // Spanned on the `if` that opens level 129.
  expect(caps[0]!.span?.start).toBe(nth(ENDGENERATION, "if a", 129));
  // A closer of another kind does not pop either; real closers still do.
  expect(scan("{% for x in y %}{% endif %}".repeat(129)).findings.map((f) => f.message)).toContain("block nesting deeper than 128");
  expect(scan("{% if a %}{% endif %}".repeat(1000)).complete).toBe(true);
  expect(scan("{% for x in y %}{% generation %}x{% endgeneration %}{% endfor %}".repeat(200)).complete).toBe(true);
});

test("ISC-31: block depth is counted on the library's own tokens, so its preprocess hides no opener", () => {
  for (const [label, rep] of [["generation strip", HIDE_BY_GENERATION], ["trim_blocks", HIDE_BY_TRIM]] as const) {
    const r = scan(hiddenIfs(rep, 300));
    const caps = r.findings.filter((f) => f.ruleId === "unanalyzable");
    expect({ label, complete: r.complete }).toEqual({ label, complete: false });
    // The library's tokens carry no offsets, so this is the whole-template case.
    expect({ label, caps: caps.map((f) => [f.severity, f.message, f.span]) }).toEqual({
      label,
      caps: [["HIGH", "block nesting deeper than 128 in the library's tokens", { start: 0, end: 0, line: 1, col: 1 }]],
    });
    // At the cap, the same shape still parses.
    expect({ label, complete: scan(hiddenIfs(rep, 128)).complete }).toEqual({ label, complete: true });
  }
});

// ISC-31 — the verdict is the same on a 1 MiB stack. The canary proves the child
// really has the small stack: the library overflows there on 4000 nested ifs.
test("ISC-31: these shapes get the same verdict on a 1 MiB stack", () => {
  const probe = join(import.meta.dir, "stack-probe.ts");
  const env = { ...process.env, BUN_JSC_maxPerThreadStackUsage: String(2 ** 20) };
  const child = (args: string[], stdin?: string): unknown => {
    const p = Bun.spawnSync([process.execPath, probe, ...args], { env, stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin) });
    return JSON.parse(p.stdout.toString());
  };
  expect(child(["canary"])).toEqual({ parsed: false });
  for (const src of [ENDGENERATION, hiddenIfs(HIDE_BY_GENERATION, 5000), hiddenIfs(HIDE_BY_TRIM, 5000)]) {
    expect(child([], src)).toEqual(verdict(analyze(src)));
  }
}, TIMING_TIMEOUT_MS);

// M5 / ISC-26.1 — a shape-cap finding is spanned where the cap tripped: the
// whitespace run itself, the token that took block or bracket depth over its
// limit, or the whole tag that passed the token limit. Each span's line:col is
// checked against an offset computed without LineMap, and the excerpt is the
// spanned text, clipped. The over-size finding is the whole-template case, at
// offset 0 with length 0.
test("M5: every shape-cap unanalyzable finding is spanned on the offending text", () => {
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

// M5 — the whitespace message and its span describe the same run: the first one
// over the cap, even when a longer one follows (runtime review, round 3).
test("M5: the whitespace cap names the length of the run it spans", () => {
  const src = "{{ x" + " ".repeat(600) + "}}{{ y" + " ".repeat(100_000) + "}}";
  const caps = scan(src).findings.filter((f) => f.ruleId === "unanalyzable");
  expect(caps.map((f) => [f.message, f.span?.start, f.span?.end])).toEqual([["whitespace run of 600 exceeds the parse limit", 4, 604]]);
});

// ISC-26.1 — no HIGH finding is spanless. A library parse error whose message
// names no locatable construct (the library's messages carry no position) is
// the whole-template case, offset 0 with length 0; a named construct is spanned
// on its token. The per-rule overflow summary is spanned on the first finding
// it stands for, and a finding on a node with no identifier or string leaf
// (`messages[0][[1]]`) is spanned on the expression that holds it.
test("ISC-26.1: no HIGH finding lacks a span, parse errors and summaries included", () => {
  const WHOLE = { start: 0, end: 0, line: 1, col: 1 };
  const spanless = (src: string): string[] =>
    scan(src).findings.filter((f) => f.severity === "HIGH" && !f.span).map((f) => `${f.ruleId}: ${f.message}`);
  const spanOf = (src: string, ruleId: string) => scan(src).findings.find((f) => f.ruleId === ruleId && f.severity === "HIGH")?.span;

  // Library parse errors with no position: the whole template.
  const positionless = [
    "{% if x is divisibleby 3 %}y{% endif %}",
    "{{ x |}}",
    "{{ x",
    "{{ x ) }}",
    "{% for %}",
    "{{ 'abc }}",
    "a\nb\n{{ x | }}",
    "{% if x %}",
  ];
  for (const src of positionless) {
    expect({ src, span: spanOf(src, "unanalyzable") }).toEqual({ src, span: WHOLE });
  }
  // A named construct keeps its token span.
  expect(spanOf("x\n{% with %}{% endwith %}", "unanalyzable")).toEqual({ start: 5, end: 9, line: 2, col: 4 });

  // The overflow summary points at the first finding it suppresses.
  const many = "{{ x.__a__ }}".repeat(150);
  const dunders = scan(many).findings.filter((f) => f.ruleId === "dunder_access");
  expect(dunders[100]?.message).toContain("50 more");
  expect(dunders[100]?.span?.start).toBe(nth(many, "__a__", 101));

  // A key with no identifier or string leaf is spanned on its expression.
  for (const key of ["[1]", "(1, 2)", "{1: 2}", "[]", "-[1]"]) {
    const src = `x\n{{ messages[0][${key}] }}`;
    expect({ key, span: spanOf(src, "dynamic_attribute") }).toEqual({ key, span: { start: 5, end: 13, line: 2, col: 4 } });
  }

  // Nothing above, and none of the cap shapes, leaves a HIGH finding spanless.
  const all = [
    ...positionless,
    many,
    "{{ messages[0][[1]] }}",
    "{{ [1][[2]] }}",
    "{{ x" + " ".repeat(1000) + "}}",
    "{% if a %}" + "{% elif b %}".repeat(300) + "{% endif %}",
    "{% set a %}".repeat(200) + "x" + "{% endset %}".repeat(200),
    "{{ " + "(".repeat(150) + "x" + ")".repeat(150) + " }}",
    "{{ " + "a+".repeat(1100) + "a }}",
    "{{ x }}" + "a".repeat(512 * 1024),
  ];
  for (const src of all) expect({ src: src.slice(0, 40), spanless: spanless(src) }).toEqual({ src: src.slice(0, 40), spanless: [] });
});

// Excerpts are clipped to 200 code units; an astral character straddling the
// cut is dropped whole, so the excerpt never ends in a lone high surrogate.
test("an excerpt clipped through an astral character keeps no lone surrogate", () => {
  const roundTrips = (s: string): boolean => new TextDecoder().decode(new TextEncoder().encode(s)) === s;
  // A token-cap finding's excerpt is the whole tag, from its opener.
  const tagWithEmojiAt = (at: number): string => {
    const head = "{{ " + "a+".repeat(200);
    const filler = head.slice(0, at - 1); // the opening quote sits at at - 1
    return filler + "'\u{1F600}'" + "+a".repeat(1100) + " }}";
  };
  const excerptOf = (src: string): string | undefined =>
    scan(src).findings.find((f) => f.ruleId === "unanalyzable" && f.severity === "HIGH")?.excerpt;

  // The emoji's surrogates are units 199 and 200: the cut drops it and stops at 199.
  const straddle = tagWithEmojiAt(199);
  expect(straddle.charCodeAt(199)).toBe(0xd83d);
  const cut = excerptOf(straddle)!;
  expect(cut).toBe(`${straddle.slice(0, 199)}…`);
  expect(roundTrips(cut)).toBe(true);

  // Control: the emoji wholly before the cut (units 197 and 198) is kept.
  const before = tagWithEmojiAt(197);
  const kept = excerptOf(before)!;
  expect(kept).toBe(`${before.slice(0, 200)}…`);
  expect(kept).toContain("\u{1F600}");
  expect(roundTrips(kept)).toBe(true);
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

test("LineMap: a lone surrogate of either kind is one column (review round 2, runtime N6)", () => {
  // [text, offset, line, col]: a surrogate pair is one column, and so is a high
  // or low surrogate standing alone.
  const cases: [string, number, number, number][] = [
    ["\uD835x", 1, 1, 2],
    ["\uDC00x", 1, 1, 2],
    ["\u{1D41E}x", 2, 1, 2],
    ["x\uD835", 2, 1, 3],
    ["\uD835\nx", 2, 2, 1],
    ["\uD835\uD835\uDC1Ex", 3, 1, 3],
    ["\uDC1E\uD835x", 2, 1, 3],
    ["\uD835\uD835 go\nab\uD835c", 9, 2, 4],
  ];
  for (const [text, offset, line, col] of cases) expect({ text, at: new LineMap(text).at(offset) }).toEqual({ text, at: { line, col } });
});

test("a lone CR moves a finding's line (runtime R4)", () => {
  const src = "a\rb\r{{ x.__class__ }}";
  const f = scan(src).findings.find((x) => x.ruleId === "dunder_access");
  expect(f?.span?.line).toBe(3);
  expect(f?.span?.col).toBe(src.indexOf("__class__") - src.lastIndexOf("\r"));
});
