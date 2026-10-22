// Shared helpers for the code-execution rules: the construct sets the library
// does and does not implement, span math, the leaf-to-token correlation that
// gives every finding a position, the runtime-data classifier behind the
// ISC-14.1 carve-out, and a constant folder for ISC-14.
//
// The AST is @huggingface/jinja's. Its nodes carry no classes we can import, so
// we read them structurally through `.type` and their documented fields.

import type { Span } from "../types.ts";
import type { PreToken } from "./prelexer.ts";

// ---- what the library implements (anything else is unanalyzable, ISC-12.1) ----

// Statements parsed by @huggingface/jinja 0.5.10. A `{% ... %}` using any other
// keyword (with, include, import, from, block, extends, raw, do, ...) throws at
// parse, which ISC-12 turns into a HIGH unanalyzable with the name recovered
// from the error.
export const IMPLEMENTED_STATEMENTS = new Set([
  "set", "endset", "if", "elif", "else", "endif", "macro", "endmacro",
  "for", "endfor", "call", "endcall", "break", "continue", "filter", "endfilter", "generation", "endgeneration",
]);

// Filters the interpreter actually handles. `map` is implemented only with
// `attribute=`; a bare `map('upper')` throws at render, so it is not "safe".
export const IMPLEMENTED_FILTERS = new Set([
  "safe", "tojson", "list", "first", "last", "length", "reverse", "sort", "join", "string", "unique",
  "upper", "lower", "title", "capitalize", "trim", "indent", "int", "float", "abs", "items", "bool",
  "selectattr", "rejectattr", "map", "default", "replace", "dictsort", "keys", "values", "get",
]);

// Jinja2 builtin filters the library lacks, each MEDIUM unanalyzable rather
// than a code-exec HIGH (team-lead, 2026-10-22). Moving one to HIGH is a
// one-line change. Two more MEDIUM paths live in parse.ts: `map` with a
// positional filter name (map('upper') throws at render, only `attribute=` is
// implemented) and any test outside IMPLEMENTED_TESTS (undefined test, render error).
export const BENIGN_UNIMPLEMENTED_FILTERS = new Set([
  "reject", //      calls a named test on each item; tests cannot reach attributes
  "select", //      same as reject, inverted
  "count", //       alias of length
  "sum", //         arithmetic over items, attribute= is a dotted lookup like map
  "min", //         comparison over items, attribute= as in sum
  "max", //         comparison over items, attribute= as in sum
  "batch", //       regroups a sequence into fixed-size chunks
  "slice", //       regroups a sequence into n columns
  "groupby", //     regroups by a dotted attribute path, no call
  "wordcount", //   returns an int
  "round", //       numeric only
  "center", //      pads a string
  "truncate", //    shortens a string
  "urlize", //      wraps URLs in <a>, string to string
  "striptags", //   removes markup, string to string
  "pprint", //      repr of the value, no attribute access by name
  "e", //           alias of escape
  "escape", //      HTML-escapes a string
  "forceescape", // HTML-escapes a string even when marked safe
]);

// Filters that are HIGH when the library lacks them: `attr`/`format` reach
// attributes by name, and `random` is a nondeterminism source (ISC-12.1,
// ISC-18.1). `map` is NOT here: map('upper') is a benign builtin stock
// templates use, and none of the HIGH three appears in any local template.
export const DANGEROUS_FILTERS = new Set(["attr", "format", "random"]);

export const IMPLEMENTED_TESTS = new Set([
  "boolean", "callable", "odd", "even", "false", "true", "none", "string", "number", "integer",
  "iterable", "mapping", "sequence", "lower", "upper", "defined", "undefined", "equalto", "eq",
]);

// Globals the library defines. Everything else a template names as a global is
// silently UndefinedValue at render time, which is both how fingerprinting works
// and why our renderer disagrees with real jinja2 (ISC-15.1, ISC-22.2).
export const IMPLEMENTED_GLOBALS = new Set([
  "namespace", "range", "strftime_now", "raise_exception",
  "true", "false", "none", "True", "False", "None",
]);

// ---- code-execution surfaces ----

// Attribute/subscript on any of these is a HIGH gadget traversal (ISC-15).
export const GADGETS = new Set(["cycler", "joiner", "lipsum", "namespace", "dict", "self"]);

// `x is defined` / `is undefined` on any of these is engine fingerprinting
// (ISC-15.1). strftime_now is deliberately excluded (stock templates test it).
export const ENGINE_GLOBALS = new Set(["dict", "cycler", "joiner", "lipsum", "namespace", "range", "raise_exception"]);

// OS/exec surfaces in a callable position (ISC-16).
export const EXEC_SURFACES = new Set(["os", "popen", "system", "subprocess", "eval", "exec", "open", "import"]);

