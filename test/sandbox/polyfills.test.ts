// The jinja2 builtins the render worker adds to @huggingface/jinja (src/sandbox/polyfills.ts).
// Every case renders inside the real sandboxed worker. Expected outputs follow jinja2 3.1:
// filters.py (do_select, do_reject, do_selectattr, do_rejectattr, do_map, do_default, do_count,
// do_first, do_last, do_list, do_min, do_max, make_attrgetter) and tests.py (test_in, test_float,
// the operator aliases), run under the ImmutableSandboxedEnvironment transformers uses.

import { Template } from "@huggingface/jinja";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JINJA2_BUILTIN_FILTERS, JINJA2_BUILTIN_TESTS } from "../../src/parse/support.ts";
import { createRenderer, sandboxAvailable } from "../../src/sandbox/index.ts";
import { JINJA2_FILTERS, JINJA2_TESTS } from "../../src/sandbox/polyfills.ts";

const live = (await sandboxAvailable()).available;
const renderer = createRenderer();

const ERROR = "<render_error>";
type Case = [label: string, body: string, expected: string | RegExp];

/**
 * Renders each case as one branch of a single template, one request per case, so a group costs one worker.
 * A render_error shows as ERROR; any other failure shows its kind and message so a surprise is readable.
 */
async function check(cases: Case[], context: Record<string, unknown> = {}): Promise<void> {
  const template = cases.map(([, body], i) => `{% ${i === 0 ? "if" : "elif"} case == ${i} %}${body}`).join("") + "{% endif %}";
  const requests = cases.map((_, i) => ({ id: String(i), context: { ...context, case: i }, profile: "hf-default" as const }));
  const results = await renderer.renderBatch(template, requests);
  const got = results.map((r, i) => {
    const [label, , want] = cases[i]!;
    if (r.ok) return [label, r.output];
    return [label, want === ERROR && r.failure === "render_error" ? ERROR : `${r.failure}: ${r.message}`];
  });
  expect(got).toEqual(cases.map(([label, , want]) => [label, want instanceof RegExp ? expect.stringMatching(want) : want]));
}

