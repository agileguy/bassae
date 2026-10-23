// Runs the code-execution and injection rules over every distinct chat template
// on this machine and prints HIGH and MEDIUM counts per template. Read-only: it
// never writes under the scanned trees.
//
//   bun scripts/corpus-scan.ts [--dump <dir>] [--verbose] [--differential] [root ...]
//
// Roots default to ~/.cache/huggingface/hub and ~/.omlx. Models are found and
// read by the real readers (discover, readHfModel, readGgufModel), so every
// template is scanned with scaffolding built from its own model's special
// tokens. A template shared by several models is scanned once per model and
// reported with the worst injection result.

import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tokenize } from "@huggingface/jinja";
import { discover } from "../src/discover.ts";
import { readGgufModel } from "../src/gguf/index.ts";
import { readHfModel } from "../src/hf/index.ts";
import { preLex } from "../src/parse/prelexer.ts";
import { analyzeCodeExec } from "../src/rules/index.ts";
import { analyzeInjection, buildScaffolding } from "../src/rules/injection.ts";
import type { ExtractedTemplate, ModelRecord, RuleResult } from "../src/types.ts";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const differential = args.includes("--differential");
const dumpAt = args.indexOf("--dump");
const dumpDir = dumpAt >= 0 ? args[dumpAt + 1] : undefined;
const roots = args.filter((a, i) => !a.startsWith("--") && !(dumpAt >= 0 && i === dumpAt + 1));
if (roots.length === 0) roots.push(join(homedir(), ".cache/huggingface/hub"), join(homedir(), ".omlx"));

// --differential: confirm the pre-lexer segments text exactly where the library
// does, across every corpus template (ISC-12 pre-lexer sync). Trimmed per run,
// empties dropped, generation-tag templates skipped (preprocess merges them).
function libraryText(src: string): string[] | null {
  try {
    return (tokenize(src) as { type: string; value: string }[])
      .filter((t) => t.type === "Text").map((t) => t.value.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

const discovery = await discover(roots);
const models: ModelRecord[] = [];
for (const m of discovery.models) {
  const at = m.paths[0] ?? m.id;
  try {
    models.push(m.format === "gguf" ? await readGgufModel(at) : await readHfModel(at));
  } catch (e) {
    console.log(`unreadable ${at.replace(homedir(), "~")}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Every distinct template, with each model that carries it.
const bySha = new Map<string, { template: ExtractedTemplate; models: ModelRecord[] }>();
let sources = 0;
for (const model of models) {
  for (const t of model.templates) {
    sources++;
    const entry = bySha.get(t.sha256) ?? { template: t, models: [] };
    if (!entry.models.includes(model)) entry.models.push(model);
    bySha.set(t.sha256, entry);
  }
}

if (differential) {
  let checked = 0;
  let mismatches = 0;
  const GENERATION_TAG = /\{%-?\s*(?:end)?generation\s*-?%\}/;
  for (const [sha, { template }] of bySha) {
    const src = template.text;
    if (GENERATION_TAG.test(src)) continue;
    const lib = libraryText(src);
    if (lib === null) continue;
    checked++;
    const mine = preLex(src).textSegments.map((s) => s.value.trim()).filter(Boolean);
    if (JSON.stringify(mine) !== JSON.stringify(lib)) {
      mismatches++;
      console.log(`MISMATCH ${sha.slice(0, 12)} ${template.source.path.replace(homedir(), "~")}`);
    }
  }
  console.log(`differential: ${checked} templates checked, ${mismatches} mismatches`);
  process.exit(mismatches === 0 ? 0 : 1);
}

function counts(r: RuleResult): { high: number; medium: number } {
  return { high: r.findings.filter((f) => f.severity === "HIGH").length, medium: r.findings.filter((f) => f.severity === "MEDIUM").length };
}

const totals = { ceHigh: 0, ceMed: 0, ceIncomplete: 0, injHigh: 0, injMed: 0, injIncomplete: 0 };
console.log(`${models.length} models, ${sources} template sources, ${bySha.size} distinct templates\n`);
console.log("code-exec       injection");
console.log("HIGH  MED done  HIGH  MED done  sha256        name        first path");
for (const [sha, { template: t, models: carriers }] of [...bySha].sort((a, b) => a[1].template.source.path.localeCompare(b[1].template.source.path))) {
  const ce = analyzeCodeExec({ template: t, scaffolding: new Set(), knownGood: false });
  // The worst injection result across the models that carry this template, each
  // with scaffolding from its own special tokens.
  let inj: RuleResult | undefined;
  for (const model of carriers) {
    const r = analyzeInjection({ template: t, scaffolding: buildScaffolding(model), knownGood: false });
    if (!inj || counts(r).high > counts(inj).high || (counts(r).high === counts(inj).high && !r.complete)) inj = r;
  }
  inj ??= { findings: [], complete: true };
  const c1 = counts(ce);
  const c2 = counts(inj);
  totals.ceHigh += c1.high;
  totals.ceMed += c1.medium;
  totals.injHigh += c2.high;
  totals.injMed += c2.medium;
  if (!ce.complete) totals.ceIncomplete++;
  if (!inj.complete) totals.injIncomplete++;
  const where = t.source.path.replace(homedir(), "~");
  const n = (x: number) => String(x).padStart(4);
  console.log(
    `${n(c1.high)} ${n(c1.medium)} ${ce.complete ? "yes " : "NO  "} ${n(c2.high)} ${n(c2.medium)} ${inj.complete ? "yes " : "NO  "} ${sha.slice(0, 12)}  ${t.source.name.padEnd(10)}  ${where}${carriers.length > 1 ? ` (+${carriers.length - 1} more models)` : ""}`,
  );
  // With no declared special tokens the scaffolding is only role names and
  // delimiters, so every control token the template writes reads as text.
  for (const model of carriers) {
    if (model.specialTokens.length === 0) console.log(`        note: no special tokens declared by ${model.id.replace(homedir(), "~")} (tokenizer files missing?)`);
  }
  if (verbose) {
    for (const f of [...ce.findings, ...inj.findings]) {
      const at = f.span ? `${f.span.line}:${f.span.col}` : "-";
      console.log(`        ${f.severity} ${f.ruleId} ${at} ${f.message} ${JSON.stringify(f.excerpt ?? "")}`);
    }
  }
  if (dumpDir) writeFileSync(join(dumpDir, `${sha.slice(0, 12)}.jinja`), t.bytes);
}
for (const f of discovery.findings) console.log(`walk: ${f.severity} ${f.ruleId} ${f.message}`);
console.log(
  `\ncode-exec: ${totals.ceHigh} HIGH, ${totals.ceMed} MEDIUM, ${totals.ceIncomplete} incomplete` +
    `\ninjection: ${totals.injHigh} HIGH, ${totals.injMed} MEDIUM, ${totals.injIncomplete} incomplete` +
    `\nacross ${bySha.size} distinct templates`,
);
