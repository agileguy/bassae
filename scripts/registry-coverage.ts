// Matches every template on this machine against the checked-in registry and prints
// exact / whitespace / none per distinct template, plus each model's runtime
// precedence and intra-model divergence. Offline and read-only.
//
//   bun scripts/registry-coverage.ts [--verbose] [root ...]
//
// Roots default to ~/.cache/huggingface/hub and ~/.omlx.

import { homedir } from "node:os";
import { join } from "node:path";
import { discover } from "../src/discover.ts";
import { readGgufModel } from "../src/gguf/index.ts";
import { readHfModel } from "../src/hf/index.ts";
import { checkIntraModel, loadPrecedence, loadRegistry, resolveProfiles } from "../src/registry/index.ts";
import type { ExtractedTemplate, ModelRecord, RegistryMatch } from "../src/types.ts";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const roots = args.filter((a) => !a.startsWith("--"));
if (roots.length === 0) roots.push(join(homedir(), ".cache/huggingface/hub"), join(homedir(), ".omlx"));

const registry = loadRegistry();
const table = loadPrecedence();
const home = (p: string) => p.replaceAll(homedir(), "~");

const { models } = await discover(roots);
const records: ModelRecord[] = [];
for (const m of models) records.push(m.format === "gguf" ? await readGgufModel(m.paths[0]!) : await readHfModel(m.paths[0]!));

const bySha = new Map<string, { t: ExtractedTemplate; match: RegistryMatch; where: string[] }>();
for (const r of records) {
  for (const t of r.templates) {
    const at = `${home(t.source.path)}${t.source.key ? ` ${t.source.key}` : ""}`;
    const seen = bySha.get(t.sha256);
    if (seen) seen.where.push(at);
    else bySha.set(t.sha256, { t, match: registry.match(t), where: [at] });
  }
}

const counts = { exact: 0, whitespace: 0, none: 0 };
console.log(`${records.length} models, ${[...bySha.values()].reduce((n, s) => n + s.where.length, 0)} template sources, ${bySha.size} distinct templates, ${registry.entries.length} registry entries\n`);
for (const [sha, { match, where }] of [...bySha].sort((a, b) => a[1].where[0]!.localeCompare(b[1].where[0]!))) {
  counts[match.kind]++;
  const pin = match.kind === "none" ? "" : `${match.known.entry.repo}@${match.known.entry.revision.slice(0, 12)}:${match.known.entry.path}`;
  console.log(`${match.kind.padEnd(10)} ${sha.slice(0, 12)}  ${where[0]}${where.length > 1 ? ` (+${where.length - 1})` : ""}${pin ? `\n           = ${pin}` : ""}`);
  if (verbose) for (const w of where.slice(1)) console.log(`           also ${w}`);
}
console.log(`\nexact ${counts.exact}, whitespace ${counts.whitespace}, none ${counts.none}`);

if (verbose) {
  console.log("\nruntime precedence and intra-model divergence:");
  for (const r of records) {
    if (r.templates.length === 0) continue;
    const resolved = resolveProfiles(r, table);
    const divergences = checkIntraModel(r, table);
    console.log(`\n${home(r.paths[0]!)}`);
    for (const [p, s] of Object.entries(resolved)) console.log(`  ${p.padEnd(24)} ${s ? `${s.kind} ${s.name}` : "-"}`);
    for (const t of r.templates.filter((x) => x.shadowed)) console.log(`  shadowed: ${t.source.kind} ${t.source.name}`);
    for (const f of divergences) console.log(`  ${f.severity} ${f.ruleId}: ${home(f.message)}`);
  }
}
