// ISC-43 and ISC-42.1: the first cap breach is one HIGH render_dos finding naming the probe and the cap, no
// further render is attempted for that template, and the scan goes on. Probes that did not render leave the
// result incomplete; a template's own refusal does not.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { diffRender } from "../../src/diffrender/index.ts";
import { buildProbes } from "../../src/diffrender/probes.ts";
import { createRenderer, sandboxAvailable } from "../../src/sandbox/index.ts";
import { makeTemplateFromString } from "../../src/template.ts";
import type { DiffRenderInput, RenderRequest, RenderResult, Renderer } from "../../src/types.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "probes");
const fixture = (name: string) => Bun.file(join(FIXTURES, `${name}.jinja`)).text();
const input = (text: string): DiffRenderInput => ({
  template: makeTemplateFromString({ kind: "bare", path: "/t.jinja", realPath: "/t.jinja", name: "default" }, text),
  injected: [],
  triggers: [],
});

/** A renderer that answers from a script and records every batch it was sent. Unscripted requests echo their messages. */
function scripted(answer: (req: RenderRequest, label: string) => RenderResult | undefined = () => undefined) {
  const batches: RenderRequest[][] = [];
  const renderer: Renderer = {
    async renderBatch(_template, requests) {
      batches.push(requests);
      return requests.map((r) => {
        const label = r.id.split("/").slice(2).join("/");
        const messages = r.context.messages as { role: string; content: unknown }[];
        return answer(r, label) ?? { id: r.id, ok: true, output: messages.map((m) => `<|${m.role}|>${typeof m.content === "string" ? m.content : ""}`).join("") };
      });
    },
  };
  return { renderer, batches };
}

const fail = (id: string, failure: (RenderResult & { ok: false })["failure"], message = "x"): RenderResult => ({ id, ok: false, failure, message });
// The templates here never read `tools`, so they get no tools-present probe.
const TOTAL = buildProbes([], { tools: false }).probes.length;

describe("render_dos (ISC-43)", () => {
  test("a breach on the first probe stops at once: one render sent, one HIGH finding naming the probe and the cap", async () => {
    const { renderer, batches } = scripted((r) => fail(r.id, "timeout", "render exceeded 2000ms"));
    const r = await diffRender(input("{{ x }}"), renderer, []);
    expect(batches.map((b) => b.length)).toEqual([1]);
    const dos = r.findings.filter((f) => f.ruleId === "render_dos");
    expect(dos).toHaveLength(1);
    expect(dos[0]!.severity).toBe("HIGH");
    expect(dos[0]!.message).toContain("one/no-system/no-tools/no-gen");
    expect(dos[0]!.message).toContain("time cap");
    expect(dos[0]!.detail).toMatchObject({ probe: "one/no-system/no-tools/no-gen", profile: "hf-default", cap: "timeout" });
    expect(r.complete).toBe(false);
    expect(r.probes).toEqual({ total: TOTAL, rendered: 0, refused: 0, failed: TOTAL });
  });

  for (const cap of ["memory", "output_limit", "stack"] as const) {
    test(`a ${cap} breach is render_dos too`, async () => {
      const { renderer } = scripted((r) => fail(r.id, cap));
      const r = await diffRender(input("{{ x }}"), renderer, []);
      expect(r.findings.map((f) => [f.ruleId, (f.detail as { cap?: string }).cap])).toEqual([["render_dos", cap]]);
    });
  }

  test("a breach on a vary probe stops before anything after its batch; what rendered is still counted and checked", async () => {
    const { renderer, batches } = scripted((r, label) => (label === "count:50" ? fail(r.id, "memory") : undefined));
    const r = await diffRender(input("{{ x }}"), renderer, []);
    expect(batches).toHaveLength(3);
    expect(r.findings.map((f) => f.ruleId)).toEqual(["render_dos"]);
    expect((r.findings[0]!.detail as { probe: string }).probe).toBe("count:50");
    expect(r.probes.rendered).toBe(TOTAL - 1);
    expect(r.probes.failed).toBe(1);
    expect(r.complete).toBe(false);
  });

  test("explain probes go before vary probes, the first one alone", async () => {
    const { renderer, batches } = scripted();
    await diffRender(input("{{ x }}"), renderer, []);
    const labels = batches.map((b) => b.map((r) => r.id.split("/").slice(2).join("/")));
    expect(labels[0]).toEqual(["one/no-system/no-tools/no-gen"]);
    expect(labels[1]!.every((l) => !l.includes(":"))).toBe(true);
    expect(labels[2]!.every((l) => l.includes(":"))).toBe(true);
    // Every probe goes under both profiles.
    expect(batches.flat().map((r) => r.profile).filter((p) => p === "jinja2-globals")).toHaveLength(TOTAL);
  });

  test("renders the fail-fast rule skipped are failures but not a breach of their own", async () => {
    const { renderer } = scripted((r) =>
      r.profile === "jinja2-globals" ? fail(r.id, "timeout", "not attempted: the 2 renders before it timed out on this template") : undefined,
    );
    const r = await diffRender(input("{{ x }}"), renderer, []);
    expect(r.findings).toEqual([]);
    expect(r.probes.rendered).toBe(TOTAL);
    const skipped = await diffRender(input("{{ x }}"), scripted((r) => fail(r.id, "skipped")).renderer, []);
    expect(skipped.findings).toEqual([]);
    expect(skipped.probes.failed).toBe(TOTAL);
    expect(skipped.complete).toBe(false);
  });

  test("a template that does not parse stops after the first probe, with no finding of its own (ISC-12 reports it)", async () => {
    const { renderer, batches } = scripted((r) => fail(r.id, "parse", "SyntaxError: Unexpected end of input"));
    const r = await diffRender(input("{% if %}"), renderer, []);
    expect(batches).toHaveLength(1);
    expect(r.findings).toEqual([]);
    expect(r.complete).toBe(false);
    // Whether it reads `tools` is unknown, so its tools-present probes are kept and fail with the rest.
    expect(r.probes.failed).toBe(buildProbes([]).probes.length);
  });

  test("a renderer that throws is a sandbox failure, not an exception", async () => {
    const renderer: Renderer = {
      renderBatch: async () => {
        throw new Error("boom");
      },
    };
    const r = await diffRender(input("{{ x }}"), renderer, []);
    expect(r.complete).toBe(false);
    expect(r.probes.failed).toBe(TOTAL);
  });
});

