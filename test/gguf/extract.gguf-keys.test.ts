// ISC-4, ISC-4.1, ISC-4.2: listed, unlisted and duplicate chat template keys.
import { expect, test } from "bun:test";
import { readGgufSource } from "../../src/gguf/index.ts";
import { bytesSource } from "../../src/gguf/reader.ts";
import { arr, buildGguf, str, T, u32, Writer, type Value } from "./builder.ts";

const read = (kvs: [string, Value][]) => readGgufSource(bytesSource(buildGguf(kvs).bytes), "/m.gguf");
const rules = (r: ReturnType<typeof read>) => r.findings.map((f) => [f.ruleId, f.severity]);

test("ISC-4: every key matching the pattern is extracted, listed or not", () => {
  const r = read([
    ["tokenizer.chat_template", str("A")],
    ["tokenizer.chat_template.tool_use", str("B")],
    ["tokenizer.chat_template.rag", str("C")],
    ["tokenizer.chat_template.a.b", str("D")],
    ["tokenizer.chat_template.line\nbreak", str("E")],
    ["tokenizer.chat_templates", arr(T.STRING, ["tool_use"])],
  ]);
  expect(r.templates.map((t) => [t.source.name, t.text])).toEqual([
    ["default", "A"],
    ["tool_use", "B"],
    ["rag", "C"],
    ["a.b", "D"],
    ["line\nbreak", "E"],
  ]);
});

test("ISC-4: near-miss keys are not templates", () => {
  const r = read([
    ["tokenizer.chat_template_v2", str("x")],
    ["xtokenizer.chat_template", str("x")],
    ["tokenizer.chat_templates", arr(T.STRING, [])],
  ]);
  expect(r.templates).toEqual([]);
});

test("ISC-4: with no tokenizer.chat_templates list, named templates raise nothing", () => {
  const r = read([
    ["tokenizer.chat_template", str("A")],
    ["tokenizer.chat_template.rag", str("C")],
  ]);
  expect(r.findings).toEqual([]);
});

test("ISC-4.1: a listed name with no key is a MEDIUM template_list_mismatch", () => {
  const r = read([
    ["tokenizer.chat_template", str("A")],
    ["tokenizer.chat_templates", arr(T.STRING, ["tool_use", "rag"])],
    ["tokenizer.chat_template.tool_use", str("B")],
  ]);
  expect(rules(r)).toEqual([["template_list_mismatch", "MEDIUM"]]);
  expect(r.findings[0]!.templateName).toBe("rag");
});

test("ISC-4.1: a named key missing from the list is a MEDIUM template_list_mismatch", () => {
  const r = read([
    ["tokenizer.chat_template", str("A")],
    ["tokenizer.chat_template.tool_use", str("B")],
    ["tokenizer.chat_template.hidden", str("C")],
    ["tokenizer.chat_templates", arr(T.STRING, ["tool_use"])],
  ]);
  expect(rules(r)).toEqual([["template_list_mismatch", "MEDIUM"]]);
  expect(r.findings[0]!.templateName).toBe("hidden");
  expect(r.findings[0]!.templateSha256).toBe(r.templates[2]!.sha256);
  expect(r.templates).toHaveLength(3);
});

test("ISC-4.1: the bare key needs no list entry, and 'default' in the list is satisfied by it", () => {
  for (const list of [["tool_use"], ["default", "tool_use"]]) {
    const r = read([
      ["tokenizer.chat_template", str("A")],
      ["tokenizer.chat_template.tool_use", str("B")],
      ["tokenizer.chat_templates", arr(T.STRING, list)],
    ]);
    expect(r.findings).toEqual([]);
  }
});

test("ISC-4.1: a tokenizer.chat_templates that is not a string array is a MEDIUM parse_error", () => {
  const r = read([
    ["tokenizer.chat_template.rag", str("C")],
    ["tokenizer.chat_templates", u32(1)],
  ]);
  expect(rules(r)).toEqual([["parse_error", "MEDIUM"]]);
  expect(r.templates).toHaveLength(1);
});

test("ISC-4.1: no list check when the parse stopped early, since later keys were never read", () => {
  const w = new Writer().header(3);
  w.kv("tokenizer.chat_templates", arr(T.STRING, ["tool_use"]));
  w.kv("tokenizer.chat_template", str("A"));
  w.str("tokenizer.chat_template.tool_use").u32(T.STRING).u64(1000).bytes(new Uint8Array(10));
  const r = readGgufSource(bytesSource(w.finish()), "/m.gguf");
  // The cut lands inside a template value, so the stop is HIGH and the record is incomplete.
  expect(rules(r)).toEqual([["parse_error", "HIGH"]]);
  expect(r.findings[0]!.templateName).toBe("tool_use");
  expect(r.extractionComplete).toBe(false);
  expect(r.templates.map((t) => t.source.name)).toEqual(["default"]);
});

test("ISC-4.2: a duplicated tokenizer.chat_template key is a HIGH parse_error and both values are extracted", () => {
  const r = read([
    ["tokenizer.chat_template", str("clean")],
    ["general.name", str("x")],
    ["tokenizer.chat_template", str("evil")],
  ]);
  expect(rules(r)).toEqual([["parse_error", "HIGH"]]);
  expect(r.findings[0]!.detail).toMatchObject({ key: "tokenizer.chat_template" });
  expect(r.templates.map((t) => t.text)).toEqual(["clean", "evil"]);
});

