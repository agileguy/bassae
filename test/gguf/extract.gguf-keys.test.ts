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
  expect(rules(r)).toEqual([["parse_error", "MEDIUM"]]);
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

test("a duplicated key that is not a template is a MEDIUM parse_error", () => {
  const r = read([
    ["general.name", str("a")],
    ["general.name", str("b")],
  ]);
  expect(rules(r)).toEqual([["parse_error", "MEDIUM"]]);
});

test("a chat template key holding a non-string is a MEDIUM parse_error and is not extracted", () => {
  const r = read([
    ["tokenizer.chat_template", arr(T.STRING, ["{{ x }}"])],
    ["tokenizer.chat_template.n", u32(5)],
  ]);
  expect(rules(r)).toEqual([["parse_error", "MEDIUM"], ["parse_error", "MEDIUM"]]);
  expect(r.templates).toEqual([]);
});
