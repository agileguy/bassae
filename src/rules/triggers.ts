// Test classification for the trigger rules (ISC-18, ISC-18.1): how strongly a
// conditional's outcome depends on what the user typed, or on chance.
//
// A test is one of four strengths, weakest first:
//   none              reads template constants only
//   presence          reads only whether runtime data is there and what shape it
//                     has: definedness, type, truthiness, emptiness, counts, a
//                     message's role or a part's type, the keys of a record, and
//                     any configuration value (tool definitions and flags)
//   content           reads the text of the conversation: a comparison, a
//                     substring test or a string method on message content,
//                     reasoning, tool-call arguments, documents, or an unknown
//                     runtime variable
//   nondeterministic  reads a strftime_now() result or a random choice
//
// The strength comes from two places: what the test itself reads (a comparison
// reads the whole value, `is defined` reads none of it) and what decided the
// values it reads. A variable assigned under a content test carries that test as
// its gate, so `{% if ns.found %}` after `{% if 'x' in m.content %}{% set
// ns.found = true %}` is a content test too (implicit flow).
//
// Which runtime data is content and which is presence is a fixed schema of the
// chat-template inputs (ROOTS below), not a guess from names in the template.

import type { Span } from "../types.ts";
import type { Node } from "../parse/support.ts";

/** The strength of a test, weakest first. `none` is a test on template constants only. */
export type TestClass = "none" | "presence" | "content" | "nondeterministic";

const RANK: Record<TestClass, number> = { none: 0, presence: 1, content: 2, nondeterministic: 3 };

/** The stronger of two test classes. */
export function stronger(a: TestClass, b: TestClass): TestClass {
  return RANK[a] >= RANK[b] ? a : b;
}

/** A test some text depends on: its strength and where it is. */
export interface Cond {
  test: Exclude<TestClass, "none">;
  span: Span;
}

/** The stronger of two conditions; on a tie the first (outer) one is kept. */
export function strongest(a: Cond | undefined, b: Cond | undefined): Cond | undefined {
  if (!a) return b;
  if (!b) return a;
  return RANK[b.test] > RANK[a.test] ? b : a;
}

export function condOf(test: TestClass, span: Span): Cond | undefined {
  return test === "none" ? undefined : { test, span };
}

// ---- the runtime-input schema ----

/** One node of the chat-template input schema: how a test on it is classed, and what its members and elements are. */
export interface Field {
  cls: "presence" | "content";
  /** `mixed` is a string or a list (message content); a membership test on it is a substring test unless a guard says otherwise. */
  kind: "list" | "record" | "string" | "mixed" | "any";
  elem?: Field;
  fields?: Readonly<Record<string, Field>>;
  /** Any member not in `fields`. */
  other?: Field;
}

const PRESENCE: Field = { cls: "presence", kind: "any" };
const TEXT: Field = { cls: "content", kind: "string" };

// Unknown data under the conversation: every member and element is content too.
const ANY_CONTENT: Field = { cls: "content", kind: "any" };
(ANY_CONTENT as { elem?: Field; other?: Field }).elem = ANY_CONTENT;
(ANY_CONTENT as { elem?: Field; other?: Field }).other = ANY_CONTENT;

// Configuration the deployment passes: tool definitions, flags, special tokens.
// Every member and element is configuration as well, so schema tests deep inside
// a tool definition (`param.type == 'string'`) are presence tests.
const CONFIG: Field = { cls: "presence", kind: "any" };
(CONFIG as { elem?: Field; other?: Field }).elem = CONFIG;
(CONFIG as { elem?: Field; other?: Field }).other = CONFIG;

// Tool-call arguments: a mapping (or its JSON string). Key tests on it are
// presence tests; its values are content.
const ARGS: Field = { cls: "content", kind: "record", other: ANY_CONTENT };
const FUNCTION: Field = { cls: "content", kind: "record", fields: { name: PRESENCE, arguments: ARGS }, other: ANY_CONTENT };
const TOOL_CALL: Field = { cls: "content", kind: "record", fields: { type: PRESENCE, id: PRESENCE, name: PRESENCE, function: FUNCTION, arguments: ARGS }, other: ANY_CONTENT };
const TOOL_CALLS: Field = { cls: "presence", kind: "list", elem: TOOL_CALL };

