// Line diff for every comparison bassae reports: two sources in one model
// (ISC-7.5), a GGUF against a local HF source (ISC-23), and a template against
// its trusted baseline (ISC-25). Bounded whatever the input: common leading and
// trailing lines are stripped first, Myers' algorithm runs on the middle up to
// MAX_EDITS edits, and past that the middle is reported as one replaced block.

/** UTF-16 offsets into a text; `end` is exclusive. */
export interface LineRange {
  start: number;
  end: number;
}

/** One run of replaced lines. An empty side is a pure insertion or deletion. */
export interface DiffBlock {
  /** 0-based line indices, end exclusive. */
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
  /** The same lines as offsets, each line's break included. Empty at the point of a pure insertion or deletion. */
  aRange: LineRange;
  bRange: LineRange;
}

export interface LineDiff {
  equal: boolean;
  blocks: DiffBlock[];
  /** True when the texts needed more than MAX_EDITS edits, or were too large to split, so the middle is one block. */
  coarse: boolean;
}

// Real templates are tens of KB; these leave wide headroom and keep a hostile
// pair at a few tens of MB and well under a second.
const MAX_DIFF_UNITS = 4 * 1024 * 1024;
const MAX_EDITS = 1000;
// Snake comparisons are O((N+M)D) in the worst case; past this many the middle is one block too.
const MAX_COMPARISONS = 20_000_000;

interface Lines {
  /** Offset of each line start, plus one entry for the end of the text. */
  starts: Int32Array;
  ids: Int32Array;
}

// A line runs to and including its "\n", so a missing final newline is a difference.
function splitLines(text: string, intern: Map<string, number>): Lines {
  const offsets: number[] = [];
  for (let i = 0; i < text.length; ) {
    offsets.push(i);
    const nl = text.indexOf("\n", i);
    i = nl < 0 ? text.length : nl + 1;
  }
  offsets.push(text.length);
  const ids = new Int32Array(offsets.length - 1);
  for (let i = 0; i < ids.length; i++) {
    const line = text.slice(offsets[i], offsets[i + 1]);
    let id = intern.get(line);
    if (id === undefined) intern.set(line, (id = intern.size));
    ids[i] = id;
  }
  return { starts: Int32Array.from(offsets), ids };
}

function countLines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; ) {
    n++;
    const nl = text.indexOf("\n", i);
    i = nl < 0 ? text.length : nl + 1;
  }
  return n;
}

type Op = 0 | 1 | 2; // equal, delete from a, insert from b

// Myers' O((N+M)D) diff on two id arrays. Each step's frontier is saved only over
// its live diagonals [-d, d], so the trace costs O(D^2), not O((N+M)D). Returns
// undefined when more than MAX_EDITS edits are needed.
function myers(a: Int32Array, b: Int32Array): Op[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let budget = MAX_COMPARISONS;
  for (let d = 0; d <= Math.min(max, MAX_EDITS); d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      const snakeFrom = x;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      budget -= x - snakeFrom + 1;
      if (budget < 0) return undefined;
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, d, n, m);
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  return undefined;
}

function backtrack(trace: Int32Array[], dFound: number, n: number, m: number): Op[] {
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = dFound; d > 0; d--) {
    const prev = trace[d - 1]!; // frontier after step d-1, indexed k + (d-1)
    const at = (k: number) => prev[k + d - 1]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const pk = down ? k + 1 : k - 1;
    const px = at(pk);
    const py = px - pk;
    const sx = down ? px : px + 1; // where the snake into (x, y) began
    while (x > sx) {
      ops.push(0);
      x--;
      y--;
    }
    ops.push(down ? 2 : 1);
    x = px;
    y = py;
  }
  while (x > 0) {
    ops.push(0);
    x--;
  }
  return ops.reverse();
}

function block(aStart: number, aEnd: number, bStart: number, bEnd: number, la: Lines, lb: Lines): DiffBlock {
  return {
    aStart,
    aEnd,
    bStart,
    bEnd,
    aRange: { start: la.starts[aStart]!, end: la.starts[aEnd]! },
    bRange: { start: lb.starts[bStart]!, end: lb.starts[bEnd]! },
  };
}

