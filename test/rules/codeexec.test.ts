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

// ISC-13/14 (item 5) — every dunder-closure route is HIGH. Each of these parsed
// cleanly and produced zero findings before the round-1 fix.
test("item 5: dunder reached by any route (attribute=, selectattr, string-op key, fold) is HIGH", () => {
  const routes = [
    "{{ messages | map(attribute='__class__') | list }}",
    "{% set s = (messages | map(attribute='__class__.__base__.__subclasses__') | first)() %}{{ s }}",
    "{{ messages | selectattr('__class__') | list }}",
    "{{ messages | sort(attribute='__class__') | list }}",
    "{{ messages[0][messages[0].role[:0] ~ '__class__'] }}",
    "{{ messages[0]['_' * 2 ~ 'class' ~ '_' * 2] }}",
    "{{ messages[0]['__ssalc__' | reverse | join] }}",
    "{% set m = messages[0] %}{{ m['_' * 2 ~ 'class' ~ '_' * 2] }}",
  ];
  const DUNDER_RULES = new Set(["dunder_access", "dynamic_attribute", "folded_dunder"]);
  for (const src of routes) {
    expect({ src, hit: highs(src).some((r) => DUNDER_RULES.has(r)) }).toEqual({ src, hit: true });
  }
  // A literal subscript naming an exec surface in callee position is ISC-16.
  expect(highs("{{ messages[0]['popen']('id') }}")).toContain("exec_surface");
});

// Item 5 — a name bound to a gadget is itself a gadget (ISC-15), by set, set-chain
// or macro-parameter default. A call result is NOT the gadget, so stock
// `set ns = namespace(...)` stays benign.
test("item 5: gadget aliases traverse HIGH; namespace() call result stays benign", () => {
  expect(highs("{% set c = cycler %}{{ c.next }}")).toContain("gadget_traversal");
  expect(highs("{% set c = cycler %}{% set d = c %}{{ d.next }}")).toContain("gadget_traversal");
  expect(highs("{% macro m(c=cycler) %}{{ c.next }}{% endmacro %}")).toContain("gadget_traversal");
  expect(highs("{% set ns = namespace(found=false) %}{{ ns.found }}")).toHaveLength(0);
});

// Item 9 — a folded/literal string that merely looks like an exec surface is a
// finding ONLY in a callable or attribute position, never in text/role position.
test("item 9: exec-surface strings fire only in callable/attribute positions", () => {
  for (const src of [
    "{{ 'system' }}",
    "{{ 'open a ticket' }}",
    "{{ ['system', 'user'] | join }}",
    "{% if message.role == 'system' %}x{% endif %}",
  ]) {
    expect({ src, highs: highs(src) }).toEqual({ src, highs: [] });
  }
  expect(highs("{{ x['system']('id') }}")).toContain("exec_surface");
  expect(highs("{{ messages | map(attribute='os.system') | list }}")).toContain("exec_surface");
});

// --- Review round 2 ---------------------------------------------------------

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function findings(src: string) {
  return scan(src);
}

// M1 — a dunder key assembled in an EARLIER statement. The carve-out checked
// "built" only at the use site, so each of these parsed clean with 0 findings.
test("M1: a dunder key built across set/loop statements is HIGH", () => {
  const cases = [
    "{% set ns = namespace(k='__cla') %}{% set ns.k = ns.k ~ 'ss__' %}{{ messages[0][ns.k] }}",
    "{% set k = '__cla' %}{% set k = k ~ 'ss__' %}{{ messages[0][k] }}",
    "{% for p in [['__cla','ss__']] %}{% set k = p|join %}{{ messages[0][k] }}{% endfor %}",
  ];
  const KEY_RULES = new Set(["dunder_access", "dynamic_attribute"]);
  for (const src of cases) {
    expect({ src, hit: highs(src).some((r) => KEY_RULES.has(r)) }).toEqual({ src, hit: true });
  }
  // A numeric counter carried through a namespace is NOT a string op: benign.
  expect(highs("{% set ns = namespace(i=0) %}{% set ns.i = ns.i + 1 %}{{ messages[ns.i] }}")).toHaveLength(0);
});

