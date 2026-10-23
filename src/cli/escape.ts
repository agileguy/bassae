// Nothing a template carries may act on the terminal that prints it (ISC-44). Every string the
// CLI writes, in either mode, passes through one of these two functions on its way out.
//
// What gets escaped: C0 and C1 controls and DEL, which drive the terminal (ESC ] 52 writes the
// clipboard); bidi controls and line separators, which reorder or break what is shown; invisible
// format characters, which would make a finding's excerpt print as nothing (ISC-21); and lone
// surrogates, which a UTF-8 write would turn into U+FFFD, making two different names look alike
// (Decisions 18:40).
//
// This file and its tests spell every such character as an escape, never raw.

const CLASSES = String.raw`[\0-\x1f\x7f-\x9f\u{61c}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{2028}\u{2029}]|\p{Default_Ignorable_Code_Point}|\p{Cf}|\p{Cs}`;
const UNSAFE = new RegExp(CLASSES, "gu");
const UNSAFE_OR_BACKSLASH = new RegExp(String.raw`\\|${CLASSES}`, "gu");

const hex = (n: number, width: number) => n.toString(16).toUpperCase().padStart(width, "0");

function visible(ch: string): string {
  const cp = ch.codePointAt(0)!;
  if (ch === "\\") return "\\\\";
  if (ch === "\n") return "\\n";
  if (ch === "\r") return "\\r";
  if (ch === "\t") return "\\t";
  if (cp <= 0x9f) return `\\x${hex(cp, 2)}`;
  if (cp <= 0xffff) return `\\u${hex(cp, 4)}`;
  return `\\u{${hex(cp, 5)}}`;
}

/**
 * For human output: every unsafe character as a visible escape, and the backslash as `\\`, so the
 * mapping is one-to-one and a literal backslash-x-1-B in a template can never pass for an escaped ESC.
 */
export function escapeText(s: string): string {
  return s.replace(UNSAFE_OR_BACKSLASH, visible);
}

/**
 * For JSON text from JSON.stringify, which escapes C0 and lone surrogates but leaves C1, DEL, bidi and
 * invisible characters raw. Those can only sit inside JSON strings, so a `\uXXXX` escape keeps the text
 * valid JSON and the parsed value unchanged. An astral character is written as its escaped surrogate pair.
 * A raw tab, newline or carriage return can only be whitespace between tokens, so it stays.
 */
export function escapeJson(json: string): string {
  return json.replace(UNSAFE, (ch) => {
    if (ch === "\n" || ch === "\r" || ch === "\t") return ch;
    let out = "";
    for (let i = 0; i < ch.length; i++) out += `\\u${hex(ch.charCodeAt(i), 4)}`;
    return out;
  });
}