// A content part: `{'type': 'text', 'text': ...}`, `{'type': 'image', ...}`.
const PART: Field = { cls: "content", kind: "record", fields: { type: PRESENCE }, other: ANY_CONTENT };
const MESSAGE_CONTENT: Field = { cls: "content", kind: "mixed", elem: PART, other: ANY_CONTENT };

// Role, type, name and ids route a message; they are what a template switches
// on, and a role test is a presence test.
const MESSAGE: Field = {
  cls: "content",
  kind: "record",
  fields: {
    role: PRESENCE,
    type: PRESENCE,
    name: PRESENCE,
    id: PRESENCE,
    tool_call_id: PRESENCE,
    tool_calls: TOOL_CALLS,
    content: MESSAGE_CONTENT,
    reasoning_content: TEXT,
    reasoning: TEXT,
    thinking: TEXT,
  },
  other: ANY_CONTENT,
};
const MESSAGES: Field = { cls: "presence", kind: "list", elem: MESSAGE };
const DOCUMENTS: Field = { cls: "presence", kind: "list", elem: ANY_CONTENT };

const ROOTS: Readonly<Record<string, Field>> = {
  messages: MESSAGES,
  message: MESSAGE,
  content: MESSAGE_CONTENT,
  tool_calls: TOOL_CALLS,
  tool_call: TOOL_CALL,
  documents: DOCUMENTS,
  document: ANY_CONTENT,
  system_message: TEXT,
  // configuration
  tools: CONFIG,
  tool: CONFIG,
  builtin_tools: CONFIG,
  custom_tools: CONFIG,
  available_tools: CONFIG,
  xml_tools: CONFIG,
  tools_in_user_message: CONFIG,
  tool_choice: CONFIG,
  add_generation_prompt: CONFIG,
  continue_final_message: CONFIG,
  enable_thinking: CONFIG,
  reasoning_effort: CONFIG,
  model_identity: CONFIG,
  bos_token: CONFIG,
  eos_token: CONFIG,
  pad_token: CONFIG,
  unk_token: CONFIG,
  date_string: CONFIG,
  today: CONFIG,
  loop: CONFIG,
};

/** The schema node for a runtime variable the template does not bind. An unknown variable is content: the strict reading of "any runtime input". */
export function rootField(name: string): Field {
  return Object.hasOwn(ROOTS, name) ? ROOTS[name]! : ANY_CONTENT;
}

/** The schema node for one member of `f`, by name, or for an element when `key` is not a string. */
export function memberField(f: Field, key: string | undefined): Field {
  if (key === undefined) return f.elem ?? f.other ?? f;
  return (f.fields && Object.hasOwn(f.fields, key) ? f.fields[key] : undefined) ?? f.other ?? f;
}

/** A set of schema nodes, by identity: a variable assigned from two different fields is either one. Sets only grow under join, so the fixpoint converges. */
export type Fields = readonly Field[];

export function mapFields(fs: Fields, fn: (f: Field) => Field): Fields {
  const out: Field[] = [];
  for (const f of fs) {
    const g = fn(f);
    if (!out.includes(g)) out.push(g);
  }
  return out;
}

export function unionFields(a: Fields | undefined, b: Fields | undefined): Fields | undefined {
  if (!a) return b;
  if (!b) return a;
  let out: Field[] | undefined;
  for (const f of b) {
    if (a.includes(f) || out?.includes(f)) continue;
    (out ??= a.slice()).push(f);
  }
  return out ?? a;
}

export function sameFields(a: Fields | undefined, b: Fields | undefined): boolean {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((f) => b.includes(f));
}

