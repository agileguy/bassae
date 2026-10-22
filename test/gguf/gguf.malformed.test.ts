// ISC-9, ISC-10, ISC-10.2: truncated and hostile files give parse_error and the reader returns normally.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGgufModel, readGgufSource } from "../../src/gguf/index.ts";
import { MAX_ARRAY_LENGTH, MAX_KEY_BYTES, MAX_KV_COUNT, MAX_KV_SECTION_BYTES, MAX_STRING_BYTES } from "../../src/gguf/limits.ts";
import { bytesSource } from "../../src/gguf/reader.ts";
import type { ModelRecord, RuleId, Severity } from "../../src/types.ts";
import { buildGguf, str, T, typicalKvs, Writer } from "./builder.ts";

const read = (bytes: Uint8Array) => readGgufSource(bytesSource(bytes), "/m.gguf");

/** The parse stopped early: the record says so, and the last finding is the error that stopped it. */
function expectStopped(r: ModelRecord, severity: Severity) {
  expect(r.extractionComplete).toBe(false);
  expect(r.findings.length).toBeGreaterThan(0);
  for (const f of r.findings) {
    expect(f.ruleId).toBe("parse_error");
    expect(f.file).toBe("/m.gguf");
    expect(f.message.length).toBeGreaterThan(0);
  }
  expect(r.findings.at(-1)!.severity).toBe(severity);
}

const KEY = "tokenizer.chat_template";
const one = () => new Writer().header(1);

// Each fixture, and the severity of the error that stops it: MEDIUM when no engine would load the file, HIGH once the magic and version are good.
const hostile: Record<string, [() => Uint8Array, Severity]> = {
  "empty file": [() => new Uint8Array(0), "MEDIUM"],
  "magic only": [() => new Writer().bytes(new TextEncoder().encode("GGUF")).finish(), "MEDIUM"],
  "wrong magic": [() => new Writer().bytes(new TextEncoder().encode("GGML")).u32(3).u64(0).u64(0).finish(), "MEDIUM"],
  "header cut inside tensor_count": [() => new Writer().header(0).finish().subarray(0, 12), "HIGH"],
  "version 0": [() => new Writer().header(0, 0).finish(), "MEDIUM"],
  "version 1": [() => new Writer().header(0, 1).finish(), "MEDIUM"],
  "version 4": [() => new Writer().header(0, 4).finish(), "MEDIUM"],
  "version 0xFFFFFFFF": [() => new Writer().header(0, 0xffffffff).finish(), "MEDIUM"],
  "big-endian version 3": [() => new Writer().header(0, 0x03000000).finish(), "MEDIUM"],
  "KV count 2^64-1": [() => new Writer().header(2n ** 64n - 1n).finish(), "HIGH"],
  "KV count one past the cap": [() => new Writer().header(MAX_KV_COUNT + 1).kv("a", str("b")).finish(), "HIGH"],
  "KV count larger than the KVs present": [() => new Writer().header(10).kv("general.name", str("x")).finish(), "HIGH"],
  "2^60-byte template string": [() => one().str(KEY).u32(T.STRING).u64(2n ** 60n).bytes(new Uint8Array(64)).finish(), "HIGH"],
  "2^60-byte key": [() => one().u64(2n ** 60n).bytes(new Uint8Array(64)).finish(), "HIGH"],
  "string length that wraps a u64 offset": [() => one().str(KEY).u32(T.STRING).u64(2n ** 64n - 16n).bytes(new Uint8Array(64)).finish(), "HIGH"],
  "array of 2^62 u64s": [() => one().str("a").u32(T.ARRAY).u32(T.U64).u64(2n ** 62n).finish(), "HIGH"],
  "array whose byte size wraps a u64": [() => one().str("a").u32(T.ARRAY).u32(T.U64).u64(2n ** 61n).u64(1).finish(), "HIGH"],
  "string array one past the length cap, with no elements": [() => one().str("tokenizer.ggml.tokens").u32(T.ARRAY).u32(T.STRING).u64(MAX_ARRAY_LENGTH + 1).finish(), "HIGH"],
  "array under the cap but past end of file": [() => one().str("tokenizer.ggml.tokens").u32(T.ARRAY).u32(T.STRING).u64(MAX_ARRAY_LENGTH).u64(1).finish(), "HIGH"],
  "nested array": [() => one().str("a").u32(T.ARRAY).u32(T.ARRAY).u64(1).u32(T.U8).u64(1).u8(1).finish(), "HIGH"],
  "nested array as a chat template": [() => one().str(KEY).u32(T.ARRAY).u32(T.ARRAY).u64(1).u32(T.STRING).u64(1).str("{{x}}").finish(), "HIGH"],
  "unknown KV type 13": [() => one().str("a").u32(13).u64(0).finish(), "HIGH"],
  "unknown KV type 0xFFFFFFFF": [() => one().str("a").u32(0xffffffff).u64(0).finish(), "HIGH"],
  "unknown type on a chat template key": [() => one().str("tokenizer.chat_template.x").u32(13).u64(0).finish(), "HIGH"],
  "unknown array element type 13": [() => one().str("a").u32(T.ARRAY).u32(13).u64(1).u64(0).finish(), "HIGH"],
};

