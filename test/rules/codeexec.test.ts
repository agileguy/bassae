import { expect, test } from "bun:test";
import { analyzeCodeExec } from "../../src/rules/index.ts";
import { makeTemplate } from "../../src/template.ts";
import type { Finding, RuleId } from "../../src/types.ts";

function scan(src: string, knownGood = false): Finding[] {
  const t = makeTemplate({ kind: "bare", path: "/t", realPath: "/t", name: "default" }, new TextEncoder().encode(src));
  return analyzeCodeExec({ template: t, scaffolding: new Set(), knownGood }).findings;
}
function highs(src: string): RuleId[] {
  return scan(src).filter((f) => f.severity === "HIGH").map((f) => f.ruleId);
}

// ISC-13 — dunder attribute access, dot and subscript.
test("ISC-13: dunder access via dot and via subscript is HIGH", () => {
  expect(highs("{{ messages[0].__class__ }}")).toContain("dunder_access");
  expect(highs("{{ x['__class__']['__mro__'] }}").filter((r) => r === "dunder_access")).toHaveLength(2);
});

// ISC-13.1 — format-spec traversal.
test("ISC-13.1: str.format() format-spec traversal is HIGH", () => {
  expect(highs("{{ '{0.__class__.__init__.__globals__}'.format(x) }}")).toContain("format_traversal");
});

// ISC-14 — constant folding of obfuscated dunders.
test("ISC-14: a dunder folded via ~ or |join is HIGH", () => {
  expect(highs("{{ '__cl' ~ 'ass__' }}")).toContain("folded_dunder");
  expect(highs("{{ ['__mr', 'o__'] | join }}")).toContain("folded_dunder");
  expect(highs("{{ '__cla' ~ ('s' | upper | lower) ~ 's__' }}")).toContain("folded_dunder");
});

// ISC-14.1 — dynamic attribute reach.
test("ISC-14.1: |attr, |format, .format( and non-literal keys on non-data objects are HIGH", () => {
  expect(highs("{{ x | attr('foo') }}")).toContain("dynamic_attribute");
  expect(highs("{{ x | format('y') }}")).toContain("dynamic_attribute");
  expect(highs("{{ payload.format(x) }}")).toContain("dynamic_attribute");
  expect(highs("{{ gadget[probe] }}")).toContain("dynamic_attribute");
});

// ISC-15 — gadget traversal.
test("ISC-15: attribute or subscript on an engine gadget is HIGH", () => {
  for (const g of ["cycler", "joiner", "lipsum", "namespace", "dict", "self"]) {
    expect(highs(`{{ ${g}.foo }}`)).toContain("gadget_traversal");
  }
  expect(highs("{{ cycler['next'] }}")).toContain("gadget_traversal");
});

test("ISC-15: namespace()/dict() calls with keyword args only are not findings", () => {
  expect(highs("{% set ns = namespace(found=false) %}{{ ns.found }}")).toHaveLength(0);
  expect(highs("{{ dict(a=1, b=2) }}")).toHaveLength(0);
});

// ISC-15.1 — engine fingerprinting.
test("ISC-15.1: `is defined` on an engine global is HIGH engine_fingerprint", () => {
  for (const g of ["dict", "cycler", "joiner", "lipsum", "namespace", "range", "raise_exception"]) {
    expect(highs(`{% if ${g} is defined %}x{% endif %}`)).toContain("engine_fingerprint");
  }
  expect(highs("{% if namespace is undefined %}x{% endif %}")).toContain("engine_fingerprint");
});

test("ISC-15.1: strftime_now is deliberately not fingerprinted", () => {
  expect(highs("{% if strftime_now is defined %}x{% endif %}")).toHaveLength(0);
});