// M2 — a gadget laundered through a local binding. cycler/joiner/lipsum are HIGH
// on any reference; namespace/dict are HIGH when used as a value, benign when
// called with keyword arguments.
test("M2: gadgets laundered through a binding are HIGH; keyword-only calls are not", () => {
  const laundered = [
    "{% set x = [lipsum] %}{{ x }}",
    "{{ (lipsum if true else 0) }}",
    "{% for g in [lipsum] %}{{ g }}{% endfor %}",
    "{% macro f(a) %}{{ a }}{% endmacro %}{{ f(lipsum) }}",
    "{% set x = [cycler] %}{{ x }}",
    "{% set x = [joiner] %}{{ x }}",
    "{% set x = [namespace] %}{{ x }}",
    "{% set x = [dict] %}{{ x }}",
    "{{ namespace }}",
    "{{ dict }}",
  ];
  for (const src of laundered) {
    expect({ src, high: highs(src).length > 0 }).toEqual({ src, high: true });
  }
  expect(highs("{% set ns = namespace(found=false) %}{{ ns.found }}")).toHaveLength(0);
  expect(highs("{{ dict(a=1, b=2) }}")).toHaveLength(0);
});

// M3 — a positional attribute argument. The library renders a positional sort
// attribute, so `messages|sort(false, false, ns.k)` must be caught like attribute=.
test("M3: a positional attribute argument reaches attributes by name (HIGH)", () => {
  expect(highs("{{ (messages | sort(false, false, ns.k)) | list }}")).toContain("dynamic_attribute");
  expect(highs("{{ (messages | unique(false, ns.k)) | list }}")).toContain("dynamic_attribute");
  expect(highs("{{ (messages | min(false, ns.k)) | list }}")).toContain("dynamic_attribute");
  expect(highs("{{ (messages | groupby(ns.k)) | list }}")).toContain("dynamic_attribute");
  expect(highs("{{ (messages | sum(ns.k)) | list }}")).toContain("dynamic_attribute");
  expect(highs("{{ (messages | sort(false, false, '__class__')) | list }}")).toContain("dunder_access");
  // A literal attribute path and an attribute-free sort are benign.
  expect(highs("{{ (messages | sort(false, false, 'role')) | list }}")).toHaveLength(0);
  expect(highs("{{ (messages | sort(true)) | list }}")).toHaveLength(0);
});

// M4 — string methods the library renders are folded; any other method call in a
// key position is built, so HIGH dynamic_attribute.
test("M4: string methods fold into the key; other methods are dynamic", () => {
  expect(highs("{{ messages[0]['__claXX'.replace('XX','ss__')] }}")).toContain("dunder_access");
  expect(highs("{{ messages[0]['__CLA'.lower() ~ 'ss__'] }}")).toContain("dunder_access");
  expect(highs("{{ messages[0][' __class__ '.strip()] }}")).toContain("dunder_access");
  expect(highs("{{ messages[0][x.split('.')] }}")).toContain("dynamic_attribute");
  // A folded exec surface in callee position is still exec_surface.
  expect(highs("{{ messages[0]['POPEN'.lower()]('id') }}")).toContain("exec_surface");
});

