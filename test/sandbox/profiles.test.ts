// The profile globals are plain data handed to @huggingface/jinja, so they are checked here in-process.
// The sandboxed path is covered end to end in renderer.test.ts.

import { Template } from "@huggingface/jinja";
import { expect, test } from "bun:test";
import { profileGlobals } from "../../src/sandbox/profiles.ts";

const render = (src: string, profile: "hf-default" | "jinja2-globals", ctx: Record<string, unknown> = {}) =>
  new Template(src).render({ ...profileGlobals(profile), ...ctx });

test("hf-default adds nothing to the library defaults", () => {
  expect(profileGlobals("hf-default")).toEqual({});
});

test("the dict-defined probe takes a different branch under each profile (ISC-22.2)", () => {
  const src = "{% if dict is defined %}[PAYLOAD]{% else %}clean{% endif %}";
  expect(render(src, "hf-default")).toBe("clean");
  expect(render(src, "jinja2-globals")).toBe("[PAYLOAD]");
});

test("jinja2-globals defines every jinja2 global the library lacks", () => {
  const src = "{{ [dict is defined, cycler is defined, joiner is defined, lipsum is defined, namespace is defined] | join(',') }}";
  expect(render(src, "jinja2-globals")).toBe("true,true,true,true,true");
  // namespace is the library's own, so it is defined under both.
  expect(render(src, "hf-default")).toBe("false,false,false,false,true");
});

test("namespace stays the library's working implementation under jinja2-globals", () => {
  const src = "{% set ns = namespace(n=0) %}{% for i in [1,2,3] %}{% set ns.n = ns.n + i %}{% endfor %}{{ ns.n }}";
  expect(render(src, "jinja2-globals")).toBe("6");
});

test("the stubs behave like their jinja2 counterparts", () => {
  expect(render("{% set d = dict(a=1, b='x') %}{{ d.a }}{{ d['b'] }}", "jinja2-globals")).toBe("1x");
  expect(render("{% set c = cycler('a', 'b') %}{{ c.next() }}{{ c.next() }}{{ c.next() }}", "jinja2-globals")).toBe("aba");
  expect(render("{% set j = joiner('|') %}{% for x in [1,2,3] %}{{ j() }}{{ x }}{% endfor %}", "jinja2-globals")).toBe("1|2|3");
  expect(render("{{ lipsum() }}", "jinja2-globals").length).toBeGreaterThan(0);
});

test("context variables win over profile stubs, as render kwargs do in jinja2", () => {
  expect(render("{{ dict }}", "jinja2-globals", { dict: "mine" })).toBe("mine");
});
