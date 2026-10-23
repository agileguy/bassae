// Test classification for the trigger rules (ISC-18, ISC-18.1): how strongly a
// conditional's outcome depends on what the user typed, or on chance.
//
// A test is one of four strengths, weakest first:
//   none              reads template constants only
//   presence          reads only whether runtime data is there and what shape it
//                     has: definedness, none, truthiness and emptiness (a length
//                     or loop position compared with 0 or 1), a message's role,
//                     a `type` or a kwarg compared with its documented vocabulary
//                     (`part.type == 'image'`, `reasoning_effort == 'high'`), an
//                     id compared for equality with another id (a call paired
//                     with its result), the keys of a record, and a tool's
//                     parameter schema
//   content           reads what a user, a tool or a caller wrote: message
//                     content and reasoning, a message's name, id or
//                     tool_call_id, a tool's or tool call's function name,
//                     description or arguments, documents, a `type` or a kwarg
//                     compared with a value outside its vocabulary, a length or
//                     loop threshold further than 1 from 0, anything serialized
//                     from these, or an unknown runtime variable
//   nondeterministic  reads the clock (strftime_now(), date_string, today) or a
//                     random choice
//
// The strength comes from two places: what the test itself reads (a comparison
// reads the whole value, `is defined` reads none of it) and what decided the
// values it reads. A variable assigned under a content test carries that test as
// its gate, so `{% if ns.found %}` after `{% if 'x' in m.content %}{% set
// ns.found = true %}` is a content test too (implicit flow).
//
// Which runtime data is content and which is presence is a fixed schema of the
// chat-template inputs (ROOTS below), and the vocabularies are the values the
// runtimes and stock templates use, never names taken from the template under
// scan (Decisions 19:15).

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
  /** The strongest class reachable from this node: what comparing, printing or serializing the whole value reveals. A list of messages is content because its messages are. */
  cls: Exclude<TestClass, "none">;
  /** `mixed` is a string or a list (message content); a membership test on it is a substring test unless a guard says otherwise. `count` is a number of items: a length or a loop position. */
  kind: "list" | "record" | "string" | "mixed" | "any" | "count";
  elem?: Field;
  fields?: Readonly<Record<string, Field>>;
  /** Any member not in `fields`. */
  other?: Field;
  /** The values a comparison may name and stay a presence test, in lower case: a `type`'s kinds, a kwarg's documented settings. */
  vocab?: ReadonlySet<string>;
  /** A count's constant shift: `messages|length - 1` is the count of messages at -1. */
  off?: number;
  /** The class of a test that compares a count with a threshold more than 1 away from it. */
  threshold?: "content" | "nondeterministic";
  /** An identifier that pairs records: a call's `id`, its result's `tool_call_id`. */
  ident?: true;
}

function vocab(...words: string[]): ReadonlySet<string> {
  return new Set(words);
}

// The kinds a content part, a message or a tool call declares, from the
// OpenAI, Anthropic and Hugging Face message formats and the stock templates.
const TYPES = vocab(
  "text", "image", "image_url", "input_image", "audio", "input_audio", "video", "video_url", "file", "refusal",
  "function", "tool_call", "tool_use", "tool_result", "thinking", "reasoning", "message", "function_call", "function_call_output",
);
// A boolean kwarg, in Jinja and Python spellings.
const FLAGS = vocab("true", "false", "none", "0", "1");
const EFFORTS = vocab("none", "minimal", "low", "medium", "high");
const TOOL_CHOICES = vocab("auto", "none", "required", "any");
// Llama 3.1's and gpt-oss's built-in tools.
const BUILTIN_NAMES = vocab("browser", "python", "brave_search", "wolfram_alpha", "code_interpreter");

const PRESENCE: Field = { cls: "presence", kind: "any" };
const TEXT: Field = { cls: "content", kind: "string" };
// A message's or tool call's `id` and a tool result's `tool_call_id`: content
// against a constant, but one compared for equality with another pairs a call
// with its result (Gemma 4), and no template value decides that.
const ID: Field = { cls: "content", kind: "string", ident: true };
const TYPE: Field = { cls: "content", kind: "string", vocab: TYPES };
// The date a runtime passes (Llama 3.x `date_string`, `today`): the clock, the
// same as a strftime_now() result.
const CLOCK: Field = { cls: "nondeterministic", kind: "string" };

