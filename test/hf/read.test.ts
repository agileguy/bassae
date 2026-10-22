import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { truncateSync } from "node:fs";
import { join } from "node:path";
import { readHfModel } from "../../src/hf/index.ts";
import { MAX_SOURCE_BYTES } from "../../src/hf/sources.ts";
import type { ExtractedTemplate, ModelRecord } from "../../src/types.ts";
import { link, makeTree, removeTrees } from "../helpers/tree.ts";

afterAll(removeTrees);

const json = (v: unknown) => JSON.stringify(v);
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

const summary = (r: ModelRecord) =>
  r.templates.map((t) => ({ kind: t.source.kind, name: t.source.name, key: t.source.key, text: t.text }));

const only = (r: ModelRecord): ExtractedTemplate => {
  expect(r.templates).toHaveLength(1);
  return r.templates[0]!;
};

describe("readHfModel sources", () => {
  test("ISC-5: chat_template as a string in tokenizer_config.json", async () => {
    const root = makeTree({ m: { "tokenizer_config.json": json({ chat_template: "{{ bos_token }}{% for m in messages %}{% endfor %}" }) } });
    const r = await readHfModel(join(root, "m"));
    expect(r.format).toBe("hf");
    expect(r.id).toBe(join(root, "m"));
    expect(r.paths).toEqual([join(root, "m")]);
    expect(r.findings).toEqual([]);
    const t = only(r);
    expect(t.source).toEqual({
      kind: "tokenizer_config",
      path: join(root, "m/tokenizer_config.json"),
      realPath: join(root, "m/tokenizer_config.json"),
      name: "default",
      key: "chat_template",
    });
    expect(t.text).toBe("{{ bos_token }}{% for m in messages %}{% endfor %}");
  });

  test("JSON templates keep the UTF-8 of the decoded string, escapes and all", async () => {
    // ​ is a zero-width space hidden behind a JSON escape; it must survive into the bytes.
    const raw = '{"chat_template": "a\\u200bb\\n\\"é\\""}';
    const root = makeTree({ m: { "tokenizer_config.json": raw } });
    const t = only(await readHfModel(join(root, "m")));
    expect(t.text).toBe('a​b\n"é"');
    expect(t.sha256).toBe(sha('a​b\n"é"'));
  });

  test("ISC-6: chat_template as a list of {name, template}, every entry by name", async () => {
    const root = makeTree({
      m: {
        "tokenizer_config.json": json({
          chat_template: [
            { name: "default", template: "D" },
            { name: "tool_use", template: "T" },
            { name: "rag", template: "R" },
          ],
        }),
      },
    });
    expect(summary(await readHfModel(join(root, "m")))).toEqual([
      { kind: "tokenizer_config", name: "default", key: "chat_template[0].template", text: "D" },
      { kind: "tokenizer_config", name: "tool_use", key: "chat_template[1].template", text: "T" },
      { kind: "tokenizer_config", name: "rag", key: "chat_template[2].template", text: "R" },
    ]);
  });

  test("ISC-7: chat_template.jinja as exact bytes, and the legacy chat_template.json", async () => {
    const jinja = new Uint8Array([0x7b, 0x7b, 0x20, 0xff, 0x20, 0x7d, 0x7d]); // invalid UTF-8 kept as planted
    const root = makeTree({ m: { "chat_template.jinja": jinja, "chat_template.json": json({ chat_template: "LEGACY" }) } });
    const r = await readHfModel(join(root, "m"));
    expect(summary(r)).toEqual([
      { kind: "chat_template_jinja", name: "default", key: undefined, text: "{{ � }}" },
      { kind: "chat_template_json", name: "default", key: "chat_template", text: "LEGACY" },
    ]);
    expect(r.templates[0]!.bytes).toEqual(jinja);
    expect(r.templates[0]!.sha256).toBe(sha(jinja));
    expect(r.templates[0]!.validUtf8).toBe(false);
  });

  test("ISC-7.1: every additional_chat_templates/*.jinja, named by file stem", async () => {
    const root = makeTree({
      m: {
        additional_chat_templates: {
          "tool_use.jinja": "T",
          "rag.v2.jinja": "R",
          "README.md": "not a template",
          "nested": { "deep.jinja": "ignored, as the runtimes ignore it" },
        },
      },
    });
    const r = await readHfModel(join(root, "m"));
    expect(summary(r)).toEqual([
      { kind: "additional_chat_templates", name: "rag.v2", key: undefined, text: "R" },
      { kind: "additional_chat_templates", name: "tool_use", key: undefined, text: "T" },
    ]);
    expect(r.templates[1]!.source.path).toBe(join(root, "m/additional_chat_templates/tool_use.jinja"));
  });

  test("ISC-7.2: chat_template from processor_config.json", async () => {
    const root = makeTree({ m: { "processor_config.json": json({ processor_class: "X", chat_template: "P" }) } });
    expect(summary(await readHfModel(join(root, "m")))).toEqual([
      { kind: "processor_config", name: "default", key: "chat_template", text: "P" },
    ]);
  });

  test("ISC-7.3: chat_template_type and tool_parser_type land in hints", async () => {
    const root = makeTree({
      m: { "tokenizer_config.json": json({ chat_template_type: "deepseek_v32", tool_parser_type: "json_tools" }) },
    });
    const r = await readHfModel(join(root, "m"));
    expect(r.hints).toEqual({ chatTemplateType: "deepseek_v32", toolParserType: "json_tools" });
    expect(r.templates).toEqual([]);
  });

  test("every source in one directory is read, in a fixed order", async () => {
    const root = makeTree({
      m: {
        "tokenizer_config.json": json({ chat_template: "TC" }),
        "chat_template.jinja": "J",
        "chat_template.json": json({ chat_template: "JS" }),
        additional_chat_templates: { "b.jinja": "B", "a.jinja": "A" },
        "processor_config.json": json({ chat_template: "PC" }),
      },
    });
    expect(summary(await readHfModel(join(root, "m"))).map((s) => `${s.kind}:${s.name}:${s.text}`)).toEqual([
      "tokenizer_config:default:TC",
      "chat_template_jinja:default:J",
      "chat_template_json:default:JS",
      "additional_chat_templates:a:A",
      "additional_chat_templates:b:B",
      "processor_config:default:PC",
    ]);
  });

  test("a tokenizer_config.json without a template yields no templates and no findings", async () => {
    const root = makeTree({ m: { "tokenizer_config.json": json({ model_max_length: 8192 }) } });
    const r = await readHfModel(join(root, "m"));
    expect(r.templates).toEqual([]);
    expect(r.findings).toEqual([]);
  });
});

