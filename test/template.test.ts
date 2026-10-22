import { expect, test } from "bun:test";
import { makeTemplate, makeTemplateFromString } from "../src/template.ts";

const source = { kind: "bare" as const, path: "/x", realPath: "/x", name: "default" };

test("makeTemplate keeps exact bytes and flags invalid UTF-8", () => {
  const bytes = new Uint8Array([0x7b, 0x7b, 0xff, 0x7d, 0x7d]);
  const t = makeTemplate(source, bytes);
  expect(t.bytes).toBe(bytes);
  expect(t.validUtf8).toBe(false);
  expect(t.text).toBe("{{�}}");
  expect(t.sha256).toHaveLength(64);
});

test("a JSON string with a lone surrogate is not valid UTF-8", () => {
  const t = makeTemplateFromString(source, "a\uD800b");
  expect(t.validUtf8).toBe(false);
  expect(t.text).toBe("a�b");
  expect(makeTemplateFromString(source, "a\u{1F600}b").validUtf8).toBe(true);
});
