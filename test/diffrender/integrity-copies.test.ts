// The copy scan (Decisions 02:58) finds the same copies it found when it sliced the output at every position. The
// slicing scan is kept here, and only here, as the reference: firstCopies must return what it returns for every
// output, content and span, from the hand-picked edge cases and from generated ones.

import { describe, expect, test } from "bun:test";
import { type Copy, firstCopies } from "../../src/diffrender/integrity.ts";

interface Site {
  start: number;
  end: number;
  inputs: number[];
}

/** The copy scan before the rolling hash, as it stood in copies(): a slice and a map lookup at every position. */
function reference(output: string, texts: readonly string[], held: readonly string[], spans: readonly Site[], skip: ReadonlySet<number>): Copy[] {
  const W = 16;
  const distinctive = (text: string) => text.length >= 16 && /\S\s+\S/.test(text);
  // Each distinctive window of a checked content, with the content and where in it the window starts.
  const owner = new Map<string, [number, number]>();
  for (const i of spans.flatMap((s) => s.inputs)) {
    const text = texts[i]!;
    if (skip.has(i) || !distinctive(text)) continue;
    for (let k = 0; k + W <= text.length; k++) {
      const w = text.slice(k, k + W);
      if (!owner.has(w) && distinctive(w)) owner.set(w, [i, k]);
    }
  }
  if (owner.size === 0) return [];
  // A window two of the probe's inputs hold is theirs to repeat.
  const holders = new Map<string, number>();
  for (const s of new Set([...held, ...texts])) {
    const seen = new Set<string>();
    for (let k = 0; k + W <= s.length; k++) {
      const w = s.slice(k, k + W);
      if (owner.has(w) && !seen.has(w)) {
        seen.add(w);
        holders.set(w, (holders.get(w) ?? 0) + 1);
      }
    }
  }
  for (const [w, n] of holders) if (n > 1) owner.delete(w);

  const found: Copy[] = [];
  const reported = new Set<number>();
  let s = 0; // the first span that ends after p
  for (let p = 0; p + W <= output.length; p++) {
    while (s < spans.length && spans[s]!.end <= p) s++;
    if (s < spans.length && spans[s]!.start <= p) {
      p = spans[s]!.end - 1;
      continue;
    }
    const hit = owner.get(output.slice(p, p + W));
    if (!hit || reported.has(hit[0])) continue;
    const [i, k] = hit;
    const text = texts[i]!;
    let before = 0;
    while (before < k && output[p - before - 1] === text[k - before - 1]) before++;
    let after = W;
    while (k + after < text.length && output[p + after] === text[k + after]) after++;
    reported.add(i);
    found.push({ i, at: p - before, length: before + after, prior: s });
    p += after - 1;
  }
  return found;
}

/** An output built from parts: text, a content placed (a span) or text that is not one. */
type Part = string | { place: number[] };

/** The output, and a span for each placed part, in output order. */
function build(texts: readonly string[], parts: readonly Part[]): { output: string; spans: Site[] } {
  let output = "";
  const spans: Site[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      output += part;
      continue;
    }
    const start = output.length;
    output += part.place.map((i) => texts[i]!).join("");
    spans.push({ start, end: output.length, inputs: part.place });
  }
  return { output, spans };
}

/** Both scans over one case, and what they found. */
function both(texts: readonly string[], parts: readonly Part[], held: readonly string[] = [], skip: ReadonlySet<number> = new Set()) {
  const { output, spans } = build(texts, parts);
  const want = reference(output, texts, held, spans, skip);
  expect([output, firstCopies(output, texts, held, spans, skip)]).toEqual([output, want]);
  return want;
}

const PORTO = "Porto tides rise twice a day, near nine and again at night.";

