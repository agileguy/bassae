// ISC-42 and ISC-42.1 through scan(): one fixture per status, each template with exactly one.

import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { scan } from "../../src/scan/index.ts";
import type { ScanReport, TemplateReport } from "../../src/types.ts";
import { makeTree, removeTrees } from "../helpers/tree.ts";
import {
  CHATML,
  CHATML_HIGH,
  CHATML_MEDIUM,
  CHATML_UNANALYZABLE,
  CHATML_VARIANT,
  chatmlRegistry,
  failedRender,
  hfModel,
  options,
  tokenizerConfig,
} from "./fixtures/pipeline.ts";

afterAll(removeTrees);

const root = makeTree({
  "known-good": hfModel(CHATML),
  "known-good-variant": hfModel(CHATML_VARIANT),
  findings: hfModel(CHATML_MEDIUM),
  "findings-high": hfModel(CHATML_HIGH),
  unanalyzable: hfModel(CHATML_UNANALYZABLE),
  "no-template": { "tokenizer_config.json": tokenizerConfig(), "tokenizer.json": JSON.stringify({ added_tokens: [] }) },
});
const unverified = makeTree({ "clean-unverified": hfModel(CHATML) });

function model(report: ScanReport, dir: string) {
  const m = report.models.find((x) => x.id.endsWith(`/${dir}`));
  if (!m) throw new Error(`no model ${dir} in the report`);
  return m;
}

function only(report: ScanReport, dir: string): TemplateReport {
  const m = model(report, dir);
  expect(m.templates).toHaveLength(1);
  return m.templates[0]!;
}

describe("ISC-42: one status per template, one fixture per status", () => {
  test("known-good, known-good-variant, findings, incomplete and no_template against a registry made with createRegistry", async () => {
    const report = await scan(options([root], { registry: chatmlRegistry() }));

    const good = only(report, "known-good");
    expect(good).toMatchObject({ status: "known-good", findings: [], gaps: [], registry: { kind: "exact" }, baseline: { kind: "registry" } });
    expect(good.severity).toBeUndefined();

    const variant = only(report, "known-good-variant");
    expect(variant).toMatchObject({ status: "known-good-variant", findings: [], gaps: [], registry: { kind: "whitespace" } });

    const medium = only(report, "findings");
    expect(medium.status).toBe("findings");
    expect(medium.severity).toBe("MEDIUM");
    expect(medium.findings.map((f) => f.ruleId)).toContain("unbaselined_text");

    const high = only(report, "findings-high");
    expect(high.status).toBe("findings");
    expect(high.severity).toBe("HIGH");
    expect(high.findings.map((f) => f.ruleId)).toContain("dunder_access");

    // ISC-42.1: a construct the engine lacks leaves code-exec analysis incomplete.
    const partial = only(report, "unanalyzable");
    expect(partial.status).toBe("incomplete");
    expect(partial.gaps).toContain("code-execution analysis incomplete");

    const none = model(report, "no-template");
    expect(none).toMatchObject({ status: "no_template", templates: [], extractionComplete: true });

    expect(report.summary.statuses).toEqual({
      "known-good": 1,
      "known-good-variant": 1,
      "clean-unverified": 0,
      findings: 2,
      incomplete: 1,
      no_template: 1,
    });
    expect(report.summary.models).toBe(6);
    expect(report.summary.templates).toBe(5);
    expect(report.exitCode).toBe(2);
  });

  test("clean-unverified: no rule fires, analysis completed, and no registry entry matches", async () => {
    const report = await scan(options([unverified]));
    const t = only(report, "clean-unverified");
    expect(t).toMatchObject({ status: "clean-unverified", findings: [], gaps: [], registry: { kind: "none" }, baseline: { kind: "none" } });
    expect(model(report, "clean-unverified").status).toBe("clean-unverified");
    expect(report.exitCode).toBe(0);
  });

  test("ISC-42.1: failed probes make a clean template incomplete, and the gap carries the probe counts", async () => {
    const report = await scan(options([unverified], { diffRender: failedRender }));
    const t = only(report, "clean-unverified");
    expect(t.status).toBe("incomplete");
    expect(t.probes).toEqual({ total: 4, rendered: 1, refused: 0, failed: 3 });
    expect(t.gaps).toEqual(["differential rendering incomplete: 1 of 4 probes rendered, 0 refused, 3 failed"]);
    expect(report.exitCode).toBe(3);
  });

  test("ISC-42.1: failed probes outrank an exact registry match", async () => {
    const report = await scan(options([join(root, "known-good")], { registry: chatmlRegistry(), diffRender: failedRender }));
    expect(report.models[0]!.templates[0]!.status).toBe("incomplete");
  });

  test("a HIGH finding still gives findings when probes failed, with the gap listed", async () => {
    const report = await scan(options([join(root, "findings-high")], { diffRender: failedRender }));
    const t = report.models[0]!.templates[0]!;
    expect(t.status).toBe("findings");
    expect(t.gaps).toHaveLength(1);
  });

  test("a model whose extraction did not complete is never clean: every template gets a gap (ISC-42)", async () => {
    // tokenizer_config.json that is not JSON may have hidden a template; chat_template.jinja still reads.
    const dir = makeTree({ m: { "tokenizer_config.json": "{not json", "chat_template.jinja": CHATML } });
    const report = await scan(options([dir]));
    const m = report.models[0]!;
    expect(m.extractionComplete).toBe(false);
    expect(m.templates[0]!.status).toBe("incomplete");
    expect(m.templates[0]!.gaps).toContain("model extraction incomplete: a template may exist that was not extracted");
    expect(m.status).toBe("incomplete");
  });
});
