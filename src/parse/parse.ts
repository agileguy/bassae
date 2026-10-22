// Parse a template with @huggingface/jinja and pair its AST with spans from the
// pre-lexer. This is the single door the code-execution rules go through; it
// never renders anything.

import { Template } from "@huggingface/jinja";
import type { Span } from "../types.ts";
import { preLex, type PreLexResult, type PreToken } from "./prelexer.ts";
import {
  BARE_ENGINE_GLOBALS,
  BENIGN_UNIMPLEMENTED_FILTERS,
  correlateSpans,
  DANGEROUS_FILTERS,
  foldLiteral,
  IMPLEMENTED_TESTS,
  JINJA2_BUILTIN_FILTERS,
  JINJA2_BUILTIN_TESTS,
  LineMap,
  type Node,
  sourceOrderLeaves,
} from "./support.ts";

// Templates longer than this (in UTF-16 code units) are not parsed in-process.
// The HF reader accepts up to 64 MiB per file; building a full token array and
// line map over that costs multiple GB, and the library's preprocess step is
// superlinear besides. Real templates are ~18KB. Over the cap we build nothing
// large and fail closed to incomplete, letting the streaming raw-text fallback
// scan the interiors (round-2 memory review).
const MAX_PARSE_UNITS = 512 * 1024;

// Shape caps checked linearly BEFORE the library parser runs, so the result is
// decided by integer token counts that are identical on every platform (ISC-31)
// — never by whether a given machine's stack survives a hostile nesting depth.
// The corpus maxima are 37 / 35 / 3 / 10, so these leave wide headroom and never
// trip a stock template. Over any of them: HIGH unanalyzable, no parse. The
// whitespace cap is 512 (corpus max run 37): the library's preprocess step is
// superlinear on long runs, so a lower cap keeps a pathological run cheap (N2).
const MAX_WHITESPACE_RUN = 512;
const MAX_TAG_TOKENS = 2048;
const MAX_BRACKET_DEPTH = 100;
const MAX_BLOCK_DEPTH = 128;

export interface UnsupportedConstruct {
  kind: "statement" | "filter" | "test" | "global" | "operator" | "method";
  name: string;
  /** HIGH for exec gadgets and unparseable constructs, MEDIUM for benign data filters. */
  severity: "HIGH" | "MEDIUM";
  /** Which use of `name` is unsupported, when the library implements other uses of it. */
  form?: string;
  /** Why it is flagged, when that is not "the library lacks it". */
  reason?: string;
  span?: Span;
}

const NOT_BUILTIN = "is not a jinja2 builtin";

export interface ParseOutcome {
  /** The pre-lexer result. Absent when the input was over the size cap (ISC-31, round-2 memory review). */
  pre?: PreLexResult;
  /** The line map. Absent when the input was over the size cap. */
  lines?: LineMap;
  /** The parsed program, when the library accepted it. */
  program?: Node;
  /** Spans for every identifier and string node, keyed by the node object. */
  spans: Map<Node, Span>;
  /** Set when parsing failed (ISC-12). */
  parseError?: string;
  /** Constructs the library does not implement (ISC-12.1). */
  unsupported: UnsupportedConstruct[];
  /** True when the input was too large/hostile to parse safely. */
  tooLarge: boolean;
  /**
   * Where a size or shape cap tripped (M5, ISC-26.1): the whitespace run itself,
   * the token that took block or bracket depth over its limit, the whole tag that
   * passed the token limit, or offset 0 with length 0 for the whole template.
   */
  capAt?: Span;
  /** True when the input was over the size cap, so no pre-lexer or line map was built; the raw-text fallback streams instead. */
  oversized?: boolean;
}

