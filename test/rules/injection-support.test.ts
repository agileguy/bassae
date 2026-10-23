import { expect, test } from "bun:test";
import { analyzeCodeExec } from "../../src/rules/index.ts";
import { makeTemplate } from "../../src/template.ts";

// The binding classifier in src/parse/support.ts, as aligned in this phase:
// children() yields a dict literal's keys as well as its values, so the value
// a dict is bound to holds a gadget in either place. Iterating a dict yields
// its keys, so a gadget key is what a loop over the dict binds.

function keyMessages(src: string): string[] {
  const t = makeTemplate({ kind: "bare", path: "/t", realPath: "/t", name: "default" }, new TextEncoder().encode(src));
  return analyzeCodeExec({ template: t, scaffolding: new Set(), knownGood: false }).findings.filter((f) => f.ruleId === "dynamic_attribute").map((f) => f.message);
}

const GADGET_KEY = "subscript key built by a string operation";

test("classifyValue: a gadget in a dict value binds the dict to a gadget", () => {
  expect(keyMessages("{% set k = {'a': joiner} %}{{ messages[k] }}")).toEqual([GADGET_KEY]);
});

test("classifyValue: a gadget in a dict key binds the dict to a gadget, as a value does", () => {
  expect(keyMessages("{% set k = {joiner: 1} %}{{ messages[k] }}")).toEqual([GADGET_KEY]);
  expect(keyMessages("{% set k = {'a': {cycler: 1}} %}{{ messages[k] }}")).toEqual([GADGET_KEY]);
  expect(keyMessages("{% for g in {joiner: 1} %}{{ messages[g] }}{% endfor %}")).toEqual([GADGET_KEY]);
});

test("classifyValue: a dict of plain keys and values is not a gadget", () => {
  expect(keyMessages("{% set k = {'a': 1} %}{{ messages[k] }}")).not.toContain(GADGET_KEY);
});
