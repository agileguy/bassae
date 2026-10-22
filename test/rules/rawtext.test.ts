// The raw-text fallback (ISC-12): the region scan used under the size cap, and
// the streaming scan used over it. Both must find tag interiors where the
// pre-lexer does, so a quoted `}}` or a nested object literal cannot end a tag
// early and hide what follows it (round 3).

import { expect, test } from "bun:test";
import { preLex } from "../../src/parse/prelexer.ts";
import { LineMap } from "../../src/parse/support.ts";
import { analyzeCodeExec } from "../../src/rules/index.ts";
import { runRawText, runRawTextStreaming } from "../../src/rules/rawtext.ts";
import { makeTemplateFromString } from "../../src/template.ts";
import type { Finding } from "../../src/types.ts";

const base = { file: "/t", templateName: "default", templateSha256: "x" };
const key = (f: Finding) => `${f.ruleId}@${f.span!.start}-${f.span!.end} ${f.span!.line}:${f.span!.col}`;

function streamed(src: string): string[] {
  return runRawTextStreaming(src, base).map(key).sort();
}
function regioned(src: string): string[] {
  return runRawText(preLex(src).regions, new LineMap(src), src, base).map(key).sort();
}

// jinja2 matches `\s*raw\s*` and `\s*endraw\s*` with Python's `\s`, which also
// covers U+001C to U+001F and U+0085 (Codex, round 4).
const PY_SPACE_RAW = [
  "{%\x1craw\x1c%}{#{% endraw %}{{ x.__class__ }}{# #}",
  "{%\x85raw%}{#{% endraw %}{{ x.__class__ }}{# #}",
  "{% raw %}{#{%\x1fendraw%}{{ x.__class__ }}{# #}",
];

const TRICKY = [
  // Codex's round-3 reproductions.
  "{{ {'a': {'b': 1}}['a'].__class__ }}",
  '{{ "}}" ~ x.__class__ }}',
  '{% set z = "%}" ~ x.__globals__ %}',
  "{{ {'k': {}}['k']['__init__'] }}",
  // Escapes inside strings, both quote kinds.
  '{{ "\\"}}" ~ x.__class__ }}',
  "{{ '\\'}}' ~ x.__class__ }}",
  "{{ '\\\\' }}{{ y.__init__ }}",
  // Close modifiers, and a close that only counts at object-literal depth 0.
  "{{- x.__class__ -}}{%+ set q = y.__dict__ +%}",
  "{{ {'a': '}}'}.__class__ }}",
  "{{{ x.__class__ }}}",
  "{{ {{ x.__class__ }} }}tail.__mro__",
  // `}}` does not close a statement, and `%}` does not close an expression.
  "{% if a }} b.__class__ %}{{ c.__init__ }}",
  "{{ x %} y.__class__ }}",
  // Comments are not scanned; a comment opener inside a string is not a comment.
  "{# {{ x.__class__ }} #}{{ y.__init__ }}",
  '{{ "{#" }}{{ x.__class__ }}{{ "#}" }}',
  "{# unclosed {{ x.__class__ }}",
  // Unclosed tags and strings run to the end of the text.
  "{{ x.__class__",
  '{{ "unclosed }} x.__class__',
  // Text outside every tag is not scanned.
  "text.__class__ {{ y }} more.__init__",
  // A raw block's body is text: what it holds opens nothing, and what follows endraw is live (round 4).
  "{% raw %}{#{% endraw %}{{ x.__class__ }}{# #}",
  ...PY_SPACE_RAW,
  "{% raw %}hi{% endraw %}{{ x.__class__ }}",
  "{% raw %}{{ x.__class__ }}{% endraw %}",
  "{%- raw -%}{{ x.__class__ }}{%+ endraw +%}{{ y.__init__ }}{%raw%}{{ z.__mro__ }}{%endraw%}",
  "{% raw %}{{ x.__class__ }}",
  "{% rawx %}{{ x.__class__ }}{% endraw %}{{ y.__init__ }}",
  "{# {% raw %} #}{{ x.__class__ }}",
  '{{ "{% raw %}" }}{{ x.__class__ }}',
  // The other raw patterns.
  "{{ x|attr('a') }}{{ y.format(1) }}{{ cycler.__init__ }}{{ os.popen('id') }}",
  "{% if self is defined %}{% endif %}{{ x is callable }}{{ xs|select('callable') }}",
];

