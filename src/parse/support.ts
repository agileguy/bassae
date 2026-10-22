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
//
// Statements the library does not parse (with, include, import, block, raw,
// do, ...) need no list: they throw at parse, and ISC-12 turns that into a HIGH
// unanalyzable with the name recovered from the error.

// Every filter and test Python jinja2 3.1 ships (jinja2/filters.py FILTERS,
// jinja2/tests.py TESTS); transformers adds no filter beyond overriding tojson.
// A name outside these either fails in every engine or exists in one engine
// only, and that difference is a fingerprint: HIGH unanalyzable (ISC-12.1).
export const JINJA2_BUILTIN_FILTERS = new Set([
  "abs", "attr", "batch", "capitalize", "center", "count", "d", "default", "dictsort", "e", "escape",
  "filesizeformat", "first", "float", "forceescape", "format", "groupby", "indent", "int", "items", "join",
  "last", "length", "list", "lower", "map", "max", "min", "pprint", "random", "reject", "rejectattr",
  "replace", "reverse", "round", "safe", "select", "selectattr", "slice", "sort", "string", "striptags",
  "sum", "title", "tojson", "trim", "truncate", "unique", "upper", "urlencode", "urlize", "wordcount",
  "wordwrap", "xmlattr",
]);

export const JINJA2_BUILTIN_TESTS = new Set([
  "odd", "even", "divisibleby", "defined", "undefined", "filter", "test", "none", "boolean", "false", "true",
  "integer", "float", "lower", "upper", "string", "mapping", "number", "sequence", "iterable", "callable",
  "sameas", "escaped", "in", "==", "eq", "equalto", "!=", "ne", ">", "gt", "greaterthan", ">=", "ge",
  "<", "lt", "lessthan", "<=", "le",
]);

// Filters the interpreter actually handles. `map` is implemented only with
// `attribute=`; a bare `map('upper')` throws at render, so it is not "safe".
// `bool`, `keys`, `values` and `get` work here but are not jinja2 builtins, so
// a template using them as filters is still HIGH.
export const IMPLEMENTED_FILTERS = new Set([
  "safe", "tojson", "list", "first", "last", "length", "reverse", "sort", "join", "string", "unique",
  "upper", "lower", "title", "capitalize", "trim", "indent", "int", "float", "abs", "items", "bool",
  "selectattr", "rejectattr", "map", "default", "replace", "dictsort", "keys", "values", "get",
]);