describe("firstCopies against the slicing scan: edge cases", () => {
  test("a copy at offset 0 and a copy that ends the output", () => {
    expect(both([PORTO], [PORTO.slice(0, 16), "\n", { place: [0] }])).toEqual([{ i: 0, at: 0, length: 16, prior: 0 }]);
    expect(both([PORTO], [{ place: [0] }, "\n", PORTO.slice(-16)])).toEqual([{ i: 0, at: PORTO.length + 1, length: 16, prior: 1 }]);
    // The output is the copy and nothing else.
    expect(both([PORTO], [PORTO.slice(5, 21)])).toEqual([]);
    expect(both([PORTO, "unplaced but copied text, long"], [{ place: [0] }, PORTO.slice(5, 21)])).toEqual([{ i: 0, at: PORTO.length, length: 16, prior: 1 }]);
  });

  test("exactly 16 characters is a copy, and 15 is not", () => {
    for (let k = 0; k + 16 <= PORTO.length; k += 7) {
      expect(both([PORTO], [{ place: [0] }, "|", PORTO.slice(k, k + 16), "|"])).toEqual([{ i: 0, at: PORTO.length + 1, length: 16, prior: 1 }]);
      expect(both([PORTO], [{ place: [0] }, "|", PORTO.slice(k, k + 15), "|"])).toEqual([]);
    }
  });

  test("overlapping and repeated windows", () => {
    const la = "la la la la la la la la la la la la";
    // Every window of `la` is one of three strings, each owned at its first offset. The run stops where the second
    // slice breaks the pattern, and the content is not reported again there.
    expect(both([la], [{ place: [0] }, "\n", la.slice(3, 30), la.slice(1, 20)])).toEqual([{ i: 0, at: la.length + 1, length: 27, prior: 1 }]);
    // Two copies that overlap in the output: the second content's window starts inside the first one's run.
    const a = "one two three four five";
    const b = "five six seven eight nine";
    expect(both([a, b], [{ place: [0] }, { place: [1] }, "\n", "one two three four five six seven eight nine"])).toEqual([
      { i: 0, at: a.length + b.length + 1, length: a.length, prior: 2 },
      { i: 1, at: a.length + b.length + 1 + 19, length: b.length, prior: 2 },
    ]);
    // A copy repeated many times is reported once.
    expect(both([PORTO, la], [{ place: [0] }, { place: [1] }, PORTO.repeat(50)])).toEqual([{ i: 0, at: PORTO.length + la.length, length: PORTO.length, prior: 2 }]);
  });

  test("characters outside Latin-1 and astral characters, split or whole", () => {
    const rook = "Ладья идёт к причалу в девять, 🌊 волна 🌊 растёт.";
    expect(both([rook], [{ place: [0] }, " ", rook.slice(3, 19)])).toEqual([{ i: 0, at: rook.length + 1, length: 16, prior: 1 }]);
    // A slice that starts or ends inside a surrogate pair is still 16 code units of the content.
    const wave = rook.indexOf("🌊");
    for (const k of [wave - 15, wave - 14, wave + 1, wave + 2]) {
      expect(both([rook], [{ place: [0] }, "\u{1F30A}", rook.slice(k, k + 16), "\u{1F30A}"]).map((c) => c.i)).toEqual([0]);
    }
    expect(both([rook], [{ place: [0] }, rook.slice(wave - 15, wave + 1)])).toEqual([{ i: 0, at: rook.length, length: 16, prior: 1 }]);
  });

  test("content shorter than 16 characters, or without a space between words, is never checked", () => {
    expect(both(["short tide note"], [{ place: [0] }, "short tide note"])).toEqual([]);
    expect(both(["PortoTidesRiseTwiceADay"], [{ place: [0] }, "PortoTidesRiseTwiceADay"])).toEqual([]);
  });

  test("a window that starts before a span and runs into it is read like any other", () => {
    const ledger = "Ledger entry 0000 ok.\nLedger entry 0001 ok.\n";
    expect(both([ledger], ["<|im_start|>user\n", { place: [0] }])).toEqual([{ i: 0, at: 16, length: 17, prior: 0 }]);
  });

  test("a window two inputs hold, a skipped content and an unplaced content are not copies", () => {
    expect(both([PORTO], [{ place: [0] }, PORTO], [`Note: ${PORTO.slice(10, 40)}`])).toEqual([{ i: 0, at: PORTO.length, length: PORTO.length, prior: 1 }]);
    expect(both([PORTO], [{ place: [0] }, PORTO.slice(10, 40)], [`Note: ${PORTO.slice(10, 40)}`])).toEqual([]);
    expect(both([PORTO], [{ place: [0] }, PORTO], [], new Set([0]))).toEqual([]);
    expect(both([PORTO, `${PORTO} Again.`], [{ place: [0] }, PORTO])).toEqual([]);
  });

  test("a span of several contents, and an empty span", () => {
    const tide = "High tide at nine, low tide at three.";
    expect(both([PORTO, tide], [{ place: [0, 1] }, "\n", tide, PORTO])).toEqual([
      { i: 1, at: PORTO.length + tide.length + 1, length: tide.length, prior: 1 },
      { i: 0, at: PORTO.length + 2 * tide.length + 1, length: PORTO.length, prior: 1 },
    ]);
    expect(both([PORTO, ""], [{ place: [0] }, "ab", { place: [1] }, PORTO])).toEqual([{ i: 0, at: PORTO.length + 2, length: PORTO.length, prior: 2 }]);
  });
});

