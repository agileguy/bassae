import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { analyzeCodeExec } from "../../src/rules/index.ts";
import { makeTemplate } from "../../src/template.ts";
import type { Finding } from "../../src/types.ts";

function scanFile(path: string, knownGood = false): { findings: Finding[]; complete: boolean } {
  const t = makeTemplate({ kind: "bare", path, realPath: path, name: "default" }, new Uint8Array(readFileSync(path)));
  return analyzeCodeExec({ template: t, scaffolding: new Set(), knownGood });
}
function scan(src: string, knownGood = false): { findings: Finding[]; complete: boolean } {
  const t = makeTemplate({ kind: "bare", path: "/t", realPath: "/t", name: "default" }, new TextEncoder().encode(src));
  return analyzeCodeExec({ template: t, scaffolding: new Set(), knownGood });
}

// ISC-12 — unparseable template is HIGH unanalyzable and incomplete.
test("ISC-12: a template the library cannot parse is HIGH unanalyzable and incomplete", () => {
  const r = scanFile("fixtures/jinja2-only/with.jinja");
  const u = r.findings.find((f) => f.ruleId === "unanalyzable" && f.severity === "HIGH");
  expect(u).toBeDefined();
  expect(r.complete).toBe(false);
});

// ISC-12 — raw-text forms of ISC-13..16 still run on an unparseable template.
test("ISC-12: raw-text rules still fire on an unparseable template", () => {
  // `{% with %}` fails to parse, but the dunder in the body is still caught.
  const r = scan("{% with x = messages.__class__ %}{{ x }}{% endwith %}");
  expect(r.findings.some((f) => f.ruleId === "dunder_access" && f.severity === "HIGH")).toBe(true);
  expect(r.findings.some((f) => f.ruleId === "unanalyzable")).toBe(true);
  expect(r.complete).toBe(false);
});

// ISC-12 — known-good exempts the unanalyzable finding only.
test("ISC-12: a known-good unparseable template raises no unanalyzable finding", () => {
  const r = scanFile("fixtures/jinja2-only/with.jinja", true);
  expect(r.findings.some((f) => f.ruleId === "unanalyzable")).toBe(false);
});

// ISC-12.1 — unimplemented constructs are HIGH and name the construct.
test("ISC-12.1: |attr, |format, |random and {% with %} are HIGH naming the construct", () => {
  for (const [path, name] of [
    ["fixtures/jinja2-only/attr.jinja", "attr"],
    ["fixtures/jinja2-only/format.jinja", "format"],
    ["fixtures/jinja2-only/random.jinja", "random"],
    ["fixtures/jinja2-only/with.jinja", "with"],
  ] as const) {
    const r = scanFile(path);
    const u = r.findings.find((f) => f.ruleId === "unanalyzable" && f.severity === "HIGH" && f.message.includes(name));
    expect({ path, found: Boolean(u) }).toEqual({ path, found: true });
  }
});

// ISC-12.2 — constructs Python jinja2 accepts but the library rejects report HIGH.
test("ISC-12.2: jinja2-valid constructs the library rejects all report HIGH", () => {
  for (const path of ["fixtures/jinja2-only/with.jinja", "fixtures/jinja2-only/do.jinja", "fixtures/jinja2-only/include.jinja"]) {
    const r = scanFile(path);
    expect({ path, high: r.findings.some((f) => f.severity === "HIGH") }).toEqual({ path, high: true });
  }
});

// A benign unimplemented data filter is MEDIUM, and the template is still incomplete.
test("a benign unimplemented filter is MEDIUM and marks the template incomplete", () => {
  const r = scan("{{ keys | reject('in', handled) }}");
  expect(r.findings.some((f) => f.ruleId === "unanalyzable" && f.severity === "MEDIUM")).toBe(true);
  expect(r.findings.some((f) => f.severity === "HIGH")).toBe(false);
  expect(r.complete).toBe(false);
});

// map('upper') is the gemma-4 stock pattern: MEDIUM, naming the positional form,
// with the span and excerpt on the filter name so Phase 3 can locate it.
test("map with a positional filter name is MEDIUM, names the form, and points at 'map'", () => {
  const src = "{{ (v | map('upper') | list) }}";
  const r = scan(src);
  const f = r.findings.find((x) => x.ruleId === "unanalyzable");
  expect(f?.severity).toBe("MEDIUM");
  expect(f?.message).toContain("'map' (positional filter argument)");
  expect(f?.excerpt).toBe("map");
  expect(f?.span?.start).toBe(src.indexOf("map"));
  expect(r.complete).toBe(false);
  // The implemented attribute= form is not a finding.
  expect(scan("{{ v | map(attribute='name') | list }}").findings).toHaveLength(0);
});