describe.skipIf(!live)("select and reject apply a named test, or truthiness when none is named", () => {
  test("tests, arguments and sources", async () => {
    await check([
      ["odd", "{{ [1,2,3,4,5]|select('odd')|join(',') }}", "1,3,5"],
      ["reject odd", "{{ [1,2,3,4,5]|reject('odd')|join(',') }}", "2,4"],
      ["no test is truthiness", "{{ [0,1,'',none,'a',[],[0]]|select|list|length }}", "3"],
      ["reject truthiness", "{{ [0,1,'']|reject|list|length }}", "2"],
      ["stock reject in", "{{ ['a','b','c']|reject('in', ['b'])|join }}", "ac"],
      ["in a string is a substring test", "{{ ['a','x','bc']|select('in', 'abc')|join(',') }}", "a,bc"],
      ["in a dict is a key test", "{{ ['k','z']|select('in', {'k': 1})|join }}", "k"],
      ["in by keyword", "{{ [1,2]|select('in', seq=[2])|join }}", "2"],
      ["== is Python equality", "{{ [1, 1.0, true, '1']|select('==', 1)|list|length }}", "3"],
      ["eq compares lists by value", "{{ [[1,2],[1,3]]|select('eq', [1,2])|list|length }}", "1"],
      ["equalto compares dicts by value", "{{ [{'a':1},{'a':2}]|select('equalto', {'a':1})|list|length }}", "1"],
      ["a tuple never equals a list", "{{ [(1,2)]|select('==', [1,2])|list|length }}", "0"],
      ["!= and ne", "{{ [1,2,3]|select('!=', 2)|join(',') }}|{{ [1,2,3]|select('ne', 2)|join(',') }}", "1,3|1,3"],
      [">, gt, greaterthan", "{{ [1,2,3,4]|select('>', 2)|join(',') }}|{{ [1,2,3,4]|select('gt', 2)|join(',') }}|{{ [1,2,3,4]|select('greaterthan', 2)|join(',') }}", "3,4|3,4|3,4"],
      [">= and ge", "{{ [1,2,3,4]|select('>=', 3)|join(',') }}|{{ [1,2,3,4]|select('ge', 3)|join(',') }}", "3,4|3,4"],
      ["<, lt, lessthan", "{{ [1,2,3,4]|select('<', 3)|join(',') }}|{{ [1,2,3,4]|select('lt', 3)|join(',') }}|{{ [1,2,3,4]|select('lessthan', 3)|join(',') }}", "1,2|1,2|1,2"],
      ["<= and le", "{{ [1,2,3,4]|select('<=', 2)|join(',') }}|{{ [1,2,3,4]|select('le', 2)|join(',') }}", "1,2|1,2"],
      ["booleans compare as numbers", "{{ [true, false, 0.5]|select('>', 0)|list|length }}", "2"],
      ["strings compare by code point", "{{ ['b','a','B']|select('>', 'a')|join }}", "b"],
      ["code points past the BMP compare by code point, not UTF-16 unit", "{{ ['～','😀']|select('>', '～')|join }}", "😀"],
      ["lists compare item by item, then by length", "{{ [[1,2],[1,3],[2],[1]]|select('>', [1,2])|list|length }}", "2"],
      ["mixed types do not compare", "{{ [1,'a']|select('>', 0)|list }}", ERROR],
      ["undefined does not compare", "{{ [nope]|select('<', 0)|list }}", ERROR],
      ["none does not compare", "{{ [none]|select('<', 0)|list }}", ERROR],
      ["an unknown test", "{{ [1]|select('banana')|list }}", ERROR],
      ["a jinja2 test the engine lacks", "{{ [4]|select('divisibleby', 2)|list }}", ERROR],
      ["too many arguments", "{{ [1]|select('odd', 1)|list }}", ERROR],
      ["a missing argument", "{{ [1]|select('in')|list }}", ERROR],
      ["operator tests take no keywords", "{{ [1]|select('==', b=1)|list }}", ERROR],
      ["value is already bound", "{{ [1]|select('in', value=[1])|list }}", ERROR],
      ["an unknown keyword", "{{ [1]|select('in', [1], other=1)|list }}", ERROR],
      ["an unconsumed result never runs its test", "{% set g = [1]|select('banana') %}ok", "ok"],
      ["an empty or false source skips the test", "{{ []|select('banana')|list|length }}{{ nope|select('banana')|list|length }}{{ none|select|list|length }}{{ 0|select|list|length }}{{ ''|select|list|length }}", "00000"],
      ["a string source yields characters", "{{ 'abc'|select('in', 'ac')|join }}", "ac"],
      ["a dict source yields keys", "{{ {'a':1,'b':2}|select('==','b')|join }}", "b"],
      ["a number is not iterable", "{{ 5|select|list }}", ERROR],
      ["true is not iterable", "{{ true|select|list }}", ERROR],
    ]);
  });
});

describe.skipIf(!live)("selectattr and rejectattr look items up the way jinja2's make_attrgetter does", () => {
  test("paths, items and test names", async () => {
    const msgs = [{ role: "system", content: "s" }, { role: "user", content: "u" }, { role: "assistant", content: "a" }];
    await check(
      [
        ["by test", "{{ [{'r':'a'},{'r':'b'},{}]|selectattr('r','==','a')|list|length }}", "1"],
        ["truthiness", "{{ [{'x':0},{'x':1},{}]|selectattr('x')|list|length }}|{{ [{'x':0},{'x':1},{}]|rejectattr('x')|list|length }}", "1|2"],
        ["stock role filter", "{{ msgs|selectattr('role','in',['user','assistant'])|map(attribute='content')|join(',') }}", "u,a"],
        ["dotted path", "{{ [{'a':{'b':1}},{'a':{'b':2}}]|selectattr('a.b','==',2)|list|length }}", "1"],
        ["digit parts are indexes", "{{ [[1,2],[3,4]]|selectattr('0','==',3)|list|length }}", "1"],
        ["a digit part never matches a string key", "{{ [{'0':1}]|selectattr('0')|list|length }}", "0"],
        ["string items index by code point", "{{ ['ab','cd']|selectattr('0','==','c')|join }}", "cd"],
        ["items that are not dicts give undefined", "{{ [1,'ab',none]|selectattr('x')|list|length }}", "0"],
        ["a missing link in the path fails", "{{ [{'a':1},{}]|selectattr('a.b')|list }}", ERROR],
        ["names chosen at render time", "{% set t = 'eq' %}{{ [{'a':1},{'a':2}]|selectattr('a', t, 1)|list|length }}", "1"],
        ["no attribute name", "{{ [1]|selectattr|list }}", ERROR],
        ["no attribute name, empty source", "{{ []|selectattr|list|length }}", "0"],
      ],
      { msgs },
    );
  });
});