/** Line diff of `a` (the baseline) against `b`. Never throws. */
export function diffLines(a: string, b: string): LineDiff {
  if (a === b) return { equal: true, blocks: [], coarse: false };
  if (a.length > MAX_DIFF_UNITS || b.length > MAX_DIFF_UNITS) {
    const aLines = countLines(a);
    const bLines = countLines(b);
    const whole: DiffBlock = { aStart: 0, aEnd: aLines, bStart: 0, bEnd: bLines, aRange: { start: 0, end: a.length }, bRange: { start: 0, end: b.length } };
    return { equal: false, blocks: [whole], coarse: true };
  }

  const intern = new Map<string, number>();
  const la = splitLines(a, intern);
  const lb = splitLines(b, intern);
  const n = la.ids.length;
  const m = lb.ids.length;
  let pre = 0;
  while (pre < n && pre < m && la.ids[pre] === lb.ids[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && la.ids[n - 1 - suf] === lb.ids[m - 1 - suf]) suf++;

  const ops = myers(la.ids.subarray(pre, n - suf), lb.ids.subarray(pre, m - suf));
  if (!ops) return { equal: false, blocks: [block(pre, n - suf, pre, m - suf, la, lb)], coarse: true };

  const blocks: DiffBlock[] = [];
  let x = pre;
  let y = pre;
  for (let i = 0; i < ops.length; ) {
    if (ops[i] === 0) {
      x++;
      y++;
      i++;
      continue;
    }
    const x0 = x;
    const y0 = y;
    for (; i < ops.length && ops[i] !== 0; i++) {
      if (ops[i] === 1) x++;
      else y++;
    }
    blocks.push(block(x0, x, y0, y, la, lb));
  }
  return { equal: false, blocks, coarse: false };
}

/** A unified diff of `a` against `b` with `context` lines around each change, or "" when they are equal. Line text is raw: printing code must escape it (ISC-44). */
export function unifiedDiff(a: string, b: string, aLabel: string, bLabel: string, context = 3): string {
  const diff = diffLines(a, b);
  if (diff.equal) return "";
  const out = [`--- ${aLabel}`, `+++ ${bLabel}`];
  if (a.length > MAX_DIFF_UNITS || b.length > MAX_DIFF_UNITS) {
    out.push(`@@ too large to diff: ${a.length} and ${b.length} UTF-16 units @@`);
    return `${out.join("\n")}\n`;
  }
  const intern = new Map<string, number>();
  const la = splitLines(a, intern);
  const lb = splitLines(b, intern);
  const lineOf = (text: string, l: Lines, i: number) => text.slice(l.starts[i], l.starts[i + 1]);
  const emit = (prefix: string, line: string) => {
    if (line.endsWith("\n")) out.push(prefix + line.slice(0, -1));
    else out.push(prefix + line, "\\ No newline at end of file");
  };

  const blocks = diff.blocks;
  for (let i = 0; i < blocks.length; ) {
    // Blocks closer than 2 * context equal lines share one hunk.
    let j = i;
    while (j + 1 < blocks.length && blocks[j + 1]!.aStart - blocks[j]!.aEnd <= 2 * context) j++;
    const first = blocks[i]!;
    const last = blocks[j]!;
    const aFrom = Math.max(0, first.aStart - context);
    const bFrom = first.bStart - (first.aStart - aFrom);
    const aTo = Math.min(la.ids.length, last.aEnd + context);
    const bTo = last.bEnd + (aTo - last.aEnd);
    const header = (from: number, to: number) => `${to - from === 0 ? from : from + 1},${to - from}`;
    out.push(`@@ -${header(aFrom, aTo)} +${header(bFrom, bTo)} @@`);
    let ax = aFrom;
    for (let k = i; k <= j; k++) {
      const blk = blocks[k]!;
      for (; ax < blk.aStart; ax++) emit(" ", lineOf(a, la, ax));
      for (let r = blk.aStart; r < blk.aEnd; r++) emit("-", lineOf(a, la, r));
      for (let r = blk.bStart; r < blk.bEnd; r++) emit("+", lineOf(b, lb, r));
      ax = blk.aEnd;
    }
    for (; ax < aTo; ax++) emit(" ", lineOf(a, la, ax));
    i = j + 1;
  }
  return `${out.join("\n")}\n`;
}