/** The class of a value that may be any of `fs`: the strongest. */
export function clsOf(fs: Fields): "presence" | "content" {
  return fs.some((f) => f.cls === "content") ? "content" : "presence";
}

const lists = new WeakMap<Field, Field>();
/** A list of `f`, one node per element field so identity stays stable across passes. */
export function listOf(f: Field): Field {
  let l = lists.get(f);
  if (!l) lists.set(f, (l = { cls: f.cls, kind: "list", elem: f }));
  return l;
}

/** What iterating `f` yields: a record's keys, or a list's elements. */
export function elementField(f: Field): Field {
  if (f.kind === "record") return PRESENCE;
  return f.elem ?? f.other ?? f;
}

/** A record's values, for `.items()` and `|dictsort` pairs. */
export function valueField(f: Field): Field {
  return f.other ?? f;
}

export const KEY_FIELD: Field = PRESENCE;

// ---- abstract values ----

/** A template literal that can reach the output: its text, where it is, and the strongest test it depends on. */
export interface Lit {
  text: string;
  span: Span;
  cond?: Cond;
  /** The generation-prompt branch it was emitted in, by If node id. */
  gen?: number;
  /** The branch exclusive with a generation-prompt branch (its `else`). */
  genElse?: number;
  /** Provenance: a new number whenever a test is applied to the literal. Two prints of one literal with the same provenance have no test between them. */
  via?: number;
}

/** What the extraction knows about one runtime value. */
export interface Val {
  /** Template literals the value can contain when it is printed. */
  lits: Lit[];
  /** Dict-literal keys: printed with the dict, never by a lookup. */
  keys?: Lit[];
  /** What comparing or printing the whole value reveals. */
  data: TestClass;
  /** What its truthiness or length reveals. */
  truth: TestClass;
  /** The strongest test that chose this value (implicit flow). */
  gate?: Cond;
  /** The schema nodes the value may be, while it is a raw runtime field. */
  fields?: Fields;
  /** The access path (`message.content`), for `is mapping` / `is string` guards. */
  path?: string;
  /** A guard in force says the value is (not) a string. */
  shape?: "string" | "nonstring";
  /** A compile-time constant. */
  konst?: string | number | boolean | null;
  /** A list of compile-time strings, for a folded `|join`. */
  konstList?: string[];
  /** A namespace: the env key its attributes hang off. */
  ns?: string;
  /** namespace(...) arguments, until the result is bound to a name. */
  nsInit?: Map<string, Val>;
  /** A macro, by name. */
  macro?: string;
  /** `.items()` / `|dictsort`: a two-name loop gets keys and values. */
  pairs?: boolean;
}

export type Facts = ReadonlyMap<string, "string" | "nonstring">;
export const NO_FACTS: Facts = new Map();

/** What classifyTest needs from the extraction: the abstract value of an expression under some guard facts. */
export interface TestEnv {
  value(n: Node, facts: Facts): Val;
}

// Tests that read nothing of the value: whether it is there, and its type.
// `date_string is defined` stays a presence test even though the value came
// from strftime_now(): the test does not read the date.
const SHAPE_TESTS = new Set([
  "defined", "undefined", "none", "string", "mapping", "iterable", "sequence", "number", "integer", "float",
  "boolean", "callable", "filter", "test", "escaped", "list", "dict", "tuple",
]);
const TRUTH_TESTS = new Set(["true", "false"]);
const COMPARISONS = new Set(["==", "!=", "<", ">", "<=", ">="]);

function op(n: Node): string {
  return String((n.operator as { value?: unknown } | undefined)?.value ?? "");
}

function gateOf(v: Val): TestClass {
  return v.gate?.test ?? "none";
}

/** True when the value depends on runtime input at all. */
export function isRuntime(v: Val): boolean {
  return v.data !== "none" || v.truth !== "none" || v.fields !== undefined;
}

/** The strength of a test that reads the whole value. */
export function readOf(v: Val): TestClass {
  return stronger(v.data, gateOf(v));
}

