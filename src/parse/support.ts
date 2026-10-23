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

// Engine globals the library lacks entirely: any reference — called or not — is
// HIGH unanalyzable (ISC-12.1, ISC-15, M2 fix 1). The library provides none of
// them and they have no benign use in a chat template, so no stock template can
// trip this; `self` has always been flagged, cycler/joiner/lipsum join it so a
// laundered handle (`[lipsum]`, `lipsum if ... else 0`) is caught at the source.
export const BARE_ENGINE_GLOBALS = new Set(["self", "cycler", "joiner", "lipsum"]);

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

/**
 * Every child of an AST value, for the explicit-stack walkers: an array's
 * elements, or a node's field values with any Map field expanded to its keys and
 * values. The library keeps a dict literal's entries in a Map, which
 * Object.values never enters, so a walker that enumerated fields itself would
 * never see inside `{'a': ...}` (round-3 D1). Every generic walk goes through
 * here. `skip` leaves out one name-bearing field.
 */
export function children(node: unknown, skip?: string): unknown[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node;
  const out: unknown[] = [];
  for (const [k, v] of Object.entries(node)) {
    if (k === skip) continue;
    if (v instanceof Map) for (const [mk, mv] of v) out.push(mk, mv);
    else out.push(v);
  }
  return out;
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
        else pushSeq(children(n).map(E));
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

// ---- binding environment (ISC-14.1 carve-out) ----
//
// The carve-out is strict: a subscript key, attribute name or callee is exempt
// only when it is PROVABLY runtime data — a plain reference whose binding chain
// is rooted in a runtime input, with no string operation, method call or gadget
// anywhere along it. Everything else is folded and checked, or it is a dynamic
// attribute reach. To decide that per use site we first resolve what every local
// name is bound to, carrying taint through `set`, two-step `set`, namespace-
// attribute assignment (`set ns.k = ...`), loop variables (runtime only when the
// loop walks runtime data) and macro parameters (runtime only when every call
// site passes runtime data), including values built inside containers or
// conditionals. A name written more than once holds the join of every write.

/** What a local name resolves to, for the carve-out. */
export type Binding =
  | { t: "const"; value: FoldValue } // folds to a compile-time constant
  | { t: "runtime" } //                a loop var or a `set`/`for` target rooted in runtime input data
  | { t: "number" } //                 a number whose value varies (a counter, a range() index); never names an attribute
  | { t: "built" } //                  assembled by a string op, filter, method or call — never exempt
  | { t: "gadget" } //                 an engine-gadget handle (cycler/joiner/lipsum/namespace/dict/self)
  | { t: "opaque" }; //                a local of unknown nature (a call result, a filtered value)

export type BindingEnv = Map<string, Binding>;

const BINDING_RUNTIME: Binding = { t: "runtime" };
const BINDING_BUILT: Binding = { t: "built" };
const BINDING_GADGET: Binding = { t: "gadget" };
const BINDING_OPAQUE: Binding = { t: "opaque" };
const BINDING_NUMBER: Binding = { t: "number" };

// Arithmetic operators: numeric operands give a number.
const ARITHMETIC_OPS = new Set(["+", "-", "*", "/", "//", "%", "**"]);

// Binary operators that build a string when either side is one: concatenation,
// repetition, and Python %-formatting (`'__%s__' % 'class'`).
const STRING_BUILDING_OPS = new Set(["+", "*", "%"]);

// Binary operators whose result is a bool or a number whatever the operands:
// comparisons and membership give a bool, and `-`, `/`, `//` and `**` are
// defined only on numbers. Neither can name an attribute.
const NUMERIC_RESULT_OPS = new Set(["==", "!=", "<", ">", "<=", ">=", "in", "not in", "-", "/", "//", "**"]);

// Filters whose result holds only values drawn from the operand (selected,
// reordered or case-mapped), never a value the template supplies, so a runtime
// operand stays runtime data through them. `default`, `replace`, `join`, `map`,
// `batch`, `groupby`, `tojson` and the rest can inject a template-chosen value,
// so they end the chain.
const DATA_FILTERS = new Set([
  "items", "dictsort", "list", "first", "last", "reverse", "sort", "unique", "select", "reject",
  "selectattr", "rejectattr", "trim", "lower", "upper", "string", "length", "count",
]);

// Methods with the same property, on a runtime receiver. `get` qualifies only
// with one argument; a second is a default the template chooses.
const DATA_METHODS = new Set(["items", "keys", "values", "split", "rsplit", "strip", "lstrip", "rstrip", "lower", "upper"]);

/** The base identifier a member/subscript/call/filter chain hangs off, if any. */
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

/** The `ns.attr` env key for a non-computed `object.property` of two identifiers, else undefined. */
function attrKey(n: Node): string | undefined {
  if (n.type !== "MemberExpression" || n.computed) return undefined;
  const obj = n.object as Node;
  const prop = n.property as Node;
  if (obj?.type === "Identifier" && prop?.type === "Identifier") return `${String(obj.value)}.${String(prop.value)}`;
  return undefined;
}

/** Classify a value expression against the current bindings (depth-capped, ISC-31). */
function classifyValue(node: unknown, env: BindingEnv, depth = 0): Binding {
  if (depth > 40 || !node || typeof node !== "object") return BINDING_OPAQUE;
  const n = node as Node;
  const folded = foldLiteral(n, 0, env);
  if (folded !== undefined) return { t: "const", value: folded };
  switch (n.type) {
    case "Identifier": {
      const v = String(n.value);
      if (GADGETS.has(v)) return BINDING_GADGET;
      // A local binding shadows the runtime input of the same name: a macro
      // parameter or loop variable called `message` is whatever was bound to it.
      return env.get(v) ?? (RUNTIME_INPUTS.has(v) ? BINDING_RUNTIME : BINDING_OPAQUE);
    }
    case "MemberExpression": {
      const key = attrKey(n);
      if (key) {
        const b = env.get(key);
        if (b) return b;
      }
      const ob = classifyValue(n.object, env, depth + 1);
      if (ob.t === "gadget") return BINDING_GADGET;
      if (ob.t === "built") return BINDING_BUILT;
      if (ob.t === "runtime") return BINDING_RUNTIME; // a field of runtime data is runtime
      return BINDING_OPAQUE;
    }
    case "BinaryExpression": {
      const op = (n.operator as { value: string }).value;
      if (op === "~") return BINDING_BUILT;
      if (STRING_BUILDING_OPS.has(op) && (foldsToString(n.left, env) || foldsToString(n.right, env))) return BINDING_BUILT;
      // `a or b` / `a and b` evaluate to one of their operands, so a literal
      // operand can be the result (`m.missing or 'upper'`).
      if (NUMERIC_RESULT_OPS.has(op)) return BINDING_NUMBER;
      const l = classifyValue(n.left, env, depth + 1);
      const r = classifyValue(n.right, env, depth + 1);
      if (op === "or" || op === "and") return joinBindings(l, r);
      // A string or a list plus a number is an error, so `x + 1` is a number.
      if (op === "+" && (isNumeric(l) || isNumeric(r))) return BINDING_NUMBER;
      if (ARITHMETIC_OPS.has(op) && isNumeric(l) && isNumeric(r)) return BINDING_NUMBER;
      // `+`, `*` and `%` that do not fold hold whatever their operands do: runtime
      // data with runtime data stays runtime, and a template-made operand makes
      // the result template-made (round-3 D2: `p + q` from two literal arguments).
      return joinBindings(l, r);
    }
    case "FilterExpression":
      return BINDING_BUILT;
    case "CallExpression": {
      const callee = n.callee as Node;
      if (callee.type === "Identifier" && (String(callee.value) === "namespace" || String(callee.value) === "dict")) return BINDING_OPAQUE;
      return BINDING_BUILT; // a method or function call assembles a value
    }
    case "Ternary":
      return joinBindings(classifyValue(n.trueExpr, env, depth + 1), classifyValue(n.falseExpr, env, depth + 1));
    case "ArrayLiteral":
    case "TupleLiteral": {
      for (const c of (n.value as Node[]) ?? []) if (classifyValue(c, env, depth + 1).t === "gadget") return BINDING_GADGET;
      return BINDING_OPAQUE;
    }
    case "ObjectLiteral": {
      // Keys as well as values, as children() walks them: iterating a dict
      // yields its keys, so a gadget key is reachable through the dict.
      const map = n.value as Map<unknown, unknown>;
      if (map instanceof Map) {
        for (const [k, v] of map) {
          if (classifyValue(k, env, depth + 1).t === "gadget" || classifyValue(v, env, depth + 1).t === "gadget") return BINDING_GADGET;
        }
      }
      return BINDING_OPAQUE;
    }
    default:
      return BINDING_OPAQUE;
  }
}

function joinBindings(a: Binding, b: Binding): Binding {
  // An empty list holds no value to bind, index or call, so it adds nothing:
  // `{% if tools is not defined %}{% set tools = [] %}` and `x or []` stay x.
  if (isEmptyList(a)) return b;
  if (isEmptyList(b)) return a;
  if (a.t === "gadget" || b.t === "gadget") return BINDING_GADGET;
  if (a.t === "built" || b.t === "built") return BINDING_BUILT;
  if (a.t === "runtime" && b.t === "runtime") return BINDING_RUNTIME;
  if (a.t === "const" && b.t === "const" && sameFold(a.value, b.value)) return a;
  if (isNumeric(a) && isNumeric(b)) return BINDING_NUMBER;
  return BINDING_OPAQUE;
}

function isEmptyList(b: Binding): boolean {
  return b.t === "const" && Array.isArray(b.value) && b.value.length === 0;
}

function isNumeric(b: Binding): boolean {
  return b.t === "number" || (b.t === "const" && typeof b.value === "number");
}

/** True when a key is a number however it is derived: it folds to one, or is bound to a counter or range() index. */
export function keyIsNumeric(node: Node, env: BindingEnv): boolean {
  return isNumeric(classifyValue(node, env));
}

function sameBinding(a: Binding | undefined, b: Binding | undefined): boolean {
  if (!a || !b) return a === b;
  return a.t === b.t && (a.t !== "const" || sameFold(a.value, (b as { value: FoldValue }).value));
}

function sameFold(a: FoldValue, b: FoldValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameFold(x, b[i]!));
  }
  return Object.is(a, b);
}

