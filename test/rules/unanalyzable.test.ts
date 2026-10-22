import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeCodeExec } from "../../src/rules/index.ts";
import { makeTemplate } from "../../src/template.ts";
import type { Finding } from "../../src/types.ts";

// Fixtures are resolved against this file's location, not the process cwd.
const FIXTURES = join(import.meta.dir, "../../fixtures");

function scanFile(rel: string, knownGood = false): { findings: Finding[]; complete: boolean } {
  const path = join(FIXTURES, rel);
  const t = makeTemplate({ kind: "bare", path, realPath: path, name: "default" }, new Uint8Array(readFileSync(path)));
  return analyzeCodeExec({ template: t, scaffolding: new Set(), knownGood });
}
function scan(src: string, knownGood = false): { findings: Finding[]; complete: boolean } {
  const t = makeTemplate({ kind: "bare", path: "/t", realPath: "/t", name: "default" }, new TextEncoder().encode(src));
  return analyzeCodeExec({ template: t, scaffolding: new Set(), knownGood });
}

// ISC-12 — unparseable template is HIGH unanalyzable and incomplete.
test("ISC-12: a template the library cannot parse is HIGH unanalyzable and incomplete", () => {
  const r = scanFile("jinja2-only/with.jinja");
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
  const r = scanFile("jinja2-only/with.jinja", true);
  expect(r.findings.some((f) => f.ruleId === "unanalyzable")).toBe(false);
});

// ISC-12.1 — unimplemented constructs are HIGH and name the construct.
test("ISC-12.1: |attr, |format, |random and {% with %} are HIGH naming the construct", () => {
  for (const [path, name] of [
    ["jinja2-only/attr.jinja", "attr"],
    ["jinja2-only/format.jinja", "format"],
    ["jinja2-only/random.jinja", "random"],
    ["jinja2-only/with.jinja", "with"],
  ] as const) {
    const r = scanFile(path);
    const u = r.findings.find((f) => f.ruleId === "unanalyzable" && f.severity === "HIGH" && f.message.includes(name));
    expect({ path, found: Boolean(u) }).toEqual({ path, found: true });
  }
});