describe.skipIf(!live)("map applies a named filter to each item, or looks up attribute=", () => {
  test("filters, arguments and attributes", async () => {
    await check([
      ["stock positional filter", "{{ ['a','b']|map('upper')|join(',') }}", "A,B"],
      ["positional arguments", "{{ ['a b','c d']|map('replace', ' ', '-')|join(',') }}", "a-b,c-d"],
      ["keyword arguments", "{{ ['a\\nb']|map('indent', width=2, first=true)|join }}", "  a\n  b"],
      ["default", "{{ [nope, 1]|map('default', 'z')|join(',') }}|{{ [nope, 1]|map('d')|join(',') }}", "z,1|,1"],
      ["length", "{{ ['ab', [1,2,3], {'a':1}]|map('length')|join(',') }}", "2,3,1"],
      ["nested select", "{{ [[1,2,3],[4,5]]|map('select','odd')|map('list')|map('length')|join(',') }}", "2,1"],
      ["tojson", "{{ [{'a':1}]|map('tojson')|join }}", '{"a": 1}'],
      ["list splits strings", "{{ ['ab','cd']|map('list')|map('join','-')|join(',') }}", "a-b,c-d"],
      ["attribute", "{{ [{'n':'a'},{'n':'b'},{}]|map(attribute='n')|map('d','?')|join(',') }}", "a,b,?"],
      ["attribute with default", "{{ [{'n':'a'},{}]|map(attribute='n', default='?')|join(',') }}", "a,?"],
      ["default replaces each missing part", "{{ [{}]|map(attribute='a.b', default={'b': 'x'})|join }}", "x"],
      ["dotted attribute", "{{ [{'a':{'b':1}}]|map(attribute='a.b')|join }}", "1"],
      ["a minus sign is not a digit", "{{ [[1,2]]|map(attribute='-1')|map('d','u')|join }}", "u"],
      ["an attribute of a number is undefined", "{{ [1]|map(attribute='x')|map('d','u')|join }}", "u"],
      ["no filter named", "{{ [1]|map|list }}", ERROR],
      ["no filter named, called", "{{ [1]|map()|list }}", ERROR],
      ["no filter named, empty source", "{{ []|map|list|length }}", "0"],
      ["an unknown filter", "{{ [1]|map('shout')|list }}", ERROR],
      ["an engine-only filter is not a jinja2 filter", "{{ [{'a':1}]|map('keys')|list }}", ERROR],
      ["a jinja2 filter the engine lacks", "{{ [1.5]|map('round')|list }}", ERROR],
      ["an unconsumed result never looks its filter up", "{% set g = [1]|map('shout') %}ok", "ok"],
      ["attribute= takes no other keyword", "{{ [{'a':1}]|map(attribute='a', foo=1)|list }}", ERROR],
    ]);
  });
});

