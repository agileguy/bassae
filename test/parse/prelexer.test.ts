import { expect, test } from "bun:test";
import { preLex } from "../../src/parse/prelexer.ts";
import { LineMap } from "../../src/parse/support.ts";

test("string literals expose their unescaped value and raw span (Phase 2 seam)", () => {
  const src = "{{ 'a\\nb' }} text {{ x }}";
  const { stringLiterals } = preLex(src);
  expect(stringLiterals).toHaveLength(1);
  expect(stringLiterals[0]!.value).toBe("a\nb");
  // Span covers the quotes and the raw escape, not the unescaped value.
  expect(src.slice(stringLiterals[0]!.start, stringLiterals[0]!.end)).toBe("'a\\nb'");
});

test("text segments are returned verbatim with spans", () => {
  const src = "hello {{ x }}\nworld";
  const { textSegments } = preLex(src);
  expect(textSegments.map((s) => s.value)).toEqual(["hello ", "\nworld"]);
  expect(src.slice(textSegments[1]!.start, textSegments[1]!.end)).toBe("\nworld");
});

test("regions capture tag interiors for the raw-text fallback", () => {
  const src = "{%- if x -%}{{ y }}";
  const { regions } = preLex(src);
  expect(regions.map((r) => r.value.trim())).toEqual(["if x", "y"]);
});

test("object literals do not end the expression early", () => {
  const src = "{{ {'a': 1} }}";
  const { tokens } = preLex(src);
  // Exactly one close token, at the real `}}`.
  expect(tokens.filter((t) => t.type === "close")).toHaveLength(1);
});

test("the pre-lexer never throws on malformed input", () => {
  for (const bad of ["{{ 'unterminated", "{# no close", "{{ x", "{% "]) {
    expect(() => preLex(bad)).not.toThrow();
  }
});

test("LineMap turns offsets into 1-based line and code-point column", () => {
  const src = "ab\ncd€f";
  const lines = new LineMap(src);
  expect(lines.at(0)).toEqual({ line: 1, col: 1 });
  expect(lines.at(3)).toEqual({ line: 2, col: 1 }); // 'c'
  // The € is one code point; the char after it is col 4 on line 2.
  expect(lines.at(src.indexOf("f"))).toEqual({ line: 2, col: 4 });
});
