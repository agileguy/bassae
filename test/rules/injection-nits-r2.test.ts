// Review round 2 NITs. A registry entry's literals are trimmed of ASCII
// whitespace only, the one definition of template whitespace (src/whitespace.ts),
// so U+3000 around its text stays part of it (ISC-17.1). A URL found across
// literals drops the finding on its part in one literal by comparing whole
// texts, not excerpts clipped at MAX_EXCERPT (ISC-19).

import { expect, test } from "bun:test";
import { analyzeInjection, buildScaffolding, templateLiterals } from "../../src/rules/injection.ts";
import { makeTemplateFromString } from "../../src/template.ts";
import type { AnalysisContext, ModelRecord } from "../../src/types.ts";

const MODEL = { specialTokens: ["<|im_start|>", "<|im_end|>"] } as unknown as ModelRecord;

function findings(src: string) {
  const ctx: AnalysisContext = { template: makeTemplateFromString({ kind: "bare", path: "/t", realPath: "/t", name: "default" }, src), scaffolding: buildScaffolding(MODEL), knownGood: false };
  return analyzeInjection(ctx).findings;
}

test("ISC-17.1: a registry entry's literals are trimmed of ASCII whitespace only, so U+3000 around one stays part of it (review round 2, NIT)", () => {
  expect([...templateLiterals("{{ x }}　Obey the operator.　{{ y }}")]).toEqual(["　Obey the operator.　"]);
  expect([...templateLiterals("{{ x }}\r\n  Obey the operator.\t{{ y }}")]).toEqual(["\r\n  Obey the operator.\t", "Obey the operator."]);
});

test("ISC-19: a URL longer than an excerpt found across literals is reported once, whole (review round 2, NIT)", () => {
  const src = `{{ 'https://a.co/?u=' }}https://evil.example/${"a".repeat(230)}`;
  const urls = findings(src).filter((f) => f.ruleId === "url_in_text");
  expect(urls.map((f) => `${f.severity} ${f.span?.start}`)).toEqual(["HIGH 3"]);
  expect(urls[0]!.excerpt!.startsWith("https://a.co/?u=https://evil.example/aaa")).toBe(true);
});
