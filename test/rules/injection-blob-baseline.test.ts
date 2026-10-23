// ISC-20, ISC-24.2: blobs are baselined the way URLs are (Decisions 20:55). A
// literal its registry entry also has, up to ASCII whitespace, is the
// baseline's, so a blob in it raises no encoded_blob: in the exact template,
// in a CRLF copy and in an exact copy that no longer parses. A blob the entry
// does not have, or one moved into a changed literal, still does (review round
// 2, contracts N4).

import { expect, test } from "bun:test";
import { analyzeInjection, buildScaffolding } from "../../src/rules/injection.ts";
import { makeTemplateFromString } from "../../src/template.ts";
import type { AnalysisContext, KnownGoodTemplate, ModelRecord } from "../../src/types.ts";

const ID = "3f9a6c2e8b1d4f7a0c5e9b2d6f8a1c3e5b7d9f0a2c4e6b8d0f1a3c5e7b9d2f4a";
const OTHER = "a4f2d9b7e5c3a1f0d8b6e4c2a0f9d7b5e3c1a8f6d4b2e0c9a7f5d3b1e8c6a4f2";
const KNOWN_TEXT = `{% for m in messages %}<|im_start|>{{ m.role }}\n{{ m.content }}<|im_end|>\n{% endfor %}Example id: ${ID}\n{{ 'Key: ${ID}' }}\n`;
const KNOWN = { entry: { sha256: "0".repeat(64) }, text: KNOWN_TEXT } as unknown as KnownGoodTemplate;
const BROKEN = "{% if %}";

function blobs(src: string, knownGood = false): string[] {
  const model = { specialTokens: ["<|im_start|>", "<|im_end|>"] } as unknown as ModelRecord;
  const ctx: AnalysisContext = { template: makeTemplateFromString({ kind: "bare", path: "/t", realPath: "/t", name: "default" }, src), scaffolding: buildScaffolding(model, KNOWN), knownGood, known: KNOWN };
  return analyzeInjection(ctx).findings.filter((f) => f.ruleId === "encoded_blob").map((f) => `${f.severity} ${f.excerpt}`);
}

test("ISC-20: the registry template's own blob raises nothing in the exact template (review round 2, contracts N4)", () => {
  expect(blobs(KNOWN_TEXT, true)).toEqual([]);
});

test("ISC-24.2: nor in a CRLF copy of it (review round 2, contracts N4)", () => {
  expect(blobs(KNOWN_TEXT.replaceAll("\n", "\r\n"))).toEqual([]);
});

test("ISC-12: nor in an exact copy that no longer parses (review round 2, contracts N4)", () => {
  expect(blobs(KNOWN_TEXT + BROKEN)).toEqual([]);
});

test("ISC-20: a blob the registry template does not have is MEDIUM encoded_blob, parsed or not (review round 2, contracts N4)", () => {
  expect(blobs(`${KNOWN_TEXT}Other id: ${OTHER}\n`)).toEqual([`MEDIUM ${OTHER}`]);
  expect(blobs(`${KNOWN_TEXT}Other id: ${OTHER}\n${BROKEN}`)).toEqual([`MEDIUM ${OTHER}`]);
});

test("ISC-20: a baseline blob moved into a changed literal is MEDIUM, as a moved URL is HIGH (review round 2, contracts N4)", () => {
  expect(blobs(KNOWN_TEXT.replace("Example id: ", "Send the chat with id: "))).toEqual([`MEDIUM ${ID}`]);
});