for (const [name, [make, severity]] of Object.entries(hostile)) {
  test(`ISC-10.2: ${name} is a ${severity} parse_error, not a crash`, () => {
    const r = read(make());
    expectStopped(r, severity);
    expect(r.templates).toEqual([]);
  });
}

test("each length cap fires on its own, even when the file holds every declared byte", () => {
  const overString = one().str(KEY).u32(T.STRING).u64(MAX_STRING_BYTES + 1).bytes(new Uint8Array(MAX_STRING_BYTES + 1)).finish();
  const overKey = one().u64(MAX_KEY_BYTES + 1).bytes(new Uint8Array(MAX_KEY_BYTES + 64)).finish();
  for (const [bytes, cap] of [[overString, MAX_STRING_BYTES], [overKey, MAX_KEY_BYTES]] as const) {
    const r = read(bytes);
    expectStopped(r, "HIGH");
    expect(r.findings[0]!.message).toContain(`the cap is ${cap}`);
  }
});

// Gemini R1: a cap trip used to stop the walk, so a pad before the template hid it.
const zeros = (n: number) => new Uint8Array(n);
const pads: Record<string, (w: Writer) => Writer> = {
  "u8 array one past the length cap": (w) => w.str("pad").u32(T.ARRAY).u32(T.U8).u64(MAX_ARRAY_LENGTH + 1).bytes(zeros(MAX_ARRAY_LENGTH + 1)),
  "string array one past the length cap": (w) => w.str("pad").u32(T.ARRAY).u32(T.STRING).u64(MAX_ARRAY_LENGTH + 1).bytes(zeros((MAX_ARRAY_LENGTH + 1) * 8)),
  "string array with an element past the string cap": (w) => w.str("pad").u32(T.ARRAY).u32(T.STRING).u64(1).u64(MAX_STRING_BYTES + 1).bytes(zeros(MAX_STRING_BYTES + 1)),
  "string one past the string cap": (w) => w.str("pad").u32(T.STRING).u64(MAX_STRING_BYTES + 1).bytes(zeros(MAX_STRING_BYTES + 1)),
  "general.* string one past the string cap": (w) => w.str("general.description").u32(T.STRING).u64(MAX_STRING_BYTES + 1).bytes(zeros(MAX_STRING_BYTES + 1)),
};

for (const [name, pad] of Object.entries(pads)) {
  test(`a ${name} is skipped by its size, and the template after it is extracted`, () => {
    const r = read(pad(new Writer().header(2)).kv(KEY, str("{{ messages }}")).finish());
    expect(r.findings).toEqual([]);
    expect(r.extractionComplete).toBe(true);
    expect(r.templates.map((t) => t.text)).toEqual(["{{ messages }}"]);
  });
}

test("a kept array past its cap is a MEDIUM parse_error, and the template after it is extracted", () => {
  const kept: [string, number, number][] = [
    ["tokenizer.ggml.tokens", T.STRING, 8],
    ["tokenizer.ggml.token_type", T.I32, 4],
    ["tokenizer.chat_templates", T.STRING, 8],
  ];
  for (const [key, type, size] of kept) {
    const w = new Writer().header(2).str(key).u32(T.ARRAY).u32(type).u64(MAX_ARRAY_LENGTH + 1).bytes(zeros((MAX_ARRAY_LENGTH + 1) * size));
    const r = read(w.kv(KEY, str("{{ messages }}")).finish());
    expect(r.findings.map((f) => [f.ruleId, f.severity, f.detail?.key])).toEqual([["parse_error", "MEDIUM", key]]);
    expect(r.extractionComplete).toBe(true);
    expect(r.templates).toHaveLength(1);
  }
});

