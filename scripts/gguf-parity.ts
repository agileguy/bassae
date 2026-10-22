// Compares bassae's GGUF template extraction with @huggingface/gguf, file by file (ISC-3).
// Usage: bun scripts/gguf-parity.ts <file.gguf>...   Exit 1 if any file disagrees.
//
// The oracle hands back decoded strings, so it can't carry invalid UTF-8 or a leading BOM.
// Where bassae's bytes differ only in those ways the row says ORACLE-LOSSY, not MISMATCH.
import { gguf } from "@huggingface/gguf";
import { openFileSource, readGgufModel, readGgufSource } from "../src/gguf/index.ts";
import { isTemplateKey, viewKey } from "../src/gguf/templates.ts";

const encoder = new TextEncoder();
const stripBom = (s: string) => (s.startsWith("\uFEFF") ? s.slice(1) : s);
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("usage: bun scripts/gguf-parity.ts <file.gguf>...");
  process.exit(2);
}

let bad = 0;
for (const path of paths) {
  let started = performance.now();
  const ours = await readGgufModel(path);
  const oursMs = performance.now() - started;

  let oracle: Record<string, unknown>;
  let kvEnd: number;
  started = performance.now();
  try {
    const parsed = await gguf(path, { allowLocalFile: true });
    oracle = parsed.metadata as Record<string, unknown>;
    kvEnd = parsed.tensorInfoByteRange[0];
  } catch (e) {
    bad++;
    console.log(`ORACLE-ERROR  ${path}\n  ${(e as Error).message}`);
    continue;
  }
  const oracleMs = performance.now() - started;

  const lines: string[] = [];
  let fileOk = true;
  // The oracle has no llama.cpp views of values that hold a NUL, so those get their own rows.
  const viewKeys = new Set(ours.templates.flatMap((t) => (t.bytes.includes(0) ? [viewKey(t.source.key!, t.bytes.indexOf(0))] : [])));
  const keys = new Set([
    ...ours.templates.map((t) => t.source.key!).filter((k) => !viewKeys.has(k)),
    ...Object.keys(oracle).filter(isTemplateKey),
  ]);
  for (const key of keys) {
    const mine = ours.templates.filter((t) => t.source.key === key);
    const theirs = oracle[key];
    let verdict: string;
    if (mine.length !== 1 || typeof theirs !== "string") {
      verdict = `MISSING (bassae ${mine.length}, oracle ${typeof theirs})`;
    } else if (equal(mine[0]!.bytes, encoder.encode(theirs))) {
      verdict = "MATCH";
    } else if (stripBom(mine[0]!.text) === theirs) {
      verdict = "ORACLE-LOSSY";
    } else {
      verdict = "MISMATCH";
    }
    if (verdict !== "MATCH" && verdict !== "ORACLE-LOSSY") fileOk = false;
    const t = mine[0];
    lines.push(`  ${verdict.padEnd(12)} ${key}  ${t ? `${t.bytes.length} bytes  sha256 ${t.sha256.slice(0, 16)}  utf8 ${t.validUtf8 ? "valid" : "INVALID"}` : ""}`);
  }
  if (keys.size === 0) lines.push("  (no chat template keys in either reader)");
  for (const t of ours.templates.filter((t) => viewKeys.has(t.source.key!))) {
    lines.push(`  ${"VIEW".padEnd(12)} ${t.source.key}  ${t.bytes.length} bytes  sha256 ${t.sha256.slice(0, 16)}  what llama.cpp renders`);
  }
  if (!ours.extractionComplete) fileOk = false;
  lines.push(`  ${(ours.extractionComplete ? "MATCH" : "INCOMPLETE").padEnd(12)} extraction complete  ${ours.extractionComplete}`);

  const tokens = oracle["tokenizer.ggml.tokens"] as string[] | undefined;
  const types = oracle["tokenizer.ggml.token_type"] as number[] | undefined;
  const special = [...new Set(tokens?.filter((_, i) => types?.[i] === 3 || types?.[i] === 4) ?? [])];
  const specialOk = special.length === ours.specialTokens.length && special.every((s, i) => s === ours.specialTokens[i]);
  if (!specialOk) fileOk = false;
  lines.push(`  ${(specialOk ? "MATCH" : "MISMATCH").padEnd(12)} special tokens  ${ours.specialTokens.length} bassae, ${special.length} oracle`);
  // ISC-38: the oracle's tensor-info offset is an independent end of the KV section.
  const file = openFileSource(path);
  let maxEnd = 0;
  try {
    readGgufSource({ size: file.size, read: (o, n) => ((maxEnd = Math.max(maxEnd, o + n)), file.read(o, n)) }, path);
  } finally {
    file.close();
  }
  const headerOnly = maxEnd > 0 && maxEnd <= kvEnd;
  if (!headerOnly) fileOk = false;
  lines.push(`  ${(headerOnly ? "MATCH" : "MISMATCH").padEnd(12)} header only  last byte read ${maxEnd}, KV section ends ${kvEnd}, file ${file.size}`);
  for (const f of ours.findings) lines.push(`  finding      ${f.severity} ${f.ruleId}: ${JSON.stringify(f.message)}`);

  if (!fileOk) bad++;
  console.log(`${fileOk ? "OK" : "FAIL"}  ${path}  (bassae ${oursMs.toFixed(0)} ms, oracle ${oracleMs.toFixed(0)} ms)`);
  console.log(lines.join("\n"));
}

console.log(`\n${paths.length - bad}/${paths.length} files agree`);
process.exit(bad ? 1 : 0);
