// Text rules that need no AST: URLs, emails, domains and IPs in injected text
// (ISC-19), encoded blobs (ISC-20) and invisible or deceptive characters
// (ISC-21), plus their raw-text forms for a template the library could not
// parse (ISC-12). Every scan is linear in the text and bounded in findings.
//
// Each scanner is a hand-written forward pass, not a regex. A domain or blob
// regex needs nested repetition, which backtracks on a long `a.a.a…` or
// `AAAA…` run, and these inputs reach 64 MiB. A rule keeps at most FINDING_CAP
// findings, the last one a summary carrying the suppressed count, so capPerRule
// passes them through unchanged and a template of millions of hits never
// builds millions of findings.

import { domainToUnicode } from "node:url";
import type { Finding, FindingBase, InjectedText, RuleId, Severity, Span } from "../types.ts";
import type { ParseOutcome } from "../parse/parse.ts";
import { isJsWhitespace } from "../parse/parse.ts";
import { isTemplateSpace } from "../whitespace.ts";
import { clip, FINDING_CAP } from "./finalize.ts";
import { eachLiteral } from "./literals.ts";
import { IncrementalPos } from "./rawtext.ts";
import { KNOWN_TLDS } from "./tlds.ts";

/**
 * HIGH url_in_text for each URL, email address, known-TLD domain or IP address
 * in injected text (ISC-19). Given the template text, a hit in an item whose
 * text stands verbatim, once, in the template at the item's span (text between
 * tags, or a string literal with no escapes) is spanned at the hit itself; any
 * other hit, as in a folded value, is spanned at the literal it sits in.
 */
export function findUrls(items: readonly InjectedText[], base: FindingBase, text?: string): Finding[] {
  const hits = new Hits();
  for (const item of items) {
    let at: SpanCursor | null | undefined; // looked up at the item's first kept hit
    scanUrls(item.text, 0, item.text.length, (start, end, kind) => {
      if (!hits.take()) return;
      if (at === undefined) at = text === undefined ? null : verbatimAt(text, item);
      const span = at ? at.span(start, end) : item.span;
      const match = item.text.slice(start, end);
      hits.kept.push({ start: span.start, end: span.end, span, message: `injected text contains ${URL_KIND[kind]} '${clip(match)}'`, excerpt: match, detail: { kind, match: clip(match) } });
    });
  }
  return finish("url_in_text", "HIGH", base, [hits], (s, e) => ({ start: s, end: e, line: 1, col: 1 }));
}

/** MEDIUM encoded_blob for each base64-like, base32-like or hex-like run of 32+ characters in a template literal: text between tags and string literals inside them (ISC-20). A run wrapped across lines or split by spaces counts when it decodes to text. */
export function findEncodedBlobs(outcome: ParseOutcome, text: string, base: FindingBase): Finding[] {
  const hits = new Hits();
  eachLiteral(outcome, text, (kind, from, to) => {
    scanBlobs(text, from, to, (start, end, blob) => {
      if (!hits.take()) return;
      const where = kind === "text" ? "template text" : "a string literal";
      hits.kept.push({ start, end, message: `${blob}-like run of ${end - start} characters in ${where}`, excerpt: text.slice(start, end), detail: { encoding: blob, length: end - start } });
    });
  });
  return finish("encoded_blob", "MEDIUM", base, [hits], placer(outcome, text));
}

/** MEDIUM encoded_blob for each base64-like, base32-like or hex-like run of 32+ characters in an injected text's folded value, spanned at the injected text (ISC-20). This catches a blob assembled from shorter literals with `~`, `+` or `|join`, or emitted by literals in sequence, whitespace between them included. The caller passes only items whose text is not one raw literal already scanned by `findEncodedBlobs`, so each blob is reported once. */
export function findEncodedBlobsIn(items: readonly InjectedText[], base: FindingBase): Finding[] {
  const hits = new Hits();
  for (const item of items) {
    scanBlobs(item.text, 0, item.text.length, (start, end, blob) => {
      if (!hits.take()) return;
      const run = item.text.slice(start, end);
      hits.kept.push({ start: item.span.start, end: item.span.end, span: item.span, message: `${blob}-like run of ${end - start} characters in injected text`, excerpt: run, detail: { encoding: blob, length: end - start } });
    });
  }
  return finish("encoded_blob", "MEDIUM", base, [hits], (s, e) => ({ start: s, end: e, line: 1, col: 1 }));
}

/** HIGH invisible_char for each run of invisible or deceptive characters anywhere in the template, tags and comments included (ISC-21). Works with or without a line map, so it covers over-cap templates too. */
export function findInvisibleChars(text: string, base: FindingBase, outcome?: ParseOutcome): Finding[] {
  const raw = new Hits();
  scanInvisible(text, raw);
  // A jinja2 string escape such as '\u200b' renders the character itself.
  // @huggingface/jinja rejects those escapes, so they occur only in a template
  // that is already HIGH unanalyzable; this names the character and its span.
  const escaped = new Hits();
  const each = outcome ?? { spans: new Map(), unsupported: [], tooLarge: false };
  eachLiteral(each, text, (kind, from, to) => {
    if (kind === "string") scanEscapes(text, from, to, escaped);
  });
  return finish("invisible_char", "HIGH", base, [raw, escaped], placer(outcome, text));
}

/** The raw-text form of ISC-19 for a template with no AST (ISC-12): URLs, emails, domains and IPs in text between tags and in string literals, streamed when the template is over the size cap. */
export function findUrlsRaw(outcome: ParseOutcome, text: string, base: FindingBase): Finding[] {
  const hits = new Hits();
  eachLiteral(outcome, text, (kind, from, to) => {
    scanUrls(text, from, to, (start, end, url) => {
      if (!hits.take()) return;
      const match = text.slice(start, end);
      const where = kind === "text" ? "template text" : "a string literal";
      hits.kept.push({ start, end, message: `${where} contains ${URL_KIND[url]} '${clip(match)}'`, excerpt: match, detail: { kind: url, match: clip(match) } });
    });
  });
  return finish("url_in_text", "HIGH", base, [hits], placer(outcome, text));
}

// ---- bounded collection ----

interface Hit {
  start: number;
  end: number;
  /** Set when the hit is placed by its caller, as findUrls places a hit at its injected-text item. */
  span?: Span;
  message: string;
  excerpt?: string;
  detail?: Record<string, unknown>;
}

// The first FINDING_CAP hits of one pass, in source order, and how many there
// were in all. A pass calls take() for every hit and builds one only when it
// returns true, so a hit past the cap costs a counter increment.
class Hits {
  readonly kept: Hit[] = [];
  total = 0;
  take(): boolean {
    return this.total++ < FINDING_CAP;
  }
}

type Placer = (start: number, end: number) => Span;

// The line map when the pre-lexer built one; over the size cap, an incremental
// walk, which finish() calls with ascending offsets.
function placer(outcome: ParseOutcome | undefined, text: string): Placer {
  const lines = outcome?.lines;
  if (lines) return (start, end) => lines.span(start, end);
  const pos = new IncrementalPos(text);
  return (start, end) => ({ start, end, ...pos.at(start) });
}

// Merge the passes in source order and keep the first FINDING_CAP hits. Over
// the cap, the last kept place holds a summary of the rest, in the shape
// capPerRule gives its own, at the first suppressed hit. Each pass kept its own
// first FINDING_CAP, so the merged first FINDING_CAP are the template's.
function finish(ruleId: RuleId, severity: Severity, base: FindingBase, passes: Hits[], place: Placer): Finding[] {
  const merged = passes.flatMap((p) => p.kept).sort((a, b) => a.start - b.start || a.end - b.end);
  const total = passes.reduce((n, p) => n + p.total, 0);
  const keep = total > FINDING_CAP ? FINDING_CAP - 1 : merged.length;
  const out: Finding[] = [];
  for (const h of merged.slice(0, keep)) {
    const span = h.span ?? place(h.start, h.end);
    const f: Finding = { ruleId, severity, message: h.message, ...base, span };
    if (h.excerpt !== undefined) f.excerpt = clip(h.excerpt);
    if (h.detail) f.detail = h.detail;
    out.push(f);
  }
  if (total > keep) {
    const first = merged[keep]!;
    const suppressed = total - keep;
    out.push({ ruleId, severity, message: `${suppressed} more ${ruleId} findings suppressed`, ...base, span: first.span ?? place(first.start, first.end), detail: { suppressed } });
  }
  return out;
}