// M5 — every HIGH finding carries a span, even when it names a composite node.
test("M5: every HIGH finding from the fixtures and bypass probes has a span", () => {
  const dir = join(import.meta.dir, "../../fixtures/malicious/codeexec");
  const fixtures = readdirSync(dir).filter((f) => f.endsWith(".jinja")).map((f) => readFileSync(join(dir, f), "utf8"));
  const probes = [
    "{% set ns = namespace(k='__cla') %}{% set ns.k = ns.k ~ 'ss__' %}{{ messages[0][ns.k] }}",
    "{% set k = '__cla' %}{% set k = k ~ 'ss__' %}{{ messages[0][k] }}",
    "{{ messages[0]['__claXX'.replace('XX','ss__')] }}",
    "{{ (messages | sort(false, false, ns.k)) | list }}",
    "{{ messages[0]['_' * 2 ~ 'class' ~ '_' * 2] }}",
    "{% set m = messages[0] %}{{ m['_' * 2 ~ 'class' ~ '_' * 2] }}",
    "{{ namespace }}",
  ];
  for (const src of [...fixtures, ...probes]) {
    for (const f of findings(src).filter((x) => x.severity === "HIGH")) {
      expect({ src: src.slice(0, 40), ruleId: f.ruleId, hasSpan: Boolean(f.span) }).toEqual({ src: src.slice(0, 40), ruleId: f.ruleId, hasSpan: true });
    }
  }
});

// T9 — stock templates from Apache-2.0 models never raise HIGH or dunder_access.
test("T9: clean stock templates produce no HIGH and no dunder_access", () => {
  const dir = join(import.meta.dir, "../../fixtures/clean");
  const files = readdirSync(dir).filter((f) => f.endsWith(".jinja"));
  expect(files.length).toBeGreaterThanOrEqual(3);
  for (const file of files) {
    const src = readFileSync(join(dir, file), "utf8");
    const fs = findings(src);
    expect({ file, high: fs.filter((f) => f.severity === "HIGH").map((f) => f.ruleId) }).toEqual({ file, high: [] });
    expect({ file, dunder: fs.some((f) => f.ruleId === "dunder_access") }).toEqual({ file, dunder: false });
  }
});

// --- Review round 2, wave 2 -------------------------------------------------

// Carve-out (Gemini M1/M2) — a subscript key is exempt ONLY when it is a direct
// literal index or provably runtime data. A key reached through a binding to a
// literal, a template-built value, or a macro parameter is not, so calling a
// value fetched by such a key is HIGH even when it folds to a benign string.
test("carve-out: a key held in a non-runtime binding is dynamic, not exempt", () => {
  // s and k are template literals; s[k]() dynamically invokes a method by a name
  // the template controls.
  expect(highs("{% set s = 'abc' %}{% set k = 'upper' %}{{ s[k]() }}")).toContain("dynamic_attribute");
  // A loop item is runtime, but a set-held key is still template-built.
  expect(highs("{% set k = 'upper' %}{% for m in messages %}{{ m[k]() }}{% endfor %}")).toContain("dynamic_attribute");
  // A macro parameter is caller-controlled: a caller that passes a literal makes
  // the param key dynamic.
  expect(highs("{% macro f(p) %}{{ messages[0][p] }}{% endmacro %}{{ f('upper') }}")).toContain("dynamic_attribute");
  // The exemptions still hold: a direct literal index, a numeric index however
  // derived, a slice, and a provably-runtime key are all benign.
  expect(highs("{{ messages[0]['content'] }}")).toHaveLength(0);
  expect(highs("{% set ns = namespace(i=0) %}{% set ns.i = ns.i + 1 %}{{ messages[ns.i] }}")).toHaveLength(0);
  expect(highs("{{ messages[::-1] }}")).toHaveLength(0);
  expect(highs("{% for key in message %}{{ message[key] }}{% endfor %}")).toHaveLength(0);
});

// Round-2 computed-callee review — a computed callee property is resolved through
// its binding, never by the variable's own spelling.
test("computed-callee review: a computed callee key resolves through its binding, not its name", () => {
  // `k` holds an exec surface: resolving the binding catches it.
  expect(highs("{% set s = 'x' %}{% set k = 'popen' %}{{ s[k]() }}")).toContain("exec_surface");
  // `format` is an unbound variable used as a key. It must NOT fire the .format()
  // rule merely because it is spelled "format"; the subscript is dynamic instead.
  const fs = scan("{% for m in messages %}{{ m[format]() }}{% endfor %}");
  expect(fs.some((f) => f.ruleId === "format_traversal")).toBe(false);
  expect(fs.some((f) => /\.format\(\)/.test(f.message))).toBe(false);
  // A real str.format() is still caught.
  expect(highs("{{ payload.format(x) }}")).toContain("dynamic_attribute");
});