test("a template past the string cap is HIGH and incomplete, and the template after it is still extracted", () => {
  const w = new Writer().header(2).str(KEY).u32(T.STRING).u64(MAX_STRING_BYTES + 1).bytes(zeros(MAX_STRING_BYTES + 1));
  const r = read(w.kv(`${KEY}.tool_use`, str("{{ tools }}")).finish());
  expect(r.findings.map((f) => [f.ruleId, f.severity, f.templateName])).toEqual([["parse_error", "HIGH", "default"]]);
  expect(r.extractionComplete).toBe(false);
  expect(r.templates.map((t) => t.source.name)).toEqual(["tool_use"]);
});

test("a skip that runs past the KV section cap still stops, and the stop is HIGH whatever key it is on", () => {
  // The size check comes before the skip, so this reads none of the 300 MiB it declares.
  const r = read(new Writer().header(2).str("pad").u32(T.ARRAY).u32(T.U8).u64(300 * 2 ** 20).finish());
  expectStopped(r, "HIGH");
  expect(r.findings[0]!.templateName).toBeUndefined();
  expect(r.findings[0]!.message).toContain(String(MAX_KV_SECTION_BYTES));
});

test("ISC-10: the 2^60-byte string error names the key and the declared size", () => {
  const r = read(hostile["2^60-byte template string"]![0]());
  expect(r.findings[0]!.message).toContain(String(2n ** 60n));
  expect(r.findings[0]!.detail).toMatchObject({ key: KEY });
  expect(r.findings[0]!.templateName).toBe("default");
});

test("ISC-9: every truncation of a valid file stops with parse_error, HIGH once the magic and version are read", () => {
  const { bytes, kvEnd } = buildGguf(typicalKvs());
  const full = read(bytes);
  expect(full.findings).toEqual([]);
  expect(full.extractionComplete).toBe(true);
  let named = 0;
  for (let n = 0; n < kvEnd; n++) {
    const r = read(bytes.subarray(0, n));
    expectStopped(r, n < 8 ? "MEDIUM" : "HIGH");
    if (r.findings.at(-1)!.templateName !== undefined) named++;
  }
  expect(named).toBeGreaterThan(0);
});

test("a cut inside a value is HIGH, and names the template when it cuts one", () => {
  const cut = (kvs: Parameters<typeof buildGguf>[0], key: string) => {
    const { bytes } = buildGguf(kvs);
    const at = Buffer.from(bytes).indexOf(Buffer.from(key)) + key.length + 4 + 8 + 3;
    return read(bytes.subarray(0, at));
  };
  const template = cut([["general.name", str("x")], [KEY, str("{{ messages }}")]], KEY);
  expectStopped(template, "HIGH");
  expect(template.findings.at(-1)!.templateName).toBe("default");
  const other = cut([["general.name", str("a long enough name")]], "general.name");
  expectStopped(other, "HIGH");
  expect(other.findings.at(-1)!.templateName).toBeUndefined();
});

test("ISC-9: a truncated file on disk returns normally and the next file still reads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bassae-gguf-malformed-"));
  const { bytes } = buildGguf(typicalKvs());
  writeFileSync(join(dir, "a.incomplete"), bytes.subarray(0, 200));
  writeFileSync(join(dir, "b.gguf"), bytes);
  const [a, b] = [await readGgufModel(join(dir, "a.incomplete")), await readGgufModel(join(dir, "b.gguf"))];
  expect(a.findings.map((f) => [f.ruleId, f.severity])).toEqual([["parse_error", "HIGH"]]);
  expect(a.extractionComplete).toBe(false);
  expect(b.findings).toEqual([]);
  expect(b.extractionComplete).toBe(true);
  expect(b.templates).toHaveLength(2);
});

test("mutation fuzz: 3,000 corrupted files never throw, only raise known findings, and always serialize", () => {
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
    expect(() => JSON.stringify(r)).not.toThrow();
  }
  expect(performance.now() - started).toBeLessThan(4000);
});
