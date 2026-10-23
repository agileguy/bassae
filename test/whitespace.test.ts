import { describe, expect, test } from "bun:test";
import { isTemplateSpace, sameIgnoringWhitespace, whitespaceKey } from "../src/whitespace.ts";

describe("one whitespace definition (ISC-24.2, round-2 review)", () => {
  test("only the six ASCII whitespace code units count", () => {
    const spaces = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20];
    for (let c = 0; c < 0x10000; c++) expect(isTemplateSpace(c)).toBe(spaces.includes(c));
  });

  test("the variant key and the pairwise check always agree", () => {
    const parts = ["do", "not", "a", "", " ", "\t", "\r\n", "\n\n", " ", " ", "　", "﻿", "x y"];
    let seed = 11;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
    const pick = () => Array.from({ length: rnd(6) }, () => parts[rnd(parts.length)]).join("");
    for (let i = 0; i < 2000; i++) {
      const a = pick();
      const b = rnd(2) ? pick() : a.replace(/ /g, "\t").replace(/\n/g, "\r\n");
      expect(whitespaceKey(a) === whitespaceKey(b)).toBe(sameIgnoringWhitespace(a, b));
    }
  });
});
