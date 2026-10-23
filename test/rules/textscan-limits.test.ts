// The text rules stay linear in the text and bounded in findings on hostile
// input (ISC-19 to ISC-21, "Bounded"). Each shape is one a backtracking regex,
// a per-hit rescan or an unbounded finding list would turn superlinear: long
// dotted runs, long blob runs, runs of invisible characters, dense escapes, and
// millions of hits. The timing method is limits.test.ts's: scan at size n and
// GROWTH * n and fail when time grows faster than linear allows. The parse
// outcome is built outside the timed region, so only the rule is measured.

import { expect, test } from "bun:test";
import { parseTemplate, type ParseOutcome } from "../../src/parse/parse.ts";
import { extract } from "../../src/rules/injected.ts";
import { FINDING_CAP } from "../../src/rules/finalize.ts";
import { findEncodedBlobs, findInvisibleChars, findUrls, findUrlsRaw } from "../../src/rules/textscan.ts";
import type { Finding, InjectedText } from "../../src/types.ts";

const base = { file: "/t", templateName: "default", templateSha256: "x" };

const GROWTH = 4;
const MAX_RATIO = 8;
const FLOOR_MS = 5;
const TIMING_TIMEOUT_MS = 120_000;

type Rule = (o: ParseOutcome, src: string) => Finding[];
const urlsRaw: Rule = (o, src) => findUrlsRaw(o, src, base);
const blobs: Rule = (o, src) => findEncodedBlobs(o, src, base);
const invisible: Rule = (o, src) => findInvisibleChars(src, base, o);

function best(rule: Rule, o: ParseOutcome, src: string, runs = 3): { r: Finding[]; ms: number } {
  let out: { r: Finding[]; ms: number } | undefined;
  for (let i = 0; i < runs; i++) {
    Bun.gc(true);
    const t0 = performance.now();
    const r = rule(o, src);
    const ms = performance.now() - t0;
    if (!out || ms < out.ms) out = { r, ms };
  }
  return out!;
}

/** Run the rule on build(n) and build(GROWTH * n); fail when time grows faster than linear allows. Returns the larger run's findings. */
function expectLinear(label: string, rule: Rule, build: (n: number) => string, n: number): Finding[] {
  const small = build(n);
  const large = build(n * GROWTH);
  const os = parseTemplate(small);
  const ol = parseTemplate(large);
  rule(os, small); // warm-up: JIT tiers and first-touch allocation
  const a = best(rule, os, small);
  const b = best(rule, ol, large);
  const ratio = (b.ms + FLOOR_MS) / (a.ms + FLOOR_MS);
  console.log(`  ${label}: ${a.ms.toFixed(1)} ms -> ${b.ms.toFixed(1)} ms at ${GROWTH}x size (${small.length} -> ${large.length} units), ratio ${ratio.toFixed(1)}`);
  expect({ label, linear: ratio < MAX_RATIO }).toEqual({ label, linear: true });
  expect(b.r.length).toBeLessThanOrEqual(FINDING_CAP);
  return b.r;
}

const suppressed = (fs: Finding[]) => fs.at(-1)?.detail?.suppressed;

// Two lines of random base64 of one width, each under MIN_BLOB.
const LINE_A = "xK9fQ2mZ7bLw0PqT4vYc8NsJ1hGd5R";
const LINE_B = "Tb6Wn3XkE0aSu9MyHf2CzVr7LgQo1D";

test("invisible characters: one long run, and millions of short ones", () => {
  const zw = expectLinear("all U+200B", invisible, (n) => "\u200b".repeat(n), 1_000_000);
  expect(zw.map((f) => f.detail!.count)).toEqual([4_000_000]);
  const tagRun = expectLinear("all tag characters", invisible, (n) => "\u{E0041}".repeat(n), 500_000);
  expect(tagRun.length).toBe(1);
  expect((tagRun[0]!.detail!.hidden as string).length).toBeLessThanOrEqual(201);
  const many = expectLinear("U+200B x alternating", invisible, (n) => "\u200bx".repeat(n), 500_000);
  expect(suppressed(many)).toBe(2_000_000 - FINDING_CAP + 1);
}, TIMING_TIMEOUT_MS);

