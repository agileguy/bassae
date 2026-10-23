import { describe, expect, test } from "bun:test";
import { escapeJson, escapeText } from "../../src/cli/escape.ts";
import { HOSTILE, RAW } from "./fixtures/hostile.ts";

describe("escapeText, human mode (ISC-44)", () => {
  test("no hostile character survives", () => {
    for (const ch of HOSTILE) {
      const out = escapeText(`a${ch}b`);
      expect(RAW.test(out)).toBe(false);
      expect(out.startsWith("a\\") && out.endsWith("b")).toBe(true);
    }
  });

  test("escapes read the way a programmer expects", () => {
    expect(escapeText("\x1b]52;c;aGk=\x07")).toBe("\\x1B]52;c;aGk=\\x07");
    expect(escapeText("line\nnext\ttab\rcr")).toBe("line\\nnext\\ttab\\rcr");
    expect(escapeText("\u{202e}gnp.exe")).toBe("\\u202Egnp.exe");
    expect(escapeText("\x9b31m")).toBe("\\x9B31m");
    expect(escapeText("tag\u{e0041}")).toBe("tag\\u{E0041}");
  });

  test("a backslash is escaped too, so every escape is unambiguous", () => {
    expect(escapeText("{{ '\\n' }}")).toBe("{{ '\\\\n' }}");
    expect(escapeText("a\\x1Bb")).not.toBe(escapeText("a\x1bb"));
  });

  test("names that differ only in a lone surrogate stay distinguishable (Decisions 18:40)", () => {
    // Invalid UTF-8 bytes 0x80 and 0x81 arrive as U+DC80 and U+DC81; a UTF-8 write would make both U+FFFD.
    const a = escapeText("tool\u{dc80}use");
    const b = escapeText("tool\u{dc81}use");
    const c = escapeText("tool\u{fffd}use");
    expect(a).toBe("tool\\uDC80use");
    expect(new Set([a, b, c]).size).toBe(3);
    // What reaches stdout survives a UTF-8 round trip unchanged.
    expect(new TextDecoder().decode(new TextEncoder().encode(a))).toBe(a);
  });

  test("ordinary text, emoji and non-Latin scripts pass through", () => {
    for (const s of ["<|im_start|>system", "\u{dc}n\u{ef}c\u{f6}d\u{e9}", "\u{65e5}\u{672c}", "\u{1f600}", "\u{645}\u{631}\u{62d}\u{628}\u{627}", "\u{2014} \u{b7} \u{2192} \u{2026}"]) {
      expect(escapeText(s)).toBe(s);
    }
  });
});

describe("escapeJson, JSON mode (ISC-44)", () => {
  test("C1, DEL, bidi and invisible characters become \\uXXXX, and the text still parses to the same value", () => {
    const value = { name: HOSTILE.join("|"), list: [...HOSTILE] };
    const out = escapeJson(JSON.stringify(value));
    expect(RAW.test(out)).toBe(false);
    expect(JSON.parse(out)).toEqual(value);
  });

  test("astral characters are written as an escaped surrogate pair", () => {
    expect(escapeJson(JSON.stringify("\u{e0041}"))).toBe('"\\uDB40\\uDC41"');
    expect(escapeJson(JSON.stringify("\u{1f600}"))).toBe('"\u{1f600}"');
  });

  test("structure and plain text are left alone", () => {
    const text = JSON.stringify({ a: [1, true, null], b: "plain \\ text \u{e9}" }, null, 2);
    expect(escapeJson(text)).toBe(text);
  });
});
