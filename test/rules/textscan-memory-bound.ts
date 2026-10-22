// The text rules on 64 MiB hostile templates: a standalone, runnable check kept
// OUT of the default `bun test` suite, like memory-bound.ts, because each shape
// allocates a 64 MiB template in a forked subprocess to measure peak RSS. Run it
// explicitly:
//
//   bun test/rules/textscan-memory-bound.ts
//
// 64 MiB is the per-file read limit (hf/sources.ts), far over the parse cap, so
// every rule runs its streaming form: no pre-lexer, no line map. Each shape is
// one the rules could blow up on: a single invisible run of tens of millions of
// characters, tens of millions of hits, one 64 MiB dotted or blob run. Every
// shape runs the three raw forms (findUrlsRaw, findEncodedBlobs,
// findInvisibleChars) and must return at most FINDING_CAP findings per rule.
//
// Two memory figures, as in memory-bound.ts: the rules' MARGINAL cost over
// holding the template (the property under review), and the process's peak RSS,
// which the template plumbing dominates (64 MiB of bytes, the UTF-16 text, and a
// transient validation decode).

import { parseTemplate } from "../../src/parse/parse.ts";
import { FINDING_CAP } from "../../src/rules/finalize.ts";
import { findEncodedBlobs, findInvisibleChars, findUrlsRaw } from "../../src/rules/textscan.ts";
import { makeTemplate } from "../../src/template.ts";

const MARGINAL_LIMIT_MB = 160;
const TOTAL_LIMIT_MB = 700;
const SIZE = 64 * 1024 * 1024;

const enc = new TextEncoder();

// Each shape is a unit repeated to fill SIZE bytes, with an optional tail.
const SHAPES: Record<string, { unit: string; tail?: string }> = {
  "all U+200B": { unit: "\u200b" },
  "all 'a.com '": { unit: "a.com " },
  "U+200B x alternating": { unit: "\u200bx" },
  "all tag characters": { unit: "\u{E0041}" },
  "one dotted run ending .info": { unit: "a.", tail: "info" },
  "one base64 run": { unit: "aB3c" },
  "one string of \\u200b escapes": { unit: "\\u200b", tail: "' }}" },
  "one string of \\N{ZWSP} escapes": { unit: "\\N{ZWSP}", tail: "' }}" },
};

// The template as ONE byte buffer, as a reader hands makeTemplate the file bytes.
function buildBytes(unit: string, tail = "", head = ""): Uint8Array {
  const u = enc.encode(unit);
  const h = enc.encode(head);
  const t = enc.encode(tail);
  const bytes = new Uint8Array(SIZE);
  bytes.set(h, 0);
  let o = h.length;
  while (o + u.length <= SIZE - t.length) {
    bytes.set(u, o);
    o += u.length;
  }
  bytes.fill(0x20, o, SIZE - t.length);
  bytes.set(t, SIZE - t.length);
  return bytes;
}

function rssMb(): number {
  return process.memoryUsage().rss / (1024 * 1024);
}
function peakRssMb(): number {
  // process.resourceUsage().maxRSS is bytes on Darwin, kilobytes on Linux.
  const maxRss = process.resourceUsage().maxRSS;
  const bytes = process.platform === "darwin" ? maxRss : maxRss * 1024;
  return bytes / (1024 * 1024);
}

interface ChildResult {
  shape: string;
  len: number;
  counts: number[];
  ms: number[];
  marginalMb: number;
  peakRssMb: number;
}

const childShape = process.env.TEXTSCAN_MEM_CHILD;
if (childShape) {
  const { unit, tail } = SHAPES[childShape]!;
  const head = childShape.includes("escapes") ? "{{ '" : "";
  const t = makeTemplate({ kind: "bare", path: "/t", realPath: "/t", name: "default" }, buildBytes(unit, tail, head));
  const base = { file: "/t", templateName: "default", templateSha256: t.sha256 };
  Bun.gc(true); // drop construction and validation garbage so the baseline is honest
  const baseline = rssMb();
  const o = parseTemplate(t.text);
  const counts: number[] = [];
  const ms: number[] = [];
  for (const rule of [() => findUrlsRaw(o, t.text, base), () => findEncodedBlobs(o, t.text, base), () => findInvisibleChars(t.text, base, o)]) {
    const t0 = performance.now();
    counts.push(rule().length);
    ms.push(Math.round(performance.now() - t0));
  }
  const result: ChildResult = { shape: childShape, len: t.text.length, counts, ms, marginalMb: Math.round(rssMb() - baseline), peakRssMb: Math.round(peakRssMb()) };
  console.log(JSON.stringify(result));
  process.exit(0);
}

// Parent: one clean subprocess per shape, so each measurement is isolated.
let ok = true;
for (const shape of Object.keys(SHAPES)) {
  const proc = Bun.spawnSync([process.execPath, import.meta.path], { env: { ...process.env, TEXTSCAN_MEM_CHILD: shape }, stdout: "pipe", stderr: "inherit" });
  const line = proc.stdout.toString().trim().split("\n").filter(Boolean).at(-1) ?? "";
  let r: ChildResult;
  try {
    r = JSON.parse(line);
  } catch {
    console.error(`FAIL  ${shape}: could not parse child output:\n${proc.stdout.toString()}`);
    ok = false;
    continue;
  }
  const checks: [string, boolean][] = [
    [`findings per rule [urls, blobs, invisible] = [${r.counts.join(", ")}] <= ${FINDING_CAP}`, r.counts.every((n) => n <= FINDING_CAP)],
    [`marginal RSS ${r.marginalMb} MB < ${MARGINAL_LIMIT_MB} MB`, r.marginalMb < MARGINAL_LIMIT_MB],
    [`peak RSS ${r.peakRssMb} MB < ${TOTAL_LIMIT_MB} MB`, r.peakRssMb < TOTAL_LIMIT_MB],
  ];
  console.log(`${shape}: ${r.len} units, [urls, blobs, invisible] in [${r.ms.join(", ")}] ms`);
  for (const [label, pass] of checks) {
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}`);
    if (!pass) ok = false;
  }
}
console.log(ok ? "\ntext-scan memory bound: PASS" : "\ntext-scan memory bound: FAIL");
process.exit(ok ? 0 : 1);
