// ISC-8, ISC-10.1, ISC-38: header-only reads, bounded memory, and no byte of tensor data.
import { afterAll, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, rmSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGgufModel, readGgufSource } from "../../src/gguf/index.ts";
import { MAX_ARRAY_LENGTH, MAX_KV_SECTION_BYTES } from "../../src/gguf/limits.ts";
import { bytesSource, openFileSource, parseGguf, type ByteSource } from "../../src/gguf/reader.ts";
import { bigVocabKvs, buildGguf, T, typicalKvs, Writer, type Tensor } from "./builder.ts";

const dir = mkdtempSync(join(tmpdir(), "bassae-gguf-io-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const GiB = 2 ** 30;
const weights = (n: number): Tensor => ({ name: "token_embd.weight", dims: [n], type: 0, data: new Uint8Array(n * 4).fill(0xaa) });

/** Wraps a source and records every read it serves. */
function instrument(src: ByteSource) {
  const reads: [offset: number, length: number][] = [];
  const source: ByteSource = {
    size: src.size,
    read(offset, length) {
      reads.push([offset, length]);
      return src.read(offset, length);
    },
  };
  const maxEnd = () => reads.reduce((m, [o, n]) => Math.max(m, o + n), 0);
  return { source, reads, maxEnd };
}

test("ISC-38: at Gemma scale, no read reaches past the end of the KV section", () => {
  const { bytes, kvEnd } = buildGguf(bigVocabKvs(), { tensors: [weights(4096)] });
  expect(parseGguf(bytesSource(bytes)).kvEnd).toBe(kvEnd);

  const probe = instrument(bytesSource(bytes));
  const r = readGgufSource(probe.source, "/m.gguf");
  expect(r.findings).toEqual([]);
  expect(r.specialTokens).toHaveLength(300);
  expect(probe.reads.length).toBeGreaterThan(0);
  expect(probe.maxEnd()).toBeLessThanOrEqual(kvEnd);
  // Read-ahead batches the work: a few hundred reads at most, not one per token.
  expect(probe.reads.length).toBeLessThan(500);
});

test("ISC-38: the same holds for a small file and for a file on disk", () => {
  const { bytes, kvEnd } = buildGguf(typicalKvs(), { tensors: [weights(64)] });
  const mem = instrument(bytesSource(bytes));
  expect(readGgufSource(mem.source, "/m.gguf").templates).toHaveLength(2);
  expect(mem.reads.length).toBeGreaterThan(0);
  expect(mem.maxEnd()).toBeLessThanOrEqual(kvEnd);

  const path = join(dir, "small.gguf");
  writeFileSync(path, bytes);
  const file = openFileSource(path);
  try {
    const disk = instrument(file);
    expect(readGgufSource(disk.source, path).findings).toEqual([]);
    expect(disk.maxEnd()).toBeLessThanOrEqual(kvEnd);
  } finally {
    file.close();
  }
});

test("ISC-8: a 40 GB sparse GGUF reads in under a second and only its header is touched", async () => {
  const path = join(dir, "sparse-40g.gguf");
  const { bytes, kvEnd } = buildGguf(bigVocabKvs(), { tensors: [weights(1024)] });
  writeFileSync(path, bytes);
  truncateSync(path, 40 * GiB);

  const started = performance.now();
  const r = await readGgufModel(path);
  const ms = performance.now() - started;
  expect(r.findings).toEqual([]);
  expect(r.templates).toHaveLength(1);
  expect(ms).toBeLessThan(1000);

  const file = openFileSource(path);
  try {
    expect(file.size).toBe(40 * GiB);
    const probe = instrument(file);
    readGgufSource(probe.source, path);
    expect(probe.maxEnd()).toBeLessThanOrEqual(kvEnd);
  } finally {
    file.close();
  }
}, 30_000);

test("a KV section running past MAX_KV_SECTION_BYTES stops with parse_error, without reading the skipped arrays", () => {
  // Ten arrays of 4 Mi u64s are 320 MiB of declared metadata in a sparse file.
  const path = join(dir, "huge-kv.gguf");
  const fd = openSync(path, "w");
  let at = 0;
  const put = (w: Writer) => {
    const b = w.finish();
    writeSync(fd, b, 0, b.length, at);
    at += b.length;
  };
  put(new Writer().header(10));
  for (let i = 0; i < 10; i++) {
    put(new Writer().str(`pad.${i}`).u32(T.ARRAY).u32(T.U64).u64(MAX_ARRAY_LENGTH));
    at += MAX_ARRAY_LENGTH * 8;
  }
  closeSync(fd);
  truncateSync(path, at);

  const file = openFileSource(path);
  try {
    const probe = instrument(file);
    const started = performance.now();
    const r = readGgufSource(probe.source, path);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(r.findings.map((f) => f.ruleId)).toEqual(["parse_error"]);
    expect(r.findings[0]!.message).toContain(String(MAX_KV_SECTION_BYTES));
    const touched = probe.reads.reduce((n, [, len]) => n + len, 0);
    expect(touched).toBeLessThan(1024 * 1024);
  } finally {
    file.close();
  }
});

const rssProbe = `
const { readGgufModel } = await import(${JSON.stringify(join(import.meta.dir, "../../src/gguf/index.ts"))});
const r = await readGgufModel(process.env.GGUF_PATH);
// Bun reports maxRSS raw: bytes on macOS. Linux states its peak in kB in /proc, which leaves no doubt about units.
const hwm = process.platform === "linux" && /VmHWM:\\s+(\\d+) kB/.exec(await Bun.file("/proc/self/status").text());
const rss = hwm ? Number(hwm[1]) * 1024 : process.resourceUsage().maxRSS;
console.log(JSON.stringify({ rss, rules: r.findings.map((f) => f.ruleId) }));
`;

/** Reads one file in a fresh process and returns its peak RSS in bytes. */
function peakRss(path: string): { rss: number; rules: string[] } {
  const p = Bun.spawnSync([process.execPath, "-e", rssProbe], { env: { ...process.env, GGUF_PATH: path } });
  expect(p.exitCode).toBe(0);
  return JSON.parse(p.stdout.toString());
}

test("ISC-10.1: peak RSS stays under 512 MB on huge declared strings", () => {
  const tiny = join(dir, "huge-string.gguf");
  writeFileSync(tiny, new Writer().header(1).str("tokenizer.chat_template").u32(T.STRING).u64(2n ** 60n).bytes(new Uint8Array(64)).finish());

  // 900 MiB declared inside a 1 GiB sparse file: the bounds check passes, so only the string cap can stop it.
  const sparse = join(dir, "huge-string-sparse.gguf");
  writeFileSync(sparse, new Writer().header(1).str("tokenizer.chat_template").u32(T.STRING).u64(900 * 2 ** 20).finish());
  truncateSync(sparse, GiB);

  const baseline = join(dir, "baseline.gguf");
  writeFileSync(baseline, buildGguf(typicalKvs()).bytes);

  const base = peakRss(baseline);
  expect(base.rules).toEqual([]);
  expect(base.rss).toBeGreaterThan(5 * 2 ** 20); // a unit mistake would show up here
  for (const path of [tiny, sparse]) {
    const { rss, rules } = peakRss(path);
    expect(rules).toEqual(["parse_error"]);
    expect(rss).toBeLessThan(512 * 2 ** 20);
  }
}, 30_000);
