// The explain side of render_divergence reads each output once, building its units as printed and date-masked in one
// pass (runtime review round 2). These tests hold it to the path it replaced: the same units, so the same verdicts.

import { describe, expect, test } from "bun:test";
import { addExplained, DATE_MASK, unexplained, units } from "../../src/diffrender/residue.ts";

// ---- the path it replaced, as it stood at 0dbaba9 ----

const OLD_GAP = "\u0000";
const OLD_DATE_NAMES = new Set(
  [
    "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  ].flatMap((name) => [name, name.slice(0, 3)]),
);
const oldIsDateWord = (word: string) => OLD_DATE_NAMES.has(word.toLowerCase());
const OLD_ROLE_MARKER = /(?:<\|?|>|\|)(?:system|developer|user|human|assistant|model|tool|tool_response|observation|ipython|start_function_response)(?![A-Za-z0-9_])/g;

function oldRuns(text: string, dateProbe = false): string[][] {
  const out: string[][] = [];
  for (const run of text.replace(OLD_ROLE_MARKER, (m) => OLD_GAP + m + OLD_GAP).split(OLD_GAP)) {
    const ws = run.match(/\p{L}+/gu);
    if (ws) out.push(dateProbe ? ws.map((w) => (oldIsDateWord(w) ? DATE_MASK : w)) : ws);
  }
  return out;
}

function oldUnits(text: string, dateProbe = false): Set<string> {
  const out = new Set<string>();
  for (const run of oldRuns(text, dateProbe)) {
    for (let i = 0; i < run.length; i++) {
      out.add(run[i]!);
      if (i > 0) out.add(`${run[i - 1]} ${run[i]}`);
    }
  }
  return out;
}

function oldUnexplained(text: string, explained: ReadonlySet<string>, dateProbe: boolean): string[] {
  const out: string[] = [];
  for (const u of oldUnits(text, dateProbe)) {
    if (explained.has(u)) continue;
    const pair = u.split(" ");
    if (pair.length === 2 && !(explained.has(pair[0]!) && explained.has(pair[1]!))) continue;
    out.push(u);
  }
  return out;
}

/** The old explain loop for one probe: every profile's output, each plain and date-masked, with no output skipped. */
function oldExplain(into: Set<string>, outputs: readonly string[]): void {
  for (const text of outputs) for (const dateProbe of [false, true]) for (const u of oldUnits(text, dateProbe)) into.add(u);
}

/** The new one: an output the other profile printed too is read once. */
function newExplain(into: Set<string>, outputs: readonly string[]): void {
  const seen = new Set<string>();
  for (const text of outputs) {
    if (seen.has(text)) continue;
    seen.add(text);
    addExplained(into, text);
  }
}

// ---- varied template text ----

const WORDS = ["Always", "check", "the", "reply", "Never", "print", "hidden", "note", "Today", "Date", "Answer", "Größe", "年", "x", "ab", "user", "assistant", "date"];
// Month and weekday names in each case and length, and words that only look like them.
const DATES = ["May", "may", "MAY", "Sun", "sunday", "SUNDAY", "Nov", "November", "Wed", "Thursday", "jan", "Dec", "SePtEmBeR", "Sept", "Thurs", "Janu", "Mayday", "Mon"];
const MARKUP = ["<|im_start|>", "<|im_end|>", "<|user|>", "<|assistant|>", "</tool_response><|assistant|>", "<b>", "</b>", ">assistant", "|system", "<tool>", "<|tool_response"];
const BETWEEN = [" ", " ", " ", ", ", ". ", "\n", ": ", "", "\u0000", " 2036 ", " 30 ", "#"];

/** A small seeded generator, so a failure names an output that can be built again. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function textFrom(next: () => number, length: number): string {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!;
  let out = "";
  for (let i = 0; i < length; i++) {
    const r = next();
    out += (r < 0.55 ? pick(WORDS) : r < 0.85 ? pick(DATES) : pick(MARKUP)) + pick(BETWEEN);
  }
  return out;
}

const EDGES = [
  "",
  "\u0000",
  "May",
  "May June",
  "<|user|>May",
  "Today Date: 30 Nov 2036, Sunday",
  "Today Date: 15 Jul 2026, Wednesday",
  "Sunday\u0000Monday",
  "Date #date",
  "Monday May Monday",
  "May may MAY",
  "Answer the Today. Mon",
  "the conversation is on <|assistant|>Sure",
];

const next = random(22);
const OUTPUTS = [...EDGES, ...Array.from({ length: 300 }, (_, i) => textFrom(next, i % 60)), textFrom(next, 40_000)];

const sorted = (s: ReadonlySet<string>) => [...s].sort();

describe("units, as printed and date-masked in one pass", () => {
  test("addExplained adds exactly what units(text, false) and units(text, true) hold together", () => {
    for (const text of OUTPUTS) {
      const old = new Set<string>();
      oldExplain(old, [text]);
      const now = new Set<string>();
      addExplained(now, text);
      expect(sorted(now)).toEqual(sorted(old));
    }
  });

  test("units() itself, both ways, lists the same units in the same order as before", () => {
    for (const text of OUTPUTS) for (const dateProbe of [false, true]) expect([...units(text, dateProbe)]).toEqual([...oldUnits(text, dateProbe)]);
  });

  test("the varied text holds what the mask is for: date words in runs with other words, and in pairs", () => {
    const all = new Set<string>();
    for (const text of OUTPUTS) addExplained(all, text);
    expect(all.has(DATE_MASK)).toBe(true);
    expect([...all].some((u) => u.startsWith(`${DATE_MASK} `))).toBe(true);
    expect([...all].some((u) => u.endsWith(` ${DATE_MASK}`))).toBe(true);
    expect(all.has(`${DATE_MASK} ${DATE_MASK}`)).toBe(true);
  });
});

describe("render_divergence verdicts", () => {
  // Each case: explain probes with an output per profile, the same under both or not, and vary outputs from the
  // same vocabulary, so some of their words and pairs are explained and some are not.
  const cases = Array.from({ length: 60 }, (_, c) => {
    const draw = random(1000 + c);
    const explain = Array.from({ length: 1 + (c % 4) }, () => {
      const a = textFrom(draw, 5 + Math.floor(draw() * 40));
      return draw() < 0.6 ? [a, a] : [a, textFrom(draw, 5 + Math.floor(draw() * 40))];
    });
    const vary = Array.from({ length: 6 }, () => textFrom(draw, 3 + Math.floor(draw() * 30)));
    return { explain, vary };
  });

  test("are the same for every vary output, at the reference date and on date probes", () => {
    let listed = 0;
    let clean = 0;
    let pairs = 0;
    for (const { explain, vary } of cases) {
      const old = new Set<string>();
      const now = new Set<string>();
      for (const outputs of explain) {
        oldExplain(old, outputs);
        newExplain(now, outputs);
      }
      expect(sorted(now)).toEqual(sorted(old));
      for (const text of vary) {
        for (const dateProbe of [false, true]) {
          const verdict = unexplained(text, now, dateProbe);
          expect(verdict).toEqual(oldUnexplained(text, old, dateProbe));
          if (verdict.length === 0) clean++;
          else listed++;
          pairs += verdict.filter((u) => u.includes(" ")).length;
        }
      }
    }
    // Both verdicts occur, and pairs are among what is listed, so the comparison is not vacuous.
    expect(listed).toBeGreaterThan(0);
    expect(clean).toBeGreaterThan(0);
    expect(pairs).toBeGreaterThan(0);
  });
});