/** The strength of a test on the value's truthiness or length. */
export function truthOf(v: Val): TestClass {
  return stronger(v.truth, gateOf(v));
}

/** The strength of `n` used as a condition. Never throws on any AST shape. */
export function classifyTest(n: Node, env: TestEnv, facts: Facts): TestClass {
  if (!n || typeof n !== "object") return "none";
  switch (n.type) {
    case "StringLiteral":
    case "IntegerLiteral":
    case "FloatLiteral":
      return "none";
    case "UnaryExpression":
      if (op(n) === "not") return classifyTest(n.argument as Node, env, facts);
      return truthOf(env.value(n, facts));
    case "BinaryExpression": {
      const o = op(n);
      if (o === "and" || o === "or") {
        // The right side runs only when the left one is true (and) or false (or),
        // so the left side's guards hold while it is classified.
        const l = classifyTest(n.left as Node, env, facts);
        const r = classifyTest(n.right as Node, env, factsFrom(n.left as Node, o === "and", facts));
        return stronger(l, r);
      }
      if (o === "in" || o === "not in") return membership(n.left as Node, n.right as Node, env, facts);
      if (COMPARISONS.has(o)) return stronger(readOf(env.value(n.left as Node, facts)), readOf(env.value(n.right as Node, facts)));
      return truthOf(env.value(n, facts));
    }
    case "TestExpression": {
      const name = testName(n);
      const v = env.value(n.operand as Node, facts);
      if (SHAPE_TESTS.has(name)) return stronger(isRuntime(v) ? "presence" : "none", gateOf(v));
      if (TRUTH_TESTS.has(name)) return truthOf(v);
      return readOf(v); // eq, ne, lt, odd, divisibleby, sameas, ...: the value itself
    }
    case "Ternary": {
      const c = n.condition as Node;
      const t = classifyTest(n.trueExpr as Node, env, factsFrom(c, true, facts));
      const f = classifyTest(n.falseExpr as Node, env, factsFrom(c, false, facts));
      return stronger(classifyTest(c, env, facts), stronger(t, f));
    }
    default:
      return truthOf(env.value(n, facts));
  }
}

// `a in b`. On a record (a message, a content part, a tool call, or anything an
// `is mapping` guard vouches for) it asks whether a key is there: a presence
// test. On a string it asks whether the text contains `a`: a content test when
// the string is conversation text. On a template constant it compares `a`
// against fixed values, so it is as strong as reading `a`.
function membership(a: Node, b: Node, env: TestEnv, facts: Facts): TestClass {
  const va = env.value(a, facts);
  const vb = env.value(b, facts);
  const gates = stronger(gateOf(va), gateOf(vb));
  let cls: TestClass;
  if (isMapping(vb)) cls = stronger(isRuntime(vb) ? "presence" : "none", readOf(va));
  else if (!isRuntime(vb)) cls = readOf(va);
  else cls = stronger(readOf(vb), readOf(va));
  return stronger(cls, gates);
}

function isMapping(v: Val): boolean {
  if (v.shape === "nonstring") return true;
  if (v.shape === "string") return false;
  return v.fields !== undefined && v.fields.length > 0 && v.fields.every((f) => f.kind === "record");
}

function testName(n: Node): string {
  const t = n.test as Node | undefined;
  if (!t) return "";
  if (t.type === "Identifier") return String(t.value);
  if (t.type === "CallExpression") return String((t.callee as Node | undefined)?.value ?? "");
  return "";
}

/** The canonical access path of a plain reference: `message.content` for both `message.content` and `message['content']`. */
export function pathOf(n: Node): string | undefined {
  let cur: Node | undefined = n;
  const parts: string[] = [];
  for (let i = 0; cur && i < 64; i++) {
    if (cur.type === "Identifier") {
      parts.push(String(cur.value));
      return parts.reverse().join(".");
    }
    if (cur.type !== "MemberExpression") return undefined;
    const p = cur.property as Node;
    if (!cur.computed && p?.type === "Identifier") parts.push(String(p.value));
    else if (cur.computed && p?.type === "StringLiteral") parts.push(String(p.value));
    else return undefined;
    cur = cur.object as Node;
  }
  return undefined;
}