test("string escapes: dense runs, near-miss \\N{ and backslashes", () => {
  const str = (body: string) => `{{ '${body}' }}`;
  const esc = expectLinear("\\u200b x n in one string", invisible, (n) => str("\\u200b".repeat(n)), 200_000);
  expect(esc.map((f) => f.detail!.count)).toEqual([800_000]);
  expect(expectLinear("unclosed \\N{ x n", invisible, (n) => str("\\N{".repeat(n)), 300_000)).toEqual([]);
  expect(expectLinear("\\N{ with a long name x n", invisible, (n) => str(`\\N{${"A".repeat(90)}}`.repeat(n)), 10_000)).toEqual([]);
  expect(expectLinear("backslashes", invisible, (n) => str("\\".repeat(2 * n)), 500_000)).toEqual([]);
}, TIMING_TIMEOUT_MS);

test("URLs: dense domains, long dotted runs, www. paths and near-miss emails", () => {
  const dense = expectLinear("'a.com ' x n", urlsRaw, (n) => "a.com ".repeat(n), 200_000);
  expect(suppressed(dense)).toBe(4 * 200_000 - FINDING_CAP + 1);
  expect(expectLinear("a.a.a... no TLD", urlsRaw, (n) => "a.".repeat(n) + "a", 500_000)).toEqual([]);
  expect(expectLinear("a.a.a...com", urlsRaw, (n) => "a.".repeat(n) + "com", 500_000).length).toBe(1);
  expect(expectLinear("www.a.com/ x n", urlsRaw, (n) => "www.a.com/".repeat(n), 100_000).length).toBe(1);
  expect(expectLinear("a:// x n", urlsRaw, (n) => "a://".repeat(n), 250_000).length).toBe(1);
  expect(expectLinear("a@ x n", urlsRaw, (n) => "a@".repeat(n), 500_000)).toEqual([]);
  expect(expectLinear("x@a.a.a...1", urlsRaw, (n) => "x@" + "a.".repeat(n) + "1", 500_000)).toEqual([]);
  expect(expectLinear("a.a@ x n", urlsRaw, (n) => "a.a@".repeat(n), 250_000)).toEqual([]);
  expect(expectLinear("63-char labels", urlsRaw, (n) => `${"a".repeat(63)}.`.repeat(n) + "com", 16_000).length).toBe(1);
}, TIMING_TIMEOUT_MS);

test("URLs through the fold: fullwidth, astral, IDN and defanged runs, IPs and brackets", () => {
  const fw = (s: string) => [...s].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join(""); // ASCII to fullwidth
  expect(expectLinear("fullwidth a.a.a...com", urlsRaw, (n) => fw("a.").repeat(n) + fw("com"), 500_000).length).toBe(1);
  expect(expectLinear("math bold a.a.a...com", urlsRaw, (n) => String.fromCodePoint(0x1d41a, 0x2e).repeat(n) + "com", 300_000).length).toBe(1);
  const rf = String.fromCharCode(0x440, 0x444);
  expect(expectLinear("Cyrillic labels ending in an IDN TLD", urlsRaw, (n) => String.fromCharCode(0x43f, 0x2e).repeat(n) + rf, 500_000).length).toBe(1);
  expect(expectLinear("a[.]a[.]...com", urlsRaw, (n) => "a[.]".repeat(n) + "com", 300_000).length).toBe(1);
  expect(expectLinear("x@ Cyrillic labels...1", urlsRaw, (n) => "x@" + String.fromCharCode(0x43f, 0x2e).repeat(n) + "1", 500_000)).toEqual([]);
  expect(suppressed(expectLinear("'1.2.3.4 ' x n", urlsRaw, (n) => "1.2.3.4 ".repeat(n), 150_000))).toBe(4 * 150_000 - FINDING_CAP + 1);
  expect(expectLinear("1.1.1.1... no IP", urlsRaw, (n) => "1.".repeat(n) + "1", 500_000)).toEqual([]);
  expect(expectLinear("unclosed IPv6 brackets", urlsRaw, (n) => "[1111:2222:3333:4444:5555:6666:7777".repeat(n), 50_000)).toEqual([]);
  expect(expectLinear("brackets", urlsRaw, (n) => "[".repeat(n), 1_000_000)).toEqual([]);
  expect(expectLinear("trailing punctuation after a scheme", urlsRaw, (n) => "x://" + ".".repeat(n), 1_000_000).length).toBe(1);
}, TIMING_TIMEOUT_MS);

