import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadRegistry, registryStatus } from "../../src/registry/index.ts";
import { analyzeCodeExec } from "../../src/rules/index.ts";
import { makeTemplate, makeTemplateFromString } from "../../src/template.ts";
import type { ExtractedTemplate } from "../../src/types.ts";

// A registry that pins a template @huggingface/jinja cannot parse ({% with %}), as a
// real upstream template can be (ISC-12 exemption).
const DIR = join(import.meta.dir, "fixtures/registry");
const registry = loadRegistry(DIR);
const pinned = registry.entries[0]!;
const path = join(DIR, "templates", `${pinned.entry.sha256}.jinja`);
const source = { kind: "chat_template_jinja" as const, path, realPath: path, name: "default" };

const highUnanalyzable = (t: ExtractedTemplate, knownGood: boolean) =>
  analyzeCodeExec({ template: t, scaffolding: new Set(), knownGood }).findings.filter((f) => f.ruleId === "unanalyzable" && f.severity === "HIGH");

test("the fixture template does not parse, so without the registry it is HIGH unanalyzable", () => {
  const t = makeTemplate(source, new Uint8Array(readFileSync(path)));
  expect(highUnanalyzable(t, false).length).toBeGreaterThan(0);
});

test("ISC-12: an exact registry match on an unparseable template gives no HIGH unanalyzable", () => {
  const t = makeTemplate(source, new Uint8Array(readFileSync(path)));
  const m = registry.match(t);
  expect(m.kind).toBe("exact");
  expect(registryStatus(m)).toBe("known-good");
  expect(highUnanalyzable(t, m.kind === "exact")).toEqual([]);
});

test("the exemption is for the exact bytes: an edited copy or a whitespace variant is still HIGH", () => {
  const edited = makeTemplateFromString(source, pinned.text.replace("message.content", "message.content.__class__"));
  expect(registry.match(edited).kind).toBe("none");
  expect(highUnanalyzable(edited, registry.match(edited).kind === "exact").length).toBeGreaterThan(0);

  const variant = makeTemplateFromString(source, pinned.text.replaceAll("\n", "\r\n"));
  expect(registry.match(variant).kind).toBe("whitespace");
  expect(highUnanalyzable(variant, registry.match(variant).kind === "exact").length).toBeGreaterThan(0);
});

// ISC-12.1 follows the renderer: every pinned stock template, Gemma 4's map('upper') and Qwen3-Coder's
// reject("in", ...) among them, is fully analyzable on its own merits, with no registry exemption.
test("ISC-12.1: every checked-in stock template is complete for code execution without the registry", () => {
  const stock = loadRegistry();
  const seen = new Set<string>();
  for (const { entry, text } of stock.entries) {
    if (seen.has(entry.sha256)) continue;
    seen.add(entry.sha256);
    const t = makeTemplateFromString({ ...source, path: entry.path, realPath: entry.path }, text);
    const r = analyzeCodeExec({ template: t, scaffolding: new Set(), knownGood: false });
    const gaps = r.findings.filter((f) => f.ruleId === "unanalyzable").map((f) => f.message);
    expect({ sha256: entry.sha256, complete: r.complete, gaps }).toEqual({ sha256: entry.sha256, complete: true, gaps: [] });
  }
  expect(seen.size).toBeGreaterThanOrEqual(21);
});