/** A small seeded generator (mulberry32), so a failing case can be found again. */
function generator(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
  return { next, int, pick };
}

// Alphabets the generated text is drawn from: few letters, so windows repeat; words; and characters outside Latin-1,
// astral characters and a lone surrogate.
const ALPHABETS: readonly (readonly string[])[] = [
  ["a", "b", " ", " ", "\n"],
  ["tide ", "harbor ", "log ", "the ", "x", "\n", "  "],
  ["a", "é", "ж", "日", "🌊", " ", "\uD83D", "b"],
];

describe("firstCopies against the slicing scan: generated cases", () => {
  test("2,000 generated outputs, contents and spans give the same copies", () => {
    let withCopies = 0;
    let atStart = 0;
    let atEnd = 0;
    for (let seed = 1; seed <= 2000; seed++) {
      const g = generator(seed);
      const alphabet = g.pick(ALPHABETS);
      const text = (n: number) => {
        let t = "";
        while (t.length < n) t += g.pick(alphabet);
        return t;
      };
      const texts = Array.from({ length: 1 + g.int(4) }, () => text(g.pick([0, 8, 15, 16, 17, 24, 40, 70])));
      // A slice of a content, of a length that sits on either side of 16, or the whole of it.
      const slice = () => {
        const t = g.pick(texts);
        const n = Math.min(t.length, g.pick([15, 16, 17, 20, 33, t.length]));
        const k = g.int(t.length - n + 1);
        return t.slice(k, k + n);
      };
      const parts: Part[] = [];
      const placed = new Set<number>();
      const count = 1 + g.int(8);
      for (let j = 0; j < count; j++) {
        const r = g.next();
        if (r < 0.3) {
          const i = g.int(texts.length);
          const place = g.next() < 0.2 && i + 1 < texts.length ? [i, i + 1] : [i];
          if (place.some((x) => placed.has(x))) continue;
          for (const x of place) placed.add(x);
          parts.push({ place });
        } else if (r < 0.7) parts.push(slice());
        else parts.push(text(g.int(20)));
      }
      const held = Array.from({ length: g.int(3) }, () => (g.next() < 0.5 ? slice() : text(g.int(30))));
      const skip = new Set(texts.flatMap((_, i) => (g.next() < 0.15 ? [i] : [])));
      const found = both(texts, parts, held, skip);
      const { output } = build(texts, parts);
      if (found.length > 0) withCopies++;
      if (found.some((c) => c.at === 0)) atStart++;
      if (found.some((c) => c.at + c.length === output.length)) atEnd++;
    }
    // The generated cases reach copies, including copies at either end of the output.
    expect(withCopies).toBeGreaterThan(300);
    expect(atStart).toBeGreaterThan(20);
    expect(atEnd).toBeGreaterThan(20);
  });
});