test("encoded blobs: one long run, hex, near-misses and many tiny strings", () => {
  expect(expectLinear("base64 run", blobs, (n) => "aB3c".repeat(n), 250_000).length).toBe(1);
  expect(expectLinear("hex run", blobs, (n) => "0a".repeat(n), 500_000).map((f) => f.detail!.encoding)).toEqual(["hex"]);
  expect(expectLinear("AAAA run", blobs, (n) => "A".repeat(n), 1_000_000)).toEqual([]);
  expect(expectLinear("snake_case run", blobs, (n) => "ab_".repeat(n), 300_000)).toEqual([]);
  const tiny = expectLinear("blob x n", blobs, (n) => "aB3caB3caB3caB3caB3caB3caB3caB3c ".repeat(n), 30_000);
  expect(suppressed(tiny)).toBe(120_000 - FINDING_CAP + 1);
}, TIMING_TIMEOUT_MS);

test("encoded blobs that hide their shape: split runs, decoded runs and base32", () => {
  // Each split run is decoded from a few of its tokens, then each token is judged alone.
  expect(expectLinear("blob-like tokens that never decode", blobs, (n) => "aB3 ".repeat(n), 250_000)).toEqual([]);
  expect(expectLinear("'A1 ' x n", blobs, (n) => "A1 ".repeat(n), 300_000)).toEqual([]);
  expect(expectLinear("blob-like token, then a word", blobs, (n) => "aB3 word ".repeat(n), 100_000)).toEqual([]);
  expect(expectLinear("wrapped base64 lines", blobs, (n) => "QWxhZGRpbjpvcGVuIHNlc2FtZSBJZ25v\n".repeat(n), 30_000).length).toBe(1);
  // Lines of equal width are each compared with the line before, then read as
  // one run, or token by token when they are a list.
  expect(expectLinear("random lines of equal width", blobs, (n) => `${LINE_A}\n${LINE_B}\n`.repeat(n), 15_000).length).toBe(1);
  expect(expectLinear("one line repeated, a list", blobs, (n) => `${LINE_A}\n`.repeat(n), 30_000)).toEqual([]);
  expect(expectLinear("lines of alternating width", blobs, (n) => "aB3cD4eF5g\naB3c\n".repeat(n), 60_000)).toEqual([]);
  expect(expectLinear("base64 of upper-case text", blobs, (n) => "U1lTVEVN".repeat(n), 120_000).map((f) => f.detail!.encoding)).toEqual(["base64"]);
  expect(expectLinear("base32 run", blobs, (n) => "JFDU4T2S".repeat(n), 120_000).map((f) => f.detail!.encoding)).toEqual(["base32"]);
  const split = expectLinear("split blob x n", blobs, (n) => "SWdub3JlIGFsbCBw cmV2aW91cyB0ZXh0 x ".repeat(n), 30_000);
  expect(suppressed(split)).toBe(120_000 - FINDING_CAP + 1);
}, TIMING_TIMEOUT_MS);

