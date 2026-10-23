// ISC-22 acceptance: differential rendering must not flag the templates people actually ship. Every distinct
// registry template, scanned as if unknown (its own injected text and trigger candidates, no registry literals as
// scaffolding), renders through the sandbox with zero render_divergence and zero env_profile_divergence.
//
// A template that cannot render every probe yet only because @huggingface/jinja lacks `reject` or `map` with a
// filter name is pending the engine's polyfill, not failed; any other gap fails here.

import { describe, expect, test } from "bun:test";
import { diffRender } from "../../src/diffrender/index.ts";
import { buildProbes } from "../../src/diffrender/probes.ts";
import { loadRegistry, loadTransforms } from "../../src/registry/index.ts";
import { analyzeInjection, buildScaffolding } from "../../src/rules/injection.ts";
import { createRenderer, sandboxAvailable } from "../../src/sandbox/index.ts";
import { makeTemplateFromString } from "../../src/template.ts";
import type { KnownGoodTemplate, ModelRecord, RenderResult, Renderer, TriggerCandidate } from "../../src/types.ts";

const NO_TOKENS = { specialTokens: [] } as unknown as ModelRecord;

/** The two engine gaps the polyfill closes, as the sandbox reports them. */
const PENDING_POLYFILL = /^Error: (Unknown \w+ filter: reject|`map` expressions without `attribute` set are not currently supported\.)$/;

/** A template's own raise_exception: the raised text is a literal in the template (the rule diffRender counts as refused). */
const isRefusal = (r: RenderResult & { ok: false }, text: string) =>
  r.failure === "render_error" && r.message.startsWith("Error: ") && text.includes(r.message.slice("Error: ".length));

const distinct = (entries: readonly KnownGoodTemplate[]) => [...new Map(entries.map((k) => [k.entry.sha256, k])).values()];

const status = await sandboxAvailable();
if (!status.available) console.warn(`\n[diffrender] SKIPPING registry render acceptance: ${status.reason}\n`);

describe.skipIf(!status.available)("registry templates through differential rendering (ISC-22)", () => {
  const templates = distinct(loadRegistry().entries);
  const transforms = loadTransforms();
  const sandbox = createRenderer();

  test(
    "every distinct registry template renders with zero render_divergence and zero env_profile_divergence",
    async () => {
      expect(templates.length).toBeGreaterThan(0);
      const pending: string[] = [];
      const flagged: string[] = [];
      const gaps: string[] = [];

      for (const known of templates) {
        const name = `${known.entry.repo} ${known.entry.templateName}`;
        const failures: (RenderResult & { ok: false })[] = [];
        const recording: Renderer = {
          async renderBatch(template, requests, limits) {
            const results = await sandbox.renderBatch(template, requests, limits);
            for (const r of results) if (!r.ok) failures.push(r);
            return results;
          },
        };
        const template = makeTemplateFromString({ kind: "bare", path: "/chat_template.jinja", realPath: "/chat_template.jinja", name: known.entry.templateName }, known.text);
        const analysis = analyzeInjection({ template, scaffolding: buildScaffolding(NO_TOKENS), knownGood: false });
        const r = await diffRender({ template, injected: analysis.injected, triggers: analysis.triggers }, recording, transforms);

        for (const f of r.findings) {
          if (["render_divergence", "env_profile_divergence", "render_dos", "scanner_error"].includes(f.ruleId)) flagged.push(`${name}: ${f.ruleId}: ${f.message}`);
        }
        if (r.complete) continue;
        const unexplained = failures.filter((f) => !isRefusal(f, known.text) && !PENDING_POLYFILL.test(f.message));
        if (unexplained.length === 0 && failures.length > 0) pending.push(name);
        else gaps.push(`${name}: ${JSON.stringify(r.probes)} ${unexplained.map((f) => `${f.failure}: ${f.message}`).slice(0, 3).join(" | ")}`);
      }

      if (pending.length) console.info(`[diffrender] ${templates.length} registry templates; pending the reject/map polyfill: ${pending.join(", ")}`);
      expect(flagged).toEqual([]);
      expect(gaps).toEqual([]);
    },
    120_000,
  );

  test("a tool key a template tests for holds what the template reads under it, so the branch it guards renders", async () => {
    const known = loadRegistry().entries.find((k) => k.entry.repo === "ggml-org/gemma-4-E2B-it-GGUF")!;
    // The candidates for `{%- if 'response' in tool_data['function'] -%}` and, under it, the unguarded
    // `response_declaration['type'] | upper == 'OBJECT'`, which fails on a response that is a plain string.
    const span = { start: 0, end: 0, line: 1, col: 1 };
    const triggers: TriggerCandidate[] = [
      { value: "response", op: "in", input: "tools[].function", test: "presence", span },
      { value: "OBJECT", op: "==", input: "tools[].function.response.type", test: "presence", span },
    ];
    const sent = buildProbes(triggers, { text: known.text }).probes.filter((p) => p.label.startsWith("trigger:"));
    const responses = sent.map((p) => (p.tools[0] as { function: Record<string, unknown> }).function.response);
    expect(responses).toContainEqual({ type: expect.any(String) });
    expect(responses).toContainEqual({ type: "OBJECT" });
    const results = await sandbox.renderBatch(known.text, sent.map((p) => p.request));
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.some((r) => r.ok && r.output.includes('type:<|"|>OBJECT<|"|>}'))).toBe(true);
  });
});