test("the streaming scan finds exactly the findings the region scan does", () => {
  for (const src of TRICKY) expect(streamed(src), src).toEqual(regioned(src));
});

// Over the size cap the library never runs, so these are found by the streaming
// scan alone. Round 2 placed each at this line:col; the round-3 tag cursor ended
// the tag at the quoted or nested close and missed all four.
const PAD = "a".repeat(600_000) + "\n";

function overCap(src: string): Finding[] {
  const t = makeTemplateFromString({ kind: "bare", path: "/t", realPath: "/t", name: "default" }, PAD + src);
  return analyzeCodeExec({ template: t, scaffolding: new Set(), knownGood: false }).findings;
}
const dunderAt = (fs: Finding[]) => fs.filter((f) => f.ruleId === "dunder_access").map((f) => `${f.span!.line}:${f.span!.col}`);

test("over the size cap, a quoted close or a nested brace does not end a tag", () => {
  expect(dunderAt(overCap("{{ {'a': {'b': 1}}['a'].__class__ }}"))).toEqual(["2:25"]);
  expect(dunderAt(overCap('{{ "}}" ~ x.__class__ }}'))).toEqual(["2:13"]);
  expect(dunderAt(overCap('{% set z = "%}" ~ x.__globals__ %}'))).toEqual(["2:21"]);
  expect(dunderAt(overCap("{{ {'k': {}}['k']['__init__'] }}"))).toEqual(["2:20"]);
  // Control: the plain form was caught before and still is.
  expect(dunderAt(overCap("{{ x.__class__ }}"))).toEqual(["2:6"]);
  // Each is still HIGH unanalyzable for its size.
  expect(overCap("{{ x.__class__ }}").some((f) => f.ruleId === "unanalyzable" && f.severity === "HIGH")).toBe(true);
});

test("over the size cap, a comment is not scanned but what follows it is", () => {
  expect(dunderAt(overCap("{# {{ x.__class__ }} #}{{ y.__init__ }}"))).toEqual(["2:29"]);
});

// Round 4 — a raw block's body is literal text in jinja2. A `{#` inside one must
// not read as a comment that swallows the live code after `endraw`, and code
// inside one is output, not run, so it gives no raw-text finding.
function underCap(src: string): Finding[] {
  const t = makeTemplateFromString({ kind: "bare", path: "/t", realPath: "/t", name: "default" }, src);
  return analyzeCodeExec({ template: t, scaffolding: new Set(), knownGood: false }).findings;
}
const at = (fs: Finding[]) => fs.map((f) => `${f.ruleId}@${f.span!.line}:${f.span!.col}`);

test("a raw block is literal text, under and over the size cap", () => {
  for (const src of ["{% raw %}{#{% endraw %}{{ x.__class__ }}{# #}", "{% raw %}hi{% endraw %}{{ x.__class__ }}"]) {
    expect(at(underCap(src)), src).toEqual(["unanalyzable@1:4", "dunder_access@1:29"]);
    expect(at(overCap(src)), src).toEqual(["unanalyzable@1:1", "dunder_access@2:29"]);
  }
  // Python whitespace around raw and endraw. Under the cap, the library rejects a
  // control character in the opener with no locatable construct (the whole
  // template, 1:1), and names `raw` (1:4) when only the endraw has one.
  for (const [src, parseErrorAt] of PY_SPACE_RAW.map((s, k) => [s, k < 2 ? "1:1" : "1:4"] as const)) {
    const col = src.indexOf("__class__") + 1;
    expect(at(underCap(src)), src).toEqual([`unanalyzable@${parseErrorAt}`, `dunder_access@1:${col}`]);
    expect(at(overCap(src)), src).toEqual(["unanalyzable@1:1", `dunder_access@2:${col}`]);
  }
  const inside = "{% raw %}{{ x.__class__ }}{% endraw %}";
  expect(at(underCap(inside))).toEqual(["unanalyzable@1:4"]);
  expect(at(overCap(inside))).toEqual(["unanalyzable@1:1"]);
});