describe("counts and completeness (ISC-42.1)", () => {
  const RAISE = "{% if messages[0].role == 'system' %}{{ raise_exception('System role not supported') }}{% endif %}{{ x }}";

  test("a template's own raise_exception is a refusal: an answer, not a gap", async () => {
    const { renderer } = scripted((r) => {
      const first = (r.context.messages as { role: string }[])[0]!;
      return first.role === "system" ? fail(r.id, "render_error", "Error: System role not supported") : undefined;
    });
    const r = await diffRender(input(RAISE), renderer, []);
    expect(r.probes.refused).toBeGreaterThan(0);
    expect(r.probes.failed).toBe(0);
    expect(r.probes.rendered + r.probes.refused).toBe(r.probes.total);
    expect(r.complete).toBe(true);
  });

  test("an engine error, such as a filter the renderer does not implement, is a gap", async () => {
    const { renderer } = scripted((r) => (r.context.tools ? fail(r.id, "render_error", "Error: Unknown ArrayValue filter: reject") : undefined));
    const r = await diffRender(input("{{ tools|reject('none')|list }}"), renderer, []);
    expect(r.probes.refused).toBe(0);
    expect(r.probes.failed).toBeGreaterThan(0);
    expect(r.complete).toBe(false);
  });

  test("a probe one profile renders is rendered", async () => {
    const { renderer } = scripted((r) => (r.profile === "hf-default" ? fail(r.id, "render_error", "Error: System role not supported") : undefined));
    const r = await diffRender(input(RAISE), renderer, []);
    expect(r.probes).toEqual({ total: TOTAL, rendered: TOTAL, refused: 0, failed: 0 });
    expect(r.complete).toBe(true);
  });

  test("a refusal under one profile and a cap under the other is a failure", async () => {
    const { renderer } = scripted((r, label) =>
      label === "count:50" ? (r.profile === "hf-default" ? fail(r.id, "render_error", "Error: System role not supported") : fail(r.id, "sandbox")) : undefined,
    );
    const r = await diffRender(input(RAISE), renderer, []);
    expect(r.probes.failed).toBe(1);
    expect(r.complete).toBe(false);
  });

  test("when every explain probe is refused the result is incomplete", async () => {
    const { renderer } = scripted((r) => fail(r.id, "render_error", "Error: System role not supported"));
    const r = await diffRender(input(RAISE), renderer, []);
    expect(r.probes.refused).toBe(TOTAL);
    expect(r.complete).toBe(false);
  });

  test("probes the cap cuts count in the total and as failed", async () => {
    const triggers = Array.from({ length: 200 }, (_, i) => ({ value: `secret phrase ${i}`, op: "==" as const, test: "content" as const, span: { start: 0, end: 0, line: 1, col: 1 } }));
    const { probes, cut } = buildProbes(triggers, { tools: false });
    const r = await diffRender({ ...input("{{ x }}"), triggers }, scripted().renderer, []);
    expect(r.probes).toEqual({ total: probes.length + cut, rendered: probes.length, refused: 0, failed: cut });
    expect(r.complete).toBe(false);
  });

  test("never throws: an internal failure is a HIGH scanner_error and an incomplete result", async () => {
    const r = await diffRender({ ...input("{{ x }}"), triggers: null as never }, scripted().renderer, []);
    expect(r.findings.map((f) => [f.ruleId, f.severity])).toEqual([["scanner_error", "HIGH"]]);
    expect(r.findings[0]!.span).toEqual({ start: 0, end: 0, line: 1, col: 1 });
    expect(r.complete).toBe(false);
  });
});

const status = await sandboxAvailable();
if (!status.available) console.warn(`\n[diffrender] SKIPPING live render_dos tests: ${status.reason}\n`);

describe.skipIf(!status.available)("render_dos through the sandboxed renderer", () => {
  const renderer = createRenderer();
  const SLOW = 30_000;

  for (const [name, caps] of [
    ["endless-range", ["memory", "timeout"]],
    ["endless-loop", ["timeout"]],
    ["recursive-macro", ["stack", "timeout"]],
  ] as const) {
    test(
      `${name}: one HIGH render_dos, about one cap of wall time, and the next template still renders`,
      async () => {
        const start = performance.now();
        const r = await diffRender(input(await fixture(name)), renderer, []);
        const elapsed = performance.now() - start;
        const dos = r.findings.filter((f) => f.ruleId === "render_dos");
        expect(dos).toHaveLength(1);
        expect(dos[0]!.severity).toBe("HIGH");
        expect(caps as readonly string[]).toContain((dos[0]!.detail as { cap: string }).cap);
        expect(r.complete).toBe(false);
        // One 2 s cap plus a spawn, never one cap per probe.
        expect(elapsed).toBeLessThan(5_000);

        const next = await diffRender(input(await fixture("chatml")), renderer, []);
        expect(next.findings).toEqual([]);
        expect(next.complete).toBe(true);
        expect(next.probes.rendered).toBe(next.probes.total);
      },
      SLOW,
    );
  }
});