/**
 * True when a value is drawn only from runtime input data: a runtime-bound name,
 * a field or element of one, or such a value passed through a filter or method
 * that only selects, reorders or case-maps it (DATA_FILTERS, DATA_METHODS). A
 * literal, a container the template writes, or a chain that can inject a
 * template-chosen value is not. This decides the OBJECT of a subscript, a loop
 * variable and a macro argument; a subscript KEY is held to the stricter
 * keyIsRuntime, where any filter or call counts as built.
 */
export function runtimeRooted(node: unknown, env: BindingEnv, depth = 0): boolean {
  if (depth > 40 || !node || typeof node !== "object") return false;
  const n = node as Node;
  const b = classifyValue(n, env);
  if (b.t === "runtime" || isEmptyList(b)) return true; // an empty list carries no value, as in joinBindings
  switch (n.type) {
    case "MemberExpression": {
      // A bound `ns.k` slot is decided by its own binding, already read above.
      const key = attrKey(n);
      if (key && env.has(key)) return false;
      return runtimeRooted(n.object, env, depth + 1);
    }
    case "FilterExpression": {
      const f = n.filter as Node;
      const name = String((f.type === "CallExpression" ? (f.callee as Node) : f).value);
      return DATA_FILTERS.has(name) && runtimeRooted(n.operand, env, depth + 1);
    }
    case "CallExpression": {
      const callee = n.callee as Node;
      if (callee.type !== "MemberExpression" || callee.computed) return false;
      const method = String((callee.property as Node).value);
      const argc = ((n.args as Node[] | undefined) ?? []).length;
      if (!DATA_METHODS.has(method) && !(method === "get" && argc <= 1)) return false;
      return runtimeRooted(callee.object, env, depth + 1);
    }
    case "SelectExpression": // `x if cond` is x or undefined
      return runtimeRooted(n.lhs, env, depth + 1);
    case "Ternary":
      return runtimeRooted(n.trueExpr, env, depth + 1) && runtimeRooted(n.falseExpr, env, depth + 1);
    default:
      return false;
  }
}

