import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { bytesSource, readGgufSource } from "../../src/gguf/index.ts";
import { readHfModel } from "../../src/hf/index.ts";
import { loadPrecedence, RUNTIME_PROFILES, resolveProfiles } from "../../src/registry/index.ts";
import type { ModelRecord, RuntimeProfile, TemplateSource } from "../../src/types.ts";
import { buildGguf, str } from "../gguf/builder.ts";
import { makeTree, removeTrees, type Tree } from "../helpers/tree.ts";

afterAll(removeTrees);

const table = loadPrecedence();
const chatml = (tag: string) => `{%- for m in messages %}<|im_start|>{{ m.role }}\n{{ m.content }}<|im_end|>\n{%- endfor %}{#- ${tag} #}`;
const json = (v: unknown) => JSON.stringify(v);

// A loaded source as "kind name", or "-" when the runtime loads nothing.
const id = (s: TemplateSource | undefined) => (s ? `${s.kind} ${s.name}` : "-");
const resolved = (model: ModelRecord) => Object.fromEntries(Object.entries(resolveProfiles(model, table)).map(([p, s]) => [p, id(s)]));
const expected = (tok: string, proc: string, mlx: string, llama: string): Record<RuntimeProfile, string> => ({
  "transformers-tokenizer": tok,
  "transformers-processor": proc,
  "mlx-lm": mlx,
  "llama.cpp": llama,
});

describe("precedence.json", () => {
  test("covers all four runtime profiles, each cited as owner/repo@tag (commit):file", () => {
    expect(Object.keys(table.order).sort()).toEqual([...RUNTIME_PROFILES].sort());
    for (const p of RUNTIME_PROFILES) {
      expect(table.order[p].length).toBeGreaterThan(0);
      expect(table.provenance[p]).toMatch(/^[\w.-]+\/[\w.-]+@[\w.-]+ \([0-9a-f]{40}\):[\w./-]+ L\d+/);
    }
  });

  test("the tokenizer never reads processor sources, and llama.cpp reads only GGUF", () => {
    expect(table.order["transformers-tokenizer"]).not.toContain("processor_config");
    expect(table.order["transformers-tokenizer"]).not.toContain("chat_template_json");
    expect(table.order["llama.cpp"]).toEqual(["gguf"]);
  });
});

describe("ISC-7.4: resolveProfiles on a model holding every HF source kind", () => {
  test("returns exactly the table's answer for each profile", async () => {
    const model = await readHfModel(join(import.meta.dir, "fixtures/every-source"));
    expect(new Set(model.templates.map((t) => t.source.kind))).toEqual(
      new Set(["tokenizer_config", "chat_template_jinja", "chat_template_json", "additional_chat_templates", "processor_config"]),
    );
    // transformers-tokenizer: additional templates overwrite chat_template.jinja by name, and the result replaces tokenizer_config.json's.
    // transformers-processor: chat_template.json beside additional_chat_templates/ raises ValueError, so no template loads.
    // mlx-lm loads through AutoTokenizer, so it matches the tokenizer. llama.cpp reads no HF source.
    expect(resolved(model)).toEqual(expected("additional_chat_templates default", "-", "additional_chat_templates default", "-"));
    expect(resolveProfiles(model, table)["transformers-tokenizer"]?.path).toEndWith("additional_chat_templates/default.jinja");
  });
});

