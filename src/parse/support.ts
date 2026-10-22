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

// Jinja2 builtin filters the library lacks. These only reshape data and fail
// loudly at render, so they are MEDIUM unanalyzable rather than a code-exec HIGH
// (team-lead, 2026-10-22). Moving any back to HIGH is a one-line change.
export const BENIGN_UNIMPLEMENTED_FILTERS = new Set([
  "reject", "select", "count", "sum", "min", "max", "batch", "slice", "groupby", "wordcount",
  "round", "center", "truncate", "urlize", "striptags", "pprint", "e", "escape", "forceescape",
]);

// Filters that are also code-execution gadgets: always HIGH, never benign.
// `map` is NOT here: map('upper') is a benign jinja2 builtin stock templates use.
export const DANGEROUS_FILTERS = new Set(["attr", "format"]);

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

/** Walk the AST in source order, emitting identifier and string leaves. */
export function sourceOrderLeaves(program: Node): Leaf[] {
  const out: Leaf[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const c of node) visit(c);
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
      case "Comment":
      case "Break":
      case "Continue":
        return;
      case "MemberExpression":
        visit(n.object);
        if (n.computed) visit(n.property);
        else visit(n.property); // dot property is still a leaf identifier in source order
        return;
      case "CallExpression":
        visit(n.callee);
        visit(n.args);
        return;
      case "FilterExpression":
        visit(n.operand);
        visit(n.filter);
        return;
      case "FilterStatement":
        visit(n.body);
        visit(n.filter);
        return;
      case "TestExpression":
        visit(n.operand);
        visit(n.test);
        return;
      case "SelectExpression":
        visit(n.lhs);
        visit(n.test);
        return;
      case "BinaryExpression":
        visit(n.left);
        visit(n.right);
        return;
      case "Ternary":
        // Source order: trueExpr `if` condition `else` falseExpr.
        visit(n.trueExpr);
        visit(n.condition);
        visit(n.falseExpr);
        return;
      case "If":
        visit(n.test);
        visit(n.body);
        visit(n.alternate);
        return;
      case "For":
        visit(n.loopvar);
        visit(n.iterable);
        visit(n.body);
        visit(n.defaultBlock);
        return;
      case "Set":
        visit(n.assignee);
        visit(n.value);
        visit(n.body);
        return;
      case "Macro":
        visit(n.name);
        visit(n.args);
        visit(n.body);
        return;
      case "CallStatement":
        visit(n.call);
        visit(n.callerArgs);
        visit(n.body);
        return;
      case "KeywordArgumentExpression":
        visit(n.key);
        visit(n.value);
        return;
      case "ObjectLiteral": {
        const map = n.value as Map<unknown, unknown>;
        if (map instanceof Map) for (const [k, v] of map) {
          visit(k);
          visit(v);
        }
        return;
      }
      case "ArrayLiteral":
      case "TupleLiteral":
        visit(n.value);
        return;
      case "SliceExpression":
        visit(n.start);
        visit(n.stop);
        visit(n.step);
        return;
      case "UnaryExpression":
        visit(n.argument);
        return;
      case "SpreadExpression":
      case "KeywordSpreadExpression":
        visit(n.argument);
        return;
      case "Program":
        visit(n.body);
        return;
      default:
        for (const v of Object.values(n)) visit(v);
    }
  };
  visit(program);
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
      while (ti < leafTokens.length && !(leafTokens[ti]!.type === "identifier" && leafTokens[ti]!.value === leaf.value)) ti++;
      if (ti < leafTokens.length) {
        const t = leafTokens[ti++]!;
        spans.set(leaf.node, lines.span(t.start, t.end));
      }
    } else {
      while (ti < leafTokens.length && leafTokens[ti]!.type !== "string") ti++;
      if (ti >= leafTokens.length) continue;
      const start = leafTokens[ti]!.start;
      let acc = "";
      let end = start;
      while (ti < leafTokens.length && leafTokens[ti]!.type === "string" && acc !== leaf.value) {
        acc += leafTokens[ti]!.value;
        end = leafTokens[ti]!.end;
        ti++;
      }
      spans.set(leaf.node, lines.span(start, end));
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