// M3 (wave 2) — a positional attribute argument that is a template-controlled
// name (not a direct literal) is dynamic; a direct literal exec path is caught.
test("M3: positional attribute args — variable name is dynamic, literal exec is exec", () => {
  expect(highs("{% set k = 'x' %}{{ (messages | sort(false, false, k)) | list }}")).toContain("dynamic_attribute");
  expect(highs("{% set k = 'x' %}{{ (messages | unique(false, k)) | list }}")).toContain("dynamic_attribute");
  expect(highs("{{ (messages | sort(false, false, 'os.system')) | list }}")).toContain("exec_surface");
  // A direct literal attribute name stays benign.
  expect(highs("{{ (messages | sort(false, false, 'role')) | list }}")).toHaveLength(0);
});

// ISC-14 (wave 2) — folding covers slices, replace, concat escapes, and |reverse.
test("ISC-14: slice, replace, escape-concat, and |reverse all fold to the dunder", () => {
  expect(highs("{{ messages[0]['__ssalc__'[::-1]] }}")).toContain("dunder_access");
  expect(highs("{{ messages[0][('__ssalc__'|reverse)] }}")).toContain("dunder_access");
  expect(highs("{{ messages[0][('__XYZ__'|replace('XYZ','class'))] }}")).toContain("dunder_access");
  expect(highs("{{ messages[0][('XX__class__YY'[2:11])] }}")).toContain("dunder_access");
});

// M7 — every finding stamps `templateSha256`, never a stray `sha256`.
test("M7: findings carry templateSha256 and never a sha256 key", () => {
  const dir = join(import.meta.dir, "../../fixtures/malicious/codeexec");
  const fixtures = readdirSync(dir).filter((f) => f.endsWith(".jinja")).map((f) => readFileSync(join(dir, f), "utf8"));
  const probes = [
    "{{ messages[0].__class__ }}",
    "{% set s = 'abc' %}{% set k = 'upper' %}{{ s[k]() }}",
    "{{ (messages | sort(false, false, ns.k)) | list }}",
    "{% with x = 1 %}{{ x }}{% endwith %}", // unanalyzable path
    "{{ x | unknownfilter }}", // unsupported path
  ];
  let checked = 0;
  for (const src of [...fixtures, ...probes]) {
    for (const f of findings(src)) {
      checked++;
      expect({ src: src.slice(0, 32), has: typeof f.templateSha256 }).toEqual({ src: src.slice(0, 32), has: "string" });
      expect({ src: src.slice(0, 32), stray: "sha256" in f }).toEqual({ src: src.slice(0, 32), stray: false });
    }
  }
  expect(checked).toBeGreaterThan(0);
});

// --- Review round 2, part 3 -------------------------------------------------

function messagesOf(src: string): string[] {
  return scan(src).filter((f) => f.severity === "HIGH").map((f) => f.message);
}

