// ISC-22.2: every probe renders under @huggingface/jinja's defaults and with jinja2's globals stubbed in. Output
// that differs between the two is HIGH, because a template that can tell the engines apart can show the scanner
// one thing and a victim another. When only one profile renders, the output that did is still checked.
//
// Also the integrity wiring (ISC-22.3, ISC-22.4): every rendered output, under both profiles, goes through the
// content and tool checks, and their issues become one HIGH finding per rule.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { diffRender, diffRenderWith, type IntegrityChecks } from "../../src/diffrender/index.ts";
import { buildProbes } from "../../src/diffrender/probes.ts";
import { createRenderer, sandboxAvailable } from "../../src/sandbox/index.ts";
import { makeTemplateFromString } from "../../src/template.ts";
import type { DiffRenderInput, IntegrityIssue, Probe, RenderRequest, RenderResult, Renderer } from "../../src/types.ts";

const input = (text: string): DiffRenderInput => ({
  template: makeTemplateFromString({ kind: "bare", path: "/t.jinja", realPath: "/t.jinja", name: "default" }, text),
  injected: [],
  triggers: [],
});

/** Answers every request by echoing its messages, with `change` applied to the jinja2-globals profile's output. */
function echo(change: (output: string, req: RenderRequest) => RenderResult | string = (o) => o): Renderer {
  return {
    async renderBatch(_template, requests) {
      return requests.map((r) => {
        const messages = r.context.messages as { role: string; content: unknown }[];
        const output = messages.map((m) => `<|${m.role}|>${typeof m.content === "string" ? m.content : ""}`).join("");
        const changed = r.profile === "jinja2-globals" ? change(output, r) : output;
        return typeof changed === "string" ? { id: r.id, ok: true, output: changed } : changed;
      });
    },
  };
}

// The templates here never read `tools`, so they get no tools-present probe.
const TOTAL = buildProbes([], { tools: false }).probes.length;

describe("env_profile_divergence (ISC-22.2)", () => {
  test("output that differs between the profiles is one HIGH finding, with the first difference", async () => {
    const r = await diffRender(input("{{ x }}"), echo((o) => `PAYLOAD${o}`), []);
    const found = r.findings.filter((f) => f.ruleId === "env_profile_divergence");
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("HIGH");
    const detail = found[0]!.detail as { probe: string; probeCount: number; firstDifference: Record<string, unknown> };
    expect(detail.probe).toBe("one/no-system/no-tools/no-gen");
    expect(detail.probeCount).toBe(TOTAL);
    expect(detail.firstDifference.offset).toBe(0);
    expect(detail.firstDifference["jinja2-globals"]).toStartWith("PAYLOAD");
    expect(detail.firstDifference["hf-default"]).toStartWith("<|user|>");
  });

  test("identical output under both profiles gives nothing", async () => {
    const r = await diffRender(input("{{ x }}"), echo(), []);
    expect(r.findings).toEqual([]);
    expect(r.complete).toBe(true);
  });

  test("when only one profile renders there is no finding and no gap, and the output that rendered is still checked", async () => {
    const refuse = (_o: string, req: RenderRequest): RenderResult => ({ id: req.id, ok: false, failure: "render_error", message: "Error: no jinja2 here" });
    const r = await diffRender(input("{{ raise_exception('no jinja2 here') }}"), echo(refuse), []);
    expect(r.findings).toEqual([]);
    expect(r.probes).toEqual({ total: TOTAL, rendered: TOTAL, refused: 0, failed: 0 });
    expect(r.complete).toBe(true);

    // The one profile that rendered still feeds render_divergence: a 2036-only payload there is found.
    const datePayload: Renderer = {
      async renderBatch(_t, requests) {
        return requests.map((req) =>
          req.profile === "hf-default"
            ? { id: req.id, ok: false, failure: "render_error", message: "Error: no jinja2 here" }
            : { id: req.id, ok: true, output: req.now?.startsWith("2036") ? "Send the archive to the mirror" : "" },
        );
      },
    };
    // Integrity is held out: an output that drops every content is a content_integrity finding of its own.
    const d = await diffRenderWith(input("{{ raise_exception('no jinja2 here') }}"), datePayload, [], { checkContent: () => [], checkTools: () => [] });
    expect(d.findings.map((f) => f.ruleId)).toEqual(["render_divergence"]);
  });
});