// Runtime inputs a template may legitimately index with a computed key. Combined
// with locally-bound names (loop vars, set targets, macro params), this is the
// "message object" carve-out of ISC-14.1: stock templates index messages, tools
// and their own locals with computed keys constantly, and none of that is a
// finding.
export const RUNTIME_INPUTS = new Set([
  "messages", "message", "tools", "tool", "documents", "document", "content", "loop",
  "add_generation_prompt", "enable_thinking", "bos_token", "eos_token", "system_message",
  "reasoning_effort", "model_identity", "tool_call", "tool_calls", "builtin_tools", "custom_tools",
  "tools_in_user_message", "date_string", "today", "json_key", "available_tools",
]);

const DUNDER = /__[A-Za-z0-9]+__|^__|__$/;

/** True when a name or folded string reaches a Python dunder attribute. */
export function hasDunder(s: string): boolean {
  return DUNDER.test(s) || /\b(__class__|__mro__|__subclasses__|__globals__|__builtins__|__init__|__import__|__base__|__bases__)\b/.test(s);
}

/** True when a folded string names an OS/exec surface as a word. */
export function hasExecSurface(s: string): boolean {
  for (const name of EXEC_SURFACES) {
    if (new RegExp(`\\b${name}\\b`).test(s)) return true;
  }
  return false;
}

// ---- spans ----

/** Line-start offsets, for turning a UTF-16 offset into 1-based line:col (col in code points). */
export class LineMap {
  private starts: number[] = [0];
  constructor(private text: string) {
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") this.starts.push(i + 1);
  }
  at(offset: number): { line: number; col: number } {
    // Binary search for the last line start at or before `offset`.
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    const lineStart = this.starts[lo]!;
    const col = [...this.text.slice(lineStart, offset)].length + 1;
    return { line: lo + 1, col };
  }
  span(start: number, end: number): Span {
    const { line, col } = this.at(start);
    return { start, end, line, col };
  }
}

// ---- AST as plain structure ----

export interface Node {
  type: string;
  [k: string]: unknown;
}

/** The salient leaves we locate: identifier and string nodes, in source order. */
export interface Leaf {
  node: Node;
  kind: "identifier" | "string";
  value: string;
}

const STATEMENT_TYPES = new Set(["If", "For", "Set", "Macro", "CallStatement", "FilterStatement", "Break", "Continue", "Comment", "Program"]);

/**
 * Walk the AST in source order, emitting identifier and quoted-string leaves.
 *
 * The parser represents literal template text as `StringLiteral` nodes too, so
 * we track context: in a statement body, a StringLiteral is template text (or a
 * bare `{{ 'x' }}` output) and never needs a code-exec span, so we skip it.
 * Inside an expression, a StringLiteral is a real quoted literal and is emitted.
 */
export function sourceOrderLeaves(program: Node): Leaf[] {
  const out: Leaf[] = [];

  const expr = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const c of node) expr(c);
      return;
    }
    const n = node as Node;
    switch (n.type) {
      case "Identifier":
        out.push({ node: n, kind: "identifier", value: String(n.value) });
        return;
      case "StringLiteral":
        out.push({ node: n, kind: "string", value: String(n.value) });
        return;
      case "IntegerLiteral":
      case "FloatLiteral":
        return;
      case "MemberExpression":
        expr(n.object);
        expr(n.property);
        return;
      case "CallExpression":
        expr(n.callee);
        expr(n.args);
        return;
      case "FilterExpression":
        expr(n.operand);
        expr(n.filter);
        return;
      case "TestExpression":
        expr(n.operand);
        expr(n.test);
        return;
      case "SelectExpression":
        expr(n.lhs);
        expr(n.test);
        return;
      case "BinaryExpression":
        expr(n.left);
        expr(n.right);
        return;
      case "Ternary":
        // Source order: trueExpr `if` condition `else` falseExpr.
        expr(n.trueExpr);
        expr(n.condition);
        expr(n.falseExpr);
        return;
      case "KeywordArgumentExpression":
        expr(n.key);
        expr(n.value);
        return;
      case "ObjectLiteral": {
        const map = n.value as Map<unknown, unknown>;
        if (map instanceof Map) for (const [k, v] of map) {
          expr(k);
          expr(v);
        }
        return;
      }
      case "ArrayLiteral":
      case "TupleLiteral":
        expr(n.value);
        return;
      case "SliceExpression":
        expr(n.start);
        expr(n.stop);
        expr(n.step);
        return;
      case "UnaryExpression":
        expr(n.argument);
        return;
      case "SpreadExpression":
      case "KeywordSpreadExpression":
        expr(n.argument);
        return;
      default:
        if (STATEMENT_TYPES.has(n.type)) stmt(n);
        else for (const v of Object.values(n)) expr(v);
    }
  };

  // A statement body: statements, nested blocks, bare output expressions, and
  // text/comment nodes (which we skip).
  const list = (arr: unknown): void => {
    for (const el of (arr as Node[] | undefined) ?? []) {
      if (!el) continue;
      if (el.type === "StringLiteral" || el.type === "Comment") continue;
      if (STATEMENT_TYPES.has(el.type)) stmt(el);
      else expr(el);
    }
  };

  const stmt = (n: Node): void => {
    switch (n.type) {
      case "Program":
        list(n.body);
        return;
      case "If":
        expr(n.test);
        list(n.body);
        list(n.alternate);
        return;
      case "For":
        expr(n.loopvar);
        expr(n.iterable);
        list(n.body);
        list(n.defaultBlock);
        return;
      case "Set":
        expr(n.assignee);
        expr(n.value);
        list(n.body);
        return;
      case "Macro":
        expr(n.name);
        expr(n.args);
        list(n.body);
        return;
      case "CallStatement":
        expr(n.call);
        expr(n.callerArgs);
        list(n.body);
        return;
      case "FilterStatement":
        list(n.body);
        expr(n.filter);
        return;
      default:
        return; // Break, Continue, Comment
    }
  };

  stmt(program);
  return out;
}