// Spans of ascending offsets into an item's text, placed in the template where
// that text stands verbatim. Line and column are walked forward from the item's
// span and counted as LineMap counts them: \r\n, \r or \n breaks a line, and a
// surrogate pair is one column.
class SpanCursor {
  private i: number;
  private line: number;
  private col: number;
  constructor(
    private readonly text: string,
    private readonly offset: number, // where the item's text starts in the template
    from: Span,
  ) {
    this.i = from.start;
    this.line = from.line;
    this.col = from.col;
  }
  span(start: number, end: number): Span {
    const t = this.text;
    for (const to = this.offset + start; this.i < to; this.i++) {
      const c = t.charCodeAt(this.i);
      if (c === 10 || (c === 13 && t.charCodeAt(this.i + 1) !== 10)) {
        this.line++;
        this.col = 1;
      } else if (c < 0xd800 || c > 0xdbff) {
        this.col++;
      }
    }
    return { start: this.offset + start, end: this.offset + end, line: this.line, col: this.col };
  }
}

// A cursor over the item's text where it occurs exactly once in the template at
// the item's span, or null. A folded value, a string with an escape, or text
// that occurs twice there has no one place.
function verbatimAt(text: string, item: InjectedText): SpanCursor | null {
  const { start, end } = item.span;
  if (end > text.length) return null;
  const at = onlyOccurrence(text, start, end, item.text);
  return at < 0 ? null : new SpanCursor(text, at, item.span);
}

// The offset of needle's only occurrence in s[from, to), or -1 when it occurs
// there not at all or more than once. Knuth-Morris-Pratt, linear in both, where
// indexOf takes quadratic time on a needle like `!!!…!a.com!!!…!` that matches
// up to its middle at every offset before its own.
function onlyOccurrence(s: string, from: number, to: number, needle: string): number {
  const n = needle.length;
  if (n === 0 || n > to - from) return -1;
  const fail = new Int32Array(n); // longest proper border of needle[0, k]
  for (let i = 1, k = 0; i < n; i++) {
    const c = needle.charCodeAt(i);
    while (k > 0 && c !== needle.charCodeAt(k)) k = fail[k - 1]!;
    if (c === needle.charCodeAt(k)) k++;
    fail[i] = k;
  }
  let found = -1;
  for (let i = from, k = 0; i < to; i++) {
    const c = s.charCodeAt(i);
    while (k > 0 && c !== needle.charCodeAt(k)) k = fail[k - 1]!;
    if (c === needle.charCodeAt(k)) k++;
    if (k === n) {
      if (found >= 0) return -1;
      found = i - n + 1;
      k = fail[k - 1]!;
    }
  }
  return found;
}

// ---- ISC-19: URLs, email addresses and domains ----

// A set of lowercase keys, each with a nonzero value, looked up in s[k, e)
// with no slice. get() folds A-Z to lower case; getFolded() reads through the
// URL fold below. The URL scanner looks up every label of every dotted run,
// and the escape scan every \N{name}; on a hostile 64 MiB template a slice per
// lookup is tens of millions of strings, hundreds of MB of garbage before a
// collection.
class FoldedSet {
  private readonly next: Map<number, number>[] = [new Map()];
  private readonly values: number[] = [0];
  constructor(entries: Iterable<[string, number]>) {
    for (const [label, value] of entries) {
      let node = 0;
      for (let j = 0; j < label.length; j++) {
        const c = label.charCodeAt(j);
        let child = this.next[node]!.get(c);
        if (child === undefined) {
          child = this.next.length;
          this.next.push(new Map());
          this.values.push(0);
          this.next[node]!.set(c, child);
        }
        node = child;
      }
      this.values[node] = value;
    }
  }
  /** The value of s[k, e) folded to lower case, or 0 when it is not in the set. */
  get(s: string, k: number, e: number): number {
    let node = 0;
    for (let j = k; j < e; j++) {
      const c = s.charCodeAt(j);
      const child = this.next[node]!.get(c >= 0x41 && c <= 0x5a ? c + 0x20 : c);
      if (child === undefined) return 0;
      node = child;
    }
    return this.values[node]!;
  }
  /** The value of s[k, e) read through the URL fold and folded to lower case, or 0. */
  getFolded(s: string, k: number, e: number): number {
    let node = 0;
    for (let j = k; j < e; ) {
      const f = at(s, j, e);
      const c = charOf(f);
      const child = this.next[node]!.get(c >= 0x41 && c <= 0x5a ? c + 0x20 : c);
      if (child === undefined) return 0;
      node = child;
      j += widthOf(f);
    }
    return this.values[node]!;
  }
}

export type UrlKind = "url" | "email" | "domain" | "ip";

const URL_KIND: Record<UrlKind, string> = { url: "URL", email: "email address", domain: "domain", ip: "IP address" };

/** Receives one match [start, end) in the scanned string. */
export type UrlSink = (start: number, end: number, kind: UrlKind) => void;

// Known TLDs that are also everyday file extensions: `config.py`, `README.md`,
// `run.sh`, `main.rs`, `weights.pt`, `Foo.app`, `MANIFEST.in`. A name under one
// of these is a domain only when something else says so: a path or port after
// it, or a second-level label such as `com` (`example.com.py`). `.ai` and
// `.io` are not here: they name a host far more often than a file, and listing
// them would hide `evil.ai`.
const FILE_EXTENSION_TLDS: ReadonlySet<string> = new Set([
  "ac", "am", "app", "ar", "cc", "cl", "cr", "fish", "gd", "in", "key", "md", "mk", "ml", "mm", "mo", "mobi",
  "mov", "pl", "pm", "properties", "ps", "pt", "pub", "py", "rs", "sc", "sh", "so", "st", "tf", "ws", "zip",
]);

// Second-level labels that ccTLD registries sell under, so `x.com.py` is a host.
const SECOND_LEVEL = new FoldedSet(["ac", "co", "com", "edu", "gob", "gov", "mil", "ne", "net", "nom", "or", "org", "sch"].map((l) => [l, 1]));

// Every known TLD: 2 for one that is also a file extension, 3 for an IDN TLD in
// its Unicode form (U+0440 U+0444 for xn--p1ai), so a name is checked after the
// IDNA conversion a browser applies, and 1 for the rest. `.onion` and `.i2p`
// are not in the root zone, but Tor and I2P resolve them, so they are here too.
const TLD = 1;
const FILE_EXTENSION_TLD = 2;
const IDN_TLD = 3;
const TLDS = new FoldedSet([
  ...[...KNOWN_TLDS].map((t): [string, number] => [t, FILE_EXTENSION_TLDS.has(t) ? FILE_EXTENSION_TLD : TLD]),
  ...[...KNOWN_TLDS].filter((t) => t.startsWith("xn--")).map((t): [string, number] => [domainToUnicode(t), IDN_TLD]),
  ["onion", TLD],
  ["i2p", TLD],
]);

// ---- the URL fold ----
//
// The URL scanner reads each character folded the way a browser's IDNA mapping
// and a reader's eye both fold it, so a host spelled in look-alike characters
// is still a host. A character folds to its NFKC form when that is one
// character: the fullwidth and mathematical letters and digits, the fullwidth
// full stop U+FF0E, the one dot leader U+2024 and the small full stop U+FE52
// all read as ASCII. The ideographic full stop U+3002 folds to '.', as IDNA
// maps it; a non-ASCII letter folds to lower case, so an IDN TLD matches in
// either case; and the defanged dot `[.]` folds to '.'. A character NFKC
// expands to several (U+2122 TRADE MARK SIGN) stays as it is, so each folded
// character stands for one source character, or one defang, and every match
// is a span of the source text.

// A folded character is packed in a number with its width: the folded code
// unit in the low 16 bits, and above them how many source code units it stands
// for, 2 for a surrogate pair and 3 for `[.]`. A number, not an object, so a
// scan allocates nothing per character.
const UNIT = 0x10000;
const charOf = (f: number) => f & 0xffff;
const widthOf = (f: number) => f >>> 16;

// What an astral character folds to when no table entry covers it: a letter
// (CJK Extension B and later), or anything else. Both are noncharacters, so no
// folded BMP character collides with them.
const ASTRAL_LETTER = 0xffff;
const ASTRAL_OTHER = 0xfffe;

// The astral block the fold reads from a table: Mathematical Alphanumeric
// Symbols through Symbols for Legacy Computing, which hold the math bold,
// script and double-struck letters and digits, the squared Latin letters and
// the segmented digits.
const ASTRAL_FROM = 0x1d400;
const ASTRAL_TO = 0x1fc00;