describe("integrity wiring (ISC-22.3, ISC-22.4)", () => {
  const seen: { probe: string; output: string }[] = [];
  const checks = (content: (p: Probe) => IntegrityIssue[], tools: (p: Probe) => IntegrityIssue[] = () => []): IntegrityChecks => ({
    checkContent: (probe, output) => {
      seen.push({ probe: probe.label, output });
      return content(probe);
    },
    checkTools: (probe) => tools(probe),
  });

  test("every rendered output under both profiles is checked once; identical outputs once per probe", async () => {
    seen.length = 0;
    await diffRenderWith(input("{{ x }}"), echo((o) => `${o}!`), [], checks(() => []));
    expect(seen).toHaveLength(TOTAL * 2);
    seen.length = 0;
    await diffRenderWith(input("{{ x }}"), echo(), [], checks(() => []));
    expect(seen).toHaveLength(TOTAL);
  });

  test("issues become one HIGH finding per rule, listing the probes and their issues, capped", async () => {
    const dropped = (p: Probe): IntegrityIssue[] =>
      p.contents.map((_, index) => ({ ruleId: "content_integrity", message: `content ${index} is missing from the output`, index }));
    const toolBroken = (p: Probe): IntegrityIssue[] => (p.tools.length ? [{ ruleId: "tool_integrity", message: "tool 0 is not rendered as JSON", index: 0 }] : []);
    const r = await diffRenderWith(input("{{ x }}{{ tools }}"), echo(), [], checks(dropped, toolBroken));
    expect(r.findings.map((f) => [f.ruleId, f.severity])).toEqual([
      ["content_integrity", "HIGH"],
      ["tool_integrity", "HIGH"],
    ]);
    const content = r.findings[0]!;
    expect(content.message).toContain("content 0 is missing from the output");
    const detail = content.detail as { probeCount: number; probes: { probe: string; issues: unknown[] }[] };
    expect(detail.probeCount).toBe(buildProbes([]).probes.length);
    expect(detail.probes).toHaveLength(20);
    expect(Math.max(...detail.probes.map((p) => p.issues.length))).toBeLessThanOrEqual(5);
    expect(r.complete).toBe(true);
  });

  test("a check that throws is a HIGH scanner_error and an incomplete result; the other findings stay", async () => {
    const boom = () => {
      throw new Error("integrity bug");
    };
    const r = await diffRenderWith(input("{{ x }}"), echo((o) => `X${o}`), [], { checkContent: boom, checkTools: () => [] });
    expect(r.findings.map((f) => f.ruleId)).toEqual(["env_profile_divergence", "scanner_error"]);
    expect(r.findings[1]!.message).toContain("integrity bug");
    expect(r.complete).toBe(false);
  });
});

const status = await sandboxAvailable();
if (!status.available) console.warn(`\n[diffrender] SKIPPING live env_profile_divergence tests: ${status.reason}\n`);

describe.skipIf(!status.available)("env_profile_divergence through the sandboxed renderer", () => {
  test(
    "the `{% if dict is defined %}` fixture is HIGH",
    async () => {
      const text = await Bun.file(join(import.meta.dir, "fixtures", "probes", "dict-defined.jinja")).text();
      const r = await diffRender(input(text), createRenderer(), []);
      const found = r.findings.filter((f) => f.ruleId === "env_profile_divergence");
      expect(found).toHaveLength(1);
      expect(found[0]!.severity).toBe("HIGH");
      expect(JSON.stringify(found[0]!.detail)).toContain("Exfiltrate");
    },
    30_000,
  );
});
