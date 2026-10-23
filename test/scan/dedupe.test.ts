// ISC-11: identical content is analyzed once across the scan, and every place that reaches it is listed.

import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { scan } from "../../src/scan/index.ts";
import type { DiffRenderInput, DiffRenderResult } from "../../src/types.ts";
import { link, makeTree, removeTrees } from "../helpers/tree.ts";
import { CHATML, CHATML_MEDIUM, completeRender, countingRender, hfCacheRepo, hfModel, options, REV_A, REV_B, tokenizerConfig } from "./fixtures/pipeline.ts";

afterAll(removeTrees);

const files = { "tokenizer_config.json": tokenizerConfig(), "chat_template.jinja": CHATML };

describe("ISC-11: analyzed once, every site listed", () => {
  test("two HF-cache snapshots whose template files link to one blob: one analysis, both (repo, revision, path) sites", async () => {
    const root = makeTree({ "models--acme--chat": hfCacheRepo({ [REV_A]: files, [REV_B]: files }) });
    const render = countingRender();
    const report = await scan(options([root], { diffRender: render.hook }));

    expect(report.models).toHaveLength(2);
    expect(render.inputs).toHaveLength(1);

    const sites = report.models.flatMap((m) => m.templates.flatMap((t) => t.sites));
    expect(sites.map((s) => s.hfCache)).toEqual([
      { repo: "acme/chat", revision: REV_A, pathInRepo: "chat_template.jinja" },
      { repo: "acme/chat", revision: REV_B, pathInRepo: "chat_template.jinja" },
    ]);
    // Both snapshot files resolve to the one blob.
    expect(new Set(sites.map((s) => s.realPath)).size).toBe(1);
    expect(sites.map((s) => s.path)).toEqual([
      join(root, "models--acme--chat/snapshots", REV_A, "chat_template.jinja"),
      join(root, "models--acme--chat/snapshots", REV_B, "chat_template.jinja"),
    ]);
    // Each report carries the analysis, stamped with its own file.
    for (const m of report.models) {
      const t = m.templates[0]!;
      expect(t.status).toBe("clean-unverified");
      expect(t.probes.total).toBe(4);
    }
  });

  test("findings from a shared analysis name each report's own file", async () => {
    const root = makeTree({ a: hfModel(CHATML_MEDIUM), b: hfModel(CHATML_MEDIUM) });
    const render = countingRender();
    const report = await scan(options([root], { diffRender: render.hook }));
    expect(render.inputs).toHaveLength(1);
    for (const m of report.models) {
      const t = m.templates[0]!;
      expect(t.findings.length).toBeGreaterThan(0);
      for (const f of t.findings) expect(f.file).toBe(join(m.id, "chat_template.jinja"));
    }
  });

  test("different scaffolding is a different analysis: the same bytes under other special tokens run again", async () => {
    const root = makeTree({ a: hfModel(CHATML), b: { "tokenizer_config.json": "{}", "chat_template.jinja": CHATML } });
    const render = countingRender();
    const report = await scan(options([root], { diffRender: render.hook }));
    expect(render.inputs).toHaveLength(2);
    const [a, b] = report.models;
    expect(a!.templates[0]!.status).toBe("clean-unverified");
    // Without declared special tokens, the ChatML markers read as injected text.
    expect(b!.templates[0]!.findings.map((f) => f.ruleId)).toContain("unbaselined_text");
  });

  test("one model carrying the same template in two sources gives one report with both sites, each with its own shadowed flag", async () => {
    const root = makeTree({ m: { "tokenizer_config.json": tokenizerConfig({ chat_template: CHATML }), "chat_template.jinja": CHATML } });
    const render = countingRender();
    const report = await scan(options([root], { diffRender: render.hook }));
    const m = report.models[0]!;
    expect(m.templates).toHaveLength(1);
    expect(render.inputs).toHaveLength(1);
    const sites = m.templates[0]!.sites;
    expect(sites.map((s) => [s.kind, s.shadowed])).toEqual([
      ["chat_template_jinja", false],
      ["tokenizer_config", true],
    ]);
    expect(sites[1]!.key).toBe("chat_template");
  });

  test("a model reached through a directory link lists the template at every path", async () => {
    const root = makeTree({ real: { m: hfModel(CHATML) }, alias: link("real") });
    const report = await scan(options([root]));
    expect(report.models).toHaveLength(1);
    const m = report.models[0]!;
    expect(m.paths).toEqual([join(root, "alias/m"), join(root, "real/m")]);
    expect(m.templates[0]!.sites.map((s) => s.path)).toEqual([join(root, "alias/m/chat_template.jinja"), join(root, "real/m/chat_template.jinja")]);
  });

  test("rendering runs in a pool of at most 8", async () => {
    const dirs: Record<string, ReturnType<typeof hfModel>> = {};
    for (let i = 0; i < 20; i++) dirs[`m${String(i).padStart(2, "0")}`] = hfModel(CHATML.replace("assistant", `assistant ${i}`));
    const root = makeTree(dirs);
    let inFlight = 0;
    let peak = 0;
    const slow = async (_: DiffRenderInput): Promise<DiffRenderResult> => {
      peak = Math.max(peak, ++inFlight);
      await Bun.sleep(5);
      inFlight--;
      return completeRender();
    };
    const render = countingRender(slow);
    await scan(options([root], { diffRender: render.hook }));
    expect(render.inputs).toHaveLength(20);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });
});
