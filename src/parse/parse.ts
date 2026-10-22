// Parse a template with @huggingface/jinja and pair its AST with spans from the
// pre-lexer. This is the single door the code-execution rules go through; it
// never renders anything.

import { Template } from "@huggingface/jinja";
import type { Span } from "../types.ts";
import { preLex, type PreLexResult } from "./prelexer.ts";
import {
  BENIGN_UNIMPLEMENTED_FILTERS,
  correlateSpans,
  DANGEROUS_FILTERS,
  IMPLEMENTED_TESTS,
  JINJA2_BUILTIN_FILTERS,
  JINJA2_BUILTIN_TESTS,
  LineMap,
  type Node,
  sourceOrderLeaves,
  UNIMPLEMENTED_CALLABLE_GLOBALS,
} from "./support.ts";

// Templates larger than this are not parsed in-process; the library's
// preprocess step is quadratic on long whitespace runs (measured: 3.8s for 100k
// spaces). Real templates are ~18KB. Over the cap we fail closed to incomplete.
const MAX_PARSE_BYTES = 512 * 1024;

export interface UnsupportedConstruct {
  kind: "statement" | "filter" | "test" | "global";
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

  if (text.length > MAX_PARSE_BYTES) {
    return { pre, lines, spans: new Map(), unsupported: [], tooLarge: true, parseError: "template exceeds the in-process parse budget" };
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

  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const c of node) visit(c);
      return;
    }
    const n = node as Node;
    // Children that hold a name rather than an expression: a filter or test
    // name, a dotted attribute name, a keyword-argument name.
    let skip: string | undefined;
    if (n.type === "FilterExpression" || n.type === "FilterStatement") {
      const filter = n.filter as Node;
      checkFilter(filter);
      if (filter.type === "CallExpression") visit(filter.args);
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
    }
    for (const [k, v] of Object.entries(n)) if (k !== skip) visit(v);
  };
  visit(program);
  return out;
}
