// Prints what bassae finds on every fixture, one line per template, so two machines can be diffed (ISC-31).
//
//   bun scripts/platform-parity.ts > mac.txt      # then the same on the other machine, and diff
//
// Scans every corpus entry the way the recall test does (a .jinja with --template, anything else as a path),
// plus the clean fixtures. Each line holds the path relative to the repo, the template name, its SHA-256, its
// status and every (rule, severity) with its count. Model-level findings get a line of their own.

import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { Finding, ScanReport } from "../src/types.ts";

const ROOT = join(import.meta.dir, "..");
const CORPORA = ["fixtures/malicious", "fixtures/heldout"];

const targets: string[] = [];
for (const corpus of CORPORA) {
  const dir = join(ROOT, corpus);
  let classes: string[];
  try {
    classes = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    continue;
  }
  for (const c of classes.sort()) {
    const file = Bun.file(join(dir, c, "expected.json"));
    if (!(await file.exists())) continue;
    for (const e of ((await file.json()) as { fixtures: { path: string }[] }).fixtures) targets.push(join(dir, e.path));
  }
}
const clean = join(ROOT, "fixtures/clean");
for (const f of readdirSync(clean).filter((f) => f.endsWith(".jinja")).sort()) targets.push(join(clean, f));

const args = targets.flatMap((t) => (t.endsWith(".jinja") ? ["--template", t] : [t]));
const proc = Bun.spawn(["bun", join(ROOT, "src/cli.ts"), "--json", ...args], { cwd: ROOT, stdout: "pipe", stderr: "inherit" });
const out = await new Response(proc.stdout).text();
const code = await proc.exited;
if (code !== 0 && code !== 1 && code !== 2) {
  console.error(`bassae exited ${code}`);
  process.exit(3);
}
const report = JSON.parse(out) as ScanReport;

const rel = (p: string) => relative(ROOT, p);
const tally = (fs: Finding[]) => {
  const n = new Map<string, number>();
  for (const f of fs) n.set(`${f.ruleId}:${f.severity}`, (n.get(`${f.ruleId}:${f.severity}`) ?? 0) + 1);
  return [...n].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}x${v}`).join(" ");
};

const lines: string[] = [];
for (const m of report.models) {
  const at = rel(m.id);
  if (m.findings.length > 0) lines.push(`${at}\t(model)\t-\t${m.status}\t${tally(m.findings)}`);
  for (const t of m.templates) lines.push(`${at}\t${t.name}\t${t.sha256}\t${t.status}\t${tally(t.findings)}`);
}
console.log(lines.sort().join("\n"));
