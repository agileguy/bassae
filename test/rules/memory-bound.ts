// Round-2 memory-bound review — a standalone, runnable check kept OUT of the
// default `bun test` suite because it allocates a 64 MiB template and forks a
// subprocess to measure peak RSS. Run it explicitly:
//
//   bun test/rules/memory-bound.ts
//
// The bug this guards against: parse.ts ran the pre-lexer and LineMap over the
// whole text BEFORE the size check, so a 16 MiB input peaked at ~1.46 GB RSS and
// a 64 MiB input at ~5.7 GB. The fix: over the per-file size cap (64 MiB is the
// hf/sources.ts read limit, far above the in-process parse budget) parse.ts
// builds no full token array and no full LineMap; the raw-text fallback streams.
//
// A 64 MiB benign template with a single `{{ x.__class__ }}` near the end must
// still yield HIGH unanalyzable plus the dunder finding. Two memory figures are
// reported: the analyzer's MARGINAL cost over holding the template (the property
// under review — it must be small), and the whole process's peak RSS, which is
// dominated by the template plumbing (makeTemplate keeps the 64 MiB bytes and a
// 128 MiB UTF-16 `text`, and validates with a transient second decode), and is
// here only to confirm we are nowhere near the multi-GB pre-fix regime.

import { analyzeCodeExec } from "../../src/rules/index.ts";
import { makeTemplate } from "../../src/template.ts";

const MARGINAL_LIMIT_MB = 160; // the analyzer must add little over the held template
const TOTAL_LIMIT_MB = 700; // a hard ceiling, far below the 1.46 GB / 5.7 GB bug
const SIZE = 64 * 1024 * 1024; // 64 MiB, the per-file read limit (hf/sources.ts)

const enc = new TextEncoder();

// Build the 64 MiB template as ONE byte buffer (the production path: a reader
// hands makeTemplate the file bytes). No giant intermediate JS strings.
function buildBytes(): Uint8Array {
  const unit = enc.encode("{{ messages[0]['content'] }}\n");
  const dunder = enc.encode("{{ x.__class__ }}");
  const bytes = new Uint8Array(SIZE);
  let o = 0;
  while (o + unit.length <= SIZE - dunder.length) {
    bytes.set(unit, o);
    o += unit.length;
  }
  // Pad any gap with spaces (0x20), then place the dunder tag at the very end.
  bytes.fill(0x20, o, SIZE - dunder.length);
  bytes.set(dunder, SIZE - dunder.length);
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

if (process.env.MEM_BOUND_CHILD === "1") {
  const bytes = buildBytes();
  const t = makeTemplate({ kind: "bare", path: "/t", realPath: "/t", name: "default" }, bytes);
  Bun.gc(true); // drop construction/validation garbage so the baseline is honest
  const baseline = rssMb();
  const r = analyzeCodeExec({ template: t, scaffolding: new Set(), knownGood: false });
  const afterAnalyze = rssMb();
  const result = {
    len: t.text.length,
    complete: r.complete,
    unanalyzable: r.findings.some((f) => f.ruleId === "unanalyzable" && f.severity === "HIGH"),
    dunder: r.findings.some((f) => f.ruleId === "dunder_access"),
    marginalMb: Math.round(afterAnalyze - baseline),
    peakRssMb: Math.round(peakRssMb()),
  };
  console.log(JSON.stringify(result));
  process.exit(0);
}

// Parent: fork a clean subprocess so the measurement is isolated.
const proc = Bun.spawnSync([process.execPath, import.meta.path], {
  env: { ...process.env, MEM_BOUND_CHILD: "1" },
  stdout: "pipe",
  stderr: "inherit",
});

const out = proc.stdout.toString().trim();
const line = out.split("\n").filter(Boolean).at(-1) ?? "";
let r: { len: number; complete: boolean; unanalyzable: boolean; dunder: boolean; marginalMb: number; peakRssMb: number };
try {
  r = JSON.parse(line);
} catch {
  console.error("FAIL: could not parse child output:\n" + out);
  process.exit(1);
}

const checks: [string, boolean][] = [
  [`64 MiB template analyzed (len=${r.len})`, r.len === SIZE],
  ["incomplete (complete=false)", r.complete === false],
  ["HIGH unanalyzable present", r.unanalyzable],
  ["dunder_access present (dunder near end found)", r.dunder],
  [`analyzer marginal RSS ${r.marginalMb} MB < ${MARGINAL_LIMIT_MB} MB`, r.marginalMb < MARGINAL_LIMIT_MB],
  [`process peak RSS ${r.peakRssMb} MB < ${TOTAL_LIMIT_MB} MB (pre-fix was ~5.7 GB)`, r.peakRssMb < TOTAL_LIMIT_MB],
];

let ok = true;
for (const [label, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
  if (!pass) ok = false;
}
console.log(ok ? "\nmemory-bound review: PASS" : "\nmemory-bound review: FAIL");
process.exit(ok ? 0 : 1);
