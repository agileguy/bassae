// Text rules that need no AST: URLs, emails and domains in injected text
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

import type { Finding, FindingBase, InjectedText, RuleId, Severity, Span } from "../types.ts";
import type { ParseOutcome } from "../parse/parse.ts";
import { isJsWhitespace } from "../parse/parse.ts";
import { clip, FINDING_CAP } from "./finalize.ts";
import { eachLiteral } from "./literals.ts";
import { IncrementalPos } from "./rawtext.ts";
import { KNOWN_TLDS, MAX_TLD_LENGTH } from "./tlds.ts";

/** HIGH url_in_text for each URL, email address or known-TLD domain in injected text, spanned at the literal it sits in (ISC-19). */
export function findUrls(items: readonly InjectedText[], base: FindingBase): Finding[] {
  const hits = new Hits();
  for (const item of items) {
    scanUrls(item.text, 0, item.text.length, (start, end, kind) => {
      if (!hits.take()) return;
      const match = item.text.slice(start, end);
      hits.kept.push({ start: item.span.start, end: item.span.end, span: item.span, message: `injected text contains ${URL_KIND[kind]} '${clip(match)}'`, excerpt: match, detail: { kind, match: clip(match) } });
    });
  }
  return finish("url_in_text", "HIGH", base, [hits], (s, e) => ({ start: s, end: e, line: 1, col: 1 }));
}

/** MEDIUM encoded_blob for each base64-like or hex-like run of 32+ characters in a template literal: text between tags and string literals inside them (ISC-20). */
export function findEncodedBlobs(outcome: ParseOutcome, text: string, base: FindingBase): Finding[] {
  const hits = new Hits();
  eachLiteral(outcome, text, (kind, from, to) => {
    scanBlobs(text, from, to, (start, end, blob) => {
      if (!hits.take()) return;
      const where = kind === "text" ? "template text" : "a string literal";
      hits.kept.push({ start, end, message: `${blob === "hex" ? "hex-like" : "base64-like"} run of ${end - start} characters in ${where}`, excerpt: text.slice(start, end), detail: { encoding: blob, length: end - start } });
    });
  });
  return finish("encoded_blob", "MEDIUM", base, [hits], placer(outcome, text));
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

/** The raw-text form of ISC-19 for a template with no AST (ISC-12): URLs, emails and domains in text between tags and in string literals, streamed when the template is over the size cap. */
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

// ---- ISC-19: URLs, email addresses and domains ----

// A set of lowercase ASCII keys, each with a nonzero value, looked up in
// s[k, e) with A-Z folded to lower case and no slice. The URL scanner looks up
// every label of every dotted run, and the escape scan every \N{name}; on a
// hostile 64 MiB template a slice per lookup is tens of millions of strings,
// hundreds of MB of garbage before a collection.
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
}

export type UrlKind = "url" | "email" | "domain";

const URL_KIND: Record<UrlKind, string> = { url: "URL", email: "email address", domain: "domain" };

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

// Every known TLD, 2 for one that is also a file extension, 1 for the rest.
const TLD = 1;
const FILE_EXTENSION_TLD = 2;
const TLDS = new FoldedSet([...KNOWN_TLDS].map((t) => [t, FILE_EXTENSION_TLDS.has(t) ? FILE_EXTENSION_TLD : TLD]));