// Macro-parameter review — a parameter is runtime data only when EVERY direct
// call site, and its default if it has one, passes runtime data. A runtime key on
// a parameter some caller fills with a literal is a template-made object reached
// by a data-chosen name.
test("macro-parameter review: a param is runtime only when every call site and its default pass runtime data", () => {
  const TEMPLATE_MADE = "runtime-data key indexes a value the template made, not runtime data";
  // The reported probe.
  expect(messagesOf("{% macro f(o) %}{{ o[messages[0].role] }}{% endmacro %}{{ f('abc') }}")).toEqual([TEMPLATE_MADE]);
  // Every caller passes runtime data: clean.
  expect(highs("{% macro f(o) %}{{ o[messages[0].role] }}{% endmacro %}{{ f(messages[0]) }}")).toHaveLength(0);
  expect(highs("{% macro f(o) %}{{ o[messages[0].role] }}{% endmacro %}{{ f(o=messages[0]) }}")).toHaveLength(0);
  // One literal caller, a literal keyword argument, or a literal default is enough.
  expect(highs("{% macro f(o) %}{{ o[messages[0].role] }}{% endmacro %}{{ f(messages[0]) }}{{ f('abc') }}")).toContain("dynamic_attribute");
  expect(highs("{% macro f(o) %}{{ o[messages[0].role] }}{% endmacro %}{{ f(o='abc') }}")).toContain("dynamic_attribute");
  expect(highs("{% macro f(o='abc') %}{{ o[messages[0].role] }}{% endmacro %}{{ f(messages[0]) }}")).toContain("dynamic_attribute");
  // A {% call %} block is a call site too.
  expect(highs("{% macro f(o) %}{{ o[messages[0].role] }}{{ caller() }}{% endmacro %}{% call f('abc') %}x{% endcall %}")).toContain("dynamic_attribute");
  // A param named like a runtime input is whatever its callers bind.
  expect(highs("{% macro f(message) %}{{ message[messages[0].role] }}{% endmacro %}{{ f('abc') }}")).toContain("dynamic_attribute");
  expect(highs("{% macro f(content) %}{{ messages[0][content]() }}{% endmacro %}{{ f('upper') }}")).toContain("dynamic_attribute");
  // A macro whose name escapes (bound by set) or that is called with a spread
  // can receive arguments we cannot see: its params are opaque.
  expect(highs("{% macro f(o) %}{{ o[messages[0].role] }}{% endmacro %}{% set g = f %}{{ g('abc') }}")).toContain("dynamic_attribute");
  expect(highs("{% macro f(o) %}{{ o[messages[0].role] }}{% endmacro %}{{ f(*['abc']) }}")).toContain("dynamic_attribute");
  // Recursion: the greatest fixpoint keeps a self-call on runtime data clean and
  // demotes the param when any call, recursive or not, passes a literal.
  expect(highs("{% macro f(o) %}{% for k, v in o|items %}{{ o[k] }}{{ f(v) }}{% endfor %}{% endmacro %}{{ f(tools[0]) }}")).toHaveLength(0);
  expect(highs("{% macro f(o) %}{% for k, v in o|items %}{{ o[k] }}{{ f('abc') }}{% endfor %}{% endmacro %}{{ f(tools[0]) }}")).toContain("dynamic_attribute");
  // A macro that is never called never runs: nothing reaches its params.
  expect(highs("{% macro f(o) %}{{ o[messages[0].role] }}{% endmacro %}")).toHaveLength(0);
});

// The upstream Qwen3-Coder template's render_extra_keys macro and its three call
// sites (structure as published; the local corpus copy predates it). Every call
// passes tool data, so `json_dict[json_key]` must stay clean.
test("macro-parameter review: Qwen3-Coder render_extra_keys stays clean", () => {
  const src = [
    "{% macro render_extra_keys(json_dict, handled_keys) %}",
    "{%- if json_dict is mapping %}",
    "{%- for json_key in json_dict if json_key not in handled_keys %}",
    "{%- if json_dict[json_key] is mapping or (json_dict[json_key] is sequence and json_dict[json_key] is not string) %}",
    "{{- '\\n<' ~ json_key ~ '>' ~ (json_dict[json_key] | tojson | safe) ~ '</' ~ json_key ~ '>' }}",
    "{%- else %}",
    "{{-'\\n<' ~ json_key ~ '>' ~ (json_dict[json_key] | string) ~ '</' ~ json_key ~ '>' }}",
    "{%- endif %}",
    "{%- endfor %}",
    "{%- endif %}",
    "{% endmacro %}",
    "{%- for tool in tools %}",
    "{%- if tool.function is defined %}{%- set tool = tool.function %}{%- endif %}",
    "{%- for param_name, param_fields in tool.parameters.properties|items %}",
    "{%- set handled_keys = ['name', 'type', 'description'] %}",
    "{{- render_extra_keys(param_fields, handled_keys) }}",
    "{%- endfor %}",
    "{% set handled_keys = ['type', 'properties'] %}",
    "{{- render_extra_keys(tool.parameters, handled_keys) }}",
    "{%- set handled_keys = ['type', 'name', 'description', 'parameters'] %}",
    "{{- render_extra_keys(tool, handled_keys) }}",
    "{%- endfor %}",
  ].join("\n");
  expect(highs(src)).toHaveLength(0);
  // The same macro fed a literal at one call site is flagged.
  expect(highs(src.replace("render_extra_keys(tool, handled_keys)", "render_extra_keys('abc', handled_keys)"))).toContain("dynamic_attribute");
});

