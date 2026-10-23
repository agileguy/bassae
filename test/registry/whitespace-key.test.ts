import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sameIgnoringWhitespace, whitespaceKey } from "../../src/whitespace.ts";

// The key's definition: SHA-256 over the UTF-16 code units of the text's runs of
// non-whitespace joined by one space, which is what the key string used to be.
function expectedKey(text: string): string {
  const joined = text.split(/[\t\n\v\f\r ]+/).filter(Boolean).join(" ");
  const units = new Uint16Array(joined.length);
  for (let i = 0; i < joined.length; i++) units[i] = joined.charCodeAt(i);
  return createHash("sha256").update(units).digest("hex");
}

describe("whitespaceKey streams a hash instead of building a key string (review round 1, R5)", () => {
  test("the key is the hash of the joined runs, for short texts and across the 64 Ki-unit chunk", () => {
    const parts = ["do", "not", "a", " ", "\t", "\r\n", "\n\n", "　", "﻿", " ", "😀", "{{ x }}"];
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
    for (let i = 0; i < 500; i++) {
      const t = Array.from({ length: rnd(12) }, () => parts[rnd(parts.length)]).join("");
      expect(whitespaceKey(t)).toBe(expectedKey(t));
    }
    // Runs and gaps that straddle the chunk boundary, and a joined text exactly one chunk long.
    for (const t of ["ab ".repeat(30_000), `${"x".repeat(65_535)} y`, `${"x".repeat(65_536)} y`, `${"x".repeat(65_535)}\r\n\t${"y".repeat(70_000)}`, "z".repeat(65_536)]) {
      expect(whitespaceKey(t)).toBe(expectedKey(t));
    }
  });

  test("long texts get equal keys exactly when sameIgnoringWhitespace holds", () => {
    const base = Array.from({ length: 40_000 }, (_, i) => `t${i % 97}`).join(" ");
    const variants = [base.replaceAll(" ", "\r\n"), ` \t${base}\n\n`, base.replaceAll(" ", "  ")];
    const changes = [base.replace("t5 t6", "t5t6"), base.replace(" ", " "), `${base} x`];
    for (const v of variants) {
      expect(sameIgnoringWhitespace(base, v)).toBe(true);
      expect(whitespaceKey(v)).toBe(whitespaceKey(base));
    }
    for (const c of changes) {
      expect(sameIgnoringWhitespace(base, c)).toBe(false);
      expect(whitespaceKey(c)).not.toBe(whitespaceKey(base));
    }
  });

  test("the key is 64 hex digits however long the text", () => {
    for (const t of ["", " \n", "a ".repeat(4 * 1024 * 1024)]) expect(whitespaceKey(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(whitespaceKey("")).toBe(whitespaceKey(" \t\r\n"));
  });
});
