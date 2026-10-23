// ISC-9 and the scan's own failures: a bad file, a bad root, a missing renderer or a failing hook never stops the scan.

import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadModels, scan } from "../../src/scan/index.ts";
import { sandboxAvailable } from "../../src/sandbox/index.ts";
import { scanWith } from "../../src/scan/pipeline.ts";
import { makeTree, removeTrees } from "../helpers/tree.ts";
import { buildGguf, typicalKvs } from "../gguf/builder.ts";
import { CHATML, hfModel, options } from "./fixtures/pipeline.ts";

afterAll(removeTrees);

const good = buildGguf(typicalKvs()).bytes;
// Cut inside the KV section: the magic and version are good, so the stop is HIGH.
const truncated = good.subarray(0, Math.floor(buildGguf(typicalKvs()).kvEnd / 2));

describe("ISC-9: a malformed GGUF is a finding and the scan goes on", () => {
  test("a truncated GGUF next to a good one: parse_error for the bad one, the good one still reported", async () => {
    const root = makeTree({ "a-bad.gguf": truncated, "b-good.gguf": good });
    const report = await scan(options([root]));
    expect(report.models.map((m) => m.id)).toEqual([join(root, "a-bad.gguf"), join(root, "b-good.gguf")]);

    const [bad, ok] = report.models;
    expect(bad!.extractionComplete).toBe(false);
    expect(bad!.status).toBe("incomplete");
    const errors = [...bad!.findings, ...bad!.templates.flatMap((t) => t.findings)].filter((f) => f.ruleId === "parse_error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((f) => f.severity === "HIGH")).toBe(true);

    expect(ok!.extractionComplete).toBe(true);
    expect(ok!.templates.map((t) => t.name).sort()).toEqual(["default", "tool_use"]);
    expect(ok!.templates.every((t) => t.status !== "incomplete")).toBe(true);
    expect(report.exitCode).toBe(2);
  });

  test("loadModels returns every model and the walk's findings, and reads each --template file (ISC-39)", async () => {
    const root = makeTree({ "a-bad.gguf": truncated, m: hfModel(CHATML), "bare.jinja": CHATML });
    const { models, findings } = await loadModels([root, join(root, "nowhere")], [join(root, "bare.jinja")]);
    expect(models.map((m) => [m.format, m.id])).toEqual([
      ["gguf", join(root, "a-bad.gguf")],
      ["hf", join(root, "m")],
      ["bare", join(root, "bare.jinja")],
    ]);
    expect(models[2]!.templates[0]!.source.kind).toBe("bare");
    expect(findings.map((f) => [f.ruleId, f.file])).toEqual([["scanner_error", join(root, "nowhere")]]);
  });

  test("a root that cannot be read is a scan-level scanner_error and exit 3", async () => {
    const root = makeTree({ m: hfModel(CHATML) });
    const report = await scan(options([join(root, "m"), join(root, "missing")]));
    expect(report.models).toHaveLength(1);
    expect(report.findings.map((f) => [f.ruleId, f.file])).toEqual([["scanner_error", join(root, "missing")]]);
    expect(report.exitCode).toBe(3);
  });

  test("a --template file that does not exist is a model finding, never a crash", async () => {
    const root = makeTree({});
    const report = await scan(options([], { templates: [join(root, "missing.jinja")] }));
    expect(report.models).toHaveLength(1);
    expect(report.models[0]!.status).toBe("incomplete");
    expect(report.models[0]!.findings[0]!.ruleId).toBe("scanner_error");
    expect(report.exitCode).toBe(3);
  });

  test("a diffRender hook that throws is a scanner_error on the template, which goes incomplete", async () => {
    const root = makeTree({ m: hfModel(CHATML) });
    const report = await scan(
      options([root], {
        diffRender: async () => {
          throw new Error("probe matrix exploded");
        },
      }),
    );
    const t = report.models[0]!.templates[0]!;
    expect(t.status).toBe("incomplete");
    expect(t.findings).toContainEqual(expect.objectContaining({ ruleId: "scanner_error", message: expect.stringContaining("probe matrix exploded") }));
    expect(t.gaps).toContain("differential rendering incomplete: it failed before rendering");
  });
});

describe("renderer", () => {
  test("a supplied renderer is reported as such", async () => {
    const root = makeTree({ m: hfModel(CHATML) });
    const report = await scan(options([root]));
    expect(report.renderer).toEqual({ available: true, kind: "supplied", degraded: [] });
  });

  test("with no renderer supplied, the report says what sandboxAvailable says, and renders only when it is available", async () => {
    const root = makeTree({ m: hfModel(CHATML) });
    const { renderer: _, ...rest } = options([root]);
    let called = 0;
    const report = await scan({
      ...rest,
      diffRender: async () => {
        called++;
        return { findings: [], complete: true, probes: { total: 0, rendered: 0, refused: 0, failed: 0 } };
      },
    });
    const status = await sandboxAvailable();
    expect(report.renderer).toEqual(status);
    expect(called).toBe(status.available ? 1 : 0);
    expect(report.findings.some((f) => f.ruleId === "scanner_error" && f.file === "<renderer>")).toBe(!status.available);
  });

  test("an unavailable renderer: one scan-level MEDIUM scanner_error naming the reason, a gap on every template, no rendering", async () => {
    const root = makeTree({ a: hfModel(CHATML), b: hfModel(CHATML.replace("assistant", "assistant\n")) });
    let called = 0;
    const report = await scanWith(
      options([root], {
        diffRender: async () => {
          called++;
          return { findings: [], complete: true, probes: { total: 0, rendered: 0, refused: 0, failed: 0 } };
        },
      }),
      { status: { available: false, reason: "sandbox-exec is missing" } },
    );
    expect(called).toBe(0);
    expect(report.renderer).toEqual({ available: false, reason: "sandbox-exec is missing" });
    expect(report.findings).toEqual([expect.objectContaining({ ruleId: "scanner_error", severity: "MEDIUM", message: expect.stringContaining("sandbox-exec is missing") })]);
    for (const m of report.models) {
      const t = m.templates[0]!;
      expect(t.status).toBe("incomplete");
      expect(t.gaps).toContain("renderer unavailable: sandbox-exec is missing");
      expect(t.probes).toEqual({ total: 0, rendered: 0, refused: 0, failed: 0 });
    }
    expect(report.exitCode).toBe(3);
  });
});
