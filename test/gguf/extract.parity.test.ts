// ISC-3: template bytes match the @huggingface/gguf oracle on synthetic files.
import { afterAll, expect, test } from "bun:test";
import { gguf } from "@huggingface/gguf";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGgufModel } from "../../src/gguf/index.ts";
import { CHAT_TEMPLATE_KEY, viewKey } from "../../src/gguf/templates.ts";
import type { RuleId, Severity } from "../../src/types.ts";
import { arr, bigVocabKvs, buildGguf, str, T, typicalKvs, type Tensor, type Value } from "./builder.ts";

const dir = mkdtempSync(join(tmpdir(), "bassae-gguf-parity-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const tensor = (name: string, n: number): Tensor => ({ name, dims: [n], type: 0, data: new Uint8Array(n * 4).fill(7) });

const templates: Record<string, string> = {
  ascii: "{% for m in messages %}{{ m.role }}: {{ m.content }}\n{% endfor %}",
  multibyte: "{# 日本語 العربية Ελληνικά 🦙🧠 é #}{{ messages[0].content }}",
  nul: "before\u0000after{{ x }}",
  bidi: "{{ '‮evil‬' }}​\u{E0041}",
  crlf: "{%- if x -%}\r\n\t{{ x }}\r\n{%- endif -%}",
  empty: "",
  large: "{{ 'pad' }}".repeat(30_000) + "😀",
};

async function compare(name: string, kvs: [string, Value][], tensors: Tensor[] = [], findings: [RuleId, Severity][] = []) {
  const path = join(dir, `${name}.gguf`);
  writeFileSync(path, buildGguf(kvs, { tensors }).bytes);
  const oracle = (await gguf(path, { allowLocalFile: true })).metadata as Record<string, unknown>;
  const ours = await readGgufModel(path);
  expect(ours.findings.map((f) => [f.ruleId, f.severity])).toEqual(findings);

  // The oracle has no llama.cpp views of values that hold a NUL; only the stored values are compared.
  const views = new Set(ours.templates.flatMap((t) => (t.bytes.includes(0) ? [viewKey(t.source.key!, t.bytes.indexOf(0))] : [])));
  const stored = ours.templates.filter((t) => !views.has(t.source.key!));
  expect(stored).toHaveLength(ours.templates.length - views.size);
  const oracleKeys = Object.keys(oracle).filter((k) => CHAT_TEMPLATE_KEY.test(k));
  expect(stored.map((t) => t.source.key)).toEqual(oracleKeys);
  for (const t of stored) {
    const expected = new TextEncoder().encode(oracle[t.source.key!] as string);
    expect(Buffer.from(t.bytes).equals(Buffer.from(expected))).toBe(true);
  }

  const tokens = oracle["tokenizer.ggml.tokens"] as string[] | undefined;
  const types = oracle["tokenizer.ggml.token_type"] as number[] | undefined;
  const special = tokens?.filter((_, i) => types?.[i] === 3 || types?.[i] === 4) ?? [];
  expect(ours.specialTokens).toEqual(special);
  return ours;
}

for (const [name, template] of Object.entries(templates)) {
  test(`ISC-3: ${name} template is byte-identical to the oracle`, async () => {
    // llama.cpp renders only what comes before a NUL, so that template is HIGH.
    await compare(name, typicalKvs(template), [], template.includes("\0") ? [["parse_error", "HIGH"]] : []);
  });
}

test("ISC-3: named templates, a non-ASCII name, and tensor info and data after the KVs", async () => {
  const kvs = typicalKvs().filter(([k]) => k !== "tokenizer.chat_templates");
  kvs.push(
    ["tokenizer.chat_template.rag", str("{% for d in documents %}{{ d.text }}{% endfor %}")],
    ["tokenizer.chat_template.ünï", str("ünï ✓")],
    ["tokenizer.chat_templates", arr(T.STRING, ["tool_use", "rag", "ünï"])],
  );
  const r = await compare("named", kvs, [tensor("token_embd.weight", 64), tensor("output.weight", 8)]);
  expect(r.templates.map((t) => t.source.name)).toEqual(["default", "tool_use", "rag", "ünï"]);
});

test("ISC-3: a Gemma-sized vocabulary", async () => {
  await compare("bigvocab", bigVocabKvs(), [tensor("token_embd.weight", 1024)]);
}, 30_000);

test("the oracle is lossy on a leading BOM; bassae keeps the stored bytes", async () => {
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("{{ x }}")]);
  const path = join(dir, "bom.gguf");
  writeFileSync(path, buildGguf([["tokenizer.chat_template", str(bom)]]).bytes);
  const oracle = (await gguf(path, { allowLocalFile: true })).metadata as Record<string, unknown>;
  const ours = await readGgufModel(path);
  expect(oracle["tokenizer.chat_template"]).toBe("{{ x }}");
  expect(Buffer.from(ours.templates[0]!.bytes).equals(Buffer.from(bom))).toBe(true);
});
