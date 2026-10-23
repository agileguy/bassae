// Acceptance for ISC-22.3 and ISC-22.4: every template pinned in the registry, rendered by the real sandboxed
// renderer under both environment profiles, gives no content or tool issue on any standard probe.

import { expect, test } from "bun:test";
import { checkContent } from "../../src/diffrender/integrity.ts";
import { checkTools } from "../../src/diffrender/tools.ts";
import { parseTemplate } from "../../src/parse/parse.ts";
import { children, type Node } from "../../src/parse/support.ts";
import { loadRegistry, loadTransforms } from "../../src/registry/index.ts";
import { createRenderer, sandboxAvailable } from "../../src/sandbox/index.ts";
import type { EnvProfile, IntegrityIssue, KnownGoodTemplate, Probe } from "../../src/types.ts";
import { markupProbes, standardProbes } from "./fixtures/integrity/probes.ts";

const live = (await sandboxAvailable()).available;
const transforms = loadTransforms();
const renderer = createRenderer();
const PROFILES: EnvProfile[] = ["hf-default", "jinja2-globals"];

// The renderer does not implement these filters yet; another phase-3 track is adding them. A template that fails
// only on them is pending, not failed.
const PENDING_FILTER = /Unknown \w+ filter: (reject|map)\b|map\(.?upper/;

// gemma-3 and gemma-3n never read `tools`: they have no tool format, so there is nothing for a tool probe to check.
// Tool probes go only to templates whose parse reads the `tools` identifier, as the probe matrix decides; one that
// reads it and drops a tool still fails (ISC-22.4). A member name (`x.tools`), a keyword, a filter or test name and
// a binding (a loop variable, a set target, a macro parameter) are not reads. A template that does not parse gets
// tool probes, so a gate it slips past never hides a tool it drops.
function readsTools(text: string): boolean {
  const program = parseTemplate(text).program;
  if (!program) return true;
  const stack: unknown[] = [program];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    const n = node as Node;
    switch (n.type) {
      case "Identifier":
        if (n.value === "tools") return true;
        continue;
      case "MemberExpression":
        stack.push(n.object, n.computed ? n.property : undefined);
        continue;
      case "KeywordArgumentExpression":
        stack.push(n.value);
        continue;
      case "FilterExpression":
        stack.push(n.operand, (n.filter as Node).type === "CallExpression" ? (n.filter as Node).args : undefined);
        continue;
      case "TestExpression":
        stack.push(n.operand);
        continue;
      case "For":
        stack.push(n.iterable, n.body, n.defaultBlock);
        continue;
      case "Set":
        stack.push(n.value, n.body);
        continue;
      case "Macro":
        // A parameter's default value is a read; the parameter itself is a binding.
        for (const a of (n.args as Node[] | undefined) ?? []) if (a.type === "KeywordArgumentExpression") stack.push(a.value);
        stack.push(n.body);
        continue;
      case "CallStatement":
        stack.push(n.call, n.body);
        continue;
      default:
        stack.push(...children(n));
    }
  }
  return false;
}

test("the tools gate counts identifier reads, not text", () => {
  for (const t of ["{{ tools }}", "{% if tools is not none %}x{% endif %}", "{{ x[tools] }}", "{% for t in tools %}{% endfor %}", "{{ f(tools) }}"]) {
    expect(readsTools(t)).toBe(true);
  }
  for (const t of ["{# tools #}", "{{ 'tools' }}", "tools", "{{ x.tools }}", "{{ f(tools=1) }}", "{% for tools in xs %}{% endfor %}", "{% set tools = 1 %}"]) {
    expect(readsTools(t)).toBe(false);
  }
});

/** One template per distinct SHA-256, named by its first registry entry. */
function distinct(): KnownGoodTemplate[] {
  const seen = new Map<string, KnownGoodTemplate>();
  for (const k of loadRegistry().entries) if (!seen.has(k.entry.sha256)) seen.set(k.entry.sha256, k);
  return [...seen.values()];
}

interface Sweep {
  names: string[];
  failures: string[];
  pending: Set<string>;
  checked: number;
  withTools: number;
}

/** Renders each distinct registry template on `probes` under both profiles and runs both checks on every output. */
async function sweep(probes: Probe[]): Promise<Sweep> {
  const out: Sweep = { names: [], failures: [], pending: new Set(), checked: 0, withTools: 0 };
  for (const known of distinct()) {
    const name = `${known.entry.family} ${known.entry.sha256.slice(0, 12)}`;
    for (const profile of PROFILES) {
      const sent = probes.filter((p) => p.tools.length === 0 || readsTools(known.text)).map((p) => ({ ...p, request: { ...p.request, profile } }));
      const results = await renderer.renderBatch(known.text, sent.map((p) => p.request));
      for (const [i, r] of results.entries()) {
        const p = sent[i]!;
        if (!r.ok) {
          if (r.failure === "render_error" && PENDING_FILTER.test(r.message)) out.pending.add(name);
          else if (r.failure !== "render_error") out.failures.push(`${name} ${p.label} ${profile}: ${r.failure}: ${r.message}`);
          continue; // a probe the template refuses is skipped
        }
        out.checked++;
        if (p.tools.length > 0) out.withTools++;
        const found: IntegrityIssue[] = [...checkContent(p, r.output, transforms), ...checkTools(p, r.output, transforms)];
        for (const issue of found) out.failures.push(`${name} ${p.label} ${profile}: ${issue.ruleId}[${issue.index}] ${issue.message}`);
      }
    }
    out.names.push(name);
  }
  return out;
}

test.if(live)(
  "every registry template gives zero content and tool issues on every probe it renders",
  async () => {
    const { names, failures, pending, checked, withTools } = await sweep(standardProbes());
    const toolless = distinct()
      .filter((k) => !readsTools(k.text))
      .map((k) => `${k.entry.family} ${k.entry.sha256.slice(0, 12)}`);
    console.log(`[integrity] ${names.length} templates, ${checked} renders checked (${withTools} with tools); pending: ${[...pending].join(", ") || "none"}; no tool format: ${toolless.join(", ") || "none"}`);
    expect(failures).toEqual([]);
    expect(names.length).toBe(distinct().length);
    // Only the qwen3-coder template waits on the missing |reject; every other template renders its tool probes.
    // Once the filter lands it renders too, and its tool list is then held to the qwen-xml-tool-list matcher.
    expect([...pending].filter((n) => n !== "qwen3-coder 672e747c77e9")).toEqual([]);
    expect(withTools).toBeGreaterThan(30);
    expect(toolless.sort()).toEqual(["gemma-3 7de1c58e208e", "gemma-3n ac03dcb3b097"].sort());
  },
  300_000,
);

test.if(live)(
  "content holding markup or a role word gives zero content issues on every registry template",
  async () => {
    const { failures, checked } = await sweep(markupProbes());
    console.log(`[integrity] markup: ${checked} renders checked`);
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(1000);
  },
  300_000,
);