describe.skipIf(!live)("select, reject, selectattr, rejectattr and map return single-use generators", () => {
  test("truthiness, consumption and use as a value", async () => {
    await check([
      ["always truthy", "{% if []|select %}T{% endif %}{% if []|reject %}T{% endif %}{% if []|selectattr('a') %}T{% endif %}{% if []|map('upper') %}T{% endif %}{% if []|map(attribute='a') %}T{% endif %}", "TTTTT"],
      ["list makes an ordinary list", "{% if []|select|list %}T{% else %}F{% endif %}", "F"],
      ["not a sequence", "{% if [1]|select is sequence %}S{% else %}N{% endif %}{% if [1]|select|list is sequence %}S{% endif %}", "NS"],
      ["a loop consumes it", "{% set g = [1,2]|select %}{% for x in g %}{{ x }}{% endfor %}|{% for x in g %}{{ x }}{% else %}empty{% endfor %}", "12|empty"],
      ["list consumes it", "{% set g = [1,2]|select %}{{ g|list|length }}{{ g|list|length }}", "20"],
      ["a library filter consumes it", "{% set g = [2,1]|select %}{{ g|sort|join }}|{{ g|join }}", "12|"],
      ["first takes one item", "{% set g = [1,2,3]|select %}{{ g|first }}|{{ g|join(',') }}", "1|2,3"],
      ["chains pull lazily", "{% set g = [1,2,3]|select %}{% set h = g|map('string') %}{{ g|first }}|{{ h|join(',') }}", "1|2,3"],
      ["a subscript is undefined and consumes nothing", "{% set g = [1]|select %}{% if g[0] is undefined %}U{% endif %}{% if g.length is undefined %}U{% endif %}{% if g[0:1] is undefined %}U{% endif %}{{ g|join }}", "UUU1"],
      ["unpacking items", "{% for a, b in [[1,2]]|select %}{{ a }}{{ b }}{% endfor %}", "12"],
      ["no length", "{{ [1]|select|length }}", ERROR],
      ["no count", "{{ [1]|select|count }}", ERROR],
      ["no last", "{{ [1]|select|last }}", ERROR],
      ["not JSON", "{{ [1]|select|tojson }}", ERROR],
      ["not JSON, with arguments", "{{ [1]|select|tojson(indent=2) }}", ERROR],
      ["prints as a generator", "{{ [1]|select }}", /^<generator object select_or_reject at 0x[0-9a-f]+>$/],
      ["map prints as its own generator", "{{ [1]|map('upper') }}", /^<generator object sync_do_map at 0x[0-9a-f]+>$/],
      ["string", "{{ [1]|select|string }}", /^<generator object select_or_reject at 0x[0-9a-f]+>$/],
      ["concatenation", "{{ 'x' ~ ([1]|select) }}", /^x<generator object select_or_reject at 0x[0-9a-f]+>$/],
      ["equality is identity and consumes nothing", "{% set g = [1]|select %}{% if g == g %}same{% endif %}{% if g != ([1]|select) %}|diff{% endif %}|{{ g|join }}", "same|diff|1"],
      ["in consumes up to the match", "{% set g = [1,2,3]|select %}{% if 2 in g %}y{% endif %}|{{ g|join(',') }}", "y|3"],
      ["not in consumes it all", "{% set g = [1,2]|select %}{% if 5 not in g %}n{% endif %}|{{ g|join }}", "n|"],
      ["adding fails", "{{ ([1]|select) + [2] }}", ERROR],
    ]);
  });
});

describe.skipIf(!live)("count, length, first, last and list take any iterable, as in jinja2", () => {
  test("strings, dicts and undefined", async () => {
    await check([
      ["len", "{{ 'a😀b'|count }}|{{ 'a😀b'|length }}|{{ nope|count }}|{{ nope|length }}|{{ {'a':1}|count }}|{{ [1,2]|count }}", "3|3|0|0|1|2"],
      ["a number has no len", "{{ 5|count }}", ERROR],
      ["none has no len", "{{ none|length }}", ERROR],
      ["first", "{{ 'ab'|first }}|{{ '😀b'|first }}|{{ {'k':1}|first }}|{% if []|first is undefined %}U{% endif %}|{% if nope|first is undefined %}U{% endif %}", "a|😀|k|U|U"],
      ["last", "{{ [1,2]|last }}|{{ 'ab😀'|last }}|{{ {'a':1,'b':2}|last }}|{% if []|last is undefined %}U{% endif %}|{% if nope|last is undefined %}U{% endif %}", "2|😀|b|U|U"],
      ["first of a number", "{{ 5|first }}", ERROR],
      ["last of none", "{{ none|last }}", ERROR],
      ["list", "{{ 'ab'|list|join(',') }}|{{ {'a':1,'b':2}|list|join(',') }}|{{ nope|list|length }}|{{ (1,2)|list|join }}", "a,b|a,b|0|12"],
      ["list of none", "{{ none|list }}", ERROR],
    ]);
  });
});

describe.skipIf(!live)("default and d bind (default_value='', boolean=False) as jinja2 does", () => {
  test("bare, positional and keyword forms", async () => {
    await check([
      ["bare", "[{{ nope|default }}][{{ nope|d }}]", "[][]"],
      ["a value", "{{ nope|d('y') }}|{{ 'v'|d('y') }}", "y|v"],
      ["falsy values stay unless boolean", "[{{ ''|d('y') }}]|{{ ''|d('y', true) }}|{{ ''|default('y', boolean=true) }}|{{ 0|d('y', 1) }}", "[]|y|y|y"],
      ["default_value by keyword", "{{ nope|default(default_value='z') }}", "z"],
      ["none is not undefined", "{% if none|d('y') is none %}N{% endif %}", "N"],
      ["a generator is truthy", "{{ []|select|d('y', true)|list|length }}", "0"],
      ["too many arguments", "{{ nope|d(1, 2, 3) }}", ERROR],
      ["an argument given twice", "{{ nope|d('a', default_value='b') }}", ERROR],
      ["an unknown keyword", "{{ nope|d(other=1) }}", ERROR],
    ]);
  });
});