/** What a loop variable is bound to: runtime when the loop counts with range() or walks runtime data. */
function loopBinding(iterable: Node | undefined, env: BindingEnv): Binding {
  if (!iterable) return BINDING_OPAQUE;
  const callee = iterable.type === "CallExpression" ? (iterable.callee as Node) : undefined;
  if (callee?.type === "Identifier" && String(callee.value) === "range") return BINDING_NUMBER;
  if (iterable.type === "ArrayLiteral" || iterable.type === "TupleLiteral") {
    // A list the template writes yields its own elements.
    const items = (iterable.value as Node[] | undefined) ?? [];
    if (items.every((c) => runtimeRooted(c, env))) return BINDING_RUNTIME;
    return items.map((c) => classifyValue(c, env)).reduce(joinBindings);
  }
  if (runtimeRooted(iterable, env)) return BINDING_RUNTIME;
  return classifyValue(iterable, env).t === "gadget" ? BINDING_GADGET : BINDING_OPAQUE;
}

// Rounds of the binding fixpoint before giving up. Every corpus template settles
// within four, counting the round that confirms nothing changed; a template that
// has not settled by here gets no exemptions.
const MAX_BINDING_ROUNDS = 16;

/** One call's arguments, split once so each parameter lookup is O(1). */
interface CallArgs {
  positional: Node[];
  keyword: Map<string, Node>;
}