// FOLD maps a BMP code unit to its folded code unit, ASTRAL_FOLD an astral
// code point in the block above, and LABEL marks the folded non-ASCII units
// that can stand in an IDN label: letters, marks and digits that are not
// default-ignorable. Built once, from the engine's own Unicode data.
const { FOLD, ASTRAL_FOLD, LABEL } = (() => {
  const one = (cp: number): number => {
    const n = String.fromCodePoint(cp).normalize("NFKC");
    if (n.length !== 1) return -1;
    const c = n.charCodeAt(0);
    if (c === 0x3002) return 0x2e;
    if (c < 0x80) return c;
    const lower = n.toLowerCase();
    return lower.length === 1 ? lower.charCodeAt(0) : c;
  };
  const fold = new Uint16Array(0x10000);
  for (let c = 0; c < 0x10000; c++) {
    const f = c < 0x80 || (c >= 0xd800 && c <= 0xdfff) ? -1 : one(c);
    fold[c] = f < 0 ? c : f;
  }
  const astral = new Uint16Array(ASTRAL_TO - ASTRAL_FROM);
  for (let cp = ASTRAL_FROM; cp < ASTRAL_TO; cp++) {
    const f = one(cp);
    astral[cp - ASTRAL_FROM] = f < 0 ? ASTRAL_OTHER : f;
  }
  const letter = /^[\p{L}\p{M}\p{Nd}]$/u;
  const ignorable = /^\p{Default_Ignorable_Code_Point}$/u;
  const label = new Uint8Array(0x10000);
  for (let c = 0x80; c < 0x10000; c++) {
    const ch = String.fromCharCode(c);
    if (letter.test(ch) && !ignorable.test(ch)) label[c] = 1;
  }
  label[ASTRAL_LETTER] = 1;
  return { FOLD: fold, ASTRAL_FOLD: astral, LABEL: label };
})();

function foldAstral(cp: number): number {
  if (cp >= ASTRAL_FROM && cp < ASTRAL_TO) return ASTRAL_FOLD[cp - ASTRAL_FROM]!;
  return cp >= 0x20000 && cp < 0x40000 ? ASTRAL_LETTER : ASTRAL_OTHER;
}

