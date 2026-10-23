// The one definition of "differs only in whitespace", shared by the registry's
// variant match (ISC-24.2), divergence from a baseline (ISC-25) and the local
// comparison (ISC-23). Whitespace is ASCII only: tab, line feed, vertical tab,
// form feed, carriage return and space. An inserted U+FEFF, U+00A0, U+2028 or
// U+3000 is a real change, never a variant, so an edit made of them is always
// reported and explained (round-2 review: Gemini 1, Codex R2).

import { createHash } from "node:crypto";

/** True for the six ASCII whitespace code units. */
export function isTemplateSpace(c: number): boolean {
  return c === 0x20 || (c >= 0x09 && c <= 0x0d);
}

/** True when the two texts' sequences of non-whitespace runs are equal (Decisions 23:30, ISC-24.2): CRLF, indentation and trailing newlines differ, `do not` and `donot` do not. Allocates nothing. */
export function sameIgnoringWhitespace(a: string, b: string): boolean {
  let i = 0;
  let j = 0;
  for (;;) {
    while (i < a.length && isTemplateSpace(a.charCodeAt(i))) i++;
    while (j < b.length && isTemplateSpace(b.charCodeAt(j))) j++;
    if (i === a.length || j === b.length) return i === a.length && j === b.length;
    // Compare one run on each side; both must end together.
    while (i < a.length && j < b.length && !isTemplateSpace(a.charCodeAt(i)) && !isTemplateSpace(b.charCodeAt(j))) {
      if (a.charCodeAt(i) !== b.charCodeAt(j)) return false;
      i++;
      j++;
    }
    const aEnd = i === a.length || isTemplateSpace(a.charCodeAt(i));
    const bEnd = j === b.length || isTemplateSpace(b.charCodeAt(j));
    if (!aEnd || !bEnd) return false;
  }
}

// Code units hashed per update. The key never holds a copy of the text, so a 64 Mi-unit
// template costs this buffer, not a second 64 Mi string (review round 1, R5).
const KEY_CHUNK = 64 * 1024;

/** SHA-256 of the text's runs of non-whitespace joined by one space, as UTF-16 code units. Two texts get the same key exactly when `sameIgnoringWhitespace` holds for them. */
export function whitespaceKey(text: string): string {
  const hash = createHash("sha256");
  const buf = new Uint16Array(KEY_CHUNK);
  let n = 0;
  let started = false;
  let gap = false;
  const put = (c: number) => {
    if (n === KEY_CHUNK) {
      hash.update(buf);
      n = 0;
    }
    buf[n++] = c;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (isTemplateSpace(c)) {
      gap = started;
      continue;
    }
    // A whitespace run between two non-whitespace runs becomes one space; at either end, nothing.
    if (gap) put(0x20);
    put(c);
    started = true;
    gap = false;
  }
  hash.update(buf.subarray(0, n));
  return hash.digest("hex");
}
