import { expect, test } from "bun:test";
import { makeTemplate } from "../src/template.ts";

const source = { kind: "bare" as const, path: "/x", realPath: "/x", name: "default" };

test("makeTemplate keeps exact bytes and flags invalid UTF-8", () => {
  const bytes = new Uint8Array([0x7b, 0x7b, 0xff, 0x7d, 0x7d]);
  const t = makeTemplate(source, bytes);
  expect(t.bytes).toBe(bytes);
  expect(t.validUtf8).toBe(false);
  expect(t.text).toBe("{{�}}");
  expect(t.sha256).toHaveLength(64);
});