export function parseTemplate(text: string): ParseOutcome {
  // Round-2 memory review — decide the size cap on the raw text BEFORE building any token
  // array or line map, so a 64 MiB input is answered in O(n) time and a few
  // hundred MB, not multiple GB. Over the cap we build nothing large; the
  // streaming raw-text fallback (rules/index.ts) scans the interiors with
  // incremental spans.
  if (text.length > MAX_PARSE_UNITS) {
    const capAt = { start: 0, end: 0, line: 1, col: 1 }; // the whole template; no line map is built
    return { spans: new Map(), unsupported: [], tooLarge: true, oversized: true, parseError: "template exceeds the in-process parse budget", capAt };
  }

  // Below the size cap the text is at most ~1 MB, so the pre-lexer and line map
  // are cheap. The whitespace run must count every Unicode space the library's
  // `\s` preprocess regex matches, or a run of U+00A0/U+3000 slips past (M6).
  const ws = whitespaceRuns(text);
  if (ws.max > MAX_WHITESPACE_RUN) {
    const pre = preLex(text);
    const lines = new LineMap(text);
    const capAt = lines.span(ws.runStart, ws.runEnd);
    return { pre, lines, spans: new Map(), unsupported: [], tooLarge: true, parseError: `whitespace run of ${ws.max} exceeds the parse limit`, capAt };
  }

  const pre = preLex(text);
  const lines = new LineMap(text);
  const shape = preParseLimit(pre.tokens);
  if (shape) {
    const capAt = lines.span(shape.at.start, shape.at.end);
    return { pre, lines, spans: new Map(), unsupported: [], tooLarge: true, parseError: shape.reason, capAt };
  }

  let program: Node | undefined;
  let parseError: string | undefined;
  try {
    program = new Template(text).parsed as unknown as Node;
  } catch (e) {
    parseError = e instanceof Error ? e.message : String(e);
  }

  const spans = program ? correlateSpans(sourceOrderLeaves(program), pre.tokens, lines) : new Map<Node, Span>();
  const unsupported = program ? findUnsupported(program, spans) : [];
  return { pre, lines, program, spans, parseError, unsupported, tooLarge: false };
}

