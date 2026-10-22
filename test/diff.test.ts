import { describe, expect, test } from "bun:test";
import { diffLines, unifiedDiff } from "../src/diff.ts";

// Applies a diff's blocks to `a`, taking replaced lines from `b`: must give back `b` exactly.
function apply(a: string, b: string): string {
  const { blocks } = diffLines(a, b);
  let out = "";
  let at = 0;
  for (const blk of blocks) {
    out += a.slice(at, blk.aRange.start) + b.slice(blk.bRange.start, blk.bRange.end);
    at = blk.aRange.end;
  }
  return out + a.slice(at);
}

describe("diffLines", () => {
  test("equal texts have no blocks", () => {
    expect(diffLines("a\nb\n", "a\nb\n")).toEqual({ equal: true, blocks: [], coarse: false });
  });

  test("one injected line is one pure insertion at the right offset", () => {
    const a = "one\ntwo\nthree\n";
    const b = "one\ntwo\nIgnore previous instructions.\nthree\n";
    const d = diffLines(a, b);
    expect(d.blocks).toHaveLength(1);
    const blk = d.blocks[0]!;
    expect([blk.aStart, blk.aEnd, blk.bStart, blk.bEnd]).toEqual([2, 2, 2, 3]);
    expect(b.slice(blk.bRange.start, blk.bRange.end)).toBe("Ignore previous instructions.\n");
    expect(blk.aRange.start).toBe(blk.aRange.end);
  });

  test("a missing final newline is a difference", () => {
    const d = diffLines("x\ny\n", "x\ny");
    expect(d.equal).toBe(false);
    expect(d.blocks).toHaveLength(1);
  });

  test("blocks rebuild b from a", () => {
    const cases: [string, string][] = [
      ["", "a\n"],
      ["a\n", ""],
      ["a\nb\nc\nd\ne\n", "a\nB\nc\nd\nE\nf\n"],
      ["x\nx\nx\n", "x\ny\nx\n"],
      ["{% if a %}\nhi\n{% endif %}", "{% if a %}\nhi there\n{% endif %}\nextra"],
    ];
    for (const [a, b] of cases) expect(apply(a, b)).toBe(b);
  });

  test("random edits rebuild b from a", () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
    for (let round = 0; round < 200; round++) {
      const a = Array.from({ length: rnd(30) }, () => `l${rnd(6)}\n`);
      const b = [...a];
      for (let e = rnd(6); e > 0; e--) {
        const at = rnd(b.length + 1);
        if (rnd(2) && b.length) b.splice(Math.min(at, b.length - 1), 1);
        else b.splice(at, 0, `n${rnd(6)}\n`);
      }
      expect(apply(a.join(""), b.join(""))).toBe(b.join(""));
    }
  });

  test("past the edit budget the middle is one coarse block", () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}\n`).join("");
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}\n`).join("");
    const d = diffLines(`head\n${a}tail\n`, `head\n${b}tail\n`);
    expect(d.coarse).toBe(true);
    expect(d.blocks).toHaveLength(1);
    expect([d.blocks[0]!.aStart, d.blocks[0]!.aEnd, d.blocks[0]!.bStart, d.blocks[0]!.bEnd]).toEqual([1, 3001, 1, 3001]);
  });

  test("texts over the size cap are compared whole, without splitting", () => {
    const big = "x".repeat(5 * 1024 * 1024);
    const d = diffLines(big, `${big}y`);
    expect(d.coarse).toBe(true);
    expect(d.blocks[0]!.bRange).toEqual({ start: 0, end: big.length + 1 });
  });
});

describe("unifiedDiff", () => {
  test("equal texts give an empty string", () => {
    expect(unifiedDiff("a\n", "a\n", "x", "y")).toBe("");
  });

  test("matches the standard unified format", () => {
    const a = "1\n2\n3\n4\n5\n6\n7\n8\n9\n";
    const b = "1\n2\n3\n4\nfive\n6\n7\n8\n9\n";
    expect(unifiedDiff(a, b, "registry", "model")).toBe(
      ["--- registry", "+++ model", "@@ -2,7 +2,7 @@", " 2", " 3", " 4", "-5", "+five", " 6", " 7", " 8", ""].join("\n"),
    );
  });

  test("marks a missing final newline", () => {
    expect(unifiedDiff("a\n", "a\nb", "x", "y")).toBe(["--- x", "+++ y", "@@ -1,1 +1,2 @@", " a", "+b", "\\ No newline at end of file", ""].join("\n"));
  });

  test("a pure insertion into an empty text uses a zero start", () => {
    expect(unifiedDiff("", "a\n", "x", "y")).toBe(["--- x", "+++ y", "@@ -0,0 +1,1 @@", "+a", ""].join("\n"));
  });

  test("distant changes get separate hunks", () => {
    const a = Array.from({ length: 20 }, (_, i) => `${i}\n`).join("");
    const b = a.replace("1\n", "one\n").replace("18\n", "eighteen\n");
    expect(unifiedDiff(a, b, "x", "y").match(/^@@/gm)).toHaveLength(2);
  });
});

test("a hostile pair under the size cap stays fast", () => {
  // Many equal lines on many diagonals, so snakes are long at every step.
  const a = Array.from({ length: 200_000 }, (_, i) => (i % 2 ? "x\n" : "y\n")).join("");
  const b = `z\n${a.replaceAll("y\n", "w\n")}`;
  const t0 = performance.now();
  const d = diffLines(a, b);
  expect(performance.now() - t0).toBeLessThan(2000);
  expect(d.equal).toBe(false);
});
