// Offset-tracking pre-lexer. @huggingface/jinja tokens and AST nodes carry no
// source positions (Decisions, 2026-10-22 16:20), so every finding span starts
// here. We re-tokenize the raw template, recording each token's UTF-16 code-unit
// offsets, and correlate leaves back to the library's AST by walking both in
// source order.
//
// Phase 2 (hidden-instruction rules, ISC-17..21) reuses this: `stringLiterals`
// and `textSegments` expose every literal and every text run with its span.
// The pre-lexer never throws; a template the library cannot parse still needs a
// segmentation for the raw-text fallback rules.

export type PreTokenType =
  | "text" //        literal text outside any tag
  | "comment" //     {# ... #}
  | "open" //        {{ or {%
  | "close" //       }} or %}
  | "string" //      a quoted string literal (value is unescaped to match the AST)
  | "identifier" //  a \w+ run (keywords, booleans, names, filter and test names)
  | "number" //      a numeric literal
  | "punct"; //      every operator, bracket, dot, pipe, colon, comma, paren

export interface PreToken {
  type: PreTokenType;
  /** For strings: the unescaped value (matches AST StringLiteral.value). Otherwise the raw slice. */
  value: string;
  /** UTF-16 code-unit offsets into the raw template text; `end` is exclusive. */
  start: number;
  end: number;
  /** True when the token sits inside a {{ }} or {% %} tag (not text, not comment). */
  inTag: boolean;
}

export interface TextRun {
  value: string;
  start: number;
  end: number;
}

export interface PreLexResult {
  tokens: PreToken[];
  /** Interiors of {{ }} and {% %} tags, for the raw-text fallback and Phase 2. */
  regions: TextRun[];
  /** Every string literal with its value and raw span (quotes included). */
  stringLiterals: TextRun[];
  /** Every literal text run between tags, verbatim with its span. */
  textSegments: TextRun[];
}

// Same escape table the library's lexer uses, so our string values compare equal.
const ESCAPES = new Map([
  ["n", "\n"],
  ["t", "\t"],
  ["r", "\r"],
  ["b", "\b"],
  ["f", "\f"],
  ["v", "\v"],
  ["'", "'"],
  ['"', '"'],
  ["\\", "\\"],
]);

const PUNCT_START = new Set(["(", ")", "[", "]", "{", "}", ",", ".", ":", "|", "+", "-", "~", "*", "/", "%", "<", ">", "=", "!"]);

function isWord(c: string | undefined): boolean {
  return c !== undefined && /\w/.test(c);
}
function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9";
}
function isSpace(c: string | undefined): boolean {
  return c !== undefined && /\s/.test(c);
}

/** Tokenize the raw template, recording a span on every token. */
export function preLex(src: string): PreLexResult {
  const tokens: PreToken[] = [];
  const regions: TextRun[] = [];
  const stringLiterals: TextRun[] = [];
  const textSegments: TextRun[] = [];
  const n = src.length;
  let i = 0;

  while (i < n) {
    // Text, until the next tag opener `{{`, `{%` or `{#` (same trigger as the library).
    if (src[i] === "{" && (src[i + 1] === "%" || src[i + 1] === "{" || src[i + 1] === "#")) {
      if (src[i + 1] === "#") {
        // Comment: consume to `#}`, tolerating a missing close.
        const start = i;
        i += 2;
        const inner = i;
        while (i < n && !(src[i] === "#" && src[i + 1] === "}")) i++;
        const end = i < n ? i + 2 : n;
        tokens.push({ type: "comment", value: src.slice(inner, i), start, end, inTag: false });
        i = end;
        continue;
      }
      i = lexTag(src, i, tokens, regions, stringLiterals);
      continue;
    }
    // A run of literal text.
    const start = i;
    while (i < n && !(src[i] === "{" && (src[i + 1] === "%" || src[i + 1] === "{" || src[i + 1] === "#"))) i++;
    const value = src.slice(start, i);
    tokens.push({ type: "text", value, start, end: i, inTag: false });
    textSegments.push({ value, start, end: i });
  }

  return { tokens, regions, stringLiterals, textSegments };
}

