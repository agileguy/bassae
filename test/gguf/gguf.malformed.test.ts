// ISC-9, ISC-10, ISC-10.2: truncated and hostile files give parse_error and the reader returns normally.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGgufModel, readGgufSource } from "../../src/gguf/index.ts";
import { MAX_ARRAY_LENGTH, MAX_KV_COUNT } from "../../src/gguf/limits.ts";
import { bytesSource } from "../../src/gguf/reader.ts";
import type { ModelRecord, RuleId } from "../../src/types.ts";
import { buildGguf, str, T, typicalKvs, Writer } from "./builder.ts";

const read = (bytes: Uint8Array) => readGgufSource(bytesSource(bytes), "/m.gguf");

function expectParseError(r: ModelRecord) {
  const errors = r.findings.filter((f) => f.ruleId === "parse_error");
  expect(errors.length).toBeGreaterThan(0);
  for (const f of errors) {
    expect(f.severity).toBe("MEDIUM");
    expect(f.file).toBe("/m.gguf");
    expect(f.message.length).toBeGreaterThan(0);
  }
}

const KEY = "tokenizer.chat_template";
const one = () => new Writer().header(1);

const hostile: Record<string, () => Uint8Array> = {
  "empty file": () => new Uint8Array(0),
  "magic only": () => new Writer().bytes(new TextEncoder().encode("GGUF")).finish(),
  "wrong magic": () => new Writer().bytes(new TextEncoder().encode("GGML")).u32(3).u64(0).u64(0).finish(),
  "header cut inside tensor_count": () => new Writer().header(0).finish().subarray(0, 12),
  "version 0": () => new Writer().header(0, 0).finish(),
  "version 1": () => new Writer().header(0, 1).finish(),
  "version 4": () => new Writer().header(0, 4).finish(),
  "version 0xFFFFFFFF": () => new Writer().header(0, 0xffffffff).finish(),
  "big-endian version 3": () => new Writer().header(0, 0x03000000).finish(),
  "KV count 2^64-1": () => new Writer().header(2n ** 64n - 1n).finish(),
  "KV count one past the cap": () => new Writer().header(MAX_KV_COUNT + 1).kv("a", str("b")).finish(),
  "KV count larger than the KVs present": () => new Writer().header(10).kv("general.name", str("x")).finish(),
  "2^60-byte template string": () => one().str(KEY).u32(T.STRING).u64(2n ** 60n).bytes(new Uint8Array(64)).finish(),
  "2^60-byte key": () => one().u64(2n ** 60n).bytes(new Uint8Array(64)).finish(),
  "string length that wraps a u64 offset": () => one().str(KEY).u32(T.STRING).u64(2n ** 64n - 16n).bytes(new Uint8Array(64)).finish(),
  "array of 2^62 u64s": () => one().str("a").u32(T.ARRAY).u32(T.U64).u64(2n ** 62n).finish(),
  "array whose byte size wraps a u64": () => one().str("a").u32(T.ARRAY).u32(T.U64).u64(2n ** 61n).u64(1).finish(),
  "string array one past the length cap": () => one().str("tokenizer.ggml.tokens").u32(T.ARRAY).u32(T.STRING).u64(MAX_ARRAY_LENGTH + 1).finish(),
  "array under the cap but past end of file": () => one().str("tokenizer.ggml.tokens").u32(T.ARRAY).u32(T.STRING).u64(MAX_ARRAY_LENGTH).u64(1).finish(),
  "nested array": () => one().str("a").u32(T.ARRAY).u32(T.ARRAY).u64(1).u32(T.U8).u64(1).u8(1).finish(),
  "nested array as a chat template": () => one().str(KEY).u32(T.ARRAY).u32(T.ARRAY).u64(1).u32(T.STRING).u64(1).str("{{x}}").finish(),
  "unknown KV type 13": () => one().str("a").u32(13).u64(0).finish(),
  "unknown KV type 0xFFFFFFFF": () => one().str("a").u32(0xffffffff).u64(0).finish(),
  "unknown array element type 13": () => one().str("a").u32(T.ARRAY).u32(13).u64(1).u64(0).finish(),
};

for (const [name, make] of Object.entries(hostile)) {
  test(`ISC-10.2: ${name} is a parse_error, not a crash`, () => {
    const r = read(make());
    expectParseError(r);
    expect(r.templates).toEqual([]);
  });
}

test("ISC-10: the 2^60-byte string error names the key and the declared size", () => {
  const r = read(hostile["2^60-byte template string"]!());
  expect(r.findings[0]!.message).toContain(String(2n ** 60n));
  expect(r.findings[0]!.detail).toMatchObject({ key: KEY });
});

test("ISC-9: every truncation of a valid file is a parse_error, and the full file is clean", () => {
  const { bytes, kvEnd } = buildGguf(typicalKvs());
  expect(read(bytes).findings).toEqual([]);
  for (let n = 0; n < kvEnd; n++) expectParseError(read(bytes.subarray(0, n)));
});

test("ISC-9: a truncated file on disk returns normally and the next file still reads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bassae-gguf-malformed-"));
  const { bytes } = buildGguf(typicalKvs());
  writeFileSync(join(dir, "a.incomplete"), bytes.subarray(0, 200));
  writeFileSync(join(dir, "b.gguf"), bytes);
  const [a, b] = [await readGgufModel(join(dir, "a.incomplete")), await readGgufModel(join(dir, "b.gguf"))];
  expect(a.findings.map((f) => [f.ruleId, f.severity])).toEqual([["parse_error", "MEDIUM"]]);
  expect(b.findings).toEqual([]);
  expect(b.templates).toHaveLength(2);
});

test("mutation fuzz: 3,000 corrupted files never throw and only raise known findings", () => {
  const { bytes } = buildGguf(typicalKvs());
  const known = new Set<RuleId>(["parse_error", "template_list_mismatch"]);
  let seed = 0x5eed;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 2 ** 32;
  };
  const started = performance.now();
  for (let i = 0; i < 3000; i++) {
    const m = bytes.slice();
    const view = new DataView(m.buffer);
    const edits = 1 + Math.floor(rand() * 4);
    for (let e = 0; e < edits; e++) {
      const at = Math.floor(rand() * m.length);
      // Half the edits plant a random u64, which is how lengths and counts go hostile.
      if (rand() < 0.5 && at + 8 <= m.length) view.setBigUint64(at, BigInt(Math.floor(rand() * 2 ** 53)) << BigInt(Math.floor(rand() * 11)), true);
      else m[at] = Math.floor(rand() * 256);
    }
    const r = read(m);
    for (const f of r.findings) expect(known.has(f.ruleId)).toBe(true);
  }
  expect(performance.now() - started).toBeLessThan(4000);
});
