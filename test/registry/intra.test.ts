import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readBareTemplate } from "../../src/bare.ts";
import { unifiedDiff } from "../../src/diff.ts";
import { bytesSource, readGgufSource } from "../../src/gguf/index.ts";
import { readHfModel } from "../../src/hf/index.ts";
import { WHOLE_TEMPLATE } from "../../src/parse/parse.ts";
import { checkIntraModel, DIFF_BUDGET, loadPrecedence, loadRegistry, MAX_DIVERGENCE_PAIRS, MAX_PAIR_DIFF_INPUT, MAX_STORED_DIFF, resolveProfiles } from "../../src/registry/index.ts";
import { makeTemplateFromString } from "../../src/template.ts";
import type { ExtractedTemplate, Finding, ModelRecord, TemplateSource } from "../../src/types.ts";
import { buildGguf, str } from "../gguf/builder.ts";
import { makeTree, removeTrees } from "../helpers/tree.ts";

afterAll(removeTrees);

const table = loadPrecedence();
const chatml = (tag: string) => `{%- for m in messages %}\n<|im_start|>{{ m.role }}\n{{ m.content }}<|im_end|>\n{%- endfor %}\n{#- ${tag} #}\n`;
const label = (s: TemplateSource) => (s.key === undefined ? s.path : `${s.path}:${s.key}`);
const rel = (t: ExtractedTemplate) => `${t.source.kind} ${t.source.name}`;

// The shape checkIntraModel puts in a divergence finding's detail.
interface Side {
  kind: string;
  sha256: string;
  loadedBy: string[];
  shadowed: boolean;
}
interface Detail {
  diff: string;
  a: Side;
  b: Side;
}
const detail = (f: Finding) => f.detail as unknown as Detail;

describe("ISC-7.5 on a model holding every HF source kind", async () => {
  const model = await readHfModel(join(import.meta.dir, "fixtures/every-source"));
  const findings = checkIntraModel(model, table);
  const bySha = new Map(model.templates.map((t) => [t.sha256, t]));

  test("one MEDIUM intra_model_divergence per pair of differing same-name templates", () => {
    // Five sources define "default" (10 pairs); tokenizer_config.json and additional_chat_templates/ define "tool_use" (1 pair).
    expect(findings).toHaveLength(11);
    expect(findings.every((f) => f.ruleId === "intra_model_divergence" && f.severity === "MEDIUM")).toBe(true);
    expect(findings.filter((f) => f.templateName === "default")).toHaveLength(10);
    expect(findings.filter((f) => f.templateName === "tool_use")).toHaveLength(1);
    const pairs = findings.map((f) => [detail(f).a.sha256, detail(f).b.sha256].sort().join(" "));
    expect(new Set(pairs).size).toBe(11);
  });

  test("detail.diff is unifiedDiff output labeled with each source's path and key", () => {
    for (const f of findings) {
      const d = detail(f);
      const a = bySha.get(d.a.sha256)!;
      const b = bySha.get(d.b.sha256)!;
      expect(d.diff).toBe(unifiedDiff(a.text, b.text, label(a.source), label(b.source)));
      expect(d.diff).toStartWith(`--- ${label(a.source)}\n+++ ${label(b.source)}\n`);
      expect(f.file).toBe(b.source.path);
      expect(f.templateSha256).toBe(b.sha256);
      expect(f.message).toContain(label(a.source));
    }
    const tc = findings.find((f) => detail(f).b.kind === "tokenizer_config" && detail(f).a.kind === "additional_chat_templates")!;
    expect(detail(tc).diff).toContain("tokenizer_config.json:chat_template[0].template");
  });

  test("the diff's baseline is the template more runtimes load", () => {
    for (const f of findings) {
      const d = detail(f);
      expect(d.a.loadedBy.length).toBeGreaterThanOrEqual(d.b.loadedBy.length);
    }
  });

  test("the span points at b's first differing line", () => {
    for (const f of findings) {
      const b = bySha.get(detail(f).b.sha256)!;
      expect(f.excerpt).toStartWith("{#- source:");
      expect(b.text.slice(f.span!.start, f.span!.end)).toBe(f.excerpt!);
    }
  });

  test("templates no runtime loads are shadowed, and still returned for scanning", () => {
    expect(model.templates).toHaveLength(7);
    const shadowed = model.templates.filter((t) => t.shadowed).map(rel).sort();
    expect(shadowed).toEqual(["chat_template_jinja default", "chat_template_json default", "processor_config default", "tokenizer_config default", "tokenizer_config tool_use"]);
    // additional_chat_templates/tool_use.jinja is what the tokenizer loads when asked for "tool_use".
    expect(model.templates.filter((t) => !t.shadowed).map(rel).sort()).toEqual(["additional_chat_templates default", "additional_chat_templates tool_use"]);
  });
});