// The same hole through other bindings: a loop variable is runtime only when the
// loop walks runtime data, a name written more than once holds the join of every
// write, and `or`/`and`/`%` can hand back a template-chosen string.
test("binding review: loops, rebinding, and operand-returning operators cannot launder a template-chosen value", () => {
  // A set-held literal object indexed by runtime data.
  expect(highs("{% set o = 'abc' %}{{ o[messages[0].role] }}")).toContain("dynamic_attribute");
  // Loops over a literal list, or through a filter that can inject a value.
  expect(highs("{% for o in ['abc'] %}{{ o[messages[0].role] }}{% endfor %}")).toContain("dynamic_attribute");
  expect(highs("{% for k in ['upper'] %}{{ messages[0][k]() }}{% endfor %}")).toContain("dynamic_attribute");
  expect(highs("{% for k in message.nope | default(['upper']) %}{{ messages[0][k]() }}{% endfor %}")).toContain("dynamic_attribute");
  expect(highs("{% for m in messages %}{{ m.get('zz', 'abc')[m.content] }}{% endfor %}")).toContain("dynamic_attribute");
  // A later clean write does not launder an earlier template-made one.
  expect(highs("{% set k = 'upper' %}{{ messages[0][k]() }}{% set k = messages[0].role %}")).toContain("dynamic_attribute");
  // `or` / `and` return an operand.
  expect(highs("{% for m in messages %}{{ m[m.nope or 'upper']() }}{% endfor %}")).toContain("dynamic_attribute");
  expect(highs("{% for m in messages %}{% set k = m.role and 'upper' %}{{ m[k]() }}{% endfor %}")).toContain("dynamic_attribute");
  // Python %-formatting builds a string: folded when it can be, flagged when not.
  expect(highs("{{ messages[0]['__%s__' % 'class'] }}")).toEqual(expect.arrayContaining(["dunder_access", "folded_dunder"]));
  expect(highs("{{ messages[0]['%s' % 'upper']() }}")).toContain("dynamic_attribute");
  // A {% call(x) %} block argument is whatever the macro passes to caller(), which is not traced.
  expect(highs("{% macro f() %}{{ caller('abc') }}{% endmacro %}{% call(o) f() %}{{ o[messages[0].role] }}{% endcall %}")).toContain("dynamic_attribute");

  // Stock shapes stay clean: a loop through data-preserving filters and methods,
  // a range() index on anything, a counter, an `or []` default, and a runtime
  // input that a branch resets to [].
  const stock = [
    "{% for k, v in tools[0].parameters.properties | dictsort %}{{ tools[0].parameters.properties[k] }}{% endfor %}",
    "{% for k in message.keys() | reject('in', ['role']) %}{{ message[k] }}{% endfor %}",
    "{% for tc in message.get('tool_calls') %}{% for k in tc %}{{ tc[k] }}{% endfor %}{% endfor %}",
    "{% for tc in message.tool_calls or [] %}{% for k in tc %}{{ tc[k] }}{% endfor %}{% endfor %}",
    "{% set roles = ['user', 'assistant'] %}{% for i in range(2) %}{{ roles[i] }}{% endfor %}",
    "{% set ns = namespace(i=0) %}{% for m in messages %}{% set ns.i = ns.i + 1 %}{{ messages[ns.i - 1] }}{% endfor %}",
    "{% if tools is not defined %}{% set tools = [] %}{% endif %}{% for t in tools %}{% for k in t %}{{ t[k] }}{% endfor %}{% endfor %}",
    "{% for m in messages %}{{ messages[loop.index0 - 1] }}{% endfor %}",
  ];
  for (const src of stock) expect({ src, highs: highs(src) }).toEqual({ src, highs: [] });
});