/** A macro's parameters and every direct call to it, for the parameter fixpoint. */
interface MacroInfo {
  params: { name: string; index: number; fallback?: Node }[];
  calls: CallArgs[]; // each `f(...)` and `{% call f(...) %}`
  /** Defined twice, referenced other than as a direct callee, or called with a spread: its params are opaque. */
  opaque: boolean;
}

/**
 * Collect every macro, its direct call sites, and whether its name escapes. A
 * name that appears anywhere except as its own definition or a direct callee
 * (bound by `set`, passed as an argument, output) may be called where we cannot
 * see the arguments, so that macro's parameters are opaque. Explicit stack (ISC-31).
 */
function collectMacros(program: Node): Map<string, MacroInfo> {
  const macros = new Map<string, MacroInfo>();
  const calls = new Map<string, CallArgs[]>();
  const refs = new Set<string>(); // identifiers used other than as a direct callee or a definition name
  const spread = new Set<string>(); // callees called with *args or **kwargs
  const excused = new Set<Node>();
  const stack: unknown[] = [program];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const c of node) stack.push(c);
      continue;
    }
    const n = node as Node;
    switch (n.type) {
      case "Macro": {
        const name = String((n.name as Node).value);
        excused.add(n.name as Node);
        const prior = macros.get(name);
        const params: MacroInfo["params"] = [];
        ((n.args as Node[] | undefined) ?? []).forEach((a, index) => {
          if (a.type === "Identifier") params.push({ name: String(a.value), index });
          else if (a.type === "KeywordArgumentExpression") params.push({ name: String((a.key as Node).value), index, fallback: a.value as Node });
        });
        macros.set(name, { params, calls: [], opaque: prior !== undefined });
        break;
      }
      case "CallExpression": {
        const callee = n.callee as Node;
        if (callee?.type === "Identifier") {
          excused.add(callee);
          const name = String(callee.value);
          const args = (n.args as Node[] | undefined) ?? [];
          if (args.some((a) => a.type === "SpreadExpression" || a.type === "KeywordSpreadExpression")) spread.add(name);
          const list = calls.get(name) ?? [];
          const keyword = new Map<string, Node>();
          for (const a of args) if (a.type === "KeywordArgumentExpression") keyword.set(String((a.key as Node).value), a.value as Node);
          list.push({ positional: args.filter((a) => a.type !== "KeywordArgumentExpression"), keyword });
          calls.set(name, list);
        }
        break;
      }
      case "MemberExpression":
        if (!n.computed) excused.add(n.property as Node);
        break;
      case "KeywordArgumentExpression":
        excused.add(n.key as Node);
        break;
      case "Identifier":
        if (!excused.has(n)) refs.add(String(n.value));
        break;
    }
    for (const c of children(n)) stack.push(c);
  }
  for (const [name, m] of macros) {
    m.calls = calls.get(name) ?? [];
    if (refs.has(name) || spread.has(name)) m.opaque = true;
  }
  return macros;
}