/**
 * The guard facts that hold where `n` evaluated to `positive`: `x is string`
 * makes `x` a string, `x is mapping` and `x is not string` make it a non-string.
 * Returns `facts` itself when `n` adds nothing.
 */
export function factsFrom(n: Node, positive: boolean, facts: Facts): Facts {
  const out = new Map<string, "string" | "nonstring">();
  collectFacts(n, positive, out, 0);
  if (out.size === 0) return facts;
  const merged = new Map(facts);
  for (const [k, v] of out) merged.set(k, v);
  return merged;
}

function collectFacts(n: Node, positive: boolean, out: Map<string, "string" | "nonstring">, depth: number): void {
  if (!n || typeof n !== "object" || depth > 32) return;
  if (n.type === "UnaryExpression" && op(n) === "not") return collectFacts(n.argument as Node, !positive, out, depth + 1);
  if (n.type === "BinaryExpression") {
    const o = op(n);
    // Both sides of a true `and` hold; both sides of a false `or` fail.
    if ((o === "and" && positive) || (o === "or" && !positive)) {
      collectFacts(n.left as Node, positive, out, depth + 1);
      collectFacts(n.right as Node, positive, out, depth + 1);
    }
    return;
  }
  if (n.type !== "TestExpression") return;
  const path = pathOf(n.operand as Node);
  if (!path) return;
  const holds = positive !== Boolean(n.negate);
  const name = testName(n);
  if (name === "string") out.set(path, holds ? "string" : "nonstring");
  else if (name === "mapping" && holds) out.set(path, "nonstring");
}

/**
 * Which branch of an If is the generation prompt: `body` for a test that holds
 * when `add_generation_prompt` is true, `alternate` for its negation, undefined
 * when the test does not decide on it.
 */
export function genPolarity(n: Node, depth = 0): "body" | "alternate" | undefined {
  if (!n || typeof n !== "object" || depth > 32) return undefined;
  switch (n.type) {
    case "Identifier":
      return String(n.value) === "add_generation_prompt" ? "body" : undefined;
    case "UnaryExpression": {
      if (op(n) !== "not") return undefined;
      const inner = genPolarity(n.argument as Node, depth + 1);
      return inner === "body" ? "alternate" : inner === "alternate" ? "body" : undefined;
    }
    case "TestExpression": {
      const operand = n.operand as Node;
      if (operand?.type !== "Identifier" || String(operand.value) !== "add_generation_prompt") return undefined;
      const name = testName(n);
      if (name !== "true" && name !== "false") return undefined;
      return (name === "true") !== Boolean(n.negate) ? "body" : "alternate";
    }
    case "BinaryExpression": {
      const o = op(n);
      if (o === "and") {
        // The body runs only with the flag set when either conjunct requires it.
        const l = genPolarity(n.left as Node, depth + 1);
        const r = genPolarity(n.right as Node, depth + 1);
        return l === "body" || r === "body" ? "body" : undefined;
      }
      if (o === "or") {
        const l = genPolarity(n.left as Node, depth + 1);
        const r = genPolarity(n.right as Node, depth + 1);
        return l === "body" || r === "body" ? "body" : undefined;
      }
      if (o === "==" || o === "!=") {
        const l = n.left as Node;
        const r = n.right as Node;
        const flag = l?.type === "Identifier" && String(l.value) === "add_generation_prompt" ? r : r?.type === "Identifier" && String(r.value) === "add_generation_prompt" ? l : undefined;
        if (!flag || flag.type !== "Identifier") return undefined;
        const v = String(flag.value).toLowerCase();
        if (v !== "true" && v !== "false") return undefined;
        return (v === "true") === (o === "==") ? "body" : "alternate";
      }
      return undefined;
    }
    default:
      return undefined;
  }
}
