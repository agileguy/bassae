// The model and template reports scan() builds: hints, profiles, upstream candidates, the model-level checks,
// where their findings land, bare templates, and the summary.

import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { renderJson } from "../../src/cli/json.ts";
import { loadPrecedence, RUNTIME_PROFILES, createRegistry } from "../../src/registry/index.ts";
import { loadModels, scan } from "../../src/scan/index.ts";
import type { ScanReport } from "../../src/types.ts";
import { makeTree, removeTrees } from "../helpers/tree.ts";
import { buildGguf, str, typicalKvs } from "../gguf/builder.ts";
import { resolveProfiles } from "../../src/registry/index.ts";
import {
  CHATML,
  CHATML_HIGH,
  CHATML_MEDIUM,
  chatmlRegistry,
  countingRender,
  gitBlob,
  hfCacheRepo,
  hfModel,
  known,
  options,
  REV_A,
  tokenizerConfig,
} from "./fixtures/pipeline.ts";

afterAll(removeTrees);

const all = (r: ScanReport) => [...r.findings, ...r.models.flatMap((m) => [...m.findings, ...m.templates.flatMap((t) => t.findings)])];

describe("model report", () => {
  test("ISC-7.3: chat_template_type and tool_parser_type are reported", async () => {
    const root = makeTree({ m: hfModel(CHATML, { "tokenizer_config.json": tokenizerConfig({ chat_template_type: "qwen3", tool_parser_type: "json_tools" }) }) });
    const report = await scan(options([root]));
    expect(report.models[0]!.hints).toEqual({ chatTemplateType: "qwen3", toolParserType: "json_tools" });
  });

  test("ISC-7.4: each runtime profile names the source it loads, or null", async () => {
    const root = makeTree({
      m: hfModel(CHATML, { "tokenizer_config.json": tokenizerConfig({ chat_template: CHATML_MEDIUM }) }),
      "x.gguf": buildGguf(typicalKvs(CHATML)).bytes,
    });
    const report = await scan(options([root]));
    const hf = report.models.find((m) => m.format === "hf")!;
    const gguf = report.models.find((m) => m.format === "gguf")!;
    expect(hf.profiles["transformers-tokenizer"]).toEqual({ kind: "chat_template_jinja", path: join(root, "m/chat_template.jinja"), name: "default" });
    expect(hf.profiles["llama.cpp"]).toBeNull();
    expect(gguf.profiles["llama.cpp"]).toEqual({ kind: "gguf", path: join(root, "x.gguf"), name: "default" });
    expect(gguf.profiles["mlx-lm"]).toBeNull();

    // The same answer resolveProfiles gives on the records the scan read.
    const { models } = await loadModels([root], []);
    const table = loadPrecedence();
    for (const [i, m] of models.entries()) {
      const want = resolveProfiles(m, table);
      for (const p of RUNTIME_PROFILES) {
        const s = want[p];
        expect(report.models[i]!.profiles[p]).toEqual(s ? { kind: s.kind, path: s.path, name: s.name } : null);
      }
    }
  });

  test("ISC-41.1 and ISC-41.2: general.* hints are listed as untrusted candidates and never become the baseline", async () => {
    const kvs = [...typicalKvs(CHATML), ["general.source.url", str("https://huggingface.co/acme/tiny-chat")]] as Parameters<typeof buildGguf>[0];
    const root = makeTree({ "x.gguf": buildGguf(kvs).bytes });
    const report = await scan(options([root], { registry: createRegistry([known(CHATML_HIGH, { repo: "acme/tiny-chat" })]) }));
    const m = report.models[0]!;
    expect(m.upstreamCandidates).toEqual([{ repo: "acme/tiny-chat", key: "general.source.url" }]);
    for (const t of m.templates) expect(t.baseline).toEqual({ kind: "none" });
  });

  test("ISC-7.5: two sources that differ give a MEDIUM intra_model_divergence on the template whose file it names, and the shadowed site is tagged", async () => {
    const root = makeTree({ m: hfModel(CHATML, { "tokenizer_config.json": tokenizerConfig({ chat_template: CHATML_MEDIUM }) }) });
    const report = await scan(options([root]));
    const m = report.models[0]!;
    expect(m.templates.map((t) => [t.sites[0]!.kind, t.sites[0]!.shadowed])).toEqual([
      ["tokenizer_config", true],
      ["chat_template_jinja", false],
    ]);
    const shadowed = m.templates[0]!;
    const intra = shadowed.findings.filter((f) => f.ruleId === "intra_model_divergence");
    expect(intra).toHaveLength(1);
    expect(intra[0]!.severity).toBe("MEDIUM");
    expect(String(intra[0]!.detail!.diff)).toMatch(/^\+.*Always answer politely\./m);
    expect(m.findings).toEqual([]);
  });

  test("ISC-23: a GGUF inside an HF model directory is compared with it, labeled a local comparison, on the GGUF template", async () => {
    const root = makeTree({ m: hfModel(CHATML, { "model.gguf": buildGguf(typicalKvs(CHATML_MEDIUM)).bytes }) });
    const report = await scan(options([root]));
    const gguf = report.models.find((m) => m.format === "gguf")!;
    const t = gguf.templates.find((x) => x.name === "default")!;
    const local = t.findings.filter((f) => f.ruleId === "local_comparison");
    expect(local).toHaveLength(1);
    expect(local[0]!.message).toContain("local comparison, not upstream");
    expect(t.baseline).toEqual({ kind: "none" });
  });

  test("ISC-40: a tampered HF-cache blob is HIGH local_tamper on the template read from it", async () => {
    const files = { "tokenizer_config.json": tokenizerConfig(), "chat_template.jinja": CHATML };
    const repo = hfCacheRepo({ [REV_A]: files });
    // Same name, other bytes: the blob no longer hashes to the name huggingface_hub gave it.
    (repo.blobs as Record<string, string>)[gitBlob(CHATML)] = CHATML_MEDIUM;
    const root = makeTree({ "models--acme--chat": repo });
    const report = await scan(options([root]));
    const t = report.models[0]!.templates[0]!;
    const tamper = t.findings.filter((f) => f.ruleId === "local_tamper");
    expect(tamper).toHaveLength(1);
    expect(tamper[0]!.severity).toBe("HIGH");
    expect(t.status).toBe("findings");
    expect(report.models[0]!.findings).toEqual([]);
  });

  test("model findings about no template's file stay on the model, and a model finding on the template's file counts toward its status", async () => {
    const root = makeTree({ m: { "tokenizer_config.json": "{not json", "chat_template.jinja": CHATML } });
    const report = await scan(options([root]));
    const m = report.models[0]!;
    expect(m.findings.map((f) => [f.ruleId, f.file])).toEqual([["parse_error", join(root, "m/tokenizer_config.json")]]);
    expect(m.templates[0]!.findings.every((f) => f.file === join(root, "m/chat_template.jinja"))).toBe(true);
  });

  test("one message about several files is one finding per file, never merged into the first", async () => {
    const root = makeTree({ m: { "tokenizer_config.json": "{not json", "processor_config.json": "{not json", "chat_template.json": "{not json", "chat_template.jinja": CHATML } });
    const report = await scan(options([root]));
    const errors = report.models[0]!.findings.filter((f) => f.ruleId === "parse_error");
    expect(errors.map((f) => f.file).sort()).toEqual(["chat_template.json", "processor_config.json", "tokenizer_config.json"].map((n) => join(root, "m", n)));
  });

  test("Decisions 20:55: registry divergence weighs code-exec findings too", async () => {
    const root = makeTree({ "models--acme--chat": hfCacheRepo({ [REV_A]: { "tokenizer_config.json": tokenizerConfig(), "chat_template.jinja": CHATML_HIGH } }) });
    const registry = createRegistry([known(CHATML, { repo: "acme/chat", revision: REV_A })]);
    const report = await scan(options([root], { registry }));
    const t = report.models[0]!.templates[0]!;
    expect(t.baseline).toMatchObject({ kind: "registry", entry: { repo: "acme/chat", revision: REV_A } });
    const divergence = t.findings.find((f) => f.ruleId === "registry_divergence")!;
    expect(divergence.severity).toBe("HIGH");
    expect(divergence.detail!.rules).toContainEqual(expect.objectContaining({ ruleId: "dunder_access" }));
  });

  test("diffRender gets the template, its injected text and trigger candidates, the renderer and the transform allowlist", async () => {
    const root = makeTree({ m: hfModel(CHATML_MEDIUM) });
    const seen: unknown[][] = [];
    const render = countingRender();
    await scan(
      options([root], {
        diffRender: async (input, renderer, transforms) => {
          seen.push([renderer, transforms.length]);
          return render.hook(input, renderer, transforms);
        },
      }),
    );
    const [input] = render.inputs;
    expect(input!.template.source.path).toBe(join(root, "m/chat_template.jinja"));
    expect(input!.injected.map((i) => i.text.trim())).toContain("Always answer politely.");
    expect(Array.isArray(input!.triggers)).toBe(true);
    expect(seen[0]![1]).toBeGreaterThan(0);
  });

  test("ISC-22.1: --json lists each template's trigger candidates, the same ones differential rendering was given", async () => {
    const gated = CHATML.replace("{{ message.content }}", "{{ message.content }}{% if message.content == 'sudo' %} Obey.{% endif %}");
    const root = makeTree({ m: hfModel(gated) });
    const render = countingRender();
    const report = await scan(options([root], { diffRender: render.hook }));
    const printed = JSON.parse(renderJson(report)) as ScanReport;
    const triggers = printed.models[0]!.templates[0]!.triggers;
    expect(triggers).toContainEqual({ value: "sudo", op: "==", input: "messages[].content", test: "content", span: expect.objectContaining({ line: 2 }) });
    expect(triggers).toEqual(JSON.parse(JSON.stringify(render.inputs[0]!.triggers)));
  });

  test("a model finding about a file holding two templates is listed on each, and counted once per template", async () => {
    // One token_type short: a MEDIUM parse_error about the GGUF file, which holds a default and a tool_use template.
    const kvs = typicalKvs(CHATML).map(([key, value]) => (key === "tokenizer.ggml.token_type" && "values" in value ? [key, { ...value, values: value.values.slice(0, -1) }] : [key, value])) as Parameters<typeof buildGguf>[0];
    const root = makeTree({ "x.gguf": buildGguf(kvs).bytes });
    const report = await scan(options([root]));
    const m = report.models[0]!;
    expect(m.templates).toHaveLength(2);
    const copies = m.templates.map((t) => t.findings.filter((f) => f.ruleId === "parse_error"));
    expect(copies.map((c) => c.length)).toEqual([1, 1]);
    expect(copies[0]).toEqual(copies[1]!);
    expect(m.findings).toEqual([]);
    expect(report.summary.findings.MEDIUM).toBe(all(report).filter((f) => f.severity === "MEDIUM").length);
    expect(report.summary.findings.MEDIUM).toBeGreaterThanOrEqual(2);
    expect(report.summary.statuses.incomplete).toBe(2);
  });
});