describe.skipIf(!live)("min and max ignore case by default, take attribute=, and are undefined when empty", () => {
  test("ordering, attributes and ties", async () => {
    await check([
      ["numbers", "{{ [3,1,2]|min }}|{{ [3,1,2]|max }}", "1|3"],
      ["case", "{{ ['a','B']|max }}|{{ ['a','B']|max(true) }}|{{ ['a','B']|max(case_sensitive=true) }}|{{ ['b','A']|min }}", "B|a|a|A"],
      ["attribute", "{{ ([{'n':2},{'n':1}]|min(attribute='n')).n }}|{{ ([{'n':2},{'n':1}]|max(false, 'n')).n }}", "1|2"],
      ["the first of equals wins", "{{ ([{'n':1,'i':'a'},{'n':1,'i':'b'}]|max(attribute='n')).i }}|{{ ([{'n':1,'i':'a'},{'n':1,'i':'b'}]|min(attribute='n')).i }}", "a|a"],
      ["empty", "{% if []|max is undefined %}U{% endif %}{% if nope|min is undefined %}U{% endif %}", "UU"],
      ["strings and dict keys", "{{ 'bca'|min }}|{{ {'b':1,'a':2}|max }}", "a|b"],
      ["a generator", "{{ [3,1]|select|min }}", "1"],
      ["mixed types", "{{ [1,'a']|max }}", ERROR],
    ]);
  });
});

describe.skipIf(!live)("tests used directly", () => {
  test("float", async () => {
    await check([["float", "{% if 1.5 is float %}F{% endif %}{% if 1 is float %}I{% endif %}", "F"]]);
  });
});

describe.skipIf(!live)("stock templates the polyfills unblock (ISC-12.1)", () => {
  const registry = join(import.meta.dir, "../../registry/templates");
  const stock = (sha: string) => readFileSync(join(registry, `${sha}.jinja`), "utf8");

  test("Gemma 4 upper-cases a list of item types with map('upper')", async () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "tag",
          description: "Tags things.",
          parameters: { type: "object", properties: { tags: { type: "array", description: "Tags.", items: { type: ["string", "null"] } } }, required: ["tags"] },
        },
      },
    ];
    const [r] = await renderer.renderBatch(stock("0a2c8073c878ab1da004bee933a998606537bbb62016310352c7285c3f01c5b5"), [
      { id: "g", context: { messages: [{ role: "user", content: "hi" }], tools, add_generation_prompt: true }, profile: "hf-default" },
    ]);
    expect(r?.ok).toBe(true);
    if (r?.ok) expect(r.output).toContain('items:{type:[<|"|>STRING<|"|>,<|"|>NULL<|"|>]}');
  });

  test("Qwen3-Coder lists a parameter's extra keys with reject('in', handled_keys)", async () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "f",
          description: "Does f.",
          parameters: { type: "object", properties: { p: { type: "integer", description: "A p.", minimum: 1, "x-unit": "s" } }, required: ["p"] },
        },
      },
    ];
    const [r] = await renderer.renderBatch(stock("672e747c77e990320152343b0a4951222e40de5645297905d89afba05586d827"), [
      { id: "q", context: { messages: [{ role: "user", content: "hi" }], tools, add_generation_prompt: true }, profile: "hf-default" },
    ]);
    expect(r?.ok).toBe(true);
    if (r?.ok) expect(r.output).toContain("\n<minimum>1</minimum>\n<x_unit>s</x_unit>\n</parameter>");
  });
});

describe("the polyfills stay inside the worker", () => {
  test("the library in this process is untouched", () => {
    expect(() => new Template("{{ [1, 2] | select('odd') | list }}").render({})).toThrow();
    expect(() => new Template("{{ x | default }}").render({})).toThrow();
  });

  test("map's filter names and select's test names are exactly jinja2's", () => {
    expect([...JINJA2_FILTERS].sort()).toEqual([...JINJA2_BUILTIN_FILTERS].sort());
    expect([...JINJA2_TESTS.keys()].sort()).toEqual([...JINJA2_BUILTIN_TESTS].sort());
  });
});