/** The values that can reach one parameter: its default, and what each call site passes. */
function paramSources(m: MacroInfo, p: MacroInfo["params"][number]): Node[] {
  const out: Node[] = p.fallback ? [p.fallback] : [];
  for (const call of m.calls) {
    const v = call.positional[p.index] ?? call.keyword.get(p.name);
    if (v) out.push(v);
  }
  return out;
}

/**
 * Resolve what every local name (and `ns.attr` slot) is bound to. One pass is a
 * straight recursive descent over STATEMENTS, whose nesting parse.ts caps at 128
 * before the parser runs, so it cannot overflow; value expressions are
 * classified with a depth cap (ISC-31).
 *
 * The env is flat and order-free: a name written more than once holds the join
 * of every write, so a later clean write cannot launder an earlier template-made
 * one, and a `set` inside a branch counts as having happened. Passes repeat,
 * each starting from the last, until nothing changes, so a value read before a
 * later write (in a loop, or a macro body called after it) sees that write too.
 *
 * A macro parameter is runtime only when every direct call site, and its default
 * if it has one, passes a runtime-rooted value (round-2 macro-parameter review).
 * That is a greatest fixpoint: every parameter starts runtime and is demoted when
 * a source is not, which handles recursive macros. A parameter that is demoted
 * holds the join of its sources: when any parameter changes, the next pass starts
 * again from the runtime inputs, so the runtime binding a parameter started with
 * does not linger in it or in the names that read it (round-3 D2). Parameters
 * only move one way (toward less exemption) and between those moves the env only
 * grows, so the rounds terminate; past MAX_BINDING_ROUNDS no local is exempt.
 */
export function resolveBindings(program: Node): BindingEnv {
  const macros = collectMacros(program);
  const paramKey = (macro: string, param: string): string => `${macro}\u0000${param}`;
  const params = new Map<string, Binding>();
  for (const [name, m] of macros) for (const p of m.params) params.set(paramKey(name, p.name), m.opaque ? BINDING_OPAQUE : BINDING_RUNTIME);

  // A runtime input holds runtime data until the template writes it, and a write
  // joins with that: `set message = 'abc'` leaves `message` no longer exempt.
  const seed = (): BindingEnv => new Map([...RUNTIME_INPUTS].map((name) => [name, BINDING_RUNTIME]));
  let env = seed();
  let restart = false;
  for (let round = 0; round < MAX_BINDING_ROUNDS; round++) {
    const next = bindingPass(program, restart ? seed() : env, params, paramKey);
    let changed = next.size !== env.size || [...next].some(([k, b]) => !sameBinding(env.get(k), b));
    restart = false;
    for (const [name, m] of macros) {
      for (const p of m.params) {
        const k = paramKey(name, p.name);
        const prev = params.get(k)!;
        const sources = paramSources(m, p);
        let b: Binding;
        if (prev.t === "runtime" && sources.every((v) => runtimeRooted(v, next))) b = BINDING_RUNTIME;
        else {
          const joined = sources.map((v) => classifyValue(v, next)).reduce<Binding | undefined>((acc, x) => (acc ? joinBindings(acc, x) : x), undefined) ?? BINDING_OPAQUE;
          // A runtime join here means a source was not rooted after all; never keep it exempt.
          b = prev.t === "runtime" ? (joined.t === "runtime" ? BINDING_OPAQUE : joined) : joinBindings(prev, joined);
        }
        if (!sameBinding(prev, b)) {
          params.set(k, b);
          changed = true;
          restart = true;
        }
      }
    }
    env = next;
    if (!changed) return env;
  }
  // Did not settle: nothing local is exempt.
  const out: BindingEnv = new Map();
  for (const [k, b] of env) out.set(k, joinBindings(b, BINDING_OPAQUE));
  return out;
}