// Computed-callee item — an unbound name used as a key is dynamic, and the
// message says that it is unbound rather than calling it runtime-or-literal.
test("computed-callee review: an unbound key is dynamic with a message naming it unbound", () => {
  expect(messagesOf("{% for m in messages %}{{ m[format]() }}{% endfor %}")).toEqual([
    "subscript key 'format' is not bound in the template and is not a known runtime input",
  ]);
  // A bound non-runtime key keeps the general message.
  expect(messagesOf("{% set k = 'upper' %}{% for m in messages %}{{ m[k]() }}{% endfor %}")).toEqual([
    "subscript key is neither a literal nor runtime data",
  ]);
});

// ISC-14.1 object rule (round-3 gate): both conditions hold together. The object
// must be runtime-rooted, and the key a direct literal, a number, a slice or
// runtime data. A runtime key on a value the template made lets the data pick
// an attribute of the template's object, so it is HIGH, and the template is
// still fully analyzed.
test("ISC-14.1 object rule: a runtime key on a template-made object is HIGH", () => {
  const made = [
    "{% set s = 'abc' %}{% for m in messages %}{{ s[m.content]() }}{% endfor %}",
    "{% set s = 'abc' %}{% for m in messages %}{{ s[m.role] }}{% endfor %}",
    "{% set xs = ['a'] %}{% for m in messages %}{{ xs[m.role] }}{% endfor %}",
    "{% macro f(o) %}{{ o[messages[0].role] }}{% endmacro %}{{ f('abc') }}",
  ];
  for (const src of made) {
    const t = makeTemplate({ kind: "bare", path: "/t", realPath: "/t", name: "default" }, new TextEncoder().encode(src));
    const r = analyzeCodeExec({ template: t, scaffolding: new Set(), knownGood: false });
    const got = r.findings.filter((f) => f.severity === "HIGH").map((f) => f.ruleId);
    expect({ src, complete: r.complete, highs: got }).toEqual({ src, complete: true, highs: ["dynamic_attribute"] });
  }
  // A runtime key on a runtime object is the carve-out, and stays clean.
  expect(highs("{% for m in messages %}{{ m[m.role] }}{% endfor %}")).toEqual([]);
});

// Round-3 D1 — the library keeps a dict literal's entries in a Map, which a
// walker enumerating node fields with Object.values never enters. Every rule
// must see a dict's values and keys, at any depth.
test("D1: the rules see inside dict literals: values, keys and nested dicts", () => {
  expect(highs("{{ {'a': messages[0].__class__} }}")).toContain("dunder_access");
  expect(highs("{{ {messages[0].__class__: 1} }}")).toContain("dunder_access");
  expect(highs("{{ {'a': {'b': messages[0].__class__}} }}")).toContain("dunder_access");
  expect(highs("{{ {'a': os.popen('x')} }}")).toContain("exec_surface");
  expect(highs("{{ {'a': messages|attr(k)} }}")).toContain("dynamic_attribute");
  expect(highs("{{ {'a': '__cla' ~ 'ss__'} }}")).toContain("folded_dunder");
  expect(highs("{{ {'a': namespace} }}")).toContain("gadget_traversal");
  // A macro whose name is used inside a dict escapes, so its parameters are not runtime.
  expect(highs("{% macro f(o) %}{{ o[messages[0].role] }}{% endmacro %}{{ {'a': f} }}{{ f(messages) }}")).toContain("dynamic_attribute");
});