function isAlnum(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

function isLetter(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

// '.', and the ideographic, fullwidth and halfwidth full stops IDNA maps to it,
// so `evil\u3002com` is the domain a browser and a model both read.
function isDot(c: number): boolean {
  return c === 0x2e || c === 0x3002 || c === 0xff0e || c === 0xff61;
}

// A run the scanner splits into labels: letters, digits, '-', '_' and dots. '_'
// is kept in the run so a label holding one can mark it as code.
function isRunChar(c: number): boolean {
  return isAlnum(c) || c === 0x2d || c === 0x5f || isDot(c);
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

/** Every URL (with a scheme, or `www.`), email address and known-TLD domain in s[from, to), in order. One forward pass. */
export function scanUrls(s: string, from: number, to: number, emit: UrlSink): void {
  // One chain for every run, reset after each, so a run costs no allocation.
  const ch: Chain = { start: -1, firstEnd: -1, labels: 0, lastEnd: -1, prevStart: -1, tldStart: -1, tldEnd: -1, sldStart: -1, resume: from };
  let i = from;
  while (i < to) {
    if (!isRunChar(s.charCodeAt(i))) {
      i++;
      continue;
    }
    const p = i;
    while (i < to && isRunChar(s.charCodeAt(i))) i++;
    const q = i;
    // scheme://…
    if (q + 2 < to && s.charCodeAt(q) === 0x3a && s.charCodeAt(q + 1) === 0x2f && s.charCodeAt(q + 2) === 0x2f) {
      const st = schemeStart(s, p, q);
      if (st >= 0) {
        const end = urlEnd(s, q + 3, to);
        emit(st, end, "url");
        i = end;
        continue;
      }
    }
    // local@domain
    if (q < to && s.charCodeAt(q) === 0x40) {
      const e = emailDomainEnd(s, q + 1, to);
      const st = Math.max(p, q - 64);
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
  while (k > p && q - k < 32) {
    const c = s.charCodeAt(k - 1);
    if (!isAlnum(c) && c !== 0x2b && c !== 0x2d && c !== 0x2e) break;
    k--;
  }
  while (k < q && !isLetter(s.charCodeAt(k))) k++;
  return k < q ? k : -1;
}

// The end of a URL body starting at `j`, without the punctuation that ends a sentence.
function urlEnd(s: string, j: number, to: number): number {
  const start = j;
  while (j < to && isUrlChar(s.charCodeAt(j))) j++;
  while (j > start && isTrailingPunct(s.charCodeAt(j - 1))) j--;
  return j;
}

// The end of the domain after an '@' at d - 1, or -1 when what follows is not a
// dotted name ending in an alphabetic (or xn--) label.
function emailDomainEnd(s: string, d: number, to: number): number {
  let e = d;
  while (e < to) {
    const c = s.charCodeAt(e);
    if (!isAlnum(c) && c !== 0x2d && !isDot(c)) break;
    e++;
  }
  while (e > d && (isDot(s.charCodeAt(e - 1)) || s.charCodeAt(e - 1) === 0x2d)) e--;
  let labels = 0;
  let k = d;
  let lastStart = d;
  while (k < e) {
    let j = k;
    while (j < e && !isDot(s.charCodeAt(j))) j++;
    if (j === k || j - k > 63) return -1;
    labels++;
    lastStart = k;
    k = j + 1;
  }
  if (labels < 2) return -1;
  return isTopLabel(s, lastStart, e) ? e : -1;
}

// An alphabetic label of 2 to 63 letters, or an IDN `xn--` label.
function isTopLabel(s: string, k: number, e: number): boolean {
  if (e - k < 2 || e - k > 63) return false;
  if (e - k > 4 && s.slice(k, k + 4).toLowerCase() === "xn--") return true;
  for (let j = k; j < e; j++) if (!isLetter(s.charCodeAt(j))) return false;
  return true;
}

function isKnownTld(s: string, k: number, e: number): boolean {
  return e - k >= 2 && e - k <= MAX_TLD_LENGTH && TLDS.get(s, k, e) !== 0;
}

function isWww(s: string, k: number, e: number): boolean {
  return e - k === 3 && (s.charCodeAt(k) | 0x20) === 0x77 && (s.charCodeAt(k + 1) | 0x20) === 0x77 && (s.charCodeAt(k + 2) | 0x20) === 0x77;
}

// A chain of valid labels inside one run, as scanHosts walks it.
interface Chain {
  start: number; //    first label's start
  firstEnd: number; // first label's end
  labels: number; //   labels so far
  lastEnd: number; //  last label's end
  prevStart: number; // start of the label before the last
  tldStart: number; // the last known-TLD label at position 2 or later, or -1
  tldEnd: number;
  sldStart: number; // the label before that TLD
  resume: number; //   where the scan goes on: past a `www.` URL path, else the run end
}

// The `www.` hosts and known-TLD domains in the run s[p, q). The run splits at
// dots into labels; a chain is a maximal sequence of valid labels. An empty,
// over-long or underscored label (`tool_call.name`) is code, not a host, so the
// chain restarts after it. In a chain, the domain runs to the last label that
// is a known TLD: `evil.com.Then` is `evil.com`. Returns where the scan goes
// on, past the path of a `www.` URL that ends the run so the path is not
// rescanned (`www.a.com/` repeated would be quadratic).
function scanHosts(s: string, p: number, q: number, to: number, ch: Chain, emit: UrlSink): number {
  ch.resume = q;
  let k = p;
  while (k < q) {
    let e = k;
    let underscore = false;
    while (e < q && !isDot(s.charCodeAt(e))) {
      if (s.charCodeAt(e) === 0x5f) underscore = true;
      e++;
    }
    // A chain's first label may carry leading hyphens (`--evil.com`); drop them.
    let ks = k;
    if (ch.labels === 0) while (ks < e && s.charCodeAt(ks) === 0x2d) ks++;
    const len = e - ks;
    if (len < 1 || len > 63 || underscore || s.charCodeAt(ks) === 0x2d || s.charCodeAt(e - 1) === 0x2d) {
      emitChain(s, ch, q, to, emit);
    } else {
      if (ch.labels === 0) {
        ch.start = ks;
        ch.firstEnd = e;
      }
      ch.labels++;
      if (ch.labels >= 2 && isKnownTld(s, ks, e)) {
        ch.tldStart = ks;
        ch.tldEnd = e;
        ch.sldStart = ch.prevStart;
      }
      ch.prevStart = ks;
      ch.lastEnd = e;
    }
    k = e + 1; // past the dot
  }
  emitChain(s, ch, q, to, emit);
  return ch.resume;
}

// Report a finished chain, then reset it for the next one.
function emitChain(s: string, ch: Chain, q: number, to: number, emit: UrlSink): void {
  if (ch.labels > 0) {
    const www = isWww(s, ch.start, ch.firstEnd);
    if (www && ch.labels === 1 && ch.lastEnd < q && isDot(s.charCodeAt(ch.lastEnd))) {
      emit(ch.start, ch.lastEnd + 1, "url"); // a bare `www.` that a template builds a URL on
    } else if (www && ch.labels >= 2) {
      const end = ch.lastEnd === q ? urlEnd(s, q, to) : ch.lastEnd;
      emit(ch.start, end, "url");
      if (end > ch.resume) ch.resume = end;
    } else if (ch.tldEnd > 0 && isHost(s, ch, q, to)) {
      emit(ch.start, ch.tldEnd, "domain");
    }
  }
  ch.start = ch.firstEnd = ch.lastEnd = ch.prevStart = ch.tldStart = ch.tldEnd = ch.sldStart = -1;
  ch.labels = 0;
}

// Whether a chain ending in a known TLD is a host, not something shaped like
// one. Three shapes are not: a method call or subscript (`re.search(`); a file
// name under a TLD that is also a file extension (`config.py`), unless a path,
// a port or a registry second-level label says it is a host; and a number
// before a capitalized word (`1.Do`, `3.5.It`), which is a list item or a
// missing space.
function isHost(s: string, ch: Chain, q: number, to: number): boolean {
  const next = ch.tldEnd < to ? s.charCodeAt(ch.tldEnd) : -1;
  if (ch.tldEnd === q && (next === 0x28 || next === 0x5b)) return false; // '(' '['
  if (TLDS.get(s, ch.tldStart, ch.tldEnd) === FILE_EXTENSION_TLD) {
    const sld = ch.sldStart >= 0 && SECOND_LEVEL.get(s, ch.sldStart, ch.tldStart - 1) !== 0;
    const pathOrPort = ch.tldEnd === q && (next === 0x2f || (next === 0x3a && ch.tldEnd + 1 < to && isAlnum(s.charCodeAt(ch.tldEnd + 1))));
    if (!sld && !pathOrPort) return false;
  }
  const c = s.charCodeAt(ch.tldStart);
  if (c >= 0x41 && c <= 0x5a) {
    let numeric = true;
    for (let j = ch.start; j < ch.tldStart && numeric; j++) {
      const d = s.charCodeAt(j);
      if (!(d >= 0x30 && d <= 0x39) && !isDot(d)) numeric = false;
    }
    if (numeric) return false;
  }
  return true;
}

// ---- ISC-20: encoded blobs ----

export type BlobKind = "base64" | "hex";

/** Receives one blob [start, end) in the scanned string. */
export type BlobSink = (start: number, end: number, kind: BlobKind) => void;

// The shortest run that counts as a blob (ISC-20).
const MIN_BLOB = 32;

// A base64-like run switches between upper case, lower case, digits and symbols
// at about 0.64 of its adjacent pairs; prose identifiers in camelCase or
// TitleCase switch only at word boundaries, about 0.35. The cut sits between.
const MIN_SWITCH_RATE = 0.45;

// Base64 has at most 2 symbols ('+/' or '-_') in 64; paths, snake_case and
// kebab-case have one every few characters. A run with more than one in 8 is
// not a blob.
const MAX_SYMBOL_SHARE = 1 / 8;

function isBlobChar(c: number): boolean {
  return isAlnum(c) || c === 0x2b || c === 0x2f || c === 0x5f || c === 0x2d; // '+' '/' '_' '-'
}

function isHexDigit(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
}

/**
 * Every base64-like and hex-like run of MIN_BLOB or more characters in
 * s[from, to), in order. One forward pass. A base64-like run mixes upper case,
 * lower case and digits, switches class often and holds few symbols; trailing
 * '=' padding is part of it. A hex-like run is hex digits only, with at least
 * one digit and one letter. English words, snake_case, camelCase, paths and
 * separator lines like `====` or `----` are neither.
 */
export function scanBlobs(s: string, from: number, to: number, emit: BlobSink): void {
  let i = from;
  while (i < to) {
    if (!isBlobChar(s.charCodeAt(i))) {
      i++;
      continue;
    }
    const p = i;
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
      else symbols++;
      if (prev >= 0 && cls !== prev) switches++;
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
    if (len >= MIN_BLOB && !allHex && upper > 0 && lowerCase > 0 && digits > 0 && symbols <= len * MAX_SYMBOL_SHARE && switches >= (len - 1) * MIN_SWITCH_RATE) {
      let e = i;
      while (e < to && e - i < 2 && s.charCodeAt(e) === 0x3d) e++; // '=' padding
      emit(p, e, "base64");
      i = e;
    }
  }
}

// ---- ISC-21: invisible and deceptive characters ----

// Names for the single code points the rule flags. Ranges are named in describe().
const NAMES: ReadonlyMap<number, string> = new Map([
  [0x00ad, "SOFT HYPHEN"],
  [0x034f, "COMBINING GRAPHEME JOINER"],
  [0x061c, "ARABIC LETTER MARK"],
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
  [0x3164, "HANGUL FILLER"],
  [0xfeff, "ZERO WIDTH NO-BREAK SPACE"],
  [0xffa0, "HALFWIDTH HANGUL FILLER"],
  [0xfff9, "INTERLINEAR ANNOTATION ANCHOR"],
  [0xfffa, "INTERLINEAR ANNOTATION SEPARATOR"],
  [0xfffb, "INTERLINEAR ANNOTATION TERMINATOR"],
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
 * unassigned ignorables. So are the interlinear annotation characters, which
 * hide the text between them, and C0 and C1 controls other than tab, line
 * feed and carriage return, which hide text in a terminal.
 */
export function isInvisible(cp: number): boolean {
  if (cp < 0xa0) return (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || cp >= 0x7f;
  if (cp < 0x2000) return NAMES.has(cp);
  if (cp <= 0x206f) return (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || cp >= 0x2060;
  if (cp < 0xfe00) return cp === 0x3164;
  if (cp <= 0xfe0f) return true;
  if (cp < 0x10000) return cp === 0xfeff || cp === 0xffa0 || (cp >= 0xfff0 && cp <= 0xfffb);
  return (cp >= 0x1bca0 && cp <= 0x1bca3) || (cp >= 0x1d173 && cp <= 0x1d17a) || (cp >= 0xe0000 && cp <= 0xe0fff);
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