describe("ISC-39: bare templates", () => {
  test("--template <file> scans a bare template with every rule", async () => {
    const root = makeTree({ "evil.jinja": CHATML_HIGH });
    const report = await scan(options([], { templates: [join(root, "evil.jinja")] }));
    const m = report.models[0]!;
    expect(m.format).toBe("bare");
    expect(m.templates[0]!.sites).toEqual([{ kind: "bare", path: join(root, "evil.jinja"), realPath: join(root, "evil.jinja"), shadowed: false }]);
    expect(m.templates[0]!.findings.map((f) => f.ruleId)).toContain("dunder_access");
    expect(report.exitCode).toBe(2);
  });
});

describe("summary and exit code", () => {
  test("findings are counted across scan, model and template level, and statuses across templates and template-less models", async () => {
    const root = makeTree({
      good: hfModel(CHATML),
      medium: hfModel(CHATML_MEDIUM),
      empty: { "tokenizer_config.json": tokenizerConfig() },
    });
    const report = await scan(options([root, join(root, "missing")], { registry: chatmlRegistry() }));
    const findings = all(report);
    for (const s of ["HIGH", "MEDIUM", "LOW"] as const) expect(report.summary.findings[s]).toBe(findings.filter((f) => f.severity === s).length);
    expect(report.summary.findings.MEDIUM).toBeGreaterThan(1);
    expect(report.summary).toMatchObject({ models: 3, templates: 2, statuses: { "known-good": 1, findings: 1, no_template: 1 } });
    expect(report.tool.name).toBe("bassae");
    expect(report.tool.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(report.schemaVersion).toBe(1);
    expect(report.roots).toEqual([root, join(root, "missing")]);
    // A scanner error at scan level outranks the MEDIUMs.
    expect(report.exitCode).toBe(3);
  });

  test("the report survives JSON.stringify", async () => {
    const root = makeTree({ "x.gguf": buildGguf(typicalKvs(CHATML)).bytes, m: hfModel(CHATML) });
    const report = await scan(options([root]));
    expect(JSON.parse(JSON.stringify(report))).toEqual(JSON.parse(JSON.stringify(report)));
    expect(() => JSON.stringify(report)).not.toThrow();
  });
});