// Jinja2 builtin filters the library lacks. Per ISC-12.1 and ISA Decision
// "2026-10-22 17:50": jinja2 3.1 builtin filters and tests that the library
// doesn't implement and that can't reach attributes are MEDIUM unanalyzable;
// `attr`, `format` and `random` stay HIGH, and so does any name that isn't a
// jinja2 builtin. Moving one here to HIGH is a one-line change. One more MEDIUM
// filter path lives in parse.ts: `map` with a positional filter name
// (map('upper') throws at render, only `attribute=` is implemented).
export const BENIGN_UNIMPLEMENTED_FILTERS = new Set([
  "reject", //         calls a named test on each item; tests cannot reach attributes
  "select", //         same as reject, inverted
  "count", //          alias of length
  "sum", //            arithmetic over items, attribute= is a dotted lookup like map
  "min", //            comparison over items, attribute= as in sum
  "max", //            comparison over items, attribute= as in sum
  "batch", //          regroups a sequence into fixed-size chunks
  "slice", //          regroups a sequence into n columns
  "groupby", //        regroups by a dotted attribute path, no call
  "wordcount", //      returns an int
  "round", //          numeric only
  "center", //         pads a string
  "truncate", //       shortens a string
  "urlize", //         wraps URLs in <a>, string to string
  "striptags", //      removes markup, string to string
  "pprint", //         repr of the value, no attribute access by name
  "e", //              alias of escape
  "escape", //         HTML-escapes a string
  "forceescape", //    HTML-escapes a string even when marked safe
  "d", //              alias of default
  "filesizeformat", // formats a number as a byte size
  "urlencode", //      percent-encodes a string or the items of a dict
  "wordwrap", //       wraps a string at a width
  "xmlattr", //        renders a dict as escaped HTML attributes
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

// Jinja2 builtin tests the library lacks. An unknown test is a render error and
// a test only sees the value it is applied to: MEDIUM.
export const BENIGN_UNIMPLEMENTED_TESTS = new Set([
  "in", //          membership; stock Qwen3-Coder uses it through reject("in", ...)
  "divisibleby", // arithmetic
  "float", //       type check
  "sameas", //      identity comparison
  "escaped", //     checks for a markup-safe string
  "filter", //      true when a filter of that name exists; also HIGH engine_fingerprint (ENGINE_PROBE_TESTS)
  "test", //        true when a test of that name exists; also HIGH engine_fingerprint (ENGINE_PROBE_TESTS)
  "==", "!=", ">", ">=", "<", "<=", // comparison operator aliases
  "ne", "gt", "ge", "lt", "le", //    comparison operator aliases
  "greaterthan", "lessthan", //       comparison operator aliases
]);

// Engine globals the library lacks. Calling one, or any use of `self`, is HIGH
// unanalyzable (ISC-12.1); keyword-only `dict(...)` is not a finding.
export const UNIMPLEMENTED_CALLABLE_GLOBALS = new Set(["cycler", "joiner", "lipsum"]);

// ---- code-execution surfaces ----

// Attribute/subscript on any of these is a HIGH gadget traversal (ISC-15).
export const GADGETS = new Set(["cycler", "joiner", "lipsum", "namespace", "dict", "self"]);

// `x is defined` / `is undefined` on any of these is engine fingerprinting
// (ISC-15.1). strftime_now is deliberately excluded (stock templates test it).
export const ENGINE_GLOBALS = new Set(["dict", "cycler", "joiner", "lipsum", "namespace", "range", "raise_exception"]);

// `'attr' is filter` / `'x' is test` exist only to ask the engine what it has:
// engine fingerprinting too (ISC-15.1), whatever the operand.
export const ENGINE_PROBE_TESTS = new Set(["filter", "test"]);

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
const DUNDER_NAME = /__[A-Za-z0-9]+__/;

/** True when a name or folded string reaches a Python dunder attribute, including a half-written one (`__cl`, `o__`). */
export function hasDunder(s: string): boolean {
  return DUNDER.test(s) || /\b(__class__|__mro__|__subclasses__|__globals__|__builtins__|__init__|__import__|__base__|__bases__)\b/.test(s);
}

/** True when a string contains a complete `__name__` dunder. Used by the string-literal catch-all so a split fragment like `__cl` does not trip it (that is the folder's job). */
export function hasDunderName(s: string): boolean {
  return DUNDER_NAME.test(s);
}

/** True when an attribute name is exactly an OS/exec surface. */
export function isExecName(s: string): boolean {
  return EXEC_SURFACES.has(s);
}

// ---- spans ----

/**
 * Line-start offsets, for turning a UTF-16 offset into 1-based line:col (col in
 * code points). Both lookups are O(log n): one pass at construction records the
 * line starts and the position of every high-surrogate code unit, and `at`
 * binary-searches both. Counting code points by slicing would make a scan of n
 * findings O(n^2) on one long line (40k tags on a line was the probe).
 */
export class LineMap {
  private starts: number[] = [0];
  private surrogates: number[] = []; // offsets of high-surrogate code units, ascending
  constructor(text: string) {
    // Lines break on \r\n, \r or \n, as jinja2 splits them; \r\n is one break.
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) this.starts.push(i + 1);
      else if (c >= 0xd800 && c <= 0xdbff) this.surrogates.push(i);
    }
  }
  // Number of ascending entries in `arr` strictly less than `offset`.
  private countBelow(arr: number[], offset: number): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid]! < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
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
    // Code points = code units minus the surrogate pairs (one high surrogate each) between.
    const pairs = this.countBelow(this.surrogates, offset) - this.countBelow(this.surrogates, lineStart);
    const col = offset - lineStart - pairs + 1;
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
  // Explicit stack so a deep chain (`a.b.b.b...`, `a|f|f|f...`, `'a' ~ 'a' ~ ...`)
  // cannot overflow (ISC-31). Items carry a mode: E = expression, S = statement,
  // L = statement body (an array). Children are pushed reversed so they pop in
  // source order, reproducing the former recursion exactly.
  type Mode = "E" | "S" | "L";
  const stack: { node: unknown; mode: Mode }[] = [{ node: program, mode: "S" }];
  const E = (node: unknown) => ({ node, mode: "E" as Mode });
  const S = (node: unknown) => ({ node, mode: "S" as Mode });
  const L = (node: unknown) => ({ node, mode: "L" as Mode });
  const pushSeq = (items: { node: unknown; mode: Mode }[]): void => {
    for (let i = items.length - 1; i >= 0; i--) stack.push(items[i]!);
  };

  while (stack.length) {
    const { node, mode } = stack.pop()!;
    if (!node || typeof node !== "object") continue;

    if (mode === "L") {
      const seq: { node: unknown; mode: Mode }[] = [];
      for (const el of node as Node[]) {
        if (!el || el.type === "StringLiteral" || el.type === "Comment") continue;
        seq.push(STATEMENT_TYPES.has(el.type) ? S(el) : E(el));
      }
      pushSeq(seq);
      continue;
    }

    if (Array.isArray(node)) {
      pushSeq((node as unknown[]).map(E));
      continue;
    }

    const n = node as Node;

    if (mode === "S") {
      switch (n.type) {
        case "Program": pushSeq([L(n.body)]); continue;
        case "If": pushSeq([E(n.test), L(n.body), L(n.alternate)]); continue;
        case "For": pushSeq([E(n.loopvar), E(n.iterable), L(n.body), L(n.defaultBlock)]); continue;
        case "Set": pushSeq([E(n.assignee), E(n.value), L(n.body)]); continue;
        case "Macro": pushSeq([E(n.name), E(n.args), L(n.body)]); continue;
        case "CallStatement": pushSeq([E(n.call), E(n.callerArgs), L(n.body)]); continue;
        case "FilterStatement": pushSeq([L(n.body), E(n.filter)]); continue;
        default: continue; // Break, Continue, Comment
      }
    }

    // mode === "E"
    switch (n.type) {
      case "Identifier": out.push({ node: n, kind: "identifier", value: String(n.value) }); continue;
      case "StringLiteral": out.push({ node: n, kind: "string", value: String(n.value) }); continue;
      case "IntegerLiteral":
      case "FloatLiteral": continue;
      case "MemberExpression": pushSeq([E(n.object), E(n.property)]); continue;
      case "CallExpression": pushSeq([E(n.callee), E(n.args)]); continue;
      case "FilterExpression": pushSeq([E(n.operand), E(n.filter)]); continue;
      case "TestExpression": pushSeq([E(n.operand), E(n.test)]); continue;
      case "SelectExpression": pushSeq([E(n.lhs), E(n.test)]); continue;
      case "BinaryExpression": pushSeq([E(n.left), E(n.right)]); continue;
      case "Ternary": pushSeq([E(n.trueExpr), E(n.condition), E(n.falseExpr)]); continue; // trueExpr if condition else falseExpr
      case "KeywordArgumentExpression": pushSeq([E(n.key), E(n.value)]); continue;
      case "ObjectLiteral": {
        const map = n.value as Map<unknown, unknown>;
        const seq: { node: unknown; mode: Mode }[] = [];
        if (map instanceof Map) for (const [k, v] of map) { seq.push(E(k)); seq.push(E(v)); }
        pushSeq(seq);
        continue;
      }
      case "ArrayLiteral":
      case "TupleLiteral": pushSeq([E(n.value)]); continue;
      case "SliceExpression": pushSeq([E(n.start), E(n.stop), E(n.step)]); continue;
      case "UnaryExpression": pushSeq([E(n.argument)]); continue;
      case "SpreadExpression":
      case "KeywordSpreadExpression": pushSeq([E(n.argument)]); continue;
      default:
        if (STATEMENT_TYPES.has(n.type)) stack.push(S(n));
        else pushSeq(Object.values(n).map(E));
        continue;
    }
  }
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
  // Explicit stack so a deeply nested AST cannot overflow (ISC-31).
  const stack: unknown[] = [program];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const c of node) stack.push(c);
      continue;
    }
    const n = node as Node;
    if (n.type === "For") addTarget(n.loopvar);
    else if (n.type === "Set") addTarget(n.assignee);
    else if (n.type === "Macro") addParams(n.args);
    else if (n.type === "CallStatement") addParams(n.callerArgs);
    for (const v of Object.values(n)) stack.push(v);
  }
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

