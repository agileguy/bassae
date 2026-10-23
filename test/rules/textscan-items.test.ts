import { expect, test } from "bun:test";
import { findEncodedBlobsIn } from "../../src/rules/textscan.ts";
import type { FindingBase, InjectedText } from "../../src/types.ts";

const base: FindingBase = { file: "/m/chat_template.jinja", templateName: "default", templateSha256: "0".repeat(64) };
const span = { start: 10, end: 60, line: 2, col: 4 };
const item = (text: string): InjectedText => ({ text, span, afterGenerationPrompt: false });

test("findEncodedBlobsIn: a blob in a folded value is MEDIUM at the injected text's span (ISC-20)", () => {
  // base64 of "hello world this is a test of base64", as if assembled with `~`.
  const out = findEncodedBlobsIn([item("aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRlc3Qgb2YgYmFzZTY0")], base);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ ruleId: "encoded_blob", severity: "MEDIUM", span, detail: { encoding: "base64" } });
});

test("findEncodedBlobsIn: ordinary prose gives nothing", () => {
  expect(findEncodedBlobsIn([item("You are a helpful assistant. Answer briefly.")], base)).toEqual([]);
});
