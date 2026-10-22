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