// Lex one {{ ... }} or {% ... %} tag starting at `i` (on the `{`). Returns the
// index just past the close, or past end on a malformed tag.
function lexTag(src: string, i: number, tokens: PreToken[], regions: TextRun[], stringLiterals: TextRun[]): number {
  const n = src.length;
  const isExpr = src[i + 1] === "{";
  const openStart = i;
  i += 2; // past {{ or {%
  if (src[i] === "-" || src[i] === "+") i++; // whitespace-control modifier
  tokens.push({ type: "open", value: src.slice(openStart, i), start: openStart, end: i, inTag: false });
  const regionStart = i;
  let curlyDepth = 0;

  while (i < n) {
    const c = src[i]!;
    if (isSpace(c)) {
      i++;
      continue;
    }
    // Close, with optional `-`/`+` modifier before it. Matching the library's
    // tokenizer: `%}` closes a statement always, `}}` closes an expression only
    // at curly-bracket depth 0 (so `}}` inside an object literal does not close).
    const mod = c === "-" || c === "+" ? 1 : 0;
    const closeTwo = src.slice(i + mod, i + mod + 2);
    if ((!isExpr && closeTwo === "%}") || (isExpr && curlyDepth === 0 && closeTwo === "}}")) {
      regions.push({ value: src.slice(regionStart, i), start: regionStart, end: i });
      const closeStart = i;
      i += mod + 2;
      tokens.push({ type: "close", value: src.slice(closeStart, i), start: closeStart, end: i, inTag: false });
      return i;
    }
    // String literal.
    if (c === "'" || c === '"') {
      const start = i;
      i++;
      let value = "";
      while (i < n && src[i] !== c) {
        if (src[i] === "\\") {
          const esc = src[i + 1];
          value += esc !== undefined && ESCAPES.has(esc) ? ESCAPES.get(esc)! : (esc ?? "");
          i += 2;
          continue;
        }
        value += src[i++]!;
      }
      if (i < n) i++; // closing quote
      tokens.push({ type: "string", value, start, end: i, inTag: true });
      stringLiterals.push({ value, start, end: i });
      continue;
    }
    // Identifier / keyword / boolean.
    if (isWord(c) && !isDigit(c)) {
      const start = i;
      while (i < n && isWord(src[i])) i++;
      tokens.push({ type: "identifier", value: src.slice(start, i), start, end: i, inTag: true });
      continue;
    }
    // Number.
    if (isDigit(c)) {
      const start = i;
      while (i < n && (isDigit(src[i]) || src[i] === ".")) i++;
      tokens.push({ type: "number", value: src.slice(start, i), start, end: i, inTag: true });
      continue;
    }
    // Punctuation / operators. Braces are single characters that move the
    // object-literal depth, exactly as the library lexes them, so a `}}` run
    // inside `{ }` lowers the depth twice and never reads as one close token.
    if (PUNCT_START.has(c)) {
      if (c === "{") curlyDepth++;
      else if (c === "}") curlyDepth = Math.max(0, curlyDepth - 1);
      // Greedily take two-char operators so spans line up; value is informational.
      // `}}`/`%}` are deliberately excluded: a brace is always one character.
      const two = src.slice(i, i + 2);
      const take = c !== "{" && c !== "}" && ["**", "//", "==", "!=", "<=", ">="].includes(two) ? 2 : 1;
      tokens.push({ type: "punct", value: src.slice(i, i + take), start: i, end: i + take, inTag: true });
      i += take;
      continue;
    }
    // Anything unexpected: emit a single-char punct and advance, never throw.
    tokens.push({ type: "punct", value: c, start: i, end: i + 1, inTag: true });
    i++;
  }
  // Unterminated tag: record what interior we have.
  regions.push({ value: src.slice(regionStart, n), start: regionStart, end: n });
  return n;
}