// Whitespace is exactly what JavaScript's `/\s/` matches — the same class the
// library's preprocess step uses (M6). All of these are in the BMP, so
// charCodeAt is enough.
export function isJsWhitespace(c: number): boolean {
  return (
    c === 0x20 ||
    (c >= 0x09 && c <= 0x0d) ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

// Longest run of whitespace anywhere in the text (code units), and the bounds of
// the first run longer than MAX_WHITESPACE_RUN, or -1 when there is none (M5).
function whitespaceRuns(text: string): { max: number; runStart: number; runEnd: number } {
  let max = 0;
  let run = 0;
  let runStart = -1;
  let runEnd = -1;
  for (let i = 0; i < text.length; i++) {
    if (isJsWhitespace(text.charCodeAt(i))) {
      if (++run > max) max = run;
      if (run === MAX_WHITESPACE_RUN + 1 && runStart < 0) runStart = i - MAX_WHITESPACE_RUN;
    } else {
      if (runStart >= 0 && runEnd < 0) runEnd = i;
      run = 0;
    }
  }
  if (runStart >= 0 && runEnd < 0) runEnd = text.length;
  return { max, runStart, runEnd };
}

// Decide, in one linear pass over the pre-lexer tokens, whether the template's
// shape is beyond what we will hand to the recursive-descent library parser.
// Returns the reason and where the cap tripped (M5) when one is exceeded, else
// undefined. The result is a platform-independent integer count, never a
// function of the host's stack (ISC-31): an `elif` deepens the open `if` (the
// parser nests it), a `{% set %}` with no top-level `=` is a block closed by
// `endset`, and each `end*` releases the whole amount its opener added (M8).
function preParseLimit(tokens: PreToken[]): { reason: string; at: { start: number; end: number } } | undefined {
  let tagTokens = 0;
  let bracket = 0;
  const blockStack: number[] = []; // depth each open block contributes (1, or 1 + elifs for an `if`)
  let block = 0; // current nesting depth = sum of blockStack
  let expectBlockKeyword = false; // the identifier right after `{%`
  let pendingSet: PreToken | undefined; // the `set` keyword this tag opened with
  let setHasEquals = false; // a top-level `=` was seen in the pending set
  const TOO_DEEP = `block nesting deeper than ${MAX_BLOCK_DEPTH}`;
  let opener: PreToken | undefined; // the `{{` or `{%` of the current tag
  // The whole tag holding token i: its opener to its closer, or to its last token when unclosed.
  const tagAt = (i: number): { start: number; end: number } => {
    let j = i;
    while (j + 1 < tokens.length && tokens[j + 1]!.inTag) j++;
    const close = tokens[j + 1]?.type === "close" ? tokens[j + 1]! : tokens[j]!;
    return { start: opener?.start ?? tokens[i]!.start, end: close.end };
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type === "open") {
      opener = t;
      tagTokens = 0;
      bracket = 0;
      expectBlockKeyword = t.value.startsWith("{%");
      pendingSet = undefined;
      setHasEquals = false;
      continue;
    }
    if (t.type === "close") {
      // A `{% set x %}` with no top-level `=` is a block closed by `endset`.
      if (pendingSet && !setHasEquals) {
        blockStack.push(1);
        if (++block > MAX_BLOCK_DEPTH) return { reason: TOO_DEEP, at: pendingSet };
      }
      continue;
    }
    if (!t.inTag) continue;
    if (++tagTokens > MAX_TAG_TOKENS) return { reason: `single tag has more than ${MAX_TAG_TOKENS} tokens`, at: tagAt(i) };
    if (t.type === "punct") {
      if (t.value === "(" || t.value === "[" || t.value === "{") {
        if (++bracket > MAX_BRACKET_DEPTH) return { reason: `bracket nesting deeper than ${MAX_BRACKET_DEPTH}`, at: t };
      } else if (t.value === ")" || t.value === "]" || t.value === "}") {
        if (bracket > 0) bracket--;
      } else if (t.value === "=" && bracket === 0) {
        setHasEquals = true; // marks the pending set as an inline assignment
      }
    }
    if (expectBlockKeyword && t.type === "identifier") {
      expectBlockKeyword = false;
      const kw = t.value;
      if (kw === "if" || kw === "for" || kw === "macro" || kw === "call" || kw === "filter") {
        blockStack.push(1);
        if (++block > MAX_BLOCK_DEPTH) return { reason: TOO_DEEP, at: t };
      } else if (kw === "elif") {
        // Each `elif` nests another `if` in the parser; one `endif` releases all.
        if (blockStack.length) blockStack[blockStack.length - 1]!++;
        if (++block > MAX_BLOCK_DEPTH) return { reason: TOO_DEEP, at: t };
      } else if (kw === "set") {
        pendingSet = t; // block-vs-inline decided when the tag closes
      } else if (kw.startsWith("end")) {
        block -= blockStack.pop() ?? 0;
        if (block < 0) block = 0;
      }
    }
  }
  return undefined;
}

// Walk the AST for filters, tests and globals the library parses but does not
// implement, and for filter and test names that are not jinja2 builtins.
// Unparseable statements never reach here; they surface as a parse error whose
// text names the construct.
function findUnsupported(program: Node, spans: Map<Node, Span>): UnsupportedConstruct[] {
  const out: UnsupportedConstruct[] = [];
  const seen = new Set<string>();
  const add = (u: UnsupportedConstruct): void => {
    const key = `${u.kind}:${u.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(u);
  };

  const classifyFilter = (name: string, at: Node, form?: string): void => {
    const span = spans.get(at);
    if (!JINJA2_BUILTIN_FILTERS.has(name)) add({ kind: "filter", name, severity: "HIGH", form, reason: NOT_BUILTIN, span });
    else if (DANGEROUS_FILTERS.has(name)) add({ kind: "filter", name, severity: "HIGH", form, span });
    else if (BENIGN_UNIMPLEMENTED_FILTERS.has(name)) add({ kind: "filter", name, severity: "MEDIUM", form, span });
  };

  const classifyTest = (name: string, at: Node, form?: string): void => {
    const span = spans.get(at);
    if (!JINJA2_BUILTIN_TESTS.has(name)) add({ kind: "test", name, severity: "HIGH", form, reason: NOT_BUILTIN, span });
    else if (!IMPLEMENTED_TESTS.has(name)) add({ kind: "test", name, severity: "MEDIUM", form, span });
  };

  // map('upper'), reject('in', xs) and selectattr('a', 'eq', 1) name another
  // filter or test by string; classify that name as if it were used directly.
  const checkNamedArg = (name: string, args: Node[]): void => {
    const positional = args.filter((a) => a.type !== "KeywordArgumentExpression");
    const at = name === "selectattr" || name === "rejectattr" ? 1 : 0;
    const arg = positional[at];
    if (arg?.type !== "StringLiteral") return;
    const named = String(arg.value);
    if (name === "map") classifyFilter(named, arg, "named in map()");
    else if (name === "select" || name === "reject" || name === "selectattr" || name === "rejectattr") classifyTest(named, arg, `named in ${name}()`);
  };

  const checkFilter = (filter: Node): void => {
    const id = filter.type === "CallExpression" ? (filter.callee as Node) : filter;
    const name = String(id.value);
    const args = filter.type === "CallExpression" ? (filter.args as Node[]) : [];
    // `map` is only implemented with attribute=; a positional arg (e.g. map('upper'))
    // throws at render, so it is a benign MEDIUM, not a code-exec HIGH.
    if (name === "map" && filter.type === "CallExpression" && !args.some((a) => a.type === "KeywordArgumentExpression")) {
      add({ kind: "filter", name, severity: "MEDIUM", form: "positional filter argument", span: spans.get(id) });
    } else if (name === "unique" && filter.type === "CallExpression" && args.length > 0) {
      // Plain `|unique` works, but `|unique(...)` (any argument, including
      // attribute=) throws at render in @huggingface/jinja (N3).
      add({ kind: "filter", name, severity: "MEDIUM", form: "called with arguments", reason: "throws at render in @huggingface/jinja", span: spans.get(id) });
    } else {
      classifyFilter(name, id);
    }
    checkNamedArg(name, args);
  };

  // Explicit stack (ISC-31). A name-bearing child (a filter/test name, a dotted
  // attribute, a keyword-argument key) is excluded from the descent so it is not
  // re-read as a bare identifier. Order is irrelevant: `add` dedupes by kind:name.
  const stack: unknown[] = [program];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const c of node) stack.push(c);
      continue;
    }
    const n = node as Node;
    let skip: string | undefined;
    if (n.type === "FilterExpression" || n.type === "FilterStatement") {
      const filter = n.filter as Node;
      checkFilter(filter);
      if (filter.type === "CallExpression") stack.push(filter.args);
      skip = "filter";
    } else if (n.type === "TestExpression") {
      classifyTest(String((n.test as Node).value), n.test as Node);
      skip = "test";
    } else if (n.type === "MemberExpression" && !n.computed) {
      skip = "property";
    } else if (n.type === "KeywordArgumentExpression") {
      skip = "key";
    } else if (n.type === "CallExpression") {
      // A `.join(...)` method call: @huggingface/jinja has no join method on any
      // type (join is a filter), so it throws at render — MEDIUM unanalyzable (N3).
      const callee = n.callee as Node;
      if (callee.type === "MemberExpression") {
        const p = callee.property as Node;
        const m = p.type === "Identifier" || p.type === "StringLiteral" ? String(p.value) : undefined;
        if (m === "join") add({ kind: "method", name: "join", severity: "MEDIUM", form: "no join method on a string or sequence", reason: "throws at render in @huggingface/jinja", span: spans.get(p) });
      }
    } else if (n.type === "Identifier" && BARE_ENGINE_GLOBALS.has(String(n.value))) {
      // Any reference to self/cycler/joiner/lipsum — called or not — is a gadget
      // handle the library lacks (ISC-12.1, ISC-15, M2 fix 1).
      add({ kind: "global", name: String(n.value), severity: "HIGH", reason: "has no benign use and @huggingface/jinja lacks it; a reference is an engine-gadget handle", span: spans.get(n) });
    } else if (n.type === "BinaryExpression" && (n.operator as { value: string }).value === "*" && isStringStar(n)) {
      // ISC-12.1 / item 6 — `'x' * 3` parses but the library throws on it at
      // render ("Unknown operator * between StringValue and IntegerValue"), so a
      // template using it is unanalyzable: MEDIUM (it still can't reach an
      // attribute on its own; the code-exec rules flag it HIGH if it folds to one).
      add({ kind: "operator", name: "*", severity: "MEDIUM", form: "string repetition", reason: "throws at render in @huggingface/jinja", span: spans.get(n.left as Node) ?? spans.get(n.right as Node) });
    }
    for (const [k, v] of Object.entries(n)) if (k !== skip) stack.push(v);
  }
  return out;
}

// True when a `*` binary expression has a string operand (string repetition).
function isStringStar(n: Node): boolean {
  const str = (side: unknown): boolean => (side as Node)?.type === "StringLiteral" || typeof foldLiteral(side) === "string";
  return str(n.left) || str(n.right);
}
