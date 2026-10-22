// ISC-3.1: a template holding invalid UTF-8 comes out as exactly the planted bytes.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGgufModel, readGgufSource } from "../../src/gguf/index.ts";
import { bytesSource } from "../../src/gguf/reader.ts";
import { buildGguf, str } from "./builder.ts";

// A lone continuation byte, 0xFF/0xFE, an encoded surrogate, an overlong '/', and a truncated sequence at the end.
const planted = new Uint8Array([
  0x7b, 0x7b, 0x20, 0x78, 0x20, 0x7d, 0x7d, 0x80, 0xff, 0xfe, 0xed, 0xa0, 0x80, 0xc0, 0xaf, 0x41, 0xe2, 0x82,
]);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function check(t: { bytes: Uint8Array; sha256: string; validUtf8: boolean }) {
  expect(t.bytes.length).toBe(planted.length);
  expect(sha(t.bytes)).toBe(sha(planted));
  expect(t.sha256).toBe(sha(planted));
  expect(t.validUtf8).toBe(false);
  // Never repaired: no EF BF BD (U+FFFD) in the stored bytes.
  expect(Buffer.from(t.bytes).includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
}

test("ISC-3.1: invalid UTF-8 is extracted byte for byte from memory", () => {
  const r = readGgufSource(bytesSource(buildGguf([["tokenizer.chat_template", str(planted)]]).bytes), "/m.gguf");
  expect(r.findings).toEqual([]);
  check(r.templates[0]!);
});

test("ISC-3.1: invalid UTF-8 is extracted byte for byte from disk, named templates too", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "bassae-gguf-raw-")), "raw.gguf");
  writeFileSync(path, buildGguf([
    ["tokenizer.chat_template", str(planted)],
    ["tokenizer.chat_template.x", str(planted)],
  ]).bytes);
  const r = await readGgufModel(path);
  expect(r.templates).toHaveLength(2);
  for (const t of r.templates) check(t);
});
