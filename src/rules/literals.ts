// The literal ranges of a template, for the text rules (ISC-19 to ISC-21): every
// run of text between tags and the interior of every string literal inside a
// tag, in source order. Under the parse cap these come from the pre-lexer; over
// it there is no pre-lexer result (round-2 memory review), so forEachLiteral
// streams the same segmentation in one forward pass with no per-tag allocation.
//
// The bounds are preLex's exactly: a {# #} comment is skipped whole, a raw
// block's body is text, a quoted string (with backslash escapes) never closes a
// tag, and `}}` closes an expression only at object-literal depth 0. A
// differential test holds the two to the same ranges.

import { keywordTagEnd, rawBodyEnd } from "../parse/prelexer.ts";
import type { ParseOutcome } from "../parse/parse.ts";

export type LiteralKind = "text" | "string";

/** Receives one literal range [start, end): a text run, or a string literal's interior without its quotes. */
export type LiteralVisitor = (kind: LiteralKind, start: number, end: number) => void;

/** Every literal range of `src` in source order, streamed with no token array. Matches the pre-lexer's textSegments and stringLiterals. */
export function forEachLiteral(src: string, visit: LiteralVisitor): void {
  const n = src.length;
  let i = 0;
  while (i < n) {
    if (opensTag(src, i)) {
      if (src.charCodeAt(i + 1) === 0x23) {
        // '{#': a comment runs to '#}', or to the end when unclosed.
        i += 2;
        while (i < n && !(src.charCodeAt(i) === 0x23 && src.charCodeAt(i + 1) === 0x7d)) i++;
        i = i < n ? i + 2 : n;
        continue;
      }
      const raw = keywordTagEnd(src, i, "raw") >= 0;
      i = walkTag(src, i, visit);
      if (raw) {
        // A raw block's body is literal text up to its endraw (round 4).
        const start = i;
        i = rawBodyEnd(src, i);
        if (i > start) visit("text", start, i);
      }
      continue;
    }
    const start = i;
    i++;
    for (;;) {
      i = src.indexOf("{", i);
      if (i < 0) {
        i = n;
        break;
      }
      if (opensTag(src, i)) break;
      i++;
    }
    visit("text", start, i);
  }
}

/** The literal ranges of a parsed or unparsed template: from the pre-lexer when it ran, else streamed. */
export function eachLiteral(outcome: ParseOutcome, text: string, visit: LiteralVisitor): void {
  if (!outcome.pre) {
    forEachLiteral(text, visit);
    return;
  }
  // Both lists are in source order; merge them so the ranges are too.
  const { textSegments, stringLiterals } = outcome.pre;
  let a = 0;
  let b = 0;
  while (a < textSegments.length || b < stringLiterals.length) {
    const seg = textSegments[a];
    const lit = stringLiterals[b];
    if (seg && (!lit || seg.start < lit.start)) {
      visit("text", seg.start, seg.end);
      a++;
    } else if (lit) {
      const [start, end] = stringInterior(text, lit.start, lit.end);
      visit("string", start, end);
      b++;
    }
  }
}

// A pre-lexer string literal's span includes its quotes; an unclosed one runs to
// the end of the text (and can overshoot it by one after a trailing backslash).
// A span ending before the end of the text is closed. One ending exactly at it
// is closed only when its last unit is the quote and no backslash escapes it:
// `{{ "a\"` is unclosed.
function stringInterior(text: string, start: number, end: number): [number, number] {
  const n = text.length;
  let closed = end < n;
  if (end === n && end - start >= 2 && text.charCodeAt(end - 1) === text.charCodeAt(start)) {
    let k = end - 2;
    while (k > start && text.charCodeAt(k) === 0x5c) k--;
    closed = (end - 2 - k) % 2 === 0;
  }
  return [start + 1, closed ? end - 1 : Math.min(end, n)];
}

function opensTag(src: string, i: number): boolean {
  if (src.charCodeAt(i) !== 0x7b) return false; // '{'
  const d = src.charCodeAt(i + 1);
  return d === 0x7b || d === 0x25 || d === 0x23; // '{' '%' '#'
}

function isWordStart(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

// One {{ }} or {% %} tag from its opener at `i`, as the pre-lexer's lexTag lexes
// it: reports each string literal's interior and returns the index just past
// the close, or the end of the text when the tag never closes.
function walkTag(src: string, i: number, visit: LiteralVisitor): number {
  const n = src.length;
  const expr = src.charCodeAt(i + 1) === 0x7b;
  i += 2;
  const m = src.charCodeAt(i);
  if (m === 0x2d || m === 0x2b) i++; // '-' / '+'
  let depth = 0; // object-literal braces open inside the tag
  while (i < n) {
    const c = src.charCodeAt(i);
    // A close may follow a '-' or '+' modifier.
    const k = c === 0x2d || c === 0x2b ? i + 1 : i;
    const c1 = src.charCodeAt(k);
    const c2 = src.charCodeAt(k + 1);
    if (expr ? depth === 0 && c1 === 0x7d && c2 === 0x7d : c1 === 0x25 && c2 === 0x7d) return k + 2;
    if (c === 0x27 || c === 0x22) {
      // A quoted string, to its closing quote; a backslash escapes the next unit.
      const start = i + 1;
      i++;
      while (i < n && src.charCodeAt(i) !== c) i += src.charCodeAt(i) === 0x5c ? 2 : 1;
      visit("string", start, Math.min(i, n));
      if (i < n) i++;
      continue;
    }
    if (isWordStart(c)) {
      // Identifiers and numbers hold no close and no quote; skip them whole, as lexTag does.
      while (i < n && (isWordStart(src.charCodeAt(i)) || isDigit(src.charCodeAt(i)))) i++;
      continue;
    }
    if (isDigit(c)) {
      while (i < n && (isDigit(src.charCodeAt(i)) || src.charCodeAt(i) === 0x2e)) i++;
      continue;
    }
    if (c === 0x7b) depth++;
    else if (c === 0x7d && depth > 0) depth--;
    i++;
  }
  return n;
}