// Unknown data under the conversation: every member and element is content too.
const ANY_CONTENT: Field = { cls: "content", kind: "any" };
(ANY_CONTENT as { elem?: Field; other?: Field }).elem = ANY_CONTENT;
(ANY_CONTENT as { elem?: Field; other?: Field }).other = ANY_CONTENT;

// A tool's parameter schema, and the special tokens: the deployment's own
// structure. Every member and element is schema as well, so tests deep inside
// it (`param.type == 'string'`, gpt-oss's `inner_type|length > 50` on the type
// it rendered) are presence tests.
const SCHEMA: Field = { cls: "presence", kind: "any" };
(SCHEMA as { elem?: Field; other?: Field }).elem = SCHEMA;
(SCHEMA as { elem?: Field; other?: Field }).other = SCHEMA;

// Tool-call arguments: a mapping (or its JSON string). Key tests on it are
// presence tests; its values are content.
const ARGS: Field = { cls: "content", kind: "record", other: ANY_CONTENT };
const FUNCTION: Field = { cls: "content", kind: "record", fields: { name: TEXT, arguments: ARGS }, other: ANY_CONTENT };
const TOOL_CALL: Field = { cls: "content", kind: "record", fields: { type: TYPE, id: ID, name: TEXT, function: FUNCTION, arguments: ARGS }, other: ANY_CONTENT };
const TOOL_CALLS: Field = { cls: "content", kind: "list", elem: TOOL_CALL };

// A content part: `{'type': 'text', 'text': ...}`, `{'type': 'image', ...}`.
const PART: Field = { cls: "content", kind: "record", fields: { type: TYPE }, other: ANY_CONTENT };
const MESSAGE_CONTENT: Field = { cls: "content", kind: "mixed", elem: PART, other: ANY_CONTENT };

// Role routes a message: a role test is a presence test whatever it names. A
// name, id or tool_call_id is a string the caller chose, so a value test on it
// can select one conversation out of many.
const MESSAGE: Field = {
  cls: "content",
  kind: "record",
  fields: {
    role: PRESENCE,
    type: TYPE,
    name: TEXT,
    id: ID,
    tool_call_id: ID,
    tool_calls: TOOL_CALLS,
    content: MESSAGE_CONTENT,
    reasoning_content: TEXT,
    reasoning: TEXT,
    thinking: TEXT,
  },
  other: ANY_CONTENT,
};
const MESSAGES: Field = { cls: "content", kind: "list", elem: MESSAGE };
const DOCUMENTS: Field = { cls: "content", kind: "list", elem: ANY_CONTENT };

// A tool definition, in the OpenAI form (`{'type': 'function', 'function':
// {...}}`) or bare. Its name and description are text the caller wrote; its
// parameters are schema.
const FUNCTION_DEF: Field = { cls: "content", kind: "record", fields: { name: TEXT, description: TEXT, parameters: SCHEMA, response: SCHEMA }, other: SCHEMA };
const TOOL: Field = { cls: "content", kind: "record", fields: { type: TYPE, function: FUNCTION_DEF, name: TEXT, description: TEXT, parameters: SCHEMA, response: SCHEMA }, other: SCHEMA };
const TOOLS: Field = { cls: "content", kind: "list", elem: TOOL };
const BUILTINS: Field = { cls: "content", kind: "list", elem: { cls: "content", kind: "string", vocab: BUILTIN_NAMES } };

// Kwargs with a documented set of values: content, except compared with one of them.
const FLAG: Field = { cls: "content", kind: "any", vocab: FLAGS };
const EFFORT: Field = { cls: "content", kind: "string", vocab: EFFORTS };
const TOOL_CHOICE: Field = { cls: "content", kind: "any", vocab: TOOL_CHOICES, fields: { type: TYPE, function: FUNCTION_DEF }, other: SCHEMA };

// Counts, one node per offset and threshold class so identity stays stable
// across passes. An offset past MAX_OFFSET saturates to infinity, so a loop
// that keeps adding to a count stops making new nodes and the fixpoint ends.
const MAX_OFFSET = 8;
const counts = new Map<string, Field>();

