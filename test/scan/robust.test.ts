// ISC-9 and the scan's own failures: a bad file, a bad root, a missing renderer or a failing hook never stops the scan.

import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createRegistry } from "../../src/registry/index.ts";
import { FINDING_CAP } from "../../src/rules/finalize.ts";
import { loadModels, scan } from "../../src/scan/index.ts";
import { sandboxAvailable } from "../../src/sandbox/index.ts";
import { scanWith } from "../../src/scan/pipeline.ts";
import type { Registry, Renderer } from "../../src/types.ts";
import { makeTree, removeTrees } from "../helpers/tree.ts";
import { buildGguf, typicalKvs } from "../gguf/builder.ts";
import { CHATML, CHATML_HIGH, CHATML_MEDIUM, countingRender, hfCacheRepo, hfModel, known, options, REV_A, tokenizerConfig } from "./fixtures/pipeline.ts";

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
    // The parse_error is HIGH and sits on the model, so the model reads as findings: a HIGH outranks a gap.
    expect(bad!.status).toBe("findings");
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

  test("a diffRender hook that throws is a HIGH scanner_error on the template, with the gap listed (Decisions 02:58)", async () => {
    const root = makeTree({ m: hfModel(CHATML) });
    const report = await scan(
      options([root], {
        diffRender: async () => {
          throw new Error("probe matrix exploded");
        },
      }),
    );
    const t = report.models[0]!.templates[0]!;
    expect(t.findings).toContainEqual(expect.objectContaining({ ruleId: "scanner_error", severity: "HIGH", message: expect.stringContaining("probe matrix exploded") }));
    expect(t.status).toBe("findings");
    expect(t.gaps).toContain("differential rendering incomplete: it failed before rendering");
    expect(report.exitCode).toBe(2);
  });

  test("a baseline comparison that throws is a HIGH scanner_error on the template, with the gap listed (Decisions 02:58)", async () => {
    // A trim marker on a tag with nothing to trim: control flow only, so the comparison renders both texts.
    const root = makeTree({ "models--acme--chat": hfCacheRepo({ [REV_A]: { "tokenizer_config.json": tokenizerConfig(), "chat_template.jinja": CHATML.replace("{% if add", "{%- if add") } }) });
    const renderer: Renderer = {
      async renderBatch(_template, requests) {
        return requests.map(() => ({
          get id(): string {
            throw new Error("renderer answer unreadable");
          },
          ok: true as const,
          output: "",
        }));
      },
    };
    const report = await scan(options([root], { registry: createRegistry([known(CHATML, { repo: "acme/chat", revision: REV_A })]), renderer }));
    const t = report.models[0]!.templates[0]!;
    expect(t.baseline).toMatchObject({ kind: "registry" });
    expect(t.findings).toContainEqual(expect.objectContaining({ ruleId: "scanner_error", severity: "HIGH", message: expect.stringContaining("renderer answer unreadable") }));
    expect(t.status).toBe("findings");
    expect(t.gaps).toContain("baseline comparison incomplete");
    expect(report.exitCode).toBe(2);
  });
});

describe("runtime SF7: one template's or one model's failure never sinks the scan", () => {
  test("an analysis that throws for one template is a HIGH scanner_error on that template; every other model keeps its findings", async () => {
    const root = makeTree({ a: hfModel(CHATML_MEDIUM), b: hfModel(CHATML_HIGH), c: hfModel(CHATML.replace("assistant", "assistant\n")) });
    const inner = createRegistry([]);
    const registry: Registry = {
      entries: inner.entries,
      forRepo: (repo) => inner.forRepo(repo),
      match(template) {
        if (template.source.path === join(root, "c", "chat_template.jinja")) throw new Error("registry lookup exploded");
        return inner.match(template);
      },
    };
    const report = await scan(options([root], { registry }));
    const [a, b, c] = report.models;

    expect(a!.templates[0]!.findings.map((f) => f.ruleId)).toContain("unbaselined_text");
    expect(a!.status).toBe("findings");
    expect(b!.templates[0]!.findings.map((f) => f.ruleId)).toContain("dunder_access");

    const failed = c!.templates[0]!;
    expect(failed.findings).toEqual([
      expect.objectContaining({ ruleId: "scanner_error", severity: "HIGH", file: join(root, "c", "chat_template.jinja"), message: expect.stringContaining("registry lookup exploded") }),
    ]);
    expect(failed.gaps).toEqual([expect.stringContaining("registry lookup exploded")]);
    expect(failed.status).toBe("findings");
    expect(report.exitCode).toBe(2);
  });
});

describe("contracts SF10: scan-level findings are finalized like every other", () => {
  test("a root given twice gives one finding, and past FINDING_CAP one summary carries the rest", async () => {
    const root = makeTree({});
    const missing = Array.from({ length: FINDING_CAP + 20 }, (_, i) => join(root, `missing-${i}`));
    const report = await scan(options([missing[0]!, ...missing]));
    const errors = report.findings.filter((f) => f.ruleId === "scanner_error");
    expect(errors).toHaveLength(FINDING_CAP + 1);
    // One "cannot read" per missing root, the root given twice once, in walk order.
    expect(errors.slice(0, FINDING_CAP).map((f) => f.file)).toEqual(missing.slice(0, FINDING_CAP));
    expect(errors.at(-1)).toMatchObject({ message: "20 more scanner_error findings suppressed", file: "<scan>", detail: { suppressed: 20 } });
    expect(report.summary.findings.MEDIUM).toBe(FINDING_CAP + 1);
    expect(report.exitCode).toBe(3);
  });
});

describe("renderer", () => {
  test("runtime 1: an `unavailable` inherited from a polluted Object.prototype does not switch rendering off", async () => {
    const root = makeTree({ m: hfModel(CHATML) });
    const render = countingRender();
    const proto = Object.prototype as { unavailable?: unknown };
    proto.unavailable = "Please note that pwned matters";
    try {
      const report = await scan(options([root], { diffRender: render.hook }));
      expect(render.inputs).toHaveLength(1);
      expect(report.models[0]!.templates[0]!.gaps).toEqual([]);
    } finally {
      delete proto.unavailable;
    }
    expect(Object.hasOwn(Object.prototype, "unavailable")).toBe(false);
  });

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