describe("ISC-7.5 edge cases", () => {
  test("identical copies of a template are no finding, though the unread copy is shadowed", async () => {
    const model = await readHfModel(makeTree({ "tokenizer_config.json": JSON.stringify({ chat_template: chatml("same") }), "chat_template.jinja": chatml("same") }));
    expect(checkIntraModel(model, table)).toEqual([]);
    expect(model.templates.find((t) => t.source.kind === "tokenizer_config")!.shadowed).toBe(true);
    expect(model.templates.find((t) => t.source.kind === "chat_template_jinja")!.shadowed).toBeUndefined();
  });

  test("a template only some runtimes load is not shadowed", async () => {
    // The processor reads chat_template.json; the tokenizer reads chat_template.jinja.
    const model = await readHfModel(makeTree({ "chat_template.jinja": chatml("j"), "chat_template.json": JSON.stringify({ chat_template: chatml("js") }) }));
    const [f] = checkIntraModel(model, table);
    expect(model.templates.some((t) => t.shadowed)).toBe(false);
    expect(detail(f!).a.loadedBy).toEqual(["transformers-tokenizer", "mlx-lm"]);
    expect(detail(f!).b.loadedBy).toEqual(["transformers-processor"]);
  });

  test("a bare --template file is never shadowed", async () => {
    const dir = makeTree({ "t.jinja": chatml("bare") });
    const model = await readBareTemplate(join(dir, "t.jinja"));
    expect(checkIntraModel(model, table)).toEqual([]);
    expect(model.templates[0]!.shadowed).toBeUndefined();
  });

  test("GGUF: a shadowed duplicate key gets labels that tell the two apart", () => {
    const { bytes } = buildGguf([["tokenizer.chat_template", str(chatml("first"))], ["tokenizer.chat_template", str(chatml("second"))]]);
    const model = readGgufSource(bytesSource(bytes), "/m/x.gguf");
    const findings = checkIntraModel(model, table);
    expect(findings).toHaveLength(1);
    expect(detail(findings[0]!).diff).toStartWith("--- /m/x.gguf:tokenizer.chat_template (first)\n+++ /m/x.gguf:tokenizer.chat_template (second)\n");
    expect(model.templates.map((t) => t.shadowed === true)).toEqual([false, true]);
  });

  test("GGUF: llama.cpp's NUL view counts as loaded, the stored value as loaded by transformers", () => {
    const { bytes } = buildGguf([["tokenizer.chat_template", str(`${chatml("seen")}\0{{ hidden }}`)]]);
    const model = readGgufSource(bytesSource(bytes), "/m/x.gguf");
    checkIntraModel(model, table);
    expect(model.templates).toHaveLength(2);
    expect(model.templates.some((t) => t.shadowed)).toBe(false);
  });

  test("a hostile GGUF repeating one key is capped at MAX_DIVERGENCE_PAIRS findings plus one summary", () => {
    const n = 400;
    const kvs = Array.from({ length: n }, (_, i) => ["tokenizer.chat_template", str(chatml(`copy ${i % 200}`))] as [string, ReturnType<typeof str>]);
    const model = readGgufSource(bytesSource(buildGguf(kvs).bytes), "/m/x.gguf");
    const started = performance.now();
    const findings = checkIntraModel(model, table);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(findings).toHaveLength(MAX_DIVERGENCE_PAIRS + 1);
    // 400 templates in 200 pairs of equal bytes: (400^2 - 200 * 2^2) / 2 differing pairs.
    const total = (n * n - 200 * 4) / 2;
    const summary = findings.at(-1)! as Finding;
    expect(summary.detail).toEqual({ suppressed: total - MAX_DIVERGENCE_PAIRS });
    expect(summary.span).toEqual(WHOLE_TEMPLATE);
    expect(model.templates.filter((t) => !t.shadowed)).toHaveLength(1);
  });

  test("65,000 identical copies of one key cost one pass, and one odd copy among them is still capped (review round 2, Codex N1)", () => {
    const n = 65_000;
    const same = Array.from({ length: n }, () => ["tokenizer.chat_template", str(chatml("same"))] as [string, ReturnType<typeof str>]);
    const identical = readGgufSource(bytesSource(buildGguf(same).bytes), "/m/x.gguf");
    let started = performance.now();
    expect(checkIntraModel(identical, table)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);

    const odd = readGgufSource(bytesSource(buildGguf([...same.slice(1), ["tokenizer.chat_template", str(chatml("odd"))]]).bytes), "/m/x.gguf");
    started = performance.now();
    const findings = checkIntraModel(odd, table);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(findings).toHaveLength(MAX_DIVERGENCE_PAIRS + 1);
    expect(findings.at(-1)!.detail).toEqual({ suppressed: n - 1 - MAX_DIVERGENCE_PAIRS });

    // Every value holds a NUL, so every one has a llama.cpp view to find.
    const nul = readGgufSource(bytesSource(buildGguf(Array.from({ length: n }, () => ["tokenizer.chat_template", str(`${chatml("same")}\0tail`)] as [string, ReturnType<typeof str>])).bytes), "/m/x.gguf");
    started = performance.now();
    resolveProfiles(nul, table);
    checkIntraModel(nul, table);
    expect(performance.now() - started).toBeLessThan(1000);
  }, 30_000);
});