describe("HF rules", () => {
  const cases: [string, Tree, Record<RuntimeProfile, string>][] = [
    ["tokenizer_config.json alone", { "tokenizer_config.json": json({ chat_template: chatml("tc") }) }, expected("tokenizer_config default", "-", "tokenizer_config default", "-")],
    [
      "chat_template.jinja replaces tokenizer_config.json's template",
      { "tokenizer_config.json": json({ chat_template: chatml("tc") }), "chat_template.jinja": chatml("j") },
      expected("chat_template_jinja default", "chat_template_jinja default", "chat_template_jinja default", "-"),
    ],
    [
      "additional_chat_templates/file.jinja stands in for chat_template.jinja",
      { "chat_template.jinja": chatml("j"), additional_chat_templates: { "file.jinja": chatml("file") } },
      expected("additional_chat_templates file", "chat_template_jinja default", "additional_chat_templates file", "-"),
    ],
    [
      "additional_chat_templates/default.jinja wins over file.jinja",
      { "chat_template.jinja": chatml("j"), additional_chat_templates: { "file.jinja": chatml("file"), "default.jinja": chatml("ad") } },
      expected("additional_chat_templates default", "chat_template_jinja default", "additional_chat_templates default", "-"),
    ],
    [
      "the processor prefers legacy chat_template.json over chat_template.jinja",
      { "chat_template.jinja": chatml("j"), "chat_template.json": json({ chat_template: chatml("js") }) },
      expected("chat_template_jinja default", "chat_template_json default", "chat_template_jinja default", "-"),
    ],
    [
      "processor_config.json's chat_template keeps priority in the processor",
      { "processor_config.json": json({ processor_class: "P", chat_template: chatml("pc") }), "chat_template.json": json({ chat_template: chatml("js") }) },
      expected("-", "processor_config default", "-", "-"),
    ],
    [
      "chat_template.json beside additional_chat_templates/ makes the processor raise",
      { "chat_template.json": json({ chat_template: chatml("js") }), additional_chat_templates: { "default.jinja": chatml("ad") } },
      expected("additional_chat_templates default", "-", "additional_chat_templates default", "-"),
    ],
    [
      "mlx-lm's chat_template_type swaps in a built-in template",
      { "tokenizer_config.json": json({ chat_template: chatml("tc"), chat_template_type: "deepseek" }) },
      expected("tokenizer_config default", "-", "-", "-"),
    ],
  ];

  for (const [name, tree, want] of cases) {
    test(name, async () => {
      expect(resolved(await readHfModel(makeTree(tree)))).toEqual(want);
    });
  }

  test("a list-valued tokenizer_config.json template with no default entry loads no default", async () => {
    const model = await readHfModel(makeTree({ "tokenizer_config.json": json({ chat_template: [{ name: "tool_use", template: chatml("tu") }] }) }));
    expect(resolved(model)).toEqual(expected("-", "-", "-", "-"));
  });
});

describe("GGUF rules", () => {
  const read = (kvs: [string, string | Uint8Array][]) =>
    readGgufSource(bytesSource(buildGguf([["general.architecture", str("llama")], ...kvs.map(([k, v]) => [k, str(v)] as [string, ReturnType<typeof str>])]).bytes), "/m/model.gguf");
  const source = (model: ModelRecord, key: string) => model.templates.find((t) => t.source.key === key)?.source;

  test("both runtimes load the bare key as the default; named keys are not the default", () => {
    const m = read([["tokenizer.chat_template.tool_use", chatml("tu")], ["tokenizer.chat_template", chatml("bare")], ["tokenizer.chat_template.rag", chatml("rag")]]);
    const r = resolveProfiles(m, table);
    expect(r["transformers-tokenizer"]).toBe(source(m, "tokenizer.chat_template"));
    expect(r["llama.cpp"]).toBe(source(m, "tokenizer.chat_template"));
    expect(r["transformers-processor"]).toBeUndefined();
    expect(r["mlx-lm"]).toBeUndefined();
  });

  test("llama.cpp falls back to tool_use when the default is \"chatml\", empty or absent; transformers does not", () => {
    for (const bare of ["chatml", "", undefined]) {
      const kvs: [string, string][] = [["tokenizer.chat_template.tool_use", chatml("tu")]];
      if (bare !== undefined) kvs.push(["tokenizer.chat_template", bare]);
      const m = read(kvs);
      const r = resolveProfiles(m, table);
      expect(r["llama.cpp"]).toBe(source(m, "tokenizer.chat_template.tool_use"));
      expect(r["transformers-tokenizer"]).toBe(bare === undefined ? undefined : source(m, "tokenizer.chat_template"));
    }
  });

  test("llama.cpp renders the bytes before a NUL in the value; transformers reads the whole value", () => {
    const m = read([["tokenizer.chat_template", `${chatml("seen")}\0{{ hidden }}`]]);
    const r = resolveProfiles(m, table);
    const n = new TextEncoder().encode(chatml("seen")).length;
    expect(r["llama.cpp"]).toBe(source(m, `tokenizer.chat_template[:${n}]`));
    expect(r["transformers-tokenizer"]).toBe(source(m, "tokenizer.chat_template"));
  });

  test("llama.cpp ends a key at its NUL and takes the first match; transformers needs the exact key", () => {
    const m = read([["tokenizer.chat_template\0x", chatml("nul-key")], ["tokenizer.chat_template", chatml("bare")]]);
    const r = resolveProfiles(m, table);
    expect(r["llama.cpp"]).toBe(source(m, "tokenizer.chat_template\0x"));
    expect(r["transformers-tokenizer"]).toBe(source(m, "tokenizer.chat_template"));
  });

  test("a repeated key resolves to its first occurrence in both runtimes", () => {
    const m = read([["tokenizer.chat_template", chatml("first")], ["tokenizer.chat_template", chatml("second")]]);
    const r = resolveProfiles(m, table);
    expect(r["llama.cpp"]).toBe(m.templates[0]!.source);
    expect(r["transformers-tokenizer"]).toBe(m.templates[0]!.source);
  });
});