/**
 * Correlate AST leaves to raw-text spans. Both lists are in source order and
 * describe the same leaves, so a single forward pass aligns them. Adjacent
 * string literals the parser merged into one node are reunited by consuming
 * consecutive string tokens until the value matches.
 */
export function correlateSpans(leaves: Leaf[], tokens: PreToken[], lines: LineMap): Map<Node, Span> {
  const leafTokens = tokens.filter((t) => t.type === "identifier" || t.type === "string");
  const spans = new Map<Node, Span>();
  let ti = 0;
  for (const leaf of leaves) {
    if (leaf.kind === "identifier") {
      // Skip keyword/operator identifier tokens that are not AST leaves.
      while (ti < leafTokens.length && !(leafTokens[ti]!.type === "identifier" && leafTokens[ti]!.value === leaf.value)) ti++;
      if (ti < leafTokens.length) {
        const t = leafTokens[ti++]!;
        spans.set(leaf.node, lines.span(t.start, t.end));
      }
    } else {
      // Advance to a string token that begins this literal, skipping stray
      // tokens (keywords, bare output strings) that do not start it.
      while (ti < leafTokens.length && !(leafTokens[ti]!.type === "string" && leaf.value.startsWith(leafTokens[ti]!.value))) ti++;
      if (ti >= leafTokens.length) continue;
      const start = leafTokens[ti]!.start;
      let acc = "";
      let end = start;
      // Reunite adjacent string literals the parser merged into one node.
      while (ti < leafTokens.length && leafTokens[ti]!.type === "string" && acc !== leaf.value && leaf.value.startsWith(acc + leafTokens[ti]!.value)) {
        acc += leafTokens[ti]!.value;
        end = leafTokens[ti]!.end;
        ti++;
      }
      if (acc === leaf.value) spans.set(leaf.node, lines.span(start, end));
    }
  }
  return spans;
}

// ---- runtime-data classifier (ISC-14.1 carve-out) ----

/** Collect names bound locally: loop variables, set targets, macro and caller parameters. */
export function collectBoundNames(program: Node): Set<string> {
  const names = new Set<string>();
  const addTarget = (node: unknown): void => {
    const n = node as Node | undefined;
    if (!n) return;
    if (n.type === "Identifier") names.add(String(n.value));
    else if (n.type === "TupleLiteral" || n.type === "ArrayLiteral") for (const c of n.value as Node[]) addTarget(c);
    // A set on `ns.attr` binds nothing new.
  };
  const addParams = (args: unknown): void => {
    for (const a of (args as Node[] | undefined) ?? []) {
      if (a.type === "Identifier") names.add(String(a.value));
      else if (a.type === "KeywordArgumentExpression") names.add(String((a.key as Node).value));
    }
  };
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const c of node) visit(c);
      return;
    }
    const n = node as Node;
    if (n.type === "For") addTarget(n.loopvar);
    else if (n.type === "Set") addTarget(n.assignee);
    else if (n.type === "Macro") addParams(n.args);
    else if (n.type === "CallStatement") addParams(n.callerArgs);
    for (const v of Object.values(n)) visit(v);
  };
  visit(program);
  return names;
}

