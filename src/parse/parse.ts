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
  IMPLEMENTED_FILTERS,
  IMPLEMENTED_GLOBALS,
  IMPLEMENTED_TESTS,
  LineMap,
  type Node,
  sourceOrderLeaves,
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
  span?: Span;
}

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

// Walk the AST for filters, tests and global names the library parses but does
// not implement. Unparseable statements never reach here; they surface as a
// parse error whose text names the construct.
function findUnsupported(program: Node, spans: Map<Node, Span>): UnsupportedConstruct[] {
  const out: UnsupportedConstruct[] = [];
  const seen = new Set<string>();

  const filterName = (filter: Node): Node => (filter.type === "CallExpression" ? (filter.callee as Node) : filter);

  const checkFilter = (filter: Node): void => {
    const id = filterName(filter);
    const name = String(id.value);
    const key = `filter:${name}`;
    if (seen.has(key)) return;
    // `map` is only implemented with attribute=; a positional arg (e.g. map('upper'))
    // throws at render, so it is a benign MEDIUM, not a code-exec HIGH.
    const mapMisuse = name === "map" && filter.type === "CallExpression" && !(filter.args as Node[]).some((a) => a.type === "KeywordArgumentExpression");
    if (DANGEROUS_FILTERS.has(name)) {
      seen.add(key);
      out.push({ kind: "filter", name, severity: "HIGH", span: spans.get(id) });
    } else if (!IMPLEMENTED_FILTERS.has(name) || BENIGN_UNIMPLEMENTED_FILTERS.has(name) || mapMisuse) {
      seen.add(key);
      out.push({ kind: "filter", name, severity: "MEDIUM", form: mapMisuse ? "positional filter argument" : undefined, span: spans.get(id) });
    }
  };

  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const c of node) visit(c);
      return;
    }
    const n = node as Node;
    if (n.type === "FilterExpression") checkFilter(n.filter as Node);
    else if (n.type === "FilterStatement") checkFilter(n.filter as Node);
    else if (n.type === "TestExpression") {
      const id = n.test as Node;
      const name = String(id.value);
      const key = `test:${name}`;
      // An unimplemented test is a render error, and a test only sees the value it is applied to: MEDIUM.
      if (!IMPLEMENTED_TESTS.has(name) && !seen.has(key)) {
        seen.add(key);
        out.push({ kind: "test", name, severity: "MEDIUM", span: spans.get(id) });
      }
    }
    for (const v of Object.values(n)) visit(v);
  };
  visit(program);
  return out;
}