/** How a key/attribute/callee position resolves (ISC-14, ISC-14.1, ISC-16). */
export interface ResolvedKey {
  /** The string the position resolves to, when it is literal or folds from literals. */
  value?: string;
  /** True when the position is assembled by a string operation (`~`, string `+`/`*`, a filter, a string slice). The carve-out never covers this. */
  built: boolean;
}

/** True when `node` folds to a string, or is a string literal. */
function foldsToString(node: unknown): boolean {
  return typeof foldLiteral(node) === "string";
}

/** True when a key node is built by a string-producing operation. */
function keyStringOp(node: Node): boolean {
  switch (node.type) {
    case "BinaryExpression": {
      const op = (node.operator as { value: string }).value;
      if (op === "~") return true; // `~` always stringifies
      if (op === "+" || op === "*") return foldsToString(node.left) || foldsToString(node.right);
      return false;
    }
    case "FilterExpression":
      // A filter applied to build the key itself (|reverse, |join, |replace, |upper, ...).
      return true;
    default:
      return false;
  }
}

/** Resolve a key/attribute/callee node for the dunder, exec and dynamic-attribute checks. */
export function resolveKey(node: Node): ResolvedKey {
  const folded = foldLiteral(node);
  return { value: typeof folded === "string" ? folded : undefined, built: keyStringOp(node) };
}

/**
 * Names that are aliases for an engine gadget (ISC-15): the gadgets themselves
 * plus any name a `set`, a `for` target, or a macro-parameter default binds
 * directly to one. Computed as a fixpoint so `set a = cycler; set b = a` chains.
 * A call like `namespace(found=false)` binds the call *result*, not the gadget,
 * so stock `set ns = namespace(...)` never makes `ns` an alias.
 */