// ISC-16 — OS/exec surfaces in a callable position.
test("ISC-16: OS/exec surfaces called are HIGH exec_surface", () => {
  expect(highs("{{ os.popen('id').read() }}")).toContain("exec_surface");
  expect(highs("{{ subprocess.run('id') }}")).toContain("exec_surface");
  expect(highs("{{ system('id') }}")).toContain("exec_surface");
});

// ISC-26.1 — spans point at the planted payload.
test("ISC-26.1: a payload planted at a known offset reports the right line:column", () => {
  const src = "line1\nline2\n  {{ x.__class__ }}";
  const f = scan(src).find((x) => x.ruleId === "dunder_access");
  expect(f?.span).toEqual({ start: src.indexOf("__class__"), end: src.indexOf("__class__") + 9, line: 3, col: 8 });
  expect(f?.excerpt).toBe("__class__");
});

test("ISC-26.1: an engine_fingerprint span lands on the global, not the keyword", () => {
  const src = "{% if dict is defined %}x{% endif %}";
  const f = scan(src).find((x) => x.ruleId === "engine_fingerprint");
  expect(f?.span?.line).toBe(1);
  expect(f?.span?.col).toBe(7); // the `d` of dict
  expect(f?.excerpt).toBe("dict");
});

// False-positive bar — the hardest part. None of these stock patterns may fire HIGH.
test("real stock patterns produce zero HIGH findings", () => {
  const stock = [
    "{{ messages[loop.index0] }}",
    "{% for m in messages %}{{ messages[loop.index0 - 1].role }}{% endfor %}",
    "{% set loop_messages = messages %}{% for m in loop_messages %}{{ loop_messages[loop.index0] }}{% endfor %}",
    "{% macro render(param_fields) %}{% for k, v in param_fields | items %}{{ param_fields[k] }}{% endfor %}{% endmacro %}",
    "{% set ns = namespace(multi_step_tool=true, last_query_index=messages | length - 1) %}{{ ns.last_query_index }}",
    "{{ raise_exception('template requires a system message') }}",
    "{{ tool_call.function.arguments }}",
    "{% if message.content.startswith('<tool_response>') %}{{ eos_token }}{% endif %}",
    "{% if enable_thinking is defined and enable_thinking %}<think>{% endif %}",
    "{{ (param_fields.type | string) }}",
  ];
  for (const src of stock) {
    expect({ src, highs: highs(src) }).toEqual({ src, highs: [] });
  }
});

test("a known-good template still runs the code-exec rules (only unanalyzable is exempt)", () => {
  // knownGood suppresses the parse-failure HIGH, not a real gadget traversal.
  expect(scan("{{ cycler.foo }}", true).some((f) => f.ruleId === "gadget_traversal")).toBe(true);
});

// ISC-15.1 — `is filter` / `is test` ask the engine what it has (team-lead, 2026-10-22).
test("ISC-15.1: `is filter` and `is test` are HIGH engine_fingerprint, span on the test name", () => {
  for (const src of ["{% if 'attr' is filter %}x{% endif %}", "{% if 'banana' is not test %}x{% endif %}"]) {
    const f = scan(src).find((x) => x.ruleId === "engine_fingerprint");
    expect(f?.severity).toBe("HIGH");
    const name = src.includes("filter") ? "filter" : "test";
    expect(f?.excerpt).toBe(name);
    expect(f?.span?.start).toBe(src.indexOf(name));
  }
  // The same probe named by string inside select/reject.
  expect(highs("{{ ['attr', 'x'] | select('filter') | list }}")).toContain("engine_fingerprint");
  expect(highs("{{ ['in'] | reject('test') | list }}")).toContain("engine_fingerprint");
  // Raw-text fallback on a template the library cannot parse.
  expect(highs("{% with a = 1 %}{% if 'attr' is filter %}x{% endif %}{% endwith %}")).toContain("engine_fingerprint");
  // A {% filter %} block is not the test.
  expect(highs("{% filter upper %}hi{% endfilter %}")).not.toContain("engine_fingerprint");
});
