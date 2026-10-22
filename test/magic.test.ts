import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGguf } from "../src/gguf/magic.ts";

test("isGguf reads the magic, not the extension", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bassae-magic-"));
  writeFileSync(join(dir, "sha256-abc"), Buffer.from("GGUF\x03\x00\x00\x00"));
  writeFileSync(join(dir, "fake.gguf"), Buffer.from("GGML...."));
  writeFileSync(join(dir, "short"), Buffer.from("GG"));
  expect(await isGguf(join(dir, "sha256-abc"))).toBe(true);
  expect(await isGguf(join(dir, "fake.gguf"))).toBe(false);
  expect(await isGguf(join(dir, "short"))).toBe(false);
  expect(await isGguf(join(dir, "missing"))).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});