// ISC-12.2 — constructs Python jinja2 accepts but the library rejects report HIGH.
test("ISC-12.2: jinja2-valid constructs the library rejects all report HIGH", () => {
  for (const path of ["jinja2-only/with.jinja", "jinja2-only/do.jinja", "jinja2-only/include.jinja"]) {
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

// ISC-12.1 boundary (team-lead, 2026-10-22 17:50): a filter or test name that is
// not a jinja2 builtin is HIGH; an unimplemented jinja2 builtin stays MEDIUM.
const unanalyzable = (src: string) => scan(src).findings.filter((f) => f.ruleId === "unanalyzable");

test("ISC-12.1: a filter name that is not a jinja2 builtin is HIGH", () => {
  const u = unanalyzable("{{ x | shout }}");
  expect(u).toHaveLength(1);
  expect(u[0]!.severity).toBe("HIGH");
  expect(u[0]!.message).toContain("'shout' is not a jinja2 builtin");
  expect(u[0]!.excerpt).toBe("shout");
});

test("ISC-12.1: a filter only @huggingface/jinja has (|bool, |keys) is HIGH", () => {
  for (const name of ["bool", "keys", "values", "get"]) {
    const u = unanalyzable(`{{ x | ${name} }}`);
    expect(u.map((f) => f.severity)).toEqual(["HIGH"]);
  }
});

test("ISC-12.1: a test name that is not a jinja2 builtin is HIGH", () => {
  const u = unanalyzable("{% if x is banana %}y{% endif %}");
  expect(u).toHaveLength(1);
  expect(u[0]!.severity).toBe("HIGH");
  expect(u[0]!.message).toContain("test 'banana' is not a jinja2 builtin");
});

test("ISC-12.1: a filter or test named by string inside map/select/reject is classified the same way", () => {
  // Unknown test handed to reject, unknown filter handed to map: HIGH.
  expect(unanalyzable("{{ xs | reject('banana') | list }}").some((f) => f.severity === "HIGH" && f.message.includes("'banana'"))).toBe(true);
  expect(unanalyzable("{{ xs | map('shout') | list }}").some((f) => f.severity === "HIGH" && f.message.includes("'shout'"))).toBe(true);
  expect(unanalyzable("{{ xs | selectattr('a', 'banana') | list }}").some((f) => f.severity === "HIGH" && f.message.includes("'banana'"))).toBe(true);
  // map('attr', ...) reaches attributes by name exactly like |attr.
  expect(unanalyzable("{{ xs | map('attr', 'name') | list }}").some((f) => f.severity === "HIGH" && f.message.includes("'attr'"))).toBe(true);
  // A builtin test the library lacks, handed to reject: MEDIUM only.
  const stock = unanalyzable('{{ ks | reject("in", handled) | list }}');
  expect(stock.every((f) => f.severity === "MEDIUM")).toBe(true);
  expect(stock.map((f) => f.message).join(" ")).toContain("test 'in'");
});

test("unimplemented jinja2 builtin filters and tests stay MEDIUM", () => {
  for (const src of ["{{ x | d('a') }}", "{{ x | wordwrap }}", "{{ x | xmlattr }}", "{% if x is escaped %}y{% endif %}"]) {
    expect(unanalyzable(src).map((f) => f.severity)).toEqual(["MEDIUM"]);
  }
});

// ISC-12.1 globals: calling cycler, joiner or lipsum, and any bare use of self, is HIGH.
test("ISC-12.1: calling cycler, joiner or lipsum is HIGH", () => {
  for (const name of ["cycler", "joiner", "lipsum"]) {
    const src = `{% set c = ${name}('a') %}{{ c }}`;
    const u = unanalyzable(src);
    expect(u).toHaveLength(1);
    expect(u[0]!.severity).toBe("HIGH");
    expect(u[0]!.message).toContain(`global '${name}'`);
    expect(u[0]!.span?.start).toBe(src.indexOf(name));
  }
});

test("ISC-12.1: any bare use of self is HIGH", () => {
  for (const src of ["{{ self }}", "{{ self.foo() }}", "{% set t = self %}{{ t }}", "{{ x if self else y }}"]) {
    const u = unanalyzable(src);
    expect(u.some((f) => f.severity === "HIGH" && f.message.includes("global 'self'"))).toBe(true);
  }
  // `self` as an attribute name or a keyword-argument name is not the global.
  expect(unanalyzable("{{ x.self }}")).toHaveLength(0);
  expect(unanalyzable("{{ f(self=1) }}")).toHaveLength(0);
});

// Item 6 — `'x' * 3` parses but the library throws on it at render, so a
// template using string repetition is unanalyzable: MEDIUM, and incomplete.
test("item 6: string repetition is MEDIUM unanalyzable and marks the template incomplete", () => {
  const r = scan("{{ 'x' * 3 }}");
  const u = r.findings.filter((f) => f.ruleId === "unanalyzable");
  expect(u.some((f) => f.severity === "MEDIUM" && f.message.includes("string repetition"))).toBe(true);
  expect(r.findings.some((f) => f.severity === "HIGH")).toBe(false);
  expect(r.complete).toBe(false);
  // Numeric `*` is untouched.
  expect(scan("{{ 3 * 4 }}").complete).toBe(true);
});

test("keyword-only dict(...) is still no finding", () => {
  const r = scan("{% set d = dict(a=1, b=2) %}{{ d.a }}");
  expect(r.findings).toHaveLength(0);
  expect(r.complete).toBe(true);
});

// N3 — constructs that parse but throw at render in @huggingface/jinja are
// MEDIUM unanalyzable (not HIGH, and never silently complete:true).
test("N3: unique(...) with arguments is MEDIUM unanalyzable and incomplete", () => {
  const r = scan("{{ (messages | unique(attribute='role')) | list }}");
  const u = r.findings.find((f) => f.ruleId === "unanalyzable" && f.message.includes("unique"));
  expect(u?.severity).toBe("MEDIUM");
  expect(r.complete).toBe(false);
  // Plain |unique renders fine and stays complete.
  expect(scan("{{ (messages | unique) | list }}").complete).toBe(true);
});

test("N3: a .join(...) method call is MEDIUM unanalyzable and incomplete", () => {
  const r = scan("{{ '-'.join(parts) }}");
  const u = r.findings.find((f) => f.ruleId === "unanalyzable" && f.message.includes("join"));
  expect(u?.severity).toBe("MEDIUM");
  expect(r.complete).toBe(false);
  // The |join filter is implemented and stays complete.
  expect(scan("{{ parts | join('-') }}").complete).toBe(true);
});