/** One pass of resolveBindings, joining every write into a copy of `prior`. */
function bindingPass(program: Node, prior: BindingEnv, params: Map<string, Binding>, paramKey: (m: string, p: string) => string): BindingEnv {
  const env: BindingEnv = new Map(prior);
  const write = (name: string, b: Binding): void => {
    const prev = env.get(name);
    env.set(name, prev ? joinBindings(prev, b) : b);
  };
  const bindTarget = (target: Node | undefined, b: Binding): void => {
    if (!target) return;
    if (target.type === "Identifier") write(String(target.value), b);
    else if (target.type === "TupleLiteral" || target.type === "ArrayLiteral") for (const c of (target.value as Node[]) ?? []) bindTarget(c, b);
  };
  const walk = (stmts: unknown): void => {
    if (!Array.isArray(stmts)) return;
    for (const s of stmts as Node[]) {
      if (!s || typeof s !== "object") continue;
      switch (s.type) {
        case "Set": {
          const assignee = s.assignee as Node;
          const value = s.value as Node | undefined;
          const b = value ? classifyValue(value, env) : BINDING_OPAQUE;
          if (assignee?.type === "Identifier") {
            write(String(assignee.value), b);
            recordNamespaceInit(String(assignee.value), value, env, write);
          } else {
            const key = attrKey(assignee);
            if (key) write(key, b);
          }
          walk(s.body); // {% set x %}...{% endset %} block body
          continue;
        }
        case "For":
          bindTarget(s.loopvar as Node, loopBinding(s.iterable as Node, env));
          walk(s.body);
          walk(s.defaultBlock);
          continue;
        case "Macro": {
          const name = String((s.name as Node).value);
          for (const a of (s.args as Node[] | undefined) ?? []) {
            const p = a.type === "Identifier" ? String(a.value) : a.type === "KeywordArgumentExpression" ? String((a.key as Node).value) : undefined;
            if (p !== undefined) write(p, params.get(paramKey(name, p)) ?? BINDING_OPAQUE);
          }
          walk(s.body);
          continue;
        }
        case "CallStatement":
          // `{% call(x) f() %}`: x is whatever the macro passes to caller(), which
          // we do not trace. No stock template uses a call block.
          for (const a of (s.callerArgs as Node[] | undefined) ?? []) if (a.type === "Identifier") write(String(a.value), BINDING_OPAQUE);
          walk(s.body);
          continue;
        case "If":
          walk(s.body);
          walk(s.alternate);
          continue;
        case "FilterStatement":
          walk(s.body);
          continue;
        default:
          continue;
      }
    }
  };
  walk((program as Node).body);
  return env;
}

/** `set ns = namespace(k=V, ...)` seeds `ns.k` bindings (same for dict()). */
function recordNamespaceInit(target: string, value: Node | undefined, env: BindingEnv, write: (k: string, b: Binding) => void): void {
  if (!value || value.type !== "CallExpression") return;
  const callee = value.callee as Node;
  if (callee.type !== "Identifier" || (String(callee.value) !== "namespace" && String(callee.value) !== "dict")) return;
  for (const a of (value.args as Node[] | undefined) ?? []) {
    if (a.type === "KeywordArgumentExpression") write(`${target}.${String((a.key as Node).value)}`, classifyValue(a.value, env));
  }
}

/** True when an identifier key is bound by nothing: no local binding, runtime input or engine gadget. */
export function isUnboundName(name: string, env: BindingEnv): boolean {
  return !env.has(name) && !RUNTIME_INPUTS.has(name) && !GADGETS.has(name);
}

/**
 * True when a key/attribute/callee node is PROVABLY runtime data: a plain
 * reference whose binding chain is rooted in a runtime input, with no string
 * operation, method call or gadget anywhere along it (ISC-14.1). This is the
 * only exemption — a literal, a template-built value, or a macro parameter some
 * caller fills with one is not runtime (Gemini M1/M2). A direct literal index is
 * handled separately.
 */
export function keyIsRuntime(node: Node, env: BindingEnv): boolean {
  return classifyValue(node, env).t === "runtime";
}

/** How a key/attribute/callee position resolves (ISC-14, ISC-14.1, ISC-16). */
export interface ResolvedKey {
  /** The string the position resolves to, when it is literal or folds from literals (env-aware). */
  value?: string;
  /** True when the position is assembled by a string op, filter, method or call, or is bound to one. The carve-out never covers this. */
  built: boolean;
}

/** True when `node` folds to a string under the current bindings. */
function foldsToString(node: unknown, env?: BindingEnv): boolean {
  return typeof foldLiteral(node, 0, env) === "string";
}