/** A count shifted by `off`, compared against a far threshold as `threshold`. Its own class is presence: its emptiness and its use as an index reveal nothing. */
export function countField(off: number, threshold: "content" | "nondeterministic"): Field {
  const o = Number.isNaN(off) || Math.abs(off) > MAX_OFFSET ? Infinity : off;
  const k = `${threshold}:${o}`;
  let f = counts.get(k);
  if (!f) counts.set(k, (f = { cls: "presence", kind: "count", off: o, threshold }));
  return f;
}

const COUNT = countField(0, "content");

// `loop`: positions and the length are counts; previtem and nextitem are the
// neighbouring elements, messages in every stock template.
const LOOP: Field = {
  cls: "content",
  kind: "record",
  fields: {
    index: COUNT,
    index0: COUNT,
    revindex: COUNT,
    revindex0: COUNT,
    length: COUNT,
    depth: COUNT,
    depth0: COUNT,
    first: PRESENCE,
    last: PRESENCE,
    previtem: MESSAGE,
    nextitem: MESSAGE,
  },
  other: PRESENCE,
};

const ROOTS: Readonly<Record<string, Field>> = {
  messages: MESSAGES,
  message: MESSAGE,
  content: MESSAGE_CONTENT,
  tool_calls: TOOL_CALLS,
  tool_call: TOOL_CALL,
  documents: DOCUMENTS,
  document: ANY_CONTENT,
  system_message: TEXT,
  // tool definitions
  tools: TOOLS,
  tool: TOOL,
  custom_tools: TOOLS,
  available_tools: TOOLS,
  xml_tools: TOOLS,
  builtin_tools: BUILTINS,
  // kwargs
  tools_in_user_message: FLAG,
  add_generation_prompt: FLAG,
  continue_final_message: FLAG,
  enable_thinking: FLAG,
  tool_choice: TOOL_CHOICE,
  reasoning_effort: EFFORT,
  model_identity: TEXT,
  bos_token: SCHEMA,
  eos_token: SCHEMA,
  pad_token: SCHEMA,
  unk_token: SCHEMA,
  date_string: CLOCK,
  today: CLOCK,
  loop: LOOP,
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

/** A set of schema nodes, by identity: a variable assigned from two different fields is either one. Sets only grow under join, and the nodes are finite, so the fixpoint converges. */
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
export function clsOf(fs: Fields): Exclude<TestClass, "none"> {
  let c: Exclude<TestClass, "none"> = "presence";
  for (const f of fs) if (RANK[f.cls] > RANK[c]) c = f.cls;
  return c;
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

/**
 * The class of comparing a value that may be any of `fs` with the constant
 * `value`: presence for a field whose vocabulary has it, the field's own class
 * otherwise. Undefined when no field has a vocabulary.
 */
export function vocabClass(fs: Fields, value: unknown): TestClass | undefined {
  if (!fs.some((f) => f.vocab)) return undefined;
  const word = vocabWord(value);
  let c: TestClass = "presence";
  for (const f of fs) c = stronger(c, word !== undefined && f.vocab?.has(word) ? "presence" : f.cls);
  return c;
}

function vocabWord(v: unknown): string | undefined {
  if (v === null) return "none";
  if (typeof v === "string") return v.trim().toLowerCase();
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return undefined;
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
  /** It reached a variable under a content test that reads a value already holding it (`set r = c.split('</think>')[0]` under `'</think>' in c`): the test moved the text, it did not put it there. */
  routed?: boolean;
  /** Not text: a runtime value or whitespace printed here, so the literals on either side are not adjacent. */
  brk?: true;
  /** Folded from several literals (`'a' ~ 'b'`, `|join`): no one literal in the template holds this text. */
  folded?: true;
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
  /** With `fields`: the value may be something else instead (a constant or other value a branch, `or` or `|default` joined in), and comparing that reveals this much. Unset while it is only ever one of `fields`. */
  rest?: TestClass;
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
  /** The clock or chance as a value (`set f = strftime_now`): calling the value calls them. */
  fns?: string[];
  /** It is `add_generation_prompt`, or a copy of it (`set g = add_generation_prompt`). */
  genFlag?: true;
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
// `date_string is defined` stays a presence test even though the value is the
// clock: the test does not read the date.
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

/** What `v` may be besides its fields, for a join: all of it when it has none. */
export function restOf(v: Val): TestClass | undefined {
  return v.fields ? v.rest : v.data;
}

/** Either of two rests. */
export function eitherRest(a: TestClass | undefined, b: TestClass | undefined): TestClass | undefined {
  return a === undefined ? b : b === undefined ? a : stronger(a, b);
}

// A test the fields alone pass as `cls`, on a value that may be something
// besides them: that other value is tested too.
function withRest(cls: TestClass | undefined, rest: TestClass | undefined): TestClass | undefined {
  return cls === undefined || rest === undefined ? cls : stronger(cls, rest);
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
      if (COMPARISONS.has(o)) return comparison(n.left as Node, n.right as Node, o, env, facts);
      return truthiness(n, env, facts);
    }
    case "TestExpression": {
      const name = testName(n);
      const v = env.value(n.operand as Node, facts);
      if (SHAPE_TESTS.has(name)) return stronger(isRuntime(v) ? "presence" : "none", gateOf(v));
      if (TRUTH_TESTS.has(name)) return truthOf(v);
      return readOf(v); // odd, even, lower, upper, ...: the value itself
    }
    case "Ternary": {
      const c = n.condition as Node;
      const t = classifyTest(n.trueExpr as Node, env, factsFrom(c, true, facts));
      const f = classifyTest(n.falseExpr as Node, env, factsFrom(c, false, facts));
      return stronger(classifyTest(c, env, facts), stronger(t, f));
    }
    default:
      return truthiness(n, env, facts);
  }
}

// A value used as a condition. A count is compared with 0: `{% if
// messages|length - 20 %}` is the threshold test `messages|length != 20`.
function truthiness(n: Node, env: TestEnv, facts: Facts): TestClass {
  const v = operand(n, env, facts, 0);
  return countTest(v, ZERO) ?? truthOf(v);
}

// `a == b`, `a < b`, ...: a count against a threshold, a field with a
// vocabulary against a constant, an id against an id, or else both values read
// whole.
function comparison(a: Node, b: Node, o: string, env: TestEnv, facts: Facts): TestClass {
  const va = operand(a, env, facts, 0);
  const vb = operand(b, env, facts, 0);
  const gates = stronger(gateOf(va), gateOf(vb));
  const join = (o === "==" || o === "!=") && identOnly(va) && identOnly(vb) ? "presence" : undefined;
  const cls = countTest(va, vb) ?? countTest(vb, va) ?? vocabTest(a, vb, env, facts) ?? vocabTest(b, va, env, facts) ?? join ?? stronger(readOf(va), readOf(vb));
  return stronger(cls, gates);
}

// `a in b`. On a record (a message, a content part, a tool call, or anything an
// `is mapping` guard vouches for) it asks whether a key is there: a presence
// test. On a string it asks whether the text contains `a`: a content test when
// the string is conversation text. On a template constant it compares `a`
// against fixed values, so it is as strong as reading `a`. A field with a
// vocabulary is judged against it: `p.type in ['image', 'video']`, `'browser'
// in builtin_tools`.
function membership(a: Node, b: Node, env: TestEnv, facts: Facts): TestClass {
  const va = env.value(a, facts);
  const vb = env.value(b, facts);
  const gates = stronger(gateOf(va), gateOf(vb));
  let cls = vocabIn(a, b, vb, env, facts);
  if (cls === undefined) {
    if (isMapping(vb)) cls = stronger(isRuntime(vb) ? "presence" : "none", stronger(readOf(va), vb.rest ?? "none"));
    else if (!isRuntime(vb)) cls = readOf(va);
    else cls = stronger(readOf(vb), readOf(va));
  }
  return stronger(cls, gates);
}

function vocabIn(a: Node, b: Node, vb: Val, env: TestEnv, facts: Facts): TestClass | undefined {
  const list = constList(b, vb, env, facts);
  if (list) {
    // The field against each value of a constant list.
    const va = env.value(uncased(a), facts);
    const fs = va.fields;
    if (!fs) return undefined;
    let cls: TestClass = "presence";
    for (const k of list) {
      const c = vocabClass(fs, k);
      if (c === undefined) return undefined;
      cls = stronger(cls, c);
    }
    return withRest(cls, va.rest);
  }
  // A constant in a list of vocabulary values, or in one such value.
  const k = constOf(env.value(a, facts));
  if (k === undefined || !vb.fields || vb.fields.length === 0) return undefined;
  const fs = vb.fields.every((f) => f.kind === "list") ? mapFields(vb.fields, elementField) : vb.fields;
  return withRest(vocabClass(fs, k), vb.rest);
}

// `x` compared with the constant `other`, when `x` has a vocabulary. Case and
// whitespace filters are looked through: `p.type|lower == 'image'`.
function vocabTest(x: Node, other: Val, env: TestEnv, facts: Facts): TestClass | undefined {
  const k = constOf(other);
  if (k === undefined) return undefined;
  const v = env.value(uncased(x), facts);
  return v.fields ? withRest(vocabClass(v.fields, k), v.rest) : undefined;
}

const CASE_FILTERS = new Set(["lower", "upper", "trim", "string", "capitalize", "title"]);
const CASE_METHODS = new Set(["lower", "upper", "strip", "lstrip", "rstrip", "capitalize", "title", "casefold"]);

// The operand under `|lower`, `|trim`, `.upper()` and the like.
function uncased(n: Node): Node {
  for (let i = 0; i < 8 && n && typeof n === "object"; i++) {
    if (n.type === "FilterExpression" && CASE_FILTERS.has(filterName(n.filter as Node))) n = n.operand as Node;
    else if (n.type === "CallExpression" && ((n.args as Node[] | undefined) ?? []).length === 0 && isCaseMethod(n.callee as Node)) n = (n.callee as Node).object as Node;
    else break;
  }
  return n;
}

function isCaseMethod(callee: Node): boolean {
  return callee?.type === "MemberExpression" && !callee.computed && (callee.property as Node)?.type === "Identifier" && CASE_METHODS.has(String((callee.property as Node).value));
}

/** A compile-time constant the value is, when it depends on no runtime input. */
function constOf(v: Val): string | number | boolean | null | undefined {
  return isRuntime(v) ? undefined : v.konst;
}

// The constants of a list literal (`['image', 'video']`, `[true, none]`) or of a
// variable set to a list of strings.
function constList(n: Node, v: Val, env: TestEnv, facts: Facts): (string | number | boolean | null)[] | undefined {
  if (isRuntime(v)) return undefined;
  if (n?.type === "ArrayLiteral" || n?.type === "TupleLiteral") {
    const out: (string | number | boolean | null)[] = [];
    for (const el of (n.value as Node[]) ?? []) {
      const k = constOf(env.value(el, facts));
      if (k === undefined) return undefined;
      out.push(k);
    }
    return out;
  }
  return v.konstList;
}

// ---- counts ----

const ZERO: Val = { lits: [], data: "none", truth: "none", konst: 0 };
const ARITHMETIC = new Set(["+", "-", "*", "/", "//", "%", "**"]);
const LENGTHS = new Set(["length", "count", "wordcount"]);

function filterName(f: Node): string {
  if (!f || typeof f !== "object") return "";
  if (f.type === "Identifier") return String(f.value);
  if (f.type === "CallExpression") return String((f.callee as Node | undefined)?.value ?? "");
  return "";
}

// The value of a comparison operand, with lengths and arithmetic on counts read
// from the AST, so `messages|length > 20` and `loop.index0 % 40 == 0` are
// judged even where the extraction does not carry counts through.
function operand(n: Node, env: TestEnv, facts: Facts, depth: number): Val {
  const v = env.value(n, facts);
  if (countsOf(v) || depth > 16 || !n || typeof n !== "object") return v;
  if (n.type === "FilterExpression" && LENGTHS.has(filterName(n.filter as Node))) {
    return { ...lengthOf(operand(n.operand as Node, env, facts, depth + 1)), gate: v.gate };
  }
  if (n.type === "BinaryExpression" && ARITHMETIC.has(op(n))) {
    const l = operand(n.left as Node, env, facts, depth + 1);
    const r = operand(n.right as Node, env, facts, depth + 1);
    const k = countArith(l, r, op(n));
    if (k) return { ...k, gate: strongest(k.gate, v.gate) };
    // A threshold value further down stays one: `(loop.index0 + 40) % 2`.
    return { ...v, data: stronger(v.data, stronger(l.data, r.data)), truth: stronger(v.truth, stronger(l.truth, r.truth)) };
  }
  return v;
}

// Runtime data that is only ever ids: `tc.get('id') == follow.get('tool_call_id')`
// pairs a call with its result. Neither side is a template constant, so the
// equality cannot name a trigger value (Decisions 20:15). An id that may be
// something else instead (`tc.id or 'sudo'`, `tc.id|default('sudo')`) may be
// that constant, so it is no join.
function identOnly(v: Val): boolean {
  return v.rest === undefined && !!v.fields && v.fields.length > 0 && v.fields.every((f) => f.ident === true);
}

/** The counts a value may be, when every field it may be is a count (`rest` says what else it may be). */
function countsOf(v: Val): Fields | undefined {
  return v.fields && v.fields.length > 0 && v.fields.every((f) => f.kind === "count") ? v.fields : undefined;
}

function thresholdOf(fs: Fields): TestClass {
  let c: TestClass = "presence";
  for (const f of fs) c = stronger(c, f.threshold ?? "content");
  return c;
}

// A count against a constant or another count. Within 1 of the count it asks
// whether there is anything, or one thing, or whether this is the first or last
// position: as telling as the value's emptiness. Further away it is a threshold
// a long enough conversation crosses (ISC-18, Decisions 19:15). A template value
// whose constant is not known (`40 if tools else 41`) may be any threshold, and
// so may a count that may be such a value instead (`n if c else 40`) when it
// is compared with a count.
function countTest(x: Val, other: Val): TestClass | undefined {
  const xs = countsOf(x);
  if (!xs) return undefined;
  const near = stronger(stronger(readOf(x), readOf(other)), stronger(x.rest ?? "none", other.rest ?? "none"));
  const ys = countsOf(other);
  let far: boolean;
  if (ys) far = x.rest !== undefined || other.rest !== undefined || xs.some((a) => ys.some((b) => !(Math.abs(a.off! - b.off!) <= 1)));
  else if (isRuntime(other)) return undefined;
  else if (typeof other.konst === "number") far = xs.some((a) => !(Math.abs((other.konst as number) - a.off!) <= 1));
  else far = other.konst === undefined;
  return far ? stronger(near, ys ? stronger(thresholdOf(xs), thresholdOf(ys)) : thresholdOf(xs)) : near;
}

/**
 * `|length`, `|count`, `|wordcount`: as telling as the value's emptiness, and
 * a count when the value holds content or the clock, so a threshold on it is
 * judged as one. The length of schema is never a count.
 */
export function lengthOf(o: Val, gate?: Cond): Val {
  const v: Val = { lits: [], data: o.truth, truth: o.truth, gate: gate ?? o.gate };
  if (countsOf(o)) return v; // a number has no length
  const d = o.fields ? clsOf(o.fields) : o.data;
  return d === "content" || d === "nondeterministic" ? { ...v, fields: [countField(0, d)], rest: o.rest } : v;
}

/**
 * Arithmetic with a count on one side: `± k` shifts it, `% 2` and `* 1` keep
 * it, and any other constant scales it into a value whose every test is a
 * threshold. Two counts added or subtracted are a count at the sum or
 * difference of their offsets. Undefined when neither side is a count, or the
 * other side is a runtime value that is not one.
 */
export function countArith(l: Val, r: Val, operator: string): Val | undefined {
  const lc = countsOf(l);
  const rc = countsOf(r);
  if ((!lc && !rc) || !ARITHMETIC.has(operator)) return undefined;
  const gate = strongest(l.gate, r.gate);
  const data = stronger(l.data, r.data);
  // A count operand that may be a constant instead makes a result that may be one.
  const rest = eitherRest(lc ? l.rest : undefined, rc ? r.rest : undefined);
  const shifted = (fs: Fields, d: number): Val => ({ lits: [], data, truth: data, gate, fields: fs.map((f) => countField(f.off! + d, f.threshold ?? "content")), rest });
  const scaled = (fs: Fields): Val => {
    const t = stronger(data, thresholdOf(fs));
    return { lits: [], data: t, truth: t, gate };
  };
  if (lc && rc) {
    if (operator !== "+" && operator !== "-") return scaled([...lc, ...rc]);
    const out: Field[] = [];
    for (const a of lc) for (const b of rc) {
      const f = countField(operator === "+" ? a.off! + b.off! : a.off! - b.off!, stronger(a.threshold ?? "content", b.threshold ?? "content") as "content" | "nondeterministic");
      if (!out.includes(f)) out.push(f);
    }
    return { lits: [], data, truth: data, gate, fields: out, rest };
  }
  const fs = (lc ?? rc)!;
  const k = constOf(lc ? r : l);
  if (typeof k !== "number") return isRuntime(lc ? r : l) ? undefined : scaled(fs);
  switch (operator) {
    case "+":
      return shifted(fs, k);
    case "-":
      return lc ? shifted(fs, -k) : scaled(fs);
    case "%":
      return lc && Math.abs(k) <= 2 ? shifted(fs, 0) : scaled(fs);
    case "*":
    case "/":
    case "//":
      // By 1 the count is unchanged; by -1 it is negated, which compares with
      // 0 and 1 the same way only when it has no shift.
      if (operator !== "*" && !lc) return scaled(fs);
      return k === 1 || (k === -1 && fs.every((f) => f.off === 0)) ? shifted(fs, 0) : scaled(fs);
    default:
      return scaled(fs);
  }
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
 * Which branch of an If runs only when `add_generation_prompt` is set: `body`
 * when the test holding implies the flag, `alternate` when the test failing
 * does, undefined when neither does. `isFlag` says which expressions are the
 * flag; the caller can resolve copies of it (`set g = add_generation_prompt`).
 */
export function genPolarity(n: Node, isFlag: (n: Node) => boolean = isGenFlag, depth = 0): "body" | "alternate" | undefined {
  if (!n || typeof n !== "object" || depth > 32) return undefined;
  if (isFlag(n)) return "body";
  const sub = (x: unknown) => genPolarity(x as Node, isFlag, depth + 1);
  switch (n.type) {
    case "UnaryExpression":
      return op(n) === "not" ? flip(sub(n.argument)) : undefined;
    case "FilterExpression":
      // `|default(false)`, `|int` and `|bool` keep the flag's truth.
      return FLAG_FILTERS.has(filterNameOf(n.filter as Node)) ? sub(n.operand) : undefined;
    case "TestExpression": {
      const name = testName(n);
      if (name !== "true" && name !== "false") return undefined;
      const p = sub(n.operand);
      return (name === "true") !== Boolean(n.negate) ? p : flip(p);
    }
    case "BinaryExpression": {
      const o = op(n);
      if (o === "and" || o === "or") {
        const l = sub(n.left);
        const r = sub(n.right);
        // `a and b` holds only when both do, so either implying the flag is
        // enough; it fails when either fails, so both failures must imply it.
        // `a or b` is the dual.
        const [one, both] = o === "and" ? ["body", "alternate"] : ["alternate", "body"];
        if (l === one || r === one) return one as "body" | "alternate";
        return l === both && r === both ? (both as "body" | "alternate") : undefined;
      }
      if (o === "==" || o === "!=") {
        const lk = boolKonst(n.left as Node);
        const rk = boolKonst(n.right as Node);
        const p = lk !== undefined ? sub(n.right) : rk !== undefined ? sub(n.left) : undefined;
        const k = lk ?? rk;
        if (p === undefined || k === undefined) return undefined;
        return k === (o === "==") ? p : flip(p);
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

function isGenFlag(n: Node): boolean {
  return n.type === "Identifier" && String(n.value) === "add_generation_prompt";
}

export const FLAG_FILTERS = new Set(["default", "d", "int", "bool"]);

function filterNameOf(f: Node): string {
  if (f?.type === "Identifier") return String(f.value);
  if (f?.type === "CallExpression") return String((f.callee as Node | undefined)?.value ?? "");
  return "";
}

function flip(p: "body" | "alternate" | undefined): "body" | "alternate" | undefined {
  return p === "body" ? "alternate" : p === "alternate" ? "body" : undefined;
}

// `true`, `True`, `1` as true; `false`, `False`, `0` as false.
function boolKonst(n: Node): boolean | undefined {
  if (n?.type === "Identifier") {
    const v = String(n.value).toLowerCase();
    return v === "true" ? true : v === "false" ? false : undefined;
  }
  if (n?.type === "IntegerLiteral") {
    const v = Number(n.value);
    return v === 1 ? true : v === 0 ? false : undefined;
  }
  return undefined;
}
