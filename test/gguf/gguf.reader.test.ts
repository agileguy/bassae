import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGgufModel, readGgufSource } from "../../src/gguf/index.ts";
import { bytesSource } from "../../src/gguf/reader.ts";
import { arr, bool, buildGguf, f32, str, T, TOKEN, typicalKvs, u32, u64, type Value } from "./builder.ts";

const read = (kvs: [string, Value][], version = 3) =>
  readGgufSource(bytesSource(buildGguf(kvs, { version }).bytes), "/models/x.gguf");

test("a typical file becomes a gguf ModelRecord", () => {
  const r = read(typicalKvs());
  expect(r.format).toBe("gguf");
  expect(r.id).toBe("/models/x.gguf");
  expect(r.paths).toEqual(["/models/x.gguf"]);
  expect(r.findings).toEqual([]);
  expect(r.hints).toEqual({});
  expect(r.hfCache).toBeUndefined();
  expect(r.templates.map((t) => [t.source.kind, t.source.name, t.source.key, t.source.path])).toEqual([
    ["gguf", "default", "tokenizer.chat_template", "/models/x.gguf"],
    ["gguf", "tool_use", "tokenizer.chat_template.tool_use", "/models/x.gguf"],
  ]);
  expect(r.templates[1]!.text).toBe("{{ tools | tojson }}");
});

test("special tokens are the CONTROL and USER_DEFINED entries of tokenizer.ggml.tokens", () => {
  expect(read(typicalKvs()).specialTokens).toEqual(["<|im_start|>", "<|im_end|>", "<tool_call>"]);
});

test("special tokens come out when token_type precedes tokens", () => {
  const r = read([
    ["tokenizer.ggml.token_type", arr(T.I32, [TOKEN.NORMAL, TOKEN.USER_DEFINED, TOKEN.CONTROL, TOKEN.BYTE])],
    ["tokenizer.ggml.tokens", arr(T.STRING, ["a", "<think>", "<eos>", "<0x0A>"])],
  ]);
  expect(r.specialTokens).toEqual(["<think>", "<eos>"]);
  expect(r.findings).toEqual([]);
});

test("a token_type array whose length differs from tokens is a MEDIUM parse_error", () => {
  const r = read([
    ["tokenizer.ggml.tokens", arr(T.STRING, ["a", "<eos>", "b"])],
    ["tokenizer.ggml.token_type", arr(T.I32, [TOKEN.NORMAL, TOKEN.CONTROL])],
  ]);
  expect(r.findings.map((f) => [f.ruleId, f.severity])).toEqual([["parse_error", "MEDIUM"]]);
  expect(r.specialTokens).toEqual(["<eos>"]);
});

// llama.cpp reads token_type as int32 whatever type it declares, so any other type gives no special tokens.
test("a token_type that is not an int32 array is a MEDIUM parse_error, and the walk carries on", () => {
  for (const types of [arr(T.U8, [1, 3, 4]), arr(T.U32, [1, 3, 4]), arr(T.STRING, ["1", "3", "4"]), u32(3)]) {
    const r = read([
      ["tokenizer.ggml.tokens", arr(T.STRING, ["a", "<eos>", "<x>"])],
      ["tokenizer.ggml.token_type", types],
      ["tokenizer.chat_template", str("{{ x }}")],
    ]);
    expect(r.findings.map((f) => [f.ruleId, f.severity, f.detail?.key])).toEqual([["parse_error", "MEDIUM", "tokenizer.ggml.token_type"]]);
    expect(r.specialTokens).toEqual([]);
    expect(r.templates).toHaveLength(1);
  }
});

test("an empty CONTROL or USER_DEFINED token is not a special token", () => {
  const r = read([
    ["tokenizer.ggml.tokens", arr(T.STRING, ["", "<eos>", "", "a"])],
    ["tokenizer.ggml.token_type", arr(T.I32, [TOKEN.CONTROL, TOKEN.CONTROL, TOKEN.USER_DEFINED, TOKEN.NORMAL])],
  ]);
  expect(r.specialTokens).toEqual(["<eos>"]);
});

test("ggufGeneral holds every general.* scalar and nothing else", () => {
  const r = read([
    ["general.architecture", str("qwen3")],
    ["general.parameter_count", u64(596049920n)],
    ["general.quantization_version", u32(2)],
    ["general.finetuned", bool(true)],
    ["general.score", f32(0.5)],
    ["general.tags", arr(T.STRING, ["text-generation"])],
    ["qwen3.block_count", u32(28)],
  ]);
  expect(r.ggufGeneral).toEqual({
    "general.architecture": "qwen3",
    "general.parameter_count": 596049920,
    "general.quantization_version": 2,
    "general.finetuned": true,
    "general.score": 0.5,
  });
});

test("64-bit general.* values are numbers in the safe range and decimal strings outside it, so the record serializes", () => {
  const r = read([
    ["general.parameter_count", u64(596049920n)],
    ["general.safe_max", u64(2n ** 53n - 1n)],
    ["general.past_safe", u64(2n ** 53n)],
    ["general.u64_max", u64(2n ** 64n - 1n)],
    ["general.small_negative", { type: T.I64, value: -5n }],
    ["general.i64_min", { type: T.I64, value: -(2n ** 63n) }],
  ]);
  expect(r.ggufGeneral).toEqual({
    "general.parameter_count": 596049920,
    "general.safe_max": 9007199254740991,
    "general.past_safe": "9007199254740992",
    "general.u64_max": "18446744073709551615",
    "general.small_negative": -5,
    "general.i64_min": "-9223372036854775808",
  });
  expect(JSON.parse(JSON.stringify(r)).ggufGeneral).toEqual(r.ggufGeneral);
});

test("a complete parse sets extractionComplete", () => {
  expect(read(typicalKvs()).extractionComplete).toBe(true);
  expect(read([]).extractionComplete).toBe(true);
});

test("version 2 files read the same as version 3", () => {
  const v2 = read(typicalKvs(), 2);
  const v3 = read(typicalKvs(), 3);
  expect(v2.findings).toEqual([]);
  expect(v2.templates.map((t) => t.sha256)).toEqual(v3.templates.map((t) => t.sha256));
  expect(v2.specialTokens).toEqual(v3.specialTokens);
});

test("readGgufModel labels templates with the path reached and the real path", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "bassae-gguf-reader-")));
  const real = join(dir, "blobs", "sha256-abc");
  mkdirSync(join(dir, "blobs"));
  writeFileSync(real, buildGguf(typicalKvs()).bytes);
  const link = join(dir, "model.gguf");
  symlinkSync(real, link);

  const r = await readGgufModel(link);
  expect(r.id).toBe(real);
  expect(r.paths).toEqual([link]);
  expect(r.findings).toEqual([]);
  expect(r.templates[0]!.source.path).toBe(link);
  expect(r.templates[0]!.source.realPath).toBe(real);
});

test("readGgufModel turns a missing file or a directory into a scanner_error instead of throwing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bassae-gguf-reader-"));
  for (const p of [join(dir, "missing.gguf"), dir]) {
    const r = await readGgufModel(p);
    expect(r.findings.map((f) => [f.ruleId, f.severity])).toEqual([["scanner_error", "MEDIUM"]]);
    expect(r.extractionComplete).toBe(false);
    expect(r.templates).toEqual([]);
  }
});