// The folded character at s[i], packed. Reads nothing at or past `to`.
function at(s: string, i: number, to: number): number {
  const c = s.charCodeAt(i);
  if (c < 0x80) {
    if (c === 0x5b && i + 2 < to && s.charCodeAt(i + 1) === 0x2e && s.charCodeAt(i + 2) === 0x5d) return 0x2e + 3 * UNIT;
    return c + UNIT;
  }
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < to) {
    const d = s.charCodeAt(i + 1);
    if (d >= 0xdc00 && d <= 0xdfff) return foldAstral(((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000) + 2 * UNIT;
  }
  return FOLD[c]! + UNIT;
}

// The folded character that ends at s[i - 1], packed. Reads nothing before
// `from`. `[.]` and a surrogate pair cannot overlap another of their kind, so
// reading backward splits a text into the same characters as reading forward.
function before(s: string, i: number, from: number): number {
  const c = s.charCodeAt(i - 1);
  if (c < 0x80) {
    if (c === 0x5d && i - 3 >= from && s.charCodeAt(i - 2) === 0x2e && s.charCodeAt(i - 3) === 0x5b) return 0x2e + 3 * UNIT;
    return c + UNIT;
  }
  if (c >= 0xdc00 && c <= 0xdfff && i - 2 >= from) {
    const h = s.charCodeAt(i - 2);
    if (h >= 0xd800 && h <= 0xdbff) return foldAstral(((h - 0xd800) << 10) + (c - 0xdc00) + 0x10000) + 2 * UNIT;
  }
  return FOLD[c]! + UNIT;
}

// The end of the folded character `code` at s[j], or -1 when s[j] is something
// else, j is past the text, or j is -1.
function past(s: string, j: number, to: number, code: number): number {
  if (j < 0 || j >= to) return -1;
  const f = at(s, j, to);
  return charOf(f) === code ? j + widthOf(f) : -1;
}

function isAlnum(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

function isLetter(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

// A folded character of a label: an ASCII letter or digit, or an IDN letter.
function isLabelChar(c: number): boolean {
  return c < 0x80 ? isAlnum(c) : LABEL[c] === 1;
}

// A folded character of a run the scanner splits into labels: a label
// character, '-', '_' or a dot. '_' is kept in the run so a label holding one
// can mark it as code.
function isRunChar(c: number): boolean {
  return isLabelChar(c) || c === 0x2d || c === 0x5f || c === 0x2e;
}

// What may follow `scheme://` in a URL: anything but whitespace, controls,
// quotes, angle brackets, backticks, braces, pipes and backslashes.
function isUrlChar(c: number): boolean {
  if (c < 0x21 || c === 0x7f || isJsWhitespace(c)) return false;
  return c !== 0x22 && c !== 0x27 && c !== 0x3c && c !== 0x3e && c !== 0x60 && c !== 0x7b && c !== 0x7d && c !== 0x7c && c !== 0x5c;
}

// Sentence punctuation a URL in prose is usually followed by.
function isTrailingPunct(c: number): boolean {
  return c === 0x2e || c === 0x2c || c === 0x3b || c === 0x3a || c === 0x21 || c === 0x3f || c === 0x29 || c === 0x5d;
}

/** Every URL (with a scheme, or `www.`), email address, known-TLD domain and IP address in s[from, to), in order, read through the URL fold. One forward pass. */
export function scanUrls(s: string, from: number, to: number, emit: UrlSink): void {
  // One chain for every run, reset after each, so a run costs no allocation.
  const ch: Chain = { start: -1, firstEnd: -1, labels: 0, octets: 0, firstOctet: -1, lastOctet: -1, lastEnd: -1, prevStart: -1, prevEnd: -1, tldStart: -1, tldEnd: -1, tldKind: 0, sldStart: -1, sldEnd: -1, resume: from };
  let i = from;
  while (i < to) {
    let f = at(s, i, to);
    if (!isRunChar(charOf(f))) {
      const e = charOf(f) === 0x5b ? ipv6End(s, i, to) : -1;
      if (e >= 0) {
        const end = hostTail(s, e, to);
        emit(i, end, "ip");
        i = end;
      } else {
        i += widthOf(f);
      }
      continue;
    }
    const p = i;
    while (i < to && isRunChar(charOf((f = at(s, i, to))))) i += widthOf(f);
    const q = i;
    // scheme://…
    const body = past(s, past(s, past(s, q, to, 0x3a), to, 0x2f), to, 0x2f);
    if (body >= 0) {
      const st = schemeStart(s, p, q);
      if (st >= 0) {
        const end = urlEnd(s, body, to);
        emit(st, end, "url");
        i = end;
        continue;
      }
    }
    // local@domain
    const d = past(s, q, to, 0x40);
    if (d >= 0) {
      const e = emailDomainEnd(s, d, to);
      const st = localStart(s, p, q);
      if (e >= 0 && st < q) {
        emit(st, e, "email");
        i = e;
        continue;
      }
    }
    i = scanHosts(s, p, q, to, ch, emit);
  }
}

// Where the scheme ending at `q` starts: the last at most 32 scheme characters
// of the run, from their first letter. -1 when there is no letter.
function schemeStart(s: string, p: number, q: number): number {
  let k = q;
  for (let n = 0; k > p && n < 32; n++) {
    const f = before(s, k, p);
    const c = charOf(f);
    if (!isAlnum(c) && c !== 0x2b && c !== 0x2d && c !== 0x2e) break;
    k -= widthOf(f);
  }
  while (k < q) {
    const f = at(s, k, q);
    if (isLetter(charOf(f))) return k;
    k += widthOf(f);
  }
  return -1;
}

// Where the local part of an email address ending at `q` starts: at most 64
// characters back, within the run that began at `p`.
function localStart(s: string, p: number, q: number): number {
  let st = q;
  for (let n = 0; n < 64 && st > p; n++) st -= widthOf(before(s, st, p));
  return st;
}

// The end of a URL body starting at `j`, without the punctuation that ends a sentence.
function urlEnd(s: string, j: number, to: number): number {
  const start = j;
  while (j < to) {
    const f = at(s, j, to);
    if (!isUrlChar(charOf(f))) break;
    j += widthOf(f);
  }
  while (j > start) {
    const f = before(s, j, start);
    if (!isTrailingPunct(charOf(f))) break;
    j -= widthOf(f);
  }
  return j;
}

// Whether a path ('/') or a port (':' then a letter or digit) starts at s[j].
function pathOrPortAt(s: string, j: number, to: number): boolean {
  if (j >= to) return false;
  const f = at(s, j, to);
  const c = charOf(f);
  if (c === 0x2f) return true;
  const k = j + widthOf(f);
  return c === 0x3a && k < to && isAlnum(charOf(at(s, k, to)));
}

// The end of a host ending at `j`, past the port and path that follow it.
function hostTail(s: string, j: number, to: number): number {
  return pathOrPortAt(s, j, to) ? urlEnd(s, j, to) : j;
}

// The end of the domain after an '@' that ends at `d`, or -1 when what follows
// is not a dotted name ending in an alphabetic (or xn--) label.
function emailDomainEnd(s: string, d: number, to: number): number {
  let e = d;
  while (e < to) {
    const f = at(s, e, to);
    const c = charOf(f);
    if (!isLabelChar(c) && c !== 0x2d && c !== 0x2e) break;
    e += widthOf(f);
  }
  while (e > d) {
    const f = before(s, e, d);
    if (charOf(f) !== 0x2e && charOf(f) !== 0x2d) break;
    e -= widthOf(f);
  }
  let labels = 0;
  let lastStart = d;
  let k = d;
  while (k < e) {
    let j = k;
    let len = 0;
    let f = 0;
    while (j < e && charOf((f = at(s, j, e))) !== 0x2e) {
      j += widthOf(f);
      len++;
    }
    if (len === 0 || len > 63) return -1;
    labels++;
    lastStart = k;
    k = j < e ? j + widthOf(f) : j;
  }
  if (labels < 2) return -1;
  return isTopLabel(s, lastStart, e) ? e : -1;
}

// A label of 2 to 63 letters, ASCII or IDN, or an IDN `xn--` label.
function isTopLabel(s: string, k: number, e: number): boolean {
  let len = 0;
  let prefix = 0; // how many leading characters match `xn--`
  let letters = true;
  for (let j = k; j < e; len++) {
    const f = at(s, j, e);
    const c = charOf(f);
    if (prefix === len && len < 4 && (c | 0x20) === "xn--".charCodeAt(len)) prefix++;
    if (c < 0x80 ? !isLetter(c) : LABEL[c] !== 1) letters = false;
    j += widthOf(f);
  }
  if (len < 2 || len > 63) return false;
  return letters || (prefix === 4 && len > 4);
}

// Whether s[k, e) is `www`, folded.
function isWww(s: string, k: number, e: number): boolean {
  let n = 0;
  for (let j = k; j < e; n++) {
    const f = at(s, j, e);
    if (n === 3 || (charOf(f) | 0x20) !== 0x77) return false;
    j += widthOf(f);
  }
  return n === 3;
}

// A chain of valid labels inside one run, as scanHosts walks it.
interface Chain {
  start: number; //      first label's start
  firstEnd: number; //   first label's end
  labels: number; //     labels so far
  octets: number; //     labels so far that read as an IPv4 octet: 0 to 255, no leading zero
  firstOctet: number; // the first label's octet value, or -1
  lastOctet: number; //  the last label's octet value, or -1
  lastEnd: number; //    last label's end
  prevStart: number; //  the last label's start, then the one before it
  prevEnd: number;
  tldStart: number; //   the last known-TLD label at position 2 or later, or -1
  tldEnd: number;
  tldKind: number; //    its TLDS value
  sldStart: number; //   the label before that TLD
  sldEnd: number;
  resume: number; //     where the scan goes on: past a `www.` URL or an IP's port and path, else the run end
}

// The `www.` hosts, known-TLD domains and IPv4 addresses in the run s[p, q).
// The run splits at dots into labels; a chain is a maximal sequence of valid
// labels. An empty, over-long or underscored label (`tool_call.name`) is code,
// not a host, so the chain restarts after it. In a chain, the domain runs to
// the last label that is a known TLD: `evil.com.Then` is `evil.com`. Returns
// where the scan goes on, past the path of a `www.` URL or an IP that ends the
// run so the path is not rescanned (`www.a.com/` repeated would be quadratic).
function scanHosts(s: string, p: number, q: number, to: number, ch: Chain, emit: UrlSink): number {
  ch.resume = q;
  let k = p;
  while (k < q) {
    // One label, to the next dot. A chain's first label drops leading hyphens (`--evil.com`).
    let ks = k;
    let e = k;
    let len = 0;
    let first = -1;
    let last = -1;
    let underscore = false;
    let octet = 0; // the label's value while it reads as an IPv4 octet, else -1
    let f = 0;
    while (e < q && charOf((f = at(s, e, q))) !== 0x2e) {
      const c = charOf(f);
      e += widthOf(f);
      if (len === 0 && c === 0x2d && ch.labels === 0) {
        ks = e;
        continue;
      }
      if (c === 0x5f) underscore = true;
      if (len === 0) first = c;
      last = c;
      len++;
      if (octet >= 0) octet = c >= 0x30 && c <= 0x39 && len <= 3 && (len === 1 || first !== 0x30) ? octet * 10 + (c - 0x30) : -1;
    }
    if (len === 0 || octet > 255) octet = -1;
    if (len < 1 || len > 63 || underscore || first === 0x2d || last === 0x2d) {
      emitChain(s, ch, q, to, emit);
    } else {
      if (ch.labels === 0) {
        ch.start = ks;
        ch.firstEnd = e;
        ch.firstOctet = octet;
      }
      ch.labels++;
      if (octet >= 0) ch.octets++;
      ch.lastOctet = octet;
      const kind = ch.labels >= 2 ? TLDS.getFolded(s, ks, e) : 0;
      if (kind) {
        ch.tldStart = ks;
        ch.tldEnd = e;
        ch.tldKind = kind;
        ch.sldStart = ch.prevStart;
        ch.sldEnd = ch.prevEnd;
      }
      ch.prevStart = ks;
      ch.prevEnd = e;
      ch.lastEnd = e;
    }
    k = e < q ? e + widthOf(f) : e; // past the dot
  }
  emitChain(s, ch, q, to, emit);
  return ch.resume;
}

// Report a finished chain, then reset it for the next one.
function emitChain(s: string, ch: Chain, q: number, to: number, emit: UrlSink): void {
  if (ch.labels > 0) {
    const www = isWww(s, ch.start, ch.firstEnd);
    if (www && ch.labels === 1 && ch.lastEnd < q) {
      // The chain ended at a dot: a bare `www.` that a template builds a URL on.
      emit(ch.start, ch.lastEnd + widthOf(at(s, ch.lastEnd, q)), "url");
    } else if (www && ch.labels >= 2) {
      const end = ch.lastEnd === q ? urlEnd(s, q, to) : ch.lastEnd;
      emit(ch.start, end, "url");
      if (end > ch.resume) ch.resume = end;
    } else if (ch.labels === 4 && ch.octets === 4 && ch.firstOctet > 0 && ch.lastOctet > 0) {
      // An IPv4 address. One starting or ending in 0 (`1.0.0.0`) is a version, not a host.
      const end = ch.lastEnd === q ? hostTail(s, q, to) : ch.lastEnd;
      emit(ch.start, end, "ip");
      if (end > ch.resume) ch.resume = end;
    } else if (ch.tldEnd > 0 && isHost(s, ch, q, to)) {
      emit(ch.start, ch.tldEnd, "domain");
    }
  }
  ch.start = ch.firstEnd = ch.firstOctet = ch.lastOctet = ch.lastEnd = ch.prevStart = ch.prevEnd = ch.tldStart = ch.tldEnd = ch.sldStart = ch.sldEnd = -1;
  ch.labels = ch.octets = ch.tldKind = 0;
}

// Whether a chain ending in a known TLD is a host, not something shaped like
// one. Four shapes are not: a method call or subscript (`re.search(`); a file
// name under a TLD that is also a file extension (`config.py`), unless a path,
// a port or a registry second-level label says it is a host; an IDN TLD after
// the ideographic full stop, which in CJK prose ends a sentence before a word
// that happens to be a TLD; and a number before a capitalized word (`1.Do`,
// `3.5.It`), which is a list item or a missing space.
function isHost(s: string, ch: Chain, q: number, to: number): boolean {
  const next = ch.tldEnd < to ? charOf(at(s, ch.tldEnd, to)) : -1;
  if (ch.tldEnd === q && (next === 0x28 || next === 0x5b)) return false; // '(' '['
  if (ch.tldKind === FILE_EXTENSION_TLD) {
    const sld = ch.sldStart >= 0 && SECOND_LEVEL.getFolded(s, ch.sldStart, ch.sldEnd) !== 0;
    if (!sld && !(ch.tldEnd === q && pathOrPortAt(s, q, to))) return false;
  }
  const dot = s.charCodeAt(ch.sldEnd);
  if (ch.tldKind === IDN_TLD && (dot === 0x3002 || dot === 0xff61)) return false;
  const c = charOf(at(s, ch.tldStart, to));
  if (c >= 0x41 && c <= 0x5a) {
    for (let j = ch.start; j < ch.tldStart; ) {
      const f = at(s, j, ch.tldStart);
      const d = charOf(f);
      if (!(d >= 0x30 && d <= 0x39) && d !== 0x2e) return true;
      j += widthOf(f);
    }
    return false;
  }
  return true;
}

// The end past ']' of a bracketed IPv6 address at s[i] === '[', else -1:
// colon-separated groups of 1 to 4 hex digits, eight of them, or fewer around
// one '::', and at least two, so a slice such as `[::2]` is not one. Reads at
// most about 50 characters, so a text of brackets stays linear.
function ipv6End(s: string, i: number, to: number): number {
  let j = i + 1;
  let groups = 0;
  let double = false;
  if (j + 1 < to && s.charCodeAt(j) === 0x3a && s.charCodeAt(j + 1) === 0x3a) {
    double = true;
    j += 2;
  }
  for (;;) {
    let digits = 0;
    while (j < to && digits < 5 && isHexDigit(s.charCodeAt(j))) {
      j++;
      digits++;
    }
    if (digits === 0 || digits > 4 || ++groups > 8 || j >= to) return -1;
    const c = s.charCodeAt(j);
    if (c === 0x5d) break;
    if (c !== 0x3a) return -1;
    j++;
    if (j < to && s.charCodeAt(j) === 0x3a) {
      if (double) return -1;
      double = true;
      j++;
      if (j < to && s.charCodeAt(j) === 0x5d) break;
    }
  }
  if (groups < 2 || (double ? groups > 7 : groups !== 8)) return -1;
  return j + 1;
}

// ---- ISC-20: encoded blobs ----

export type BlobKind = "base64" | "base32" | "hex";

/** Receives one blob [start, end) in the scanned string. */
export type BlobSink = (start: number, end: number, kind: BlobKind) => void;

// The shortest run that counts as a blob (ISC-20). A run split by whitespace
// counts its characters without the whitespace.
const MIN_BLOB = 32;

// A base64-like run switches between upper case, lower case, digits and symbols
// at about 0.64 of its adjacent pairs; prose identifiers in camelCase or
// TitleCase switch only at word boundaries, about 0.35. The cut sits between.
const MIN_SWITCH_RATE = 0.45;

// Base64 has at most 2 symbols ('+/' or '-_') in 64; paths, snake_case and
// kebab-case have one every few characters. A run with more than one in 8 is
// not a blob.
const MAX_SYMBOL_SHARE = 1 / 8;

// About 1 random base64 run in 100 fails the two cuts above by chance. A second
// test adds whether its letters pair the way English words do. Of its pairs of
// adjacent letters, case folded and doubled letters left out, about 23% of a
// random run's are among the common English pairs below, and most of an
// identifier's, which is built from words. Its switch rate here leaves out
// symbols, which in a path or a kebab-case name only separate words. A random
// run's common share is about 0.4 below that rate, and an identifier's well
// above it. A run with both cases, symbols from one base64 alphabet and at most
// one in 4, and a common share at most 0.15 above its rate, is random. Together
// the two tests miss about 5 in 1,000,000 random runs of 40 characters.
const MAX_COMMON_OVER_SWITCH = 0.15;
const MAX_RANDOM_SYMBOL_SHARE = 1 / 4;

// 150 common English letter pairs, roughly commonest first.
const COMMON_PAIRS: Uint8Array = (() => {
  const pairs =
    "th he in er an re on at en nd ti es or te of ed is it al ar st to nt ng se ha as ou io le ve co me de hi ri ro ic ne ea ra ce li ch ll be ma si om ur ca el ta la ns di fo ho pe ec pr no ct us ac ot il tr ly nc et ut ss so rs un lo wa ge ie wh ee wi em ad ol rt po we na ul ni ts mo ow pa im mi ai sh ir su id os iv ia am fi ci vi pl ig tu ev ld ry mp fe bl ab gh ty op wo sa ay ex ke fr oo av ag if ap gr od bo sp rd do uc bu ei ov by rm ep tt oc fa";
  const table = new Uint8Array(32 * 32);
  for (const p of pairs.split(" ")) table[pairPlace(p.charCodeAt(0), p.charCodeAt(1))] = 1;
  return table;
})();

// A letter pair's place in COMMON_PAIRS, either case: A-Z and a-z share their low five bits.
function pairPlace(a: number, b: number): number {
  return (a & 31) * 32 + (b & 31);
}

// A run split by whitespace is tried as one blob from each of its first few
// tokens, so a blob-like word or two before it does not hide it.
const MAX_SPLIT_STARTS = 3;

// Decoded bytes are text when at least this share of their characters print.
const MIN_PRINTABLE_SHARE = 0.9;

function isBlobChar(c: number): boolean {
  return isAlnum(c) || c === 0x2b || c === 0x2f || c === 0x5f || c === 0x2d; // '+' '/' '_' '-'
}

function isHexDigit(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
}

function isAsciiLetter(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

// The value of a base64 digit in either alphabet, or -1.
function base64Value(c: number): number {
  if (c >= 0x41 && c <= 0x5a) return c - 0x41;
  if (c >= 0x61 && c <= 0x7a) return c - 0x61 + 26;
  if (c >= 0x30 && c <= 0x39) return c - 0x30 + 52;
  if (c === 0x2b || c === 0x2d) return 62; // '+' '-'
  if (c === 0x2f || c === 0x5f) return 63; // '/' '_'
  return -1;
}

// The value of a base32 digit in either case, or -1.
function base32Value(c: number): number {
  if (c >= 0x41 && c <= 0x5a) return c - 0x41;
  if (c >= 0x61 && c <= 0x7a) return c - 0x61;
  if (c >= 0x32 && c <= 0x37) return c - 0x32 + 26;
  return -1;
}

/**
 * Every encoded blob of MIN_BLOB or more characters in s[from, to), in order.
 * One forward pass, each character read a bounded number of times.
 *
 * A base64-like run mixes upper case, lower case and digits, switches class
 * often and holds few symbols, or its letters pair unlike English words, or it
 * decodes to text; trailing '=' padding is part of it. A hex-like run is hex
 * digits only, with at least one digit and one letter. A base32 run decodes to
 * text. Blob-like tokens apart only by whitespace, a blob wrapped across lines
 * or split by spaces, are one blob when they decode to text. English words,
 * snake_case, camelCase, paths and separator lines like `====` or `----` are
 * none of these.
 */
export function scanBlobs(s: string, from: number, to: number, emit: BlobSink): void {
  let i = from;
  while (i < to) {
    if (!isBlobChar(s.charCodeAt(i))) {
      i++;
      continue;
    }
    const end = splitEnd(s, i, to);
    if (end === i) {
      i = judgeRun(s, i, to, emit);
      continue;
    }
    // A split run is one blob when it decodes to text from one of its first
    // tokens; the tokens before that, and every token of a run that does not
    // decode, are judged alone.
    let start = i;
    let kind: BlobKind | undefined;
    for (let tries = 0; tries < MAX_SPLIT_STARTS && start < end; tries++) {
      kind = textKind(s, start, end);
      if (kind) break;
      start = nextToken(s, start, end);
    }
    const alone = kind ? start : end;
    for (let k = i; k < alone; k = nextToken(s, k, alone)) judgeRun(s, k, alone, emit);
    if (kind) emit(start, end, kind);
    i = end;
  }
}

// The end of the run of two or more blob-like tokens at i, apart only by ASCII
// whitespace, '=' padding included; i when the token at i is not blob-like or
// stands alone. A token is blob-like when it holds a digit, '+' or '/', or an
// upper-case letter after its first character, or ends in padding, which ends
// the run too.
function splitEnd(s: string, i: number, to: number): number {
  let tokens = 0;
  let end = i;
  let k = i;
  for (;;) {
    let e = k;
    let like = false;
    for (let c; e < to && isBlobChar((c = s.charCodeAt(e))); e++) {
      if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2f || (e > k && c >= 0x41 && c <= 0x5a)) like = true;
    }
    const unpadded = e;
    while (e < to && e - unpadded < 6 && s.charCodeAt(e) === 0x3d) e++; // '=', up to base32's 6
    if (e > unpadded) like = true;
    if (!like) break;
    tokens++;
    end = e;
    if (e > unpadded) break;
    let n = e;
    while (n < to && isTemplateSpace(s.charCodeAt(n))) n++;
    if (n === e || n === to || !isBlobChar(s.charCodeAt(n))) break;
    k = n;
  }
  return tokens >= 2 ? end : i;
}

// The start of the token after the one at k, or end.
function nextToken(s: string, k: number, end: number): number {
  while (k < end && !isTemplateSpace(s.charCodeAt(k))) k++;
  while (k < end && isTemplateSpace(s.charCodeAt(k))) k++;
  return k;
}

// The kind of the blob s[from, to), whitespace skipped, when it decodes to text.
function textKind(s: string, from: number, to: number): BlobKind | undefined {
  if (decodesToText(s, from, to, 6)) return "base64";
  if (isBase32(s, from, to) && decodesToText(s, from, to, 5)) return "base32";
  return undefined;
}

// Whether s[from, to), whitespace skipped and up to its padding, is base32
// digits in one case.
function isBase32(s: string, from: number, to: number): boolean {
  let upper = false;
  let lower = false;
  for (let i = from; i < to; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x3d) break;
    if (isTemplateSpace(c)) continue;
    if (base32Value(c) < 0) return false;
    if (c >= 0x41 && c <= 0x5a) upper = true;
    else if (c >= 0x61) lower = true;
  }
  return !(upper && lower);
}

/**
 * Whether s[from, to), read as base64 (6 bits a digit) or base32 (5) with ASCII
 * whitespace skipped, holds MIN_BLOB or more digits and decodes to UTF-8 text:
 * MIN_PRINTABLE_SHARE of its characters printable. Padding or any other
 * character outside the alphabet ends the data; a broken UTF-8 sequence is one
 * unprintable character. Allocates nothing.
 */
function decodesToText(s: string, from: number, to: number, bits: 5 | 6): boolean {
  let read = 0;
  let acc = 0;
  let held = 0; // bits in acc not yet decoded
  let need = 0; // continuation bytes the current UTF-8 character still needs
  let chars = 0;
  let printable = 0;
  for (let i = from; i < to; i++) {
    const c = s.charCodeAt(i);
    if (isTemplateSpace(c)) continue;
    const v = bits === 6 ? base64Value(c) : base32Value(c);
    if (v < 0) break;
    read++;
    acc = ((acc << bits) | v) & 0x3fff;
    held += bits;
    if (held < 8) continue;
    held -= 8;
    const b = (acc >> held) & 0xff;
    if (need > 0) {
      if ((b & 0xc0) === 0x80) {
        if (--need === 0) {
          chars++;
          printable++;
        }
        continue;
      }
      need = 0;
      chars++; // the broken sequence; b starts afresh
    }
    if (b < 0x80) {
      chars++;
      if ((b >= 0x20 && b < 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d) printable++;
    } else if (b >= 0xc2 && b <= 0xdf) need = 1;
    else if (b >= 0xe0 && b <= 0xef) need = 2;
    else if (b >= 0xf0 && b <= 0xf4) need = 3;
    else chars++;
  }
  return read >= MIN_BLOB && chars > 0 && printable >= chars * MIN_PRINTABLE_SHARE;
}

// Judge the run of blob characters at p, emitting it and any hex sub-run that
// is a blob. Returns the index after the run, past its padding when emitted.
function judgeRun(s: string, p: number, to: number, emit: BlobSink): number {
  let i = p;
  let upper = 0;
  let lowerCase = 0;
  let digits = 0;
  let symbols = 0;
  let switches = 0;
  let prev = -1;
  let allHex = true;
  let hexStart = -1; // the hex sub-run in progress
  let hexDigit = false;
  let hexLetter = false;
  let adjacent = 0; // adjacent pairs with no symbol
  let wordSwitches = 0; // of those, pairs that switch class
  let pairs = 0; // adjacent distinct letters, case folded
  let common = 0; // of those, pairs in COMMON_PAIRS
  let plusSlash = false;
  let dashUnderscore = false;
  let base32 = true; // only base32 digits so far
  for (;;) {
    const c = i < to ? s.charCodeAt(i) : -1;
    const blob = c >= 0 && isBlobChar(c);
    if (!blob || !isHexDigit(c)) {
      // The hex sub-run in progress, if any, ends here.
      if (hexStart >= 0 && i - hexStart >= MIN_BLOB && hexDigit && hexLetter) emit(hexStart, i, "hex");
      hexStart = -1;
    }
    if (!blob) break;
    const cls = c >= 0x41 && c <= 0x5a ? 0 : c >= 0x61 && c <= 0x7a ? 1 : c >= 0x30 && c <= 0x39 ? 2 : 3;
    if (cls === 0) upper++;
    else if (cls === 1) lowerCase++;
    else if (cls === 2) digits++;
    else {
      symbols++;
      if (c === 0x2b || c === 0x2f) plusSlash = true;
      else dashUnderscore = true;
    }
    if (prev >= 0 && cls !== prev) switches++;
    if (prev >= 0 && prev !== 3 && cls !== 3) {
      adjacent++;
      if (cls !== prev) wordSwitches++;
    }
    if (cls < 2 && i > p) {
      const b = s.charCodeAt(i - 1);
      if (isAsciiLetter(b) && (b & 31) !== (c & 31)) {
        pairs++;
        common += COMMON_PAIRS[pairPlace(b, c)]!;
      }
    }
    if (base32Value(c) < 0) base32 = false;
    prev = cls;
    if (isHexDigit(c)) {
      if (hexStart < 0) {
        hexStart = i;
        hexDigit = hexLetter = false;
      }
      if (cls === 2) hexDigit = true;
      else hexLetter = true;
    } else {
      allHex = false;
    }
    i++;
  }
  const len = i - p;
  if (len < MIN_BLOB || allHex) return i;
  const mixedCase = upper > 0 && lowerCase > 0;
  let kind: BlobKind | undefined;
  if (mixedCase && digits > 0 && symbols <= len * MAX_SYMBOL_SHARE && switches >= (len - 1) * MIN_SWITCH_RATE) kind = "base64";
  else if (mixedCase && !(plusSlash && dashUnderscore) && symbols <= len * MAX_RANDOM_SYMBOL_SHARE && (pairs > 0 ? common / pairs : 1) - (adjacent > 0 ? wordSwitches / adjacent : 0) <= MAX_COMMON_OVER_SWITCH) kind = "base64";
  else if (decodesToText(s, p, i, 6)) kind = "base64";
  else if (base32 && !mixedCase && decodesToText(s, p, i, 5)) kind = "base32";
  if (!kind) return i;
  let e = i;
  const padding = kind === "base64" ? 2 : 6;
  while (e < to && e - i < padding && s.charCodeAt(e) === 0x3d) e++; // '='
  emit(p, e, kind);
  return e;
}

// ---- ISC-21: invisible and deceptive characters ----

// Names for the single code points the rule flags. Ranges are named in describe().
const NAMES: ReadonlyMap<number, string> = new Map([
  [0x00ad, "SOFT HYPHEN"],
  [0x034f, "COMBINING GRAPHEME JOINER"],
  [0x0600, "ARABIC NUMBER SIGN"],
  [0x0601, "ARABIC SIGN SANAH"],
  [0x0602, "ARABIC FOOTNOTE MARKER"],
  [0x0603, "ARABIC SIGN SAFHA"],
  [0x0604, "ARABIC SIGN SAMVAT"],
  [0x0605, "ARABIC NUMBER MARK ABOVE"],
  [0x061c, "ARABIC LETTER MARK"],
  [0x06dd, "ARABIC END OF AYAH"],
  [0x070f, "SYRIAC ABBREVIATION MARK"],
  [0x0890, "ARABIC POUND MARK ABOVE"],
  [0x0891, "ARABIC PIASTRE MARK ABOVE"],
  [0x08e2, "ARABIC DISPUTED END OF AYAH"],
  [0x115f, "HANGUL CHOSEONG FILLER"],
  [0x1160, "HANGUL JUNGSEONG FILLER"],
  [0x17b4, "KHMER VOWEL INHERENT AQ"],
  [0x17b5, "KHMER VOWEL INHERENT AA"],
  [0x180b, "MONGOLIAN FREE VARIATION SELECTOR ONE"],
  [0x180c, "MONGOLIAN FREE VARIATION SELECTOR TWO"],
  [0x180d, "MONGOLIAN FREE VARIATION SELECTOR THREE"],
  [0x180e, "MONGOLIAN VOWEL SEPARATOR"],
  [0x180f, "MONGOLIAN FREE VARIATION SELECTOR FOUR"],
  [0x200b, "ZERO WIDTH SPACE"],
  [0x200c, "ZERO WIDTH NON-JOINER"],
  [0x200d, "ZERO WIDTH JOINER"],
  [0x200e, "LEFT-TO-RIGHT MARK"],
  [0x200f, "RIGHT-TO-LEFT MARK"],
  [0x202a, "LEFT-TO-RIGHT EMBEDDING"],
  [0x202b, "RIGHT-TO-LEFT EMBEDDING"],
  [0x202c, "POP DIRECTIONAL FORMATTING"],
  [0x202d, "LEFT-TO-RIGHT OVERRIDE"],
  [0x202e, "RIGHT-TO-LEFT OVERRIDE"],
  [0x2060, "WORD JOINER"],
  [0x2061, "FUNCTION APPLICATION"],
  [0x2062, "INVISIBLE TIMES"],
  [0x2063, "INVISIBLE SEPARATOR"],
  [0x2064, "INVISIBLE PLUS"],
  [0x2066, "LEFT-TO-RIGHT ISOLATE"],
  [0x2067, "RIGHT-TO-LEFT ISOLATE"],
  [0x2068, "FIRST STRONG ISOLATE"],
  [0x2069, "POP DIRECTIONAL ISOLATE"],
  [0x206a, "INHIBIT SYMMETRIC SWAPPING"],
  [0x206b, "ACTIVATE SYMMETRIC SWAPPING"],
  [0x206c, "INHIBIT ARABIC FORM SHAPING"],
  [0x206d, "ACTIVATE ARABIC FORM SHAPING"],
  [0x206e, "NATIONAL DIGIT SHAPES"],
  [0x206f, "NOMINAL DIGIT SHAPES"],
  [0x2800, "BRAILLE PATTERN BLANK"],
  [0x3164, "HANGUL FILLER"],
  [0xfeff, "ZERO WIDTH NO-BREAK SPACE"],
  [0xffa0, "HALFWIDTH HANGUL FILLER"],
  [0xfff9, "INTERLINEAR ANNOTATION ANCHOR"],
  [0xfffa, "INTERLINEAR ANNOTATION SEPARATOR"],
  [0xfffb, "INTERLINEAR ANNOTATION TERMINATOR"],
  [0x110bd, "KAITHI NUMBER SIGN"],
  [0x110cd, "KAITHI NUMBER SIGN ABOVE"],
  [0x13430, "EGYPTIAN HIEROGLYPH VERTICAL JOINER"],
  [0x13431, "EGYPTIAN HIEROGLYPH HORIZONTAL JOINER"],
  [0x13432, "EGYPTIAN HIEROGLYPH INSERT AT TOP START"],
  [0x13433, "EGYPTIAN HIEROGLYPH INSERT AT BOTTOM START"],
  [0x13434, "EGYPTIAN HIEROGLYPH INSERT AT TOP END"],
  [0x13435, "EGYPTIAN HIEROGLYPH INSERT AT BOTTOM END"],
  [0x13436, "EGYPTIAN HIEROGLYPH OVERLAY MIDDLE"],
  [0x13437, "EGYPTIAN HIEROGLYPH BEGIN SEGMENT"],
  [0x13438, "EGYPTIAN HIEROGLYPH END SEGMENT"],
  [0x13439, "EGYPTIAN HIEROGLYPH INSERT AT MIDDLE"],
  [0x1343a, "EGYPTIAN HIEROGLYPH INSERT AT TOP"],
  [0x1343b, "EGYPTIAN HIEROGLYPH INSERT AT BOTTOM"],
  [0x1343c, "EGYPTIAN HIEROGLYPH BEGIN ENCLOSURE"],
  [0x1343d, "EGYPTIAN HIEROGLYPH END ENCLOSURE"],
  [0x1343e, "EGYPTIAN HIEROGLYPH BEGIN WALLED ENCLOSURE"],
  [0x1343f, "EGYPTIAN HIEROGLYPH END WALLED ENCLOSURE"],
  [0x1bca0, "SHORTHAND FORMAT LETTER OVERLAP"],
  [0x1bca1, "SHORTHAND FORMAT CONTINUING OVERLAP"],
  [0x1bca2, "SHORTHAND FORMAT DOWN STEP"],
  [0x1bca3, "SHORTHAND FORMAT UP STEP"],
  [0xe0001, "LANGUAGE TAG"],
  [0xe007f, "CANCEL TAG"],
]);

/**
 * True for a code point the rule flags. ISC-21 names zero-width characters
 * (U+200B to U+200D, U+FEFF), bidi embeddings, overrides and isolates (U+202A
 * to U+202E, U+2066 to U+2069), tag characters (U+E0000 to U+E007F), variation
 * selectors (U+FE00 to U+FE0F, U+E0100 to U+E01EF), U+00AD and U+2060 to
 * U+2064. The rest of Unicode's Default_Ignorable_Code_Point set is just as
 * invisible, so it is here too: bidi marks, Hangul fillers, Mongolian and
 * Khmer format characters, the deprecated U+206A to U+206F controls and the
 * unassigned ignorables. So is every other format character (category Cf):
 * the Arabic, Syriac and Kaithi number and ayah signs, the Egyptian hieroglyph
 * format controls, and the interlinear annotation characters, which hide the
 * text between them. So are U+2800 BRAILLE PATTERN BLANK, which renders as a
 * space but is no whitespace to a tokenizer or a filter, and C0 and C1
 * controls other than tab, line feed and carriage return, which hide text in
 * a terminal. A test holds this to the engine's own \p{Cf}.
 */
export function isInvisible(cp: number): boolean {
  if (cp < 0xa0) return (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || cp >= 0x7f;
  if (cp < 0x2000) return NAMES.has(cp);
  if (cp <= 0x206f) return (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || cp >= 0x2060;
  if (cp < 0xfe00) return cp === 0x2800 || cp === 0x3164;
  if (cp <= 0xfe0f) return true;
  if (cp < 0x10000) return cp === 0xfeff || cp === 0xffa0 || (cp >= 0xfff0 && cp <= 0xfffb);
  return NAMES.has(cp) || (cp >= 0x1d173 && cp <= 0x1d17a) || (cp >= 0xe0000 && cp <= 0xe0fff);
}

/** A code point's name for a finding message: `U+200B ZERO WIDTH SPACE`. */
export function describe(cp: number): string {
  const hex = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
  const name =
    NAMES.get(cp) ??
    (cp >= 0xfe00 && cp <= 0xfe0f
      ? `VARIATION SELECTOR-${cp - 0xfe00 + 1}`
      : cp >= 0xe0100 && cp <= 0xe01ef
        ? `VARIATION SELECTOR-${cp - 0xe0100 + 17}`
        : cp >= 0xe0020 && cp <= 0xe007e
          ? `TAG ${JSON.stringify(String.fromCharCode(cp - 0xe0000))}`
          : cp < 0xa0
            ? "CONTROL CHARACTER"
            : cp >= 0x1d173 && cp <= 0x1d17a
              ? "MUSICAL SYMBOL FORMAT CONTROL"
              : "DEFAULT IGNORABLE (UNASSIGNED)");
  return `${hex} ${name}`;
}

// The code point at s[i] when it is flagged, else -1; an astral one is two
// units long. A number, not an object, so a run of millions allocates nothing.
// Printable ASCII, the bulk of every template, leaves on the first test.
function invisibleAt(s: string, i: number): number {
  const c = s.charCodeAt(i);
  if (c >= 0x20 && c < 0x7f) return -1;
  if (c >= 0xd800 && c <= 0xdbff) {
    const d = s.charCodeAt(i + 1);
    if (d >= 0xdc00 && d <= 0xdfff) {
      const cp = ((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000;
      return isInvisible(cp) ? cp : -1;
    }
    return -1;
  }
  return isInvisible(c) ? c : -1;
}

// How many distinct code points a run's message and detail name; a run is one
// finding however long it is, so its description is bounded too.
const MAX_NAMED = 8;
const MAX_LISTED = 64;

// Builds the description of one run of flagged code points as it is walked.
class RunInfo {
  readonly distinct: number[] = [];
  private readonly seen = new Set<number>();
  count = 0;
  hidden = ""; // ASCII spelled by tag characters (U+E0020 to U+E007E), clipped
  add(cp: number): void {
    this.count++;
    if (!this.seen.has(cp) && this.seen.size < MAX_LISTED) {
      this.seen.add(cp);
      this.distinct.push(cp);
    }
    if (cp >= 0xe0020 && cp <= 0xe007e && this.hidden.length <= 200) this.hidden += String.fromCharCode(cp - 0xe0000);
  }
  hit(start: number, end: number, what: string): Hit {
    const named = this.distinct.slice(0, MAX_NAMED).map(describe).join(", ");
    const more = this.distinct.length > MAX_NAMED ? ` and ${this.distinct.length - MAX_NAMED}${this.distinct.length === MAX_LISTED ? "+" : ""} more` : "";
    const spelled = this.hidden ? `; the tag characters spell '${clip(this.hidden)}'` : "";
    const detail: Record<string, unknown> = { count: this.count, codePoints: this.distinct.map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`) };
    if (this.hidden) detail.hidden = clip(this.hidden);
    return { start, end, message: `${what} of ${this.count} invisible character${this.count === 1 ? "" : "s"}: ${named}${more}${spelled}`, detail };
  }
}

// Every run of flagged code points in the whole text, tags and comments included.
function scanInvisible(s: string, hits: Hits): void {
  const n = s.length;
  let i = 0;
  while (i < n) {
    let cp = invisibleAt(s, i);
    if (cp < 0) {
      i++;
      continue;
    }
    const start = i;
    const run = hits.take() ? new RunInfo() : undefined;
    while (cp >= 0) {
      run?.add(cp);
      i += cp > 0xffff ? 2 : 1;
      cp = i < n ? invisibleAt(s, i) : -1;
    }
    if (run) hits.kept.push({ ...run.hit(start, i, "run"), excerpt: s.slice(start, i) });
  }
}

// ---- jinja2 string escapes ----

// Escape names that \N{...} resolves to a flagged code point: the NAMES table,
// the variation selectors and the Unicode name aliases Python accepts. Python
// matches a name case-insensitively and nothing else: no trimming, no folding
// of spaces.
const NAMED_ESCAPES: FoldedSet = (() => {
  const m = new Map<string, number>();
  for (const [cp, name] of NAMES) m.set(name, cp);
  for (let k = 0; k < 16; k++) m.set(`VARIATION SELECTOR-${k + 1}`, 0xfe00 + k);
  for (let k = 0; k < 240; k++) m.set(`VARIATION SELECTOR-${k + 17}`, 0xe0100 + k);
  for (let k = 0; k < 256; k++) m.set(`VS${k + 1}`, k < 16 ? 0xfe00 + k : 0xe0100 + k - 16);
  const aliases: [string, number][] = [
    ["SHY", 0xad], ["CGJ", 0x34f], ["ALM", 0x61c], ["FVS1", 0x180b], ["FVS2", 0x180c], ["FVS3", 0x180d], ["MVS", 0x180e], ["FVS4", 0x180f],
    ["ZWSP", 0x200b], ["ZWNJ", 0x200c], ["ZWJ", 0x200d], ["LRM", 0x200e], ["RLM", 0x200f], ["LRE", 0x202a], ["RLE", 0x202b],
    ["PDF", 0x202c], ["LRO", 0x202d], ["RLO", 0x202e], ["WJ", 0x2060], ["LRI", 0x2066], ["RLI", 0x2067], ["FSI", 0x2068],
    ["PDI", 0x2069], ["ZWNBSP", 0xfeff], ["BOM", 0xfeff], ["BYTE ORDER MARK", 0xfeff],
  ];
  for (const [a, cp] of aliases) m.set(a, cp);
  return new FoldedSet([...m].map(([name, cp]) => [name.toLowerCase(), cp]));
})();

// An escape packed in one number: its code point in the low 21 bits, its length
// in code units above them, 0 for none. A number, not an object, so a string of
// millions of escapes allocates nothing.
const CP_BITS = 0x200000;
const escape = (cp: number, len: number) => len * CP_BITS + cp;
const escapeCp = (e: number) => e % CP_BITS;
const escapeLen = (e: number) => Math.floor(e / CP_BITS);

function hexValue(d: number): number {
  return d <= 0x39 ? d - 0x30 : (d | 0x20) - 0x57;
}

// The escape starting at the backslash s[i] when it renders a flagged code
// point, packed as above, else 0. jinja2 decodes string literals with Python's
// unicode_escape codec: \xHH, \uHHHH, \UHHHHHHHH, \N{name} and up to three octal
// digits.
function escapeAt(s: string, i: number, to: number): number {
  const kind = s.charCodeAt(i + 1);
  const hexDigits = kind === 0x78 ? 2 : kind === 0x75 ? 4 : kind === 0x55 ? 8 : 0; // x u U
  if (hexDigits) {
    if (i + 2 + hexDigits > to) return 0;
    let cp = 0;
    for (let k = 0; k < hexDigits; k++) {
      const d = s.charCodeAt(i + 2 + k);
      if (!isHexDigit(d)) return 0;
      cp = cp * 16 + hexValue(d);
    }
    return cp <= 0x10ffff && isInvisible(cp) ? escape(cp, 2 + hexDigits) : 0;
  }
  if (kind === 0x4e && s.charCodeAt(i + 2) === 0x7b) {
    // \N{name}: names are case-insensitive, and no real one is longer than 96.
    const limit = Math.min(to, i + 3 + 97);
    let close = i + 3;
    while (close < limit && s.charCodeAt(close) !== 0x7d) close++;
    if (close >= limit) return 0;
    const cp = namedEscape(s, i + 3, close);
    return cp ? escape(cp, close + 1 - i) : 0;
  }
  // The control-character escapes both engines accept: \b, \f and \v, plus
  // jinja2's \a. A backspace rendered into a prompt overwrites what came before
  // it on a terminal.
  const control = kind === 0x62 ? 0x08 : kind === 0x66 ? 0x0c : kind === 0x76 ? 0x0b : kind === 0x61 ? 0x07 : -1;
  if (control >= 0) return escape(control, 2);
  if (kind >= 0x30 && kind <= 0x37) {
    let cp = 0;
    let k = i + 1;
    while (k < to && k < i + 4 && s.charCodeAt(k) >= 0x30 && s.charCodeAt(k) <= 0x37) cp = cp * 8 + (s.charCodeAt(k++) - 0x30);
    return isInvisible(cp) ? escape(cp, k - i) : 0;
  }
  return 0;
}

// The flagged code point the name s[k, e) resolves to, else 0.
function namedEscape(s: string, k: number, e: number): number {
  const cp = NAMED_ESCAPES.get(s, k, e);
  if (cp) return cp;
  // TAG LATIN SMALL LETTER A, TAG DIGIT ZERO, TAG SPACE, ...: every one is a tag character.
  const tag = e - k > 4 && (s.charCodeAt(k) | 0x20) === 0x74 && (s.charCodeAt(k + 1) | 0x20) === 0x61 && (s.charCodeAt(k + 2) | 0x20) === 0x67 && s.charCodeAt(k + 3) === 0x20;
  return tag ? 0xe0000 : 0;
}

// Every run of escapes in a string literal's interior s[from, to) that render
// flagged code points. A backslash pair that is anything else is skipped whole,
// so `\\u200b` is an escaped backslash followed by text.
function scanEscapes(s: string, from: number, to: number, hits: Hits): void {
  let i = from;
  while (i < to) {
    if (s.charCodeAt(i) !== 0x5c) {
      i++;
      continue;
    }
    let at = escapeAt(s, i, to);
    if (!at) {
      i += 2;
      continue;
    }
    const start = i;
    const run = hits.take() ? new RunInfo() : undefined;
    while (at) {
      run?.add(escapeCp(at));
      i += escapeLen(at);
      at = i < to && s.charCodeAt(i) === 0x5c ? escapeAt(s, i, to) : 0;
    }
    if (run) hits.kept.push({ ...run.hit(start, i, "string escapes render a run"), excerpt: s.slice(start, i) });
  }
}
