// Parse a template with @huggingface/jinja and pair its AST with spans from the
// pre-lexer. This is the single door the code-execution rules go through; it
// never renders anything.

import { Template } from "@huggingface/jinja";
import type { Span } from "../types.ts";
import { preLex, type PreLexResult, type PreToken } from "./prelexer.ts";
import {
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
  UNIMPLEMENTED_CALLABLE_GLOBALS,
} from "./support.ts";

// Templates longer than this (in UTF-16 code units) are not parsed in-process;
// the library's preprocess step is quadratic on long whitespace runs (measured:
// 3.8s for 100k spaces). Real templates are ~18KB. Over the cap we fail closed
// to incomplete and let the raw-text fallback scan the interiors.
const MAX_PARSE_UNITS = 512 * 1024;

// Shape caps checked linearly BEFORE the library parser runs, so the result is
// decided by integer token counts that are identical on every platform (ISC-31)
// — never by whether a given machine's stack survives a hostile nesting depth.
// The corpus maxima are 37 / 35 / 3 / 10, so these leave 50x-100x headroom and
// never trip a stock template. Over any of them: HIGH unanalyzable, no parse.
const MAX_WHITESPACE_RUN = 4096;
const MAX_TAG_TOKENS = 2048;
const MAX_BRACKET_DEPTH = 100;
const MAX_BLOCK_DEPTH = 128;

export interface UnsupportedConstruct {
  kind: "statement" | "filter" | "test" | "global" | "operator";
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
  pre: PreLexResult;
  lines: LineMap;
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
}

export function parseTemplate(text: string): ParseOutcome {
  const pre = preLex(text);
  const lines = new LineMap(text);

  const tooLargeReason =
    text.length > MAX_PARSE_UNITS ? "template exceeds the in-process parse budget" : preParseLimit(text, pre.tokens);
  if (tooLargeReason) {
    return { pre, lines, spans: new Map(), unsupported: [], tooLarge: true, parseError: tooLargeReason };
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

// Longest run of whitespace anywhere in the text (code units). Linear.
function maxWhitespaceRun(text: string): number {
  let max = 0;
  let run = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // space, \t, \n, \v, \f, \r
    if (c === 32 || (c >= 9 && c <= 13)) {
      if (++run > max) max = run;
    } else run = 0;
  }
  return max;
}

// Decide, in one linear pass over the pre-lexer tokens, whether the template's
// shape is beyond what we will hand to the recursive-descent library parser.
// Returns a reason string when a cap is exceeded, else undefined.
function preParseLimit(text: string, tokens: PreToken[]): string | undefined {
  const ws = maxWhitespaceRun(text);
  if (ws > MAX_WHITESPACE_RUN) return `whitespace run of ${ws} exceeds the parse limit`;

  let tagTokens = 0;
  let bracket = 0;
  let maxBracket = 0;
  let block = 0;
  let maxBlock = 0;
  let expectBlockKeyword = false; // the identifier right after `{%`
  for (const t of tokens) {
    if (t.type === "open") {
      tagTokens = 0;
      bracket = 0;
      expectBlockKeyword = t.value.startsWith("{%");
      continue;
    }
    if (t.type === "close") continue;
    if (!t.inTag) continue;
    if (++tagTokens > MAX_TAG_TOKENS) return `single tag has more than ${MAX_TAG_TOKENS} tokens`;
    if (t.type === "punct") {
      if (t.value === "(" || t.value === "[" || t.value === "{") {
        if (++bracket > maxBracket) maxBracket = bracket;
        if (bracket > MAX_BRACKET_DEPTH) return `bracket nesting deeper than ${MAX_BRACKET_DEPTH}`;
      } else if (t.value === ")" || t.value === "]" || t.value === "}") {
        if (bracket > 0) bracket--;
      }
    }
    if (expectBlockKeyword && t.type === "identifier") {
      expectBlockKeyword = false;
      const kw = t.value;
      if (kw === "if" || kw === "for" || kw === "macro" || kw === "call" || kw === "filter") {
        if (++block > maxBlock) maxBlock = block;
        if (block > MAX_BLOCK_DEPTH) return `block nesting deeper than ${MAX_BLOCK_DEPTH}`;
      } else if (kw.startsWith("end")) {
        if (block > 0) block--;
      }
    }
  }
  void maxBracket;
  void maxBlock;
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
      const callee = n.callee as Node;
      if (callee.type === "Identifier" && UNIMPLEMENTED_CALLABLE_GLOBALS.has(String(callee.value))) {
        add({ kind: "global", name: String(callee.value), severity: "HIGH", form: "called", span: spans.get(callee) });
      }
    } else if (n.type === "Identifier" && n.value === "self") {
      add({ kind: "global", name: "self", severity: "HIGH", span: spans.get(n) });
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