/** True when a key node is assembled by a string-producing operation, or bound to one. */
function keyStringOp(node: Node, env?: BindingEnv): boolean {
  if (env) {
    const b = node.type === "Identifier" ? env.get(String(node.value)) : env.get(attrKey(node) ?? "\u0000");
    if (b && (b.t === "built" || b.t === "gadget")) return true;
  }
  switch (node.type) {
    case "BinaryExpression": {
      const op = (node.operator as { value: string }).value;
      if (op === "~") return true; // `~` always stringifies
      if (STRING_BUILDING_OPS.has(op)) return foldsToString(node.left, env) || foldsToString(node.right, env);
      if (op === "or" || op === "and") return keyStringOp(node.left as Node, env) || keyStringOp(node.right as Node, env);
      return false;
    }
    case "FilterExpression":
      // A filter applied to build the key itself (|reverse, |join, |replace, |upper, ...).
      return true;
    case "CallExpression":
      return true; // a method or function call builds the key (M4)
    default:
      return false;
  }
}

/** Resolve a key/attribute/callee node for the dunder, exec and dynamic-attribute checks. */
export function resolveKey(node: Node, env?: BindingEnv): ResolvedKey {
  const folded = foldLiteral(node, 0, env);
  return { value: typeof folded === "string" ? folded : undefined, built: keyStringOp(node, env) };
}

/** A composite node has no span of its own; point at its first leaf (ISC-26.1, M5). */
export function firstLeafSpan(node: Node, spans: Map<Node, Span>): Span | undefined {
  const stack: unknown[] = [node];
  while (stack.length) {
    const x = stack.pop();
    if (!x || typeof x !== "object") continue;
    if (Array.isArray(x)) {
      for (let i = x.length - 1; i >= 0; i--) stack.push(x[i]);
      continue;
    }
    const nn = x as Node;
    const s = spans.get(nn);
    if (s) return s;
    const vals = children(nn);
    for (let i = vals.length - 1; i >= 0; i--) stack.push(vals[i]);
  }
  return undefined;
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
    for (const c of children(n)) stack.push(c);
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

/**
 * Evaluate a literal-only expression, or return undefined if it depends on
 * runtime input. With an `env`, identifiers and `ns.attr` slots bound to a
 * compile-time constant are substituted, so a dunder assembled across `set`
 * statements still folds (M1).
 */
export function foldLiteral(node: unknown, depth = 0, env?: BindingEnv): FoldValue | undefined {
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
      if (env) {
        const b = env.get(v);
        if (b?.t === "const") return b.value;
      }
      return undefined;
    }
    case "ArrayLiteral":
    case "TupleLiteral": {
      const out: FoldValue[] = [];
      for (const c of n.value as Node[]) {
        const f = foldLiteral(c, depth + 1, env);
        if (f === undefined) return undefined;
        out.push(f);
      }
      return out;
    }
    case "UnaryExpression": {
      const a = foldLiteral(n.argument, depth + 1, env);
      const op = (n.operator as { value: string }).value;
      if (typeof a === "number") return op === "-" ? -a : op === "+" ? a : undefined;
      if (op === "not") return !truthy(a);
      return undefined;
    }
    case "BinaryExpression": {
      const op = (n.operator as { value: string }).value;
      const l = foldLiteral(n.left, depth + 1, env);
      // `a or b` / `a and b` evaluate to an operand; the left alone can decide.
      if (op === "or" && l !== undefined) return truthy(l) ? l : foldLiteral(n.right, depth + 1, env);
      if (op === "and" && l !== undefined) return truthy(l) ? foldLiteral(n.right, depth + 1, env) : l;
      const r = foldLiteral(n.right, depth + 1, env);
      if (l === undefined || r === undefined) return undefined;
      if (op === "~") return `${stringify(l)}${stringify(r)}`;
      if (op === "%") {
        if (typeof l === "string") return pyPercent(l, r, (n.right as Node).type === "TupleLiteral");
        if (typeof l === "number" && typeof r === "number" && r !== 0) return l - r * Math.floor(l / r); // Python modulo
        return undefined;
      }
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
      return foldFilter(n, depth, env);
    case "CallExpression": {
      // M4 — string methods the library implements at render (receiver folds):
      // 'x'.replace/lower/upper/strip/title/capitalize. Any other method is a
      // key built dynamically; keyStringOp flags that, foldLiteral stays undefined.
      const callee = n.callee as Node;
      if (callee.type !== "MemberExpression" || callee.computed) return undefined;
      const recv = foldLiteral(callee.object, depth + 1, env);
      if (typeof recv !== "string") return undefined;
      const prop = callee.property as Node;
      const method = prop.type === "Identifier" ? String(prop.value) : undefined;
      const a = (n.args as Node[]).map((x) => foldLiteral(x, depth + 1, env));
      return foldStringMethod(recv, method, a);
    }
    case "MemberExpression": {
      if (!n.computed) {
        const key = attrKey(n);
        if (key && env) {
          const b = env.get(key);
          if (b?.t === "const") return b.value;
        }
        return undefined;
      }
      const obj = foldLiteral(n.object, depth + 1, env);
      const prop = n.property as Node;
      if (prop.type === "SliceExpression") {
        const items = typeof obj === "string" ? obj.split("") : Array.isArray(obj) ? obj : undefined;
        if (!items) return undefined;
        const start = prop.start === undefined ? undefined : foldLiteral(prop.start, depth + 1, env);
        const stop = prop.stop === undefined ? undefined : foldLiteral(prop.stop, depth + 1, env);
        const step = prop.step === undefined ? undefined : foldLiteral(prop.step, depth + 1, env);
        if ([start, stop, step].some((v) => v !== undefined && typeof v !== "number")) return undefined;
        const sliced = pySlice(items, start as number | undefined, stop as number | undefined, step as number | undefined);
        return typeof obj === "string" ? sliced.join("") : sliced;
      }
      const key = foldLiteral(prop, depth + 1, env);
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

/**
 * Python `fmt % args` for the plain `%s`, `%d`, `%i` and `%%` specifiers; any
 * other specifier, flag or width does not fold (the key is still flagged as
 * built). Only a tuple spreads into several arguments, as in Python.
 */
function pyPercent(fmt: string, arg: FoldValue, isTuple: boolean): string | undefined {
  const args = isTuple && Array.isArray(arg) ? arg : [arg];
  let used = 0;
  let out = "";
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] !== "%") {
      out += fmt[i];
      continue;
    }
    const spec = fmt[++i];
    if (spec === "%") {
      out += "%";
      continue;
    }
    if (used >= args.length) return undefined;
    const a = args[used++]!;
    if (spec === "s" && !Array.isArray(a)) out += pyStr(a);
    else if ((spec === "d" || spec === "i") && typeof a === "number") out += String(Math.trunc(a));
    else return undefined;
  }
  return used === args.length ? out : undefined;
}

