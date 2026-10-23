// checkIntraModel on hostile same-name templates: a standalone, runnable check kept OUT
// of the default `bun test` suite, like test/rules/memory-bound.ts, because each shape
// builds tens of MiB of templates in a forked subprocess to measure peak RSS. Run it
// explicitly:
//
//   bun test/registry/intra-memory-bound.ts
//
// The bug this guards against (review round 1, C5): every compared pair kept a full
// unifiedDiff, so a 37.7 MB GGUF holding nine tokenizer.chat_template values of 2Mi
// single-letter lines each reached 3-4 GB RSS and took 9 s. Now a pair is diffed only
// under MAX_PAIR_DIFF_INPUT, diffing stops when the model's DIFF_BUDGET is spent, and a
// stored diff is clipped to MAX_STORED_DIFF.

import { heapSize } from "bun:jsc";
import { bytesSource, readGgufSource } from "../../src/gguf/index.ts";
import { checkIntraModel, loadPrecedence, MAX_DIVERGENCE_PAIRS, MAX_PAIR_DIFF_INPUT, MAX_STORED_DIFF } from "../../src/registry/index.ts";
import { makeTemplateFromString } from "../../src/template.ts";
import type { ModelRecord } from "../../src/types.ts";
import { buildGguf, str } from "../gguf/builder.ts";

const PEAK_LIMIT_MB = 512;
const RETAINED_LIMIT_MB = 16;
const TIME_LIMIT_MS = 5000;
const MiB = 1024 * 1024;

// Nine values of `units` UTF-16 units each, one shared key, so 36 pairs differ.
const SHAPES: Record<string, () => ModelRecord> = {
  // The review's case, read through the GGUF reader: every line differs between every pair.
  "nine 4 MiB single-letter GGUF values": () => {
    const n = 4 * MiB - 2;
    const kvs = Array.from({ length: 9 }, (_, k) => ["tokenizer.chat_template", str(`${String.fromCharCode(97 + k)}\n`.repeat(n / 2))] as [string, ReturnType<typeof str>]);
    return readGgufSource(bytesSource(buildGguf(kvs).bytes), "/m/x.gguf");
  },
  // Each pair just fits MAX_PAIR_DIFF_INPUT, so the per-model budget decides how many are diffed.
  "nine values at the per-pair diff limit": () => record((k) => `${String.fromCharCode(97 + k)}\n`.repeat(MAX_PAIR_DIFF_INPUT / 4)),
  // Equal but for the last line, so finding each pair's first differing line scans 4 MiB.
  "nine 4 MiB values differing in the last line": () => record((k) => `${"x\n".repeat(2 * MiB - 2)}${k}\n`),
};

function record(text: (k: number) => string): ModelRecord {
  const src = { kind: "gguf" as const, path: "/m/x.gguf", realPath: "/m/x.gguf", name: "default", key: "tokenizer.chat_template" };
  return { format: "gguf", id: "/m/x.gguf", paths: ["/m/x.gguf"], templates: Array.from({ length: 9 }, (_, k) => makeTemplateFromString(src, text(k))), hints: {}, specialTokens: [], extractionComplete: true, findings: [] };
}

function peakRssMb(): number {
  // process.resourceUsage().maxRSS is bytes on Darwin, kilobytes on Linux.
  const maxRss = process.resourceUsage().maxRSS;
  return (process.platform === "darwin" ? maxRss : maxRss * 1024) / MiB;
}

interface ChildResult {
  shape: string;
  findings: number;
  longestDiff: number;
  ms: number;
  retainedMb: number;
  peakRssMb: number;
}

const childShape = process.env.INTRA_MEM_CHILD;
if (childShape) {
  const model = SHAPES[childShape]!();
  const table = loadPrecedence();
  Bun.gc(true); // drop construction garbage so the baseline is honest
  const baseline = heapSize();
  const t0 = performance.now();
  const findings = checkIntraModel(model, table);
  const ms = Math.round(performance.now() - t0);
  Bun.gc(true); // what the findings keep, not garbage the diffs left behind; RSS does not shrink after a GC, the JS heap does
  const retainedMb = Math.round((heapSize() - baseline) / MiB);
  const longestDiff = Math.max(0, ...findings.map((f) => String(f.detail?.diff ?? "").length));
  const result: ChildResult = { shape: childShape, findings: findings.length, longestDiff, ms, retainedMb, peakRssMb: Math.round(peakRssMb()) };
  console.log(JSON.stringify(result));
  process.exit(0);
}

// Parent: one clean subprocess per shape, so each measurement is isolated.
let ok = true;
for (const shape of Object.keys(SHAPES)) {
  const proc = Bun.spawnSync([process.execPath, import.meta.path], { env: { ...process.env, INTRA_MEM_CHILD: shape }, stdout: "pipe", stderr: "inherit" });
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
    [`findings ${r.findings} = ${MAX_DIVERGENCE_PAIRS} pairs + 1 summary`, r.findings === MAX_DIVERGENCE_PAIRS + 1],
    [`longest stored diff ${r.longestDiff} units < ${MAX_STORED_DIFF} + its marker`, r.longestDiff < MAX_STORED_DIFF + 100],
    [`checkIntraModel ${r.ms} ms < ${TIME_LIMIT_MS} ms`, r.ms < TIME_LIMIT_MS],
    [`JS heap retained after GC ${r.retainedMb} MB < ${RETAINED_LIMIT_MB} MB`, r.retainedMb < RETAINED_LIMIT_MB],
    [`peak RSS ${r.peakRssMb} MB < ${PEAK_LIMIT_MB} MB`, r.peakRssMb < PEAK_LIMIT_MB],
  ];
  console.log(`${shape}:`);
  for (const [label, pass] of checks) {
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}`);
    if (!pass) ok = false;
  }
}
console.log(ok ? "\nintra-model divergence memory bound: PASS" : "\nintra-model divergence memory bound: FAIL");
process.exit(ok ? 0 : 1);