// Structural form of D1: whatever an expression raises at top level, it raises
// in a dict value, a dict key, a nested dict and a dict inside a list, and the
// template is complete in each exactly when it is at top level.
test("D1: every rule that fires on an expression also fires when it sits in a dict", () => {
  const EXPRS = [
    "messages[0].__class__",
    "messages[0]['__class__']",
    "messages[0][k]",
    "'__cla' ~ 'ss__'",
    "['__mr', 'o__'] | join",
    "'{0.__class__}'.format(x)",
    "payload.format(x)",
    "x | attr('foo')",
    "x | format('y')",
    "os.popen('x')",
    "namespace",
    "dict.items",
    "self",
    "joiner",
    "lipsum()",
    "cycler('a')",
    "cycler is defined",
    "x is filter",
    "x | select('filter')",
    "x | nosuchfilter",
    "x is nosuchtest",
    "x | wordwrap",
    "x.join(y)",
    "'x' * 3",
  ];
  const sig = (src: string): { complete: boolean; rules: string[] } => {
    const t = makeTemplate({ kind: "bare", path: "/t", realPath: "/t", name: "default" }, new TextEncoder().encode(src));
    const r = analyzeCodeExec({ template: t, scaffolding: new Set(), knownGood: false });
    return { complete: r.complete, rules: [...new Set(r.findings.map((f) => `${f.ruleId}:${f.severity}`))].sort() };
  };
  for (const e of EXPRS) {
    const top = sig(`{{ ${e} }}`);
    expect({ e, fires: top.rules.length > 0 }).toEqual({ e, fires: true });
    for (const wrapped of [`{{ {'k': ${e}} }}`, `{{ {${e}: 1} }}`, `{{ {'k': {'j': ${e}}} }}`, `{{ [{'k': ${e}}] }}`]) {
      const got = sig(wrapped);
      const missing = top.rules.filter((r) => !got.rules.includes(r));
      expect({ wrapped, complete: got.complete, missing }).toEqual({ wrapped, complete: top.complete, missing: [] });
    }
  }
});

// Round-3 D2 — a binary expression that does not fold is runtime data only
// when every operand is. Two template-sourced macro arguments joined with `+`,
// `*` or `%` can spell any attribute name, so as a key they are dynamic.
test("D2: a non-folding binary expression is runtime only when its operands are", () => {
  expect(highs("{% macro f(p, q) %}{{ messages[0][p + q] }}{% endmacro %}{{ f('__cla', 'ss__') }}").length).toBeGreaterThan(0);
  expect(highs("{% set s = 'abc' %}{% macro f(p, q) %}{{ s[p + q] }}{% endmacro %}{{ f('up', 'per') }}")).toContain("dynamic_attribute");
  expect(highs("{% macro f(p, q) %}{{ messages[0][p + q]() }}{% endmacro %}{{ f(messages[0].role, 'x') }}")).toContain("dynamic_attribute");
  expect(highs("{% macro f(p, n) %}{{ messages[0][p * n]() }}{% endmacro %}{{ f(messages[0].role, 1) }}")).toContain("dynamic_attribute");
  expect(highs("{% macro f(p, q) %}{{ messages[0][p % q]() }}{% endmacro %}{{ f(messages[0].role, 'upper') }}")).toContain("dynamic_attribute");
  // Literal operands still fold to the dunder.
  expect(highs("{% set a = '__cla' %}{% set b = 'ss__' %}{{ messages[0][a + b] }}")).toContain("dunder_access");
  // Runtime with runtime stays runtime; a number, a comparison and a counter never name an attribute.
  const clean = [
    "{% for m in messages %}{{ m[m.role + m.content] }}{% endfor %}",
    "{% for m in messages %}{{ messages[loop.index0 + 1] }}{{ messages[loop.index - 1] }}{% endfor %}",
    "{% macro f(p, q) %}{{ messages[p + q] }}{% endmacro %}{{ f(1, 2) }}",
    "{% for m in messages %}{{ messages[(m.role == 'user') + 0] }}{% endfor %}",
    "{% set ns = namespace(i=0) %}{% for m in messages %}{{ messages[ns.i * 2 // 2] }}{% endfor %}",
  ];
  for (const src of clean) expect({ src, highs: highs(src) }).toEqual({ src, highs: [] });
});
