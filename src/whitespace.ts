// The one definition of "differs only in whitespace", shared by the registry's
// variant match (ISC-24.2), divergence from a baseline (ISC-25) and the local
// comparison (ISC-23). Whitespace is ASCII only: tab, line feed, vertical tab,
// form feed, carriage return and space. An inserted U+FEFF, U+00A0, U+2028 or
// U+3000 is a real change, never a variant, so an edit made of them is always
// reported and explained (round-2 review: Gemini 1, Codex R2).

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

/** The text's runs of non-whitespace joined by one space. Two texts get the same key exactly when `sameIgnoringWhitespace` holds for them. */
export function whitespaceKey(text: string): string {
  const s = text.replace(/[\t\n\v\f\r ]+/g, " ");
  return s.slice(s.startsWith(" ") ? 1 : 0, s.endsWith(" ") ? -1 : undefined);
}