describe("readHfModel never throws on bad input", () => {
  test("malformed JSON is a MEDIUM parse_error and the other sources are still read", async () => {
    const root = makeTree({
      m: {
        "tokenizer_config.json": '{"chat_template": "unterminated',
        "processor_config.json": "[1,",
        "chat_template.jinja": "J",
      },
    });
    const r = await readHfModel(join(root, "m"));
    expect(summary(r).map((s) => s.text)).toEqual(["J"]);
    expect(r.findings.map((f) => [f.ruleId, f.severity, f.file])).toEqual([
      ["parse_error", "MEDIUM", join(root, "m/tokenizer_config.json")],
      ["parse_error", "MEDIUM", join(root, "m/processor_config.json")],
    ]);
  });

  test("a bad list entry is a finding; the good entries are still read", async () => {
    const root = makeTree({
      m: {
        "tokenizer_config.json": json({
          chat_template: [{ name: "default", template: "D" }, { name: "broken" }, "nope", { name: 7, template: "N" }, { name: "x", template: "X" }],
        }),
      },
    });
    const r = await readHfModel(join(root, "m"));
    expect(summary(r).map((s) => `${s.name}:${s.key}`)).toEqual(["default:chat_template[0].template", "x:chat_template[4].template"]);
    expect(r.findings.map((f) => [f.ruleId, f.severity, f.detail?.key])).toEqual([
      ["parse_error", "MEDIUM", "chat_template[1]"],
      ["parse_error", "MEDIUM", "chat_template[2]"],
      ["parse_error", "MEDIUM", "chat_template[3]"],
    ]);
  });

  test("chat_template of the wrong type is a finding", async () => {
    const root = makeTree({ m: { "tokenizer_config.json": json({ chat_template: { template: "x" } }), "chat_template.json": json([1]) } });
    const r = await readHfModel(join(root, "m"));
    expect(r.templates).toEqual([]);
    expect(r.findings.map((f) => [f.ruleId, f.severity])).toEqual([
      ["parse_error", "MEDIUM"],
      ["parse_error", "MEDIUM"],
    ]);
  });

  test("a missing directory or a dangling source becomes a finding, not a throw", async () => {
    const root = makeTree({ m: { "chat_template.jinja": link("gone.jinja") } });
    const missing = await readHfModel(join(root, "nope"));
    expect(missing.templates).toEqual([]);
    expect(missing.findings.map((f) => f.ruleId)).toEqual(["scanner_error"]);
    const dangling = await readHfModel(join(root, "m"));
    expect(dangling.templates).toEqual([]);
    expect(dangling.findings.map((f) => [f.ruleId, f.file])).toEqual([["scanner_error", join(root, "m/chat_template.jinja")]]);
  });

  test("a template source over the size cap is a HIGH parse_error and is not read", async () => {
    const root = makeTree({ m: { "chat_template.jinja": "" } });
    truncateSync(join(root, "m/chat_template.jinja"), MAX_SOURCE_BYTES + 1); // sparse, costs no disk
    const r = await readHfModel(join(root, "m"));
    expect(r.templates).toEqual([]);
    expect(r.findings.map((f) => [f.ruleId, f.severity])).toEqual([["parse_error", "HIGH"]]);
  });

  test("a FIFO planted under a source name does not hang the read", async () => {
    const root = makeTree({ m: { "tokenizer_config.json": json({ chat_template: "T" }) } });
    expect(Bun.spawnSync(["mkfifo", join(root, "m/chat_template.jinja")]).exitCode).toBe(0);
    const r = await readHfModel(join(root, "m"));
    expect(summary(r).map((s) => s.text)).toEqual(["T"]);
    expect(r.findings.map((f) => [f.ruleId, f.file])).toEqual([["scanner_error", join(root, "m/chat_template.jinja")]]);
  });

  test("additional_chat_templates as a file, not a directory, is a finding", async () => {
    const root = makeTree({ m: { additional_chat_templates: "oops", "chat_template.jinja": "J" } });
    const r = await readHfModel(join(root, "m"));
    expect(summary(r).map((s) => s.text)).toEqual(["J"]);
    expect(r.findings.map((f) => f.ruleId)).toEqual(["scanner_error"]);
  });
});