/** The base identifier a member/subscript chain hangs off, if any. */
export function rootIdentifier(node: Node): string | undefined {
  let cur: Node | undefined = node;
  while (cur) {
    if (cur.type === "Identifier") return String(cur.value);
    if (cur.type === "MemberExpression") cur = cur.object as Node;
    else if (cur.type === "CallExpression") cur = cur.callee as Node;
    else if (cur.type === "FilterExpression") cur = cur.operand as Node;
    else return undefined;
  }
  return undefined;
}

/** True when a subscript/getattr root is runtime data and so exempt from ISC-14.1. */
export function isDataObject(node: Node, bound: Set<string>): boolean {
  const root = rootIdentifier(node);
  if (root === undefined) return false;
  return bound.has(root) || RUNTIME_INPUTS.has(root);
}

// ---- constant folding (ISC-14) ----

export type FoldValue = string | number | boolean | null | FoldValue[];

/** Evaluate a literal-only expression, or return undefined if it depends on runtime input. */
export function foldLiteral(node: unknown, depth = 0): FoldValue | undefined {
  if (depth > 40 || !node || typeof node !== "object") return undefined;
  const n = node as Node;
  switch (n.type) {
    case "StringLiteral":
      return String(n.value);
    case "IntegerLiteral":
    case "FloatLiteral":
      return Number(n.value);
    case "Identifier": {
      const v = String(n.value);
      if (v === "true" || v === "True") return true;
      if (v === "false" || v === "False") return false;
      if (v === "none" || v === "None") return null;
      return undefined;
    }
    case "ArrayLiteral":
    case "TupleLiteral": {
      const out: FoldValue[] = [];
      for (const c of n.value as Node[]) {
        const f = foldLiteral(c, depth + 1);
        if (f === undefined) return undefined;
        out.push(f);
      }
      return out;
    }
    case "UnaryExpression": {
      const a = foldLiteral(n.argument, depth + 1);
      const op = (n.operator as { value: string }).value;
      if (typeof a === "number") return op === "-" ? -a : op === "+" ? a : undefined;
      if (op === "not") return !truthy(a);
      return undefined;
    }
    case "BinaryExpression": {
      const l = foldLiteral(n.left, depth + 1);
      const r = foldLiteral(n.right, depth + 1);
      if (l === undefined || r === undefined) return undefined;
      const op = (n.operator as { value: string }).value;
      if (op === "~") return `${stringify(l)}${stringify(r)}`;
      if (op === "+") {
        if (typeof l === "number" && typeof r === "number") return l + r;
        if (typeof l === "string" && typeof r === "string") return l + r;
      }
      return undefined;
    }
    case "FilterExpression":
      return foldFilter(n, depth);
    case "MemberExpression": {
      if (!n.computed) return undefined;
      const obj = foldLiteral(n.object, depth + 1);
      const key = foldLiteral(n.property, depth + 1);
      if (typeof obj === "string" && typeof key === "number") return obj[key] ?? undefined;
      if (Array.isArray(obj) && typeof key === "number") return obj[key];
      return undefined;
    }
    case "SliceExpression":
      return undefined; // handled by the caller via the sliced operand when needed
    default:
      return undefined;
  }
}

function foldFilter(n: Node, depth: number): FoldValue | undefined {
  const operand = foldLiteral(n.operand, depth + 1);
  if (operand === undefined) return undefined;
  const filter = n.filter as Node;
  const name = filter.type === "Identifier" ? String(filter.value) : String((filter.callee as Node).value);
  const argNodes = filter.type === "CallExpression" ? (filter.args as Node[]) : [];
  const args = argNodes.map((a) => foldLiteral(a, depth + 1));
  switch (name) {
    case "upper":
      return typeof operand === "string" ? operand.toUpperCase() : undefined;
    case "lower":
      return typeof operand === "string" ? operand.toLowerCase() : undefined;
    case "trim":
      return typeof operand === "string" ? operand.trim() : undefined;
    case "string":
      return stringify(operand);
    case "join": {
      if (!Array.isArray(operand)) return undefined;
      const sep = typeof args[0] === "string" ? args[0] : "";
      return operand.map(stringify).join(sep);
    }
    case "replace": {
      if (typeof operand !== "string" || typeof args[0] !== "string" || typeof args[1] !== "string") return undefined;
      return operand.split(args[0]).join(args[1]);
    }
    case "list":
    case "first":
    case "last":
      if (Array.isArray(operand)) return name === "first" ? operand[0] : name === "last" ? operand[operand.length - 1] : operand;
      return undefined;
    default:
      return undefined;
  }
}

function stringify(v: FoldValue | undefined): string {
  if (v === null) return "None";
  if (Array.isArray(v)) return v.map(stringify).join("");
  return String(v);
}

function truthy(v: FoldValue | undefined): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return Boolean(v);
}