/** Python str() of a scalar. */
function pyStr(v: string | number | boolean | null): string {
  if (v === null) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  return String(v);
}

/** Fold a string method the library renders, or undefined for anything else (M4). */
function foldStringMethod(recv: string, method: string | undefined, args: (FoldValue | undefined)[]): FoldValue | undefined {
  switch (method) {
    case "lower":
      return recv.toLowerCase();
    case "upper":
      return recv.toUpperCase();
    case "strip":
      return typeof args[0] === "string" ? stripChars(recv, args[0]) : recv.trim();
    case "title":
      return recv.replace(/[A-Za-z]+/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase());
    case "capitalize":
      return recv.length ? recv[0]!.toUpperCase() + recv.slice(1).toLowerCase() : recv;
    case "replace":
      return typeof args[0] === "string" && typeof args[1] === "string" ? recv.split(args[0]).join(args[1]) : undefined;
    default:
      return undefined;
  }
}

/** Python str.strip(chars): trim any leading/trailing character in `chars`. */
function stripChars(s: string, chars: string): string {
  const set = new Set(chars.split(""));
  let i = 0;
  let j = s.length;
  while (i < j && set.has(s[i]!)) i++;
  while (j > i && set.has(s[j - 1]!)) j--;
  return s.slice(i, j);
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

function foldFilter(n: Node, depth: number, env?: BindingEnv): FoldValue | undefined {
  const operand = foldLiteral(n.operand, depth + 1, env);
  if (operand === undefined) return undefined;
  const filter = n.filter as Node;
  const name = filter.type === "Identifier" ? String(filter.value) : String((filter.callee as Node).value);
  const argNodes = filter.type === "CallExpression" ? (filter.args as Node[]) : [];
  const args = argNodes.map((a) => foldLiteral(a, depth + 1, env));
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