export function gadgetAliases(program: Node): Set<string> {
  const aliases = new Set(GADGETS);
  // Collect candidate (target, sourceName) bindings once.
  const bindings: { target: string; source: string }[] = [];
  const stack: unknown[] = [program];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const c of node) stack.push(c);
      continue;
    }
    const n = node as Node;
    if (n.type === "Set" && (n.assignee as Node)?.type === "Identifier" && (n.value as Node)?.type === "Identifier") {
      bindings.push({ target: String((n.assignee as Node).value), source: String((n.value as Node).value) });
    } else if (n.type === "For" && (n.loopvar as Node)?.type === "Identifier" && (n.iterable as Node)?.type === "Identifier") {
      bindings.push({ target: String((n.loopvar as Node).value), source: String((n.iterable as Node).value) });
    } else if (n.type === "Macro") {
      for (const a of (n.args as Node[] | undefined) ?? []) {
        if (a.type === "KeywordArgumentExpression" && (a.value as Node)?.type === "Identifier") {
          bindings.push({ target: String((a.key as Node).value), source: String((a.value as Node).value) });
        }
      }
    }
    for (const v of Object.values(n)) stack.push(v);
  }
  // Propagate to a fixpoint.
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of bindings) {
      if (aliases.has(b.source) && !aliases.has(b.target)) {
        aliases.add(b.target);
        changed = true;
      }
    }
  }
  return aliases;
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
      if (op === "*") {
        // Python string repetition (which the library rejects at render, but
        // which still assembles a key: '_' * 2 -> '__'). Negative/zero -> "".
        if (typeof l === "string" && typeof r === "number") return l.repeat(Math.max(0, r | 0));
        if (typeof l === "number" && typeof r === "string") return r.repeat(Math.max(0, l | 0));
        if (typeof l === "number" && typeof r === "number") return l * r;
      }
      return undefined;
    }
    case "FilterExpression":
      return foldFilter(n, depth);
    case "MemberExpression": {
      if (!n.computed) return undefined;
      const obj = foldLiteral(n.object, depth + 1);
      const prop = n.property as Node;
      if (prop.type === "SliceExpression") {
        const items = typeof obj === "string" ? obj.split("") : Array.isArray(obj) ? obj : undefined;
        if (!items) return undefined;
        const start = prop.start === undefined ? undefined : foldLiteral(prop.start, depth + 1);
        const stop = prop.stop === undefined ? undefined : foldLiteral(prop.stop, depth + 1);
        const step = prop.step === undefined ? undefined : foldLiteral(prop.step, depth + 1);
        if ([start, stop, step].some((v) => v !== undefined && typeof v !== "number")) return undefined;
        const sliced = pySlice(items, start as number | undefined, stop as number | undefined, step as number | undefined);
        return typeof obj === "string" ? sliced.join("") : sliced;
      }
      const key = foldLiteral(prop, depth + 1);
      if (typeof obj === "string" && typeof key === "number") return obj[pyIndex(key, obj.length)] ?? undefined;
      if (Array.isArray(obj) && typeof key === "number") return obj[pyIndex(key, obj.length)];
      return undefined;
    }
    case "SliceExpression":
      return undefined; // folded through its enclosing computed MemberExpression
    default:
      return undefined;
  }
}

/** Normalize a Python index (negative counts from the end). */
function pyIndex(i: number, len: number): number {
  return i < 0 ? i + len : i;
}

/** Python slice semantics, including negative steps, on an array of items. */
function pySlice<T>(items: T[], start: number | undefined, stop: number | undefined, step: number | undefined): T[] {
  const n = items.length;
  const st = step ?? 1;
  const out: T[] = [];
  if (st === 0) return out;
  if (st > 0) {
    const lo = start === undefined ? 0 : start < 0 ? Math.max(0, start + n) : Math.min(start, n);
    const hi = stop === undefined ? n : stop < 0 ? Math.max(0, stop + n) : Math.min(stop, n);
    for (let i = lo; i < hi; i += st) out.push(items[i]!);
  } else {
    const lo = start === undefined ? n - 1 : start < 0 ? Math.max(-1, start + n) : Math.min(start, n - 1);
    const hi = stop === undefined ? -1 : stop < 0 ? Math.max(-1, stop + n) : Math.min(stop, n - 1);
    for (let i = lo; i > hi; i += st) out.push(items[i]!);
  }
  return out;
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
    case "reverse":
      if (typeof operand === "string") return operand.split("").reverse().join("");
      if (Array.isArray(operand)) return [...operand].reverse();
      return undefined;
    case "list":
    case "first":
    case "last":
      if (typeof operand === "string") return name === "first" ? operand[0] : name === "last" ? operand[operand.length - 1] : operand.split("");
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