test("ISC-4.2: a duplicated named template key is HIGH too", () => {
  const r = read([
    ["tokenizer.chat_template.tool_use", str("a")],
    ["tokenizer.chat_template.tool_use", str("b")],
    ["tokenizer.chat_templates", arr(T.STRING, ["tool_use"])],
  ]);
  expect(rules(r)).toEqual([["parse_error", "HIGH"]]);
  expect(r.templates).toHaveLength(2);
});

// llama.cpp keeps keys as std::string but looks them up with strcmp and C-string map keys, so the part
// after a NUL is invisible to it. Byte-exact readers would miss these templates entirely.
test("a lone template key with a NUL is extracted under the name llama.cpp sees, and is HIGH", () => {
  const r = read([
    ["tokenizer.chat_template\u0000x", str("A")],
    ["tokenizer.chat_template.tool_use\u0000y", str("B")],
    ["general.name\u0000z", str("C")],
  ]);
  expect(r.templates.map((t) => [t.source.name, t.source.key])).toEqual([
    ["default", "tokenizer.chat_template\u0000x"],
    ["tool_use", "tokenizer.chat_template.tool_use\u0000y"],
  ]);
  // A NUL in a key that is not a template stays MEDIUM.
  expect(rules(r)).toEqual([["parse_error", "HIGH"], ["parse_error", "HIGH"], ["parse_error", "MEDIUM"]]);
  expect(r.findings.map((f) => f.templateName)).toEqual(["default", "tool_use", undefined]);
});

test("ISC-4.2: a NUL alias of the bare template key is HIGH for the NUL and HIGH for the duplicate", () => {
  const r = read([
    ["tokenizer.chat_template\u0000evil", str("evil")],
    ["tokenizer.chat_template", str("clean")],
    ["tokenizer.chat_templates", arr(T.STRING, [])],
  ]);
  expect(rules(r)).toEqual([["parse_error", "HIGH"], ["parse_error", "HIGH"]]);
  expect(r.findings.map((f) => f.message)).toEqual([
    'key "tokenizer.chat_template\\u0000evil" contains a NUL byte; llama.cpp reads it as "tokenizer.chat_template"',
    'key "tokenizer.chat_template" appears more than once',
  ]);
  expect(r.templates.map((t) => t.text)).toEqual(["evil", "clean"]);
});

test("a duplicated key that is not a template is a MEDIUM parse_error", () => {
  const r = read([
    ["general.name", str("a")],
    ["general.name", str("b")],
  ]);
  expect(rules(r)).toEqual([["parse_error", "MEDIUM"]]);
});

test("a chat template key holding a non-string is a MEDIUM parse_error, is not extracted, and leaves extraction incomplete", () => {
  const r = read([
    ["tokenizer.chat_template", arr(T.STRING, ["{{ x }}"])],
    ["tokenizer.chat_template.n", u32(5)],
  ]);
  expect(rules(r)).toEqual([["parse_error", "MEDIUM"], ["parse_error", "MEDIUM"]]);
  expect(r.templates).toEqual([]);
  expect(r.extractionComplete).toBe(false);
});

// llama.cpp reads string values through gguf_get_val_str, which returns c_str(): it renders only the
// bytes before the first NUL, while gguf-py and HF tooling see the whole value.
test("a NUL inside a template value is HIGH with its offsets, and the part llama.cpp renders is extracted too", () => {
  const value = new TextEncoder().encode("é{{ a }}\n\u0000{{ evil }}\u0000tail");
  const { bytes } = buildGguf([
    ["general.name", str("x")],
    ["tokenizer.chat_template", str(value)],
    ["tokenizer.chat_templates", arr(T.STRING, ["tool_use"])],
    ["tokenizer.chat_template.tool_use", str("ok")],
  ]);
  const r = readGgufSource(bytesSource(bytes), "/m.gguf");
  expect(rules(r)).toEqual([["parse_error", "HIGH"]]);
  const f = r.findings[0]!;
  expect(f.templateName).toBe("default");
  expect(f.templateSha256).toBe(r.templates[0]!.sha256);
  // é is two bytes and one UTF-16 unit, so the NUL is byte 10, text offset 9, line 2 column 1.
  expect(f.detail).toMatchObject({ key: "tokenizer.chat_template", byteOffset: 10, fileOffset: Buffer.from(bytes).indexOf(Buffer.from(value)) + 10 });
  expect(f.span).toEqual({ start: 9, end: 10, line: 2, col: 1 });
  expect(r.templates.map((t) => [t.source.name, t.source.key, t.text])).toEqual([
    ["default", "tokenizer.chat_template", "é{{ a }}\n\u0000{{ evil }}\u0000tail"],
    ["tool_use", "tokenizer.chat_template.tool_use", "ok"],
    ["default", "tokenizer.chat_template[:10]", "é{{ a }}\n"],
  ]);
  expect(f.detail).toMatchObject({ viewSha256: r.templates[2]!.sha256 });
  expect(r.extractionComplete).toBe(true);
});

test("a NUL at byte 0 of a named template gives an empty llama.cpp view", () => {
  const r = read([["tokenizer.chat_template.tool_use", str("\u0000{{ evil }}")]]);
  expect(rules(r)).toEqual([["parse_error", "HIGH"]]);
  expect(r.templates.map((t) => [t.source.name, t.source.key, t.text])).toEqual([
    ["tool_use", "tokenizer.chat_template.tool_use", "\u0000{{ evil }}"],
    ["tool_use", "tokenizer.chat_template.tool_use[:0]", ""],
  ]);
});
