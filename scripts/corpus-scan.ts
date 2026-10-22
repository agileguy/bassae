// Runs the code-execution rules over every distinct chat template on this
// machine and prints HIGH and MEDIUM counts per template. Read-only: it never
// writes under the scanned trees.
//
//   bun scripts/corpus-scan.ts [--dump <dir>] [--verbose] [root ...]
//
// Roots default to ~/.cache/huggingface/hub and ~/.omlx. It has its own small
// walker so it doesn't depend on the HF reader being built in parallel.

import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { tokenize } from "@huggingface/jinja";
import { analyzeCodeExec } from "../src/rules/index.ts";
import { preLex } from "../src/parse/prelexer.ts";
import { makeTemplate, makeTemplateFromString } from "../src/template.ts";
import type { ExtractedTemplate, SourceKind } from "../src/types.ts";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const differential = args.includes("--differential");
const dumpAt = args.indexOf("--dump");
const dumpDir = dumpAt >= 0 ? args[dumpAt + 1] : undefined;
const roots = args.filter((a, i) => !a.startsWith("--") && !(dumpAt >= 0 && i === dumpAt + 1));

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
if (roots.length === 0) roots.push(join(homedir(), ".cache/huggingface/hub"), join(homedir(), ".omlx"));

const found: ExtractedTemplate[] = [];
const seenDirs = new Set<string>();

function walk(dir: string): void {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return;
  }
  if (seenDirs.has(real)) return;
  seenDirs.add(real);
  for (const name of readdirSync(dir)) {
    if (name === ".no_exist") continue;
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(path);
    else if (st.isFile()) readSources(path, dir);
  }
}

function add(kind: SourceKind, path: string, name: string, key: string | undefined, value: unknown): void {
  const source = { kind, path, realPath: realpathSync(path), name, key };
  if (typeof value === "string") found.push(makeTemplateFromString(source, value));
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function readSources(path: string, dir: string): void {
  const name = basename(path);
  if (name === "chat_template.jinja" || (basename(dir) === "additional_chat_templates" && name.endsWith(".jinja"))) {
    const kind = name === "chat_template.jinja" ? "chat_template_jinja" : "additional_chat_templates";
    const bytes = new Uint8Array(readFileSync(path));
    if (bytes.length > 0) {
      const source = { kind, path, realPath: realpathSync(path), name: kind === "chat_template_jinja" ? "default" : name.slice(0, -6) } as const;
      found.push(makeTemplate(source, bytes));
    }
    return;
  }
  if (name !== "tokenizer_config.json" && name !== "processor_config.json" && name !== "chat_template.json") return;
  const kind: SourceKind =
    name === "tokenizer_config.json" ? "tokenizer_config" : name === "processor_config.json" ? "processor_config" : "chat_template_json";
  const json = readJson(path) as { chat_template?: unknown } | undefined;
  const ct = json?.chat_template;
  if (typeof ct === "string") add(kind, path, "default", "chat_template", ct);
  else if (Array.isArray(ct)) {
    ct.forEach((entry, i) => {
      const e = entry as { name?: unknown; template?: unknown };
      add(kind, path, typeof e.name === "string" ? e.name : `#${i}`, `chat_template[${i}].template`, e.template);
    });
  }
}

for (const root of roots) walk(root);

const bySha = new Map<string, ExtractedTemplate[]>();
for (const t of found) {
  const list = bySha.get(t.sha256) ?? [];
  list.push(t);
  bySha.set(t.sha256, list);
}

if (differential) {
  let checked = 0;
  let mismatches = 0;
  const GENERATION_TAG = /\{%-?\s*(?:end)?generation\s*-?%\}/;
  for (const [sha, list] of bySha) {
    const src = list[0]!.text;
    if (GENERATION_TAG.test(src)) continue;
    const lib = libraryText(src);
    if (lib === null) continue;
    checked++;
    const mine = preLex(src).textSegments.map((s) => s.value.trim()).filter(Boolean);
    if (JSON.stringify(mine) !== JSON.stringify(lib)) {
      mismatches++;
      console.log(`MISMATCH ${sha.slice(0, 12)} ${list[0]!.source.path.replace(homedir(), "~")}`);
    }
  }
  console.log(`differential: ${checked} templates checked, ${mismatches} mismatches`);
  process.exit(mismatches === 0 ? 0 : 1);
}

let totalHigh = 0;
let totalMedium = 0;
let incomplete = 0;
console.log(`${found.length} template sources, ${bySha.size} distinct templates\n`);
console.log("HIGH  MED  done  sha256        name        first path");
for (const [sha, list] of [...bySha].sort((a, b) => a[1][0]!.source.path.localeCompare(b[1][0]!.source.path))) {
  const t = list[0]!;
  const result = analyzeCodeExec({ template: t, scaffolding: new Set(), knownGood: false });
  const high = result.findings.filter((f) => f.severity === "HIGH");
  const medium = result.findings.filter((f) => f.severity === "MEDIUM");
  totalHigh += high.length;
  totalMedium += medium.length;
  if (!result.complete) incomplete++;
  const where = t.source.path.replace(homedir(), "~");
  console.log(
    `${String(high.length).padStart(4)} ${String(medium.length).padStart(4)}  ${result.complete ? "yes " : "NO  "}  ${sha.slice(0, 12)}  ${t.source.name.padEnd(10)}  ${where}${list.length > 1 ? ` (+${list.length - 1} more)` : ""}`,
  );
  if (verbose) {
    for (const other of list.slice(1)) console.log(`        also ${other.source.path.replace(homedir(), "~")}`);
    for (const f of result.findings) {
      const at = f.span ? `${f.span.line}:${f.span.col}` : "-";
      console.log(`        ${f.severity} ${f.ruleId} ${at} ${f.message} ${JSON.stringify(f.excerpt ?? "")}`);
    }
  }
  if (dumpDir) writeFileSync(join(dumpDir, `${sha.slice(0, 12)}.jinja`), t.bytes);
}
console.log(`\ntotal: ${totalHigh} HIGH, ${totalMedium} MEDIUM, ${incomplete} incomplete, across ${bySha.size} distinct templates`);