describe("ISC-7.5 memory bound (review round 1, C5)", () => {
  // n same-name GGUF templates, each `units` UTF-16 units of single-letter lines, so every pair differs on every line.
  const letters = (n: number, units: number): ModelRecord => ({
    format: "gguf",
    id: "/m/x.gguf",
    paths: ["/m/x.gguf"],
    templates: Array.from({ length: n }, (_, k) =>
      makeTemplateFromString({ kind: "gguf", path: "/m/x.gguf", realPath: "/m/x.gguf", name: "default", key: "tokenizer.chat_template" }, `${String.fromCharCode(97 + k)}\n`.repeat(units / 2)),
    ),
    hints: {},
    specialTokens: [],
    extractionComplete: true,
    findings: [],
  });

  test("a pair over MAX_PAIR_DIFF_INPUT reports without a diff", () => {
    const [f, ...rest] = checkIntraModel(letters(2, MAX_PAIR_DIFF_INPUT / 2 + 2), table);
    expect(rest).toEqual([]);
    expect(f!.severity).toBe("MEDIUM");
    expect(detail(f!).diff).toMatch(new RegExp(`^--- .*\n\\+\\+\\+ .*\n@@ not diffed: \\d+ and \\d+ UTF-16 units, over the ${MAX_PAIR_DIFF_INPUT}-unit limit for one pair @@\n$`));
    expect(f!.detail!.diffComplete).toBe(false);
    expect(f!.span).toEqual({ start: 0, end: 1, line: 1, col: 1 });
  });

  test("once the model's diff budget is spent, the remaining pairs report without a diff", () => {
    const units = MAX_PAIR_DIFF_INPUT / 4;
    const findings = checkIntraModel(letters(9, units), table);
    // 9 templates make 36 differing pairs: 32 compared, then one summary for the other 4.
    expect(findings).toHaveLength(MAX_DIVERGENCE_PAIRS + 1);
    const pairs = findings.slice(0, -1);
    const diffed = pairs.filter((f) => !detail(f).diff.includes("@@ not diffed"));
    expect(diffed).toHaveLength(Math.floor(DIFF_BUDGET / (2 * units)));
    for (const f of pairs.slice(diffed.length)) expect(detail(f).diff).toEndWith(`@@ not diffed: this model's diff budget of ${DIFF_BUDGET} UTF-16 units is spent @@\n`);
    // Every stored diff, diffed or not, stays within MAX_STORED_DIFF plus its marker line.
    for (const f of pairs) expect(detail(f).diff.length).toBeLessThan(MAX_STORED_DIFF + 100);
  });

  test("a long diff is cut at a line end and marked, keeping the start of the full diff", () => {
    const a = Array.from({ length: 20_000 }, (_, i) => `line ${i}\n`).join("");
    const b = a.replace(/line/g, "LINE");
    const src = (key: string): TemplateSource => ({ kind: "gguf", path: "/m/x.gguf", realPath: "/m/x.gguf", name: "default", key });
    const model = { ...letters(0, 0), templates: [makeTemplateFromString(src("tokenizer.chat_template"), a), makeTemplateFromString(src("tokenizer.chat_template"), b)] };
    const [f] = checkIntraModel(model, table);
    const full = unifiedDiff(a, b, "/m/x.gguf:tokenizer.chat_template (first)", "/m/x.gguf:tokenizer.chat_template (second)");
    const d = detail(f!).diff;
    expect(full.length).toBeGreaterThan(MAX_STORED_DIFF);
    expect(f!.detail!.diffComplete).toBe(false);
    const [, kept, total] = /@@ diff truncated: (\d+) of (\d+) UTF-16 units shown @@\n$/.exec(d)!;
    expect(Number(total)).toBe(full.length);
    expect(Number(kept)).toBeLessThanOrEqual(MAX_STORED_DIFF);
    expect(d.slice(0, Number(kept))).toBe(full.slice(0, Number(kept)));
    expect(full[Number(kept) - 1]).toBe("\n");
  });

  test("a small diff is stored whole", async () => {
    const model = await readHfModel(join(import.meta.dir, "fixtures/every-source"));
    for (const f of checkIntraModel(model, table)) expect(f.detail!.diffComplete).toBe(true);
  });

  test("the span is b's first differing line, with lines broken as LineMap breaks them", () => {
    const src: TemplateSource = { kind: "gguf", path: "/m/x.gguf", realPath: "/m/x.gguf", name: "default", key: "tokenizer.chat_template" };
    const model = { ...letters(0, 0), templates: [makeTemplateFromString(src, "a\rb\r\nc d\ne"), makeTemplateFromString(src, "a\rb\r\nc D\ne")] };
    const [f] = checkIntraModel(model, table);
    expect(f!.span).toEqual({ start: 5, end: 8, line: 3, col: 1 });
    expect(f!.excerpt).toBe("c D");
    const crlf = { ...model, templates: [makeTemplateFromString(src, "x\r"), makeTemplateFromString(src, "x\r\ny")] };
    expect(checkIntraModel(crlf, table)[0]!.excerpt).toBe("x");
  });
});

// The omlx Gemma 4 QAT model ships a chat_template.jinja that differs from its tokenizer_config.json template.
const OMLX_GEMMA = join(homedir(), ".omlx/models/gemma-4-26b-a4b-qat-4bit");

test.skipIf(!existsSync(OMLX_GEMMA))("probe: the omlx Gemma 4 QAT model gets one divergence, with tokenizer_config.json shadowed", async () => {
  const model = await readHfModel(OMLX_GEMMA);
  const findings = checkIntraModel(model, table);
  expect(findings).toHaveLength(1);
  const d = detail(findings[0]!);
  expect([d.a.kind, d.b.kind]).toEqual(["chat_template_jinja", "tokenizer_config"]);
  expect(d.b.shadowed).toBe(true);
  expect(Object.values(resolveProfiles(model, table)).filter(Boolean).map((s) => s!.kind)).toEqual(["chat_template_jinja", "chat_template_jinja", "chat_template_jinja"]);
  // Both sides are upstream text, pinned in the registry.
  const registry = loadRegistry();
  for (const t of model.templates) expect(registry.match(t).kind).toBe("exact");
});