test("the literal walk is linear under the cap and over it", () => {
  // Under the cap the literals come from the pre-lexer; over it they stream.
  const tags = (n: number) => "{{ 'a.com' }}".repeat(n);
  expect(tags(10_000).length).toBeLessThan(512 * 1024);
  expect(suppressed(expectLinear("tiny strings, under the cap", urlsRaw, tags, 9_000))).toBe(4 * 9_000 - FINDING_CAP + 1);
  expect(suppressed(expectLinear("tiny strings, over the cap", urlsRaw, tags, 100_000))).toBe(4 * 100_000 - FINDING_CAP + 1);
  expect(expectLinear("unclosed tags", blobs, (n) => "{{ x ".repeat(n), 200_000)).toEqual([]);
  expect(expectLinear("comments", urlsRaw, (n) => "{# a.com #}".repeat(n), 100_000)).toEqual([]);
}, TIMING_TIMEOUT_MS);

// findUrls on items built outside the timed region, as expectLinear times a rule.
function expectLinearItems(label: string, build: (n: number) => { items: InjectedText[]; text?: string }, n: number): Finding[] {
  const small = build(n);
  const large = build(n * GROWTH);
  const run = (x: { items: InjectedText[]; text?: string }) => () => findUrls(x.items, base, x.text);
  run(small)(); // warm-up
  const a = bestOf(run(small));
  const b = bestOf(run(large));
  const ratio = (b.ms + FLOOR_MS) / (a.ms + FLOOR_MS);
  console.log(`  ${label}: ${a.ms.toFixed(1)} ms -> ${b.ms.toFixed(1)} ms at ${GROWTH}x size, ratio ${ratio.toFixed(1)}`);
  expect({ label, linear: ratio < MAX_RATIO }).toEqual({ label, linear: true });
  expect(b.r.length).toBeLessThanOrEqual(FINDING_CAP);
  return b.r;
}

// Best of three after a full GC, as best() does.
function bestOf(run: () => Finding[]): { r: Finding[]; ms: number } {
  let out: { r: Finding[]; ms: number } | undefined;
  for (let i = 0; i < 3; i++) {
    Bun.gc(true);
    const t0 = performance.now();
    const r = run();
    const ms = performance.now() - t0;
    if (!out || ms < out.ms) out = { r, ms };
  }
  return out!;
}

test("findUrls is linear in the number of items and bounded in findings", () => {
  const items = (n: number): InjectedText[] => Array.from({ length: n }, (_, k) => ({ text: "see a.com and b.com", span: { start: k, end: k + 1, line: 1, col: k + 1 }, afterGenerationPrompt: false }));
  expect(suppressed(expectLinearItems("findUrls items", (n) => ({ items: items(n) }), 100_000))).toBe(800_000 - FINDING_CAP + 1);
}, TIMING_TIMEOUT_MS);

test("findUrls places hits in the template text linearly, however its text nearly matches", () => {
  const extracted = (src: string) => ({ items: extract(parseTemplate(src), src, new Set(["<s>"])).items, text: src });
  // Every hit placed in one long item, lines and surrogate pairs counted once.
  const dense = expectLinearItems("one item of 'a.com\\n\\u{1F600} '", (n) => extracted(`{{ x }}${"a.com\n\u{1F600} ".repeat(n)}`), 12_000);
  expect(suppressed(dense)).toBe(48_000 - FINDING_CAP + 1);
  expect(dense[1]!.span).toEqual({ start: 16, end: 21, line: 2, col: 3 });
  // The item's text is `!!!…!a.com!!!…!`, after scaffolding and twice as many
  // '!': it matches up to its host at every offset before its own, which takes
  // indexOf quadratic time (3.5 s at the larger size).
  const near = expectLinearItems("near-miss before the item's text", (n) => extracted(`<s>${"!".repeat(2 * n)}<s>${"!".repeat(n)}a.com${"!".repeat(n)}`), 30_000);
  expect(near.map((f) => f.span!.start)).toEqual([3 * 30_000 * GROWTH + 6]);
}, TIMING_TIMEOUT_MS);