describe("special tokens", () => {
  test("tokenizer.json added_tokens plus tokenizer_config.json added_tokens_decoder, deduplicated", async () => {
    const root = makeTree({
      m: {
        "tokenizer.json": json({
          added_tokens: [
            { id: 1, content: "<|im_start|>", special: true },
            { id: 2, content: "<think>", special: false },
          ],
        }),
        "tokenizer_config.json": json({
          added_tokens_decoder: { "1": { content: "<|im_start|>", special: true }, "3": { content: "<|im_end|>", special: true } },
        }),
      },
    });
    expect((await readHfModel(join(root, "m"))).specialTokens).toEqual(["<|im_start|>", "<think>", "<|im_end|>"]);
  });

  test("a malformed tokenizer.json is a finding and the templates are still read", async () => {
    const root = makeTree({ m: { "tokenizer.json": "{", "chat_template.jinja": "J" } });
    const r = await readHfModel(join(root, "m"));
    expect(r.templates).toHaveLength(1);
    expect(r.findings.map((f) => [f.ruleId, f.file])).toEqual([["parse_error", join(root, "m/tokenizer.json")]]);
  });
});

describe("ISC-11: HF cache snapshots resolve to blobs", () => {
  test("source path is the snapshot path, realPath is the blob, and the cache location is filled", async () => {
    const root = makeTree({
      "models--org--name": {
        blobs: { aaa: json({ chat_template: "SHARED" }), ccc: "JINJA" },
        snapshots: {
          r1: { "tokenizer_config.json": link("../../blobs/aaa") },
          r2: { "tokenizer_config.json": link("../../blobs/aaa"), "chat_template.jinja": link("../../blobs/ccc") },
        },
      },
    });
    const snap = (r: string) => join(root, "models--org--name/snapshots", r);
    const r1 = await readHfModel(snap("r1"));
    const r2 = await readHfModel(snap("r2"));
    expect(r1.hfCache).toEqual({ repo: "org/name", revision: "r1", pathInRepo: "" });
    expect(r2.hfCache).toEqual({ repo: "org/name", revision: "r2", pathInRepo: "" });
    const a = only(r1);
    const b = r2.templates[0]!;
    expect(a.source.path).toBe(join(snap("r1"), "tokenizer_config.json"));
    expect(b.source.path).toBe(join(snap("r2"), "tokenizer_config.json"));
    expect(a.source.realPath).toBe(join(root, "models--org--name/blobs/aaa"));
    expect(b.source.realPath).toBe(a.source.realPath);
    expect(b.sha256).toBe(a.sha256);
    expect(r2.templates[1]!.source.realPath).toBe(join(root, "models--org--name/blobs/ccc"));
  });

  test("a model dir reached through a symlink keeps the reaching path and reads the real dir", async () => {
    const root = makeTree({
      hub: { "models--o--n": { snapshots: { r9: { "chat_template.jinja": "x" } } } },
      omlx: { n: link("../hub/models--o--n/snapshots/r9") },
    });
    const r = await readHfModel(join(root, "omlx/n"));
    expect(r.id).toBe(join(root, "hub/models--o--n/snapshots/r9"));
    expect(r.paths).toEqual([join(root, "omlx/n")]);
    expect(r.hfCache).toEqual({ repo: "o/n", revision: "r9", pathInRepo: "" });
    expect(only(r).source.path).toBe(join(root, "omlx/n/chat_template.jinja"));
    expect(only(r).source.realPath).toBe(join(root, "hub/models--o--n/snapshots/r9/chat_template.jinja"));
  });
});
