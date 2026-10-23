// jinja2 builtins that @huggingface/jinja 0.5.10 lacks or gets wrong, added to its interpreter inside the
// render worker (ISC-12.1). Importing this file changes nothing: only installPolyfills does, and only the
// sandboxed worker calls it, so the parse layer and the rules in the parent keep the library as it ships.
// Each polyfill follows jinja2 3.1 (filters.py, tests.py) under the ImmutableSandboxedEnvironment that
// transformers renders with; the jinja2 function it copies is named where it is defined.

import { Environment, Interpreter } from "@huggingface/jinja";

/** A library runtime value. The library exports none of its value classes, so this is their shape. */
interface Value {
  type: string;
  value: unknown;
  readonly builtins: ReadonlyMap<string, Value>;
  __bool__(): { value: boolean };
  toString(): string;
}
type ValueClass = new (value?: unknown) => Value;

/** An AST node, read by its `.type` as the interpreter reads it. */
interface Node {
  type: string;
  [k: string]: unknown;
}

/** The interpreter's private methods the polyfills wrap or call; they are ordinary methods at runtime. */
interface Internals {
  evaluate(node: Node, env: Environment): Value;
  evaluateArguments(args: Node[], env: Environment): [Value[], Map<string, Value>];
  applyFilter(operand: Value, filter: Node, env: Environment): Value;
  evaluateMemberExpression(expr: Node, env: Environment): Value;
  evaluateBinaryExpression(expr: Node, env: Environment): Value;
  evaluateFor(node: Node, env: Environment): Value;
}

type Test = (...values: Value[]) => boolean;
type Filter = (this: Internals, operand: Value, args: Value[], kwargs: Map<string, Value>, env: Environment) => Value;

// Every filter jinja2 3.1 ships. map() may name only these, as jinja2's call_filter allows only its own.
export const JINJA2_FILTERS: ReadonlySet<string> = new Set([
  "abs", "attr", "batch", "capitalize", "center", "count", "d", "default", "dictsort", "e", "escape",
  "filesizeformat", "first", "float", "forceescape", "format", "groupby", "indent", "int", "items", "join",
  "last", "length", "list", "lower", "map", "max", "min", "pprint", "random", "reject", "rejectattr",
  "replace", "reverse", "round", "safe", "select", "selectattr", "slice", "sort", "string", "striptags",
  "sum", "title", "tojson", "trim", "truncate", "unique", "upper", "urlencode", "urlize", "wordcount",
  "wordwrap", "xmlattr",
]);

// Every test jinja2 3.1 ships, with its parameters after the value. The operator aliases and callable are C
// builtins (operator.eq, callable) that take no keyword arguments; the rest are Python functions.
type TestSpec = { params: readonly string[]; positionalOnly?: boolean };
export const JINJA2_TESTS: ReadonlyMap<string, TestSpec> = new Map<string, TestSpec>([
  ...["odd", "even", "defined", "undefined", "filter", "test", "none", "boolean", "false", "true", "integer", "float"].map((n): [string, TestSpec] => [n, { params: [] }]),
  ...["lower", "upper", "string", "mapping", "number", "sequence", "iterable", "escaped"].map((n): [string, TestSpec] => [n, { params: [] }]),
  ["callable", { params: [], positionalOnly: true }],
  ["divisibleby", { params: ["num"] }],
  ["sameas", { params: ["other"] }],
  ["in", { params: ["seq"] }],
  ...["==", "eq", "equalto", "!=", "ne", ">", "gt", "greaterthan", ">=", "ge", "<", "lt", "lessthan", "<=", "le"].map(
    (n): [string, TestSpec] => [n, { params: ["b"], positionalOnly: true }],
  ),
]);

// The library turns plain values into its own classes, which is how this file reaches them.
const samples = new Environment();
const classOf = (name: string, sample: unknown) => samples.set(name, sample).constructor as unknown as ValueClass;
const StringValue = classOf("s", "");
const IntegerValue = classOf("i", 0);
const BooleanValue = classOf("b", false);
const UndefinedValue = classOf("u", undefined);
const ArrayValue = classOf("a", []);
const ObjectValue = classOf("o", {});

const str = (s: string) => new StringValue(s);
const int = (n: number) => new IntegerValue(n);
const bool = (b: boolean) => new BooleanValue(b);
const undef = () => new UndefinedValue();
const items = (v: Value) => v.value as Value[];
const text = (v: Value) => v.value as string;
const entries = (v: Value) => v.value as Map<string, Value>;
const truthy = (v: Value) => v.__bool__().value;
// Plain predicates: an instanceof on a class typed only by shape would narrow every other value away.
const isArray = (v: Value): boolean => v instanceof ArrayValue;
const isDict = (v: Value): boolean => v instanceof ObjectValue;

/**
 * What select, reject, selectattr, rejectattr and map return in jinja2: a generator. It is always true, has no
 * length, items or JSON form, prints as a generator object, and is used up by whatever iterates it. The library's
 * own code may still read `.value` to see the items left; that look uses nothing up.
 */
class GeneratorValue extends ArrayValue {
  #source: Iterator<Value>;
  #pulled: Value[] = [];

  constructor(
    readonly fn: string,
    source: Iterator<Value>,
  ) {
    super([]);
    this.#source = source;
    Object.defineProperty(this, "value", { get: () => this.peek(), configurable: true });
  }

  /** The items left, pulled from the source but not used up. */
  peek(): Value[] {
    for (let r = this.#source.next(); !r.done; r = this.#source.next()) this.#pulled.push(r.value);
    return this.#pulled;
  }

  /** Uses up one item, as Python's next() does; undefined once there are none. */
  next(): Value | undefined {
    if (this.#pulled.length > 0) return this.#pulled.shift();
    const r = this.#source.next();
    return r.done ? undefined : r.value;
  }

  /** Uses up every item left, as list() does. */
  take(): Value[] {
    const rest = this.peek();
    this.#pulled = [];
    return rest;
  }

  override __bool__() {
    return bool(true) as unknown as { value: boolean };
  }

  // jinja2 prints the generator's repr, whose address differs from run to run; this one never does.
  override toString(): string {
    return `<generator object ${this.fn} at 0x0>`;
  }
}

const PY_TYPES = new Map([
  ["IntegerValue", "int"], ["FloatValue", "float"], ["BooleanValue", "bool"], ["StringValue", "str"], ["NullValue", "NoneType"],
  ["UndefinedValue", "Undefined"], ["ArrayValue", "list"], ["TupleValue", "tuple"], ["ObjectValue", "dict"],
  ["KeywordArgumentsValue", "dict"], ["NamespaceValue", "Namespace"], ["FunctionValue", "function"],
]);
const pyType = (v: Value) => (v instanceof GeneratorValue ? "generator" : (PY_TYPES.get(v.type) ?? v.type));
const isList = (v: Value) => isArray(v) && !(v instanceof GeneratorValue);

/** Python's iter(): a generator is used up as the loop goes, and anything not iterable raises when the loop starts. */
function* iterate(v: Value): Generator<Value, void, undefined> {
  if (v instanceof GeneratorValue) {
    for (let x = v.next(); x !== undefined; x = v.next()) yield x;
  } else if (isArray(v)) {
    yield* items(v);
  } else if (v.type === "StringValue") {
    for (const ch of text(v)) yield str(ch);
  } else if (isDict(v)) {
    for (const key of entries(v).keys()) yield str(key);
  } else if (v.type !== "UndefinedValue") {
    throw new TypeError(`'${pyType(v)}' object is not iterable`);
  }
}

/** A bool, int or float as Python compares it; undefined for anything else. */
function numeric(v: Value): number | undefined {
  if (v.type === "IntegerValue" || v.type === "FloatValue") return v.value as number;
  if (v.type === "BooleanValue") return v.value ? 1 : 0;
  return undefined;
}

/** Python's ==. Lists, tuples and dicts compare by value; a generator, function or namespace only to itself. */
function pyEquals(a: Value, b: Value): boolean {
  if (a === b) return true;
  const x = numeric(a);
  const y = numeric(b);
  if (x !== undefined || y !== undefined) return x === y;
  if (isList(a) && isList(b)) {
    if ((a.type === "TupleValue") !== (b.type === "TupleValue") || items(a).length !== items(b).length) return false;
    return items(a).every((item, i) => pyEquals(item, items(b)[i]!));
  }
  if (isDict(a) && isDict(b)) {
    if (entries(a).size !== entries(b).size) return false;
    for (const [key, value] of entries(a)) {
      const other = entries(b).get(key);
      if (other === undefined || !pyEquals(value, other)) return false;
    }
    return true;
  }
  // jinja2's Undefined equals any Undefined; strings and None compare by value.
  return a.type === b.type && ["StringValue", "NullValue", "UndefinedValue"].includes(a.type) && a.value === b.value;
}

/** Orders two strings by code point, as Python does; JavaScript's < orders by UTF-16 unit. */
function compareStrings(s: string, t: string): number {
  let i = 0;
  while (i < s.length && i < t.length) {
    const a = s.codePointAt(i)!;
    const b = t.codePointAt(i)!;
    if (a !== b) return a - b;
    i += a > 0xffff ? 2 : 1;
  }
  return s.length - t.length;
}

type Order = "<" | "<=" | ">" | ">=";

function ordered(c: number, op: Order): boolean {
  return op === "<" ? c < 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : c >= 0;
}

/** Python's <, <=, > and >=: numbers, strings, and lists or tuples item by item; anything else raises. */
function pyCompare(a: Value, b: Value, op: Order): boolean {
  if (a.type === "UndefinedValue" || b.type === "UndefinedValue") throw new Error(`UndefinedError: an undefined value does not support '${op}'`);
  const x = numeric(a);
  const y = numeric(b);
  if (x !== undefined && y !== undefined) return op === "<" ? x < y : op === "<=" ? x <= y : op === ">" ? x > y : x >= y;
  if (a.type === "StringValue" && b.type === "StringValue") return ordered(compareStrings(text(a), text(b)), op);
  if (isList(a) && isList(b) && (a.type === "TupleValue") === (b.type === "TupleValue")) {
    const [p, q] = [items(a), items(b)];
    for (let i = 0; i < Math.min(p.length, q.length); i++) if (!pyEquals(p[i]!, q[i]!)) return pyCompare(p[i]!, q[i]!, op);
    return ordered(p.length - q.length, op);
  }
  throw new TypeError(`'${op}' not supported between instances of '${pyType(a)}' and '${pyType(b)}'`);
}

/** Raises Python's TypeError for a value that cannot be a dict key. */
function requireHashable(v: Value): void {
  if (v.type === "TupleValue") items(v).forEach(requireHashable);
  else if (isList(v) || isDict(v)) throw new TypeError(`unhashable type: '${pyType(v)}'`);
}

/** Python's `value in seq`: a substring, a dict key, or an item equal to it, using up a generator up to the match. */
function pyContains(seq: Value, value: Value): boolean {
  if (seq.type === "StringValue") {
    if (value.type !== "StringValue") throw new TypeError(`'in <string>' requires string as left operand, not ${pyType(value)}`);
    return text(seq).includes(text(value));
  }
  if (isDict(seq)) {
    requireHashable(value);
    return value.type === "StringValue" && entries(seq).has(text(value));
  }
  if (isArray(seq) || seq.type === "UndefinedValue") {
    for (const item of iterate(seq)) if (pyEquals(item, value)) return true;
    return false;
  }
  throw new TypeError(`argument of type '${pyType(seq)}' is not iterable`);
}

/**
 * Binds a call's arguments to a jinja2 builtin's parameters after the value, as Python would, and raises
 * Python's TypeError when they do not fit. Parameters missing from `defaults` are required.
 */
function bind(fn: string, params: readonly string[], args: Value[], kwargs: ReadonlyMap<string, Value>, defaults: ReadonlyMap<string, Value> = new Map(), positionalOnly = false): Value[] {
  if (args.length > params.length) throw new TypeError(`${fn}() takes ${params.length + 1} positional arguments but ${args.length + 1} were given`);
  if (positionalOnly && kwargs.size > 0) throw new TypeError(`${fn}() takes no keyword arguments`);
  const bound: (Value | undefined)[] = [...args];
  for (const [key, value] of kwargs) {
    const i = params.indexOf(key);
    if (i < 0 && key !== "value") throw new TypeError(`${fn}() got an unexpected keyword argument '${key}'`);
    if (i < 0 || bound[i] !== undefined) throw new TypeError(`${fn}() got multiple values for argument '${key}'`);
    bound[i] = value;
  }
  return params.map((p, i) => {
    const v = bound[i] ?? defaults.get(p);
    if (v === undefined) throw new TypeError(`${fn}() missing required argument: '${p}'`);
    return v;
  });
}

/**
 * jinja2's sandboxed getitem for one step of an attribute path: an item, else an attribute (here the library's
 * own builtins, as its `x.name` gives), else undefined. Stepping into an undefined raises UndefinedError.
 */
function getItem(obj: Value, key: Value): Value {
  if (obj.type === "UndefinedValue") throw new Error(`UndefinedError: an undefined value has no item '${key.toString()}'`);
  if (obj instanceof GeneratorValue) return undef();
  const name = key.type === "StringValue" ? text(key) : undefined;
  if (isDict(obj)) return (name === undefined ? undefined : (entries(obj).get(name) ?? obj.builtins.get(name))) ?? undef();
  if (obj.type === "NamespaceValue") return (name === undefined ? undefined : entries(obj).get(name)) ?? undef();
  const index = key.type === "IntegerValue" ? (key.value as number) : key.type === "BooleanValue" ? Number(key.value) : undefined;
  if (isArray(obj)) return (index === undefined ? undefined : items(obj).at(index)) ?? undef();
  if (obj.type === "StringValue") {
    if (index !== undefined) {
      const ch = Array.from(text(obj)).at(index);
      return ch === undefined ? undef() : str(ch);
    }
    return (name === undefined ? undefined : obj.builtins.get(name)) ?? undef();
  }
  return undef();
}

/**
 * jinja2 make_attrgetter: a dotted path whose all-digit parts are indexes, or one non-string key. A `fallback`
 * other than none replaces each undefined step, and `post` maps the result.
 */
function attrGetter(attribute: Value | undefined, fallback?: Value, post?: (v: Value) => Value): (item: Value) => Value {
  const parts =
    attribute === undefined || attribute.type === "NullValue"
      ? []
      : attribute.type === "StringValue"
        ? text(attribute).split(".").map((p) => (/^[0-9]+$/.test(p) ? int(Number(p)) : str(p)))
        : [attribute];
  const replace = fallback !== undefined && fallback.type !== "NullValue" ? fallback : undefined;
  return (item) => {
    for (const part of parts) {
      item = getItem(item, part);
      if (replace && item.type === "UndefinedValue") item = replace;
    }
    return post ? post(item) : item;
  };
}

// The library's test map, shared by every Environment it makes.
const TESTS = (Environment as unknown as { TESTS: Map<string, Test> }).TESTS;

/** A test of the value against one argument. jinja2 raises when the argument is missing, as in a bare `x is in`. */
const withArgument =
  (name: string, fn: (a: Value, b: Value) => boolean): Test =>
  (...v) => {
    if (v.length !== 2) throw new TypeError(`${name}() takes exactly 2 arguments (${v.length} given)`);
    return fn(v[0]!, v[1]!);
  };

// jinja2 tests.py: test_in, test_float, and the operator module behind each comparison alias.
const POLYFILLED_TESTS: [string, Test][] = [
  ["in", withArgument("test_in", (value, seq) => pyContains(seq, value))],
  ["float", (value) => value.type === "FloatValue"],
  ...["==", "eq", "equalto"].map((n): [string, Test] => [n, withArgument("eq", pyEquals)]),
  ...["!=", "ne"].map((n): [string, Test] => [n, withArgument("ne", (a, b) => !pyEquals(a, b))]),
  ...["gt", ">", "greaterthan"].map((n): [string, Test] => [n, withArgument("gt", (a, b) => pyCompare(a, b, ">"))]),
  ...["ge", ">="].map((n): [string, Test] => [n, withArgument("ge", (a, b) => pyCompare(a, b, ">="))]),
  ...["lt", "<", "lessthan"].map((n): [string, Test] => [n, withArgument("lt", (a, b) => pyCompare(a, b, "<"))]),
  ...["le", "<="].map((n): [string, Test] => [n, withArgument("le", (a, b) => pyCompare(a, b, "<="))]),
];

/** jinja2 Environment.call_test: a builtin test by name, its arguments bound as Python binds them. */
function callTest(name: Value, item: Value, args: Value[], kwargs: Map<string, Value>): boolean {
  const spec = name.type === "StringValue" ? JINJA2_TESTS.get(text(name)) : undefined;
  if (spec === undefined) throw new Error(`No test named '${name.toString()}'.`);
  const test = TESTS.get(text(name));
  if (test === undefined) throw new Error(`the jinja2 test '${text(name)}' is not available in this renderer`);
  return test(item, ...bind(`test_${text(name)}`, spec.params, args, kwargs, undefined, spec.positionalOnly));
}

// A node the parser never makes: a value already evaluated, so a wrapped method never evaluates anything twice.
const VALUE = "\0Value";
const valueNode = (value: Value): Node => ({ type: VALUE, value });

/** jinja2 Environment.call_filter: a builtin filter by name, applied as `item|name(args)` would be. */
function callFilter(interp: Internals, name: Value, item: Value, args: Value[], kwargs: Map<string, Value>, env: Environment): Value {
  if (name.type !== "StringValue" || !JINJA2_FILTERS.has(text(name))) throw new Error(`No filter named '${name.toString()}'.`);
  const callee: Node = { type: "Identifier", value: text(name) };
  if (args.length === 0 && kwargs.size === 0) return interp.applyFilter(item, callee, env);
  const keywords = [...kwargs].map(([key, value]): Node => ({ type: "KeywordArgumentExpression", key: { type: "Identifier", value: key }, value: valueNode(value) }));
  return interp.applyFilter(item, { type: "CallExpression", callee, args: [...args.map(valueNode), ...keywords] }, env);
}

// jinja2 select_or_reject and prepare_select_or_reject. The body runs when the result is first iterated, as a
// Python generator's does, so an empty or false source never looks its test up and an unused result never runs.
function selectOrReject(lookupAttr: boolean, keep: boolean): Filter {
  return (operand, args, kwargs) =>
    new GeneratorValue(
      "select_or_reject",
      (function* () {
        if (!truthy(operand)) return;
        if (lookupAttr && args.length === 0) throw new Error("Missing parameter for attribute name");
        const lookup = lookupAttr ? attrGetter(args[0]) : (x: Value) => x;
        const [name, ...rest] = args.slice(lookupAttr ? 1 : 0);
        const test = name === undefined ? truthy : (x: Value) => callTest(name, x, rest, kwargs);
        for (const item of iterate(operand)) if (test(lookup(item)) === keep) yield item;
      })(),
    );
}

// jinja2 sync_do_map and prepare_map: attribute= with no positional argument looks each item up; otherwise the
// first argument names a filter that gets the rest. Like select, nothing runs until the result is iterated.
const map: Filter = function (operand, args, kwargs, env) {
  const interp = this;
  return new GeneratorValue(
    "sync_do_map",
    (function* () {
      if (!truthy(operand)) return;
      let fn: (item: Value) => Value;
      if (args.length === 0 && kwargs.has("attribute")) {
        for (const key of kwargs.keys()) if (key !== "attribute" && key !== "default") throw new Error(`Unexpected keyword argument '${key}'`);
        fn = attrGetter(kwargs.get("attribute"), kwargs.get("default"));
      } else {
        const [name, ...rest] = args;
        if (name === undefined) throw new Error("map requires a filter argument");
        fn = (item) => callFilter(interp, name, item, rest, kwargs, env);
      }
      for (const item of iterate(operand)) yield fn(item);
    })(),
  );
};

// jinja2's count and length are both Python's len(): code points for a string, and 0 for an undefined.
const len: Filter = (operand, args, kwargs) => {
  bind("len", [], args, kwargs, undefined, true);
  if (operand.type === "StringValue") return int(Array.from(text(operand)).length);
  if (isList(operand)) return int(items(operand).length);
  if (isDict(operand)) return int(entries(operand).size);
  if (operand.type === "UndefinedValue") return int(0);
  throw new TypeError(`object of type '${pyType(operand)}' has no len()`);
};

// jinja2 do_first: the first item of any iterable, using up one item of a generator; undefined when empty.
const first: Filter = (operand, args, kwargs) => {
  bind("do_first", [], args, kwargs);
  for (const item of iterate(operand)) return item;
  return undef();
};

// jinja2 do_last: next(reversed(seq)), so a generator raises; undefined when empty.
const last: Filter = (operand, args, kwargs) => {
  bind("do_last", [], args, kwargs);
  if (operand instanceof GeneratorValue || !(isArray(operand) || isDict(operand) || ["StringValue", "UndefinedValue"].includes(operand.type))) {
    throw new TypeError(`'${pyType(operand)}' object is not reversible`);
  }
  return [...iterate(operand)].at(-1) ?? undef();
};

// jinja2 do_list: list(value), which uses a generator up.
const toList: Filter = (operand, args, kwargs) => {
  bind("do_list", [], args, kwargs);
  return new ArrayValue(operand instanceof GeneratorValue ? operand.take() : [...iterate(operand)]);
};

// jinja2 do_default(value, default_value='', boolean=False), bare or called, by position or keyword.
const DEFAULT_ARGS = new Map([
  ["default_value", str("")],
  ["boolean", bool(false)],
]);
const byDefault: Filter = (operand, args, kwargs) => {
  const [fallback, boolean] = bind("do_default", ["default_value", "boolean"], args, kwargs, DEFAULT_ARGS) as [Value, Value];
  return operand.type === "UndefinedValue" || (truthy(boolean) && !truthy(operand)) ? fallback : operand;
};

// jinja2 do_min and do_max (_min_or_max): the first least or greatest item by Python order, compared lower-cased
// unless case_sensitive, by attribute= when given; undefined when empty.
const MIN_MAX_ARGS = new Map([
  ["case_sensitive", bool(false)],
  ["attribute", samples.set("none", null)],
]);
const ignoreCase = (v: Value) => (v.type === "StringValue" ? str(text(v).toLowerCase()) : v);
function minOrMax(fn: string, op: "<" | ">"): Filter {
  return (operand, args, kwargs) => {
    const [caseSensitive, attribute] = bind(fn, ["case_sensitive", "attribute"], args, kwargs, MIN_MAX_ARGS) as [Value, Value];
    const key = attrGetter(attribute, undefined, truthy(caseSensitive) ? undefined : ignoreCase);
    let best: [Value, Value] | undefined;
    for (const item of iterate(operand)) {
      const k = key(item);
      if (best === undefined || pyCompare(k, best[1], op)) best = [item, k];
    }
    return best?.[0] ?? undef();
  };
}

const POLYFILLED_FILTERS = new Map<string, Filter>([
  ["select", selectOrReject(false, true)],
  ["reject", selectOrReject(false, false)],
  ["selectattr", selectOrReject(true, true)],
  ["rejectattr", selectOrReject(true, false)],
  ["map", map],
  ["count", len],
  ["length", len],
  ["first", first],
  ["last", last],
  ["list", toList],
  ["default", byDefault],
  ["d", byDefault],
  ["min", minOrMax("do_min", "<")],
  ["max", minOrMax("do_max", ">")],
]);

/** What a binary operator does with a generator on either side, as Python does it. */
function generatorOperation(op: string, left: Value, right: Value): Value {
  if (op === "==" || op === "!=") return bool((left === right) === (op === "=="));
  if (op === "in" || op === "not in") return bool(pyContains(right, left) === (op === "in"));
  if (op === "~") {
    const s = (v: Value) => (v.type === "UndefinedValue" ? "" : v.toString());
    return str(s(left) + s(right));
  }
  throw new TypeError(`unsupported operand type(s) for ${op}: '${pyType(left)}' and '${pyType(right)}'`);
}

let installed = false;

/** Adds the polyfills to the library's interpreter. Called once, by the worker, before any template parses. */
export function installPolyfills(): void {
  if (installed) return;
  installed = true;
  const proto = Interpreter.prototype as unknown as Internals;
  const { evaluate, applyFilter, evaluateMemberExpression, evaluateBinaryExpression, evaluateFor } = proto;

  proto.evaluate = function (node, env) {
    return node?.type === VALUE ? (node.value as Value) : evaluate.call(this, node, env);
  };

  proto.applyFilter = function (operand, filter, env) {
    const callee = filter.type === "CallExpression" ? (filter.callee as Node) : filter;
    const name = callee.type === "Identifier" ? String(callee.value) : undefined;
    const polyfill = name === undefined ? undefined : POLYFILLED_FILTERS.get(name);
    if (polyfill) {
      const [args, kwargs] = filter.type === "CallExpression" ? this.evaluateArguments(filter.args as Node[], env) : [[], new Map<string, Value>()];
      return polyfill.call(this, operand, args, kwargs, env);
    }
    if (operand instanceof GeneratorValue) {
      if (name === "tojson") throw new TypeError("Object of type generator is not JSON serializable");
      if (name === "string" && filter.type === "Identifier") return str(operand.toString());
      // Every other filter iterates its input, which uses a generator up; safe hands it back untouched.
      if (name !== "safe") operand = new ArrayValue(operand.take());
    }
    return applyFilter.call(this, operand, filter, env);
  };

  // A generator has no items or attributes under jinja2's sandboxed getitem, and looking uses nothing up.
  proto.evaluateMemberExpression = function (expr, env) {
    const object = this.evaluate(expr.object as Node, env);
    if (!(object instanceof GeneratorValue)) return evaluateMemberExpression.call(this, { ...expr, object: valueNode(object) }, env);
    const property = expr.property as Node;
    if (expr.computed && property.type === "SliceExpression") {
      for (const bound of [property.start, property.stop, property.step]) if (bound) this.evaluate(bound as Node, env);
    } else if (expr.computed) {
      this.evaluate(property, env);
    }
    return undef();
  };

  proto.evaluateBinaryExpression = function (expr, env) {
    const op = String((expr.operator as Node).value);
    if (op === "and" || op === "or") return evaluateBinaryExpression.call(this, expr, env);
    const left = this.evaluate(expr.left as Node, env);
    const right = this.evaluate(expr.right as Node, env);
    if (left instanceof GeneratorValue || right instanceof GeneratorValue) return generatorOperation(op, left, right);
    return evaluateBinaryExpression.call(this, { ...expr, left: valueNode(left), right: valueNode(right) }, env);
  };

  // A for loop uses a generator up, so a second loop over it sees nothing, as in jinja2.
  proto.evaluateFor = function (node, env) {
    const iterable = node.iterable as Node;
    const select = iterable.type === "SelectExpression";
    const value = this.evaluate((select ? iterable.lhs : iterable) as Node, env);
    const items = valueNode(value instanceof GeneratorValue ? new ArrayValue(value.take()) : value);
    return evaluateFor.call(this, { ...node, iterable: select ? { ...iterable, lhs: items } : items }, env);
  };

  for (const [name, test] of POLYFILLED_TESTS) TESTS.set(name, test);
  // jinja2's test_sequence needs len() and indexing, which a generator lacks.
  const sequence = TESTS.get("sequence")!;
  TESTS.set("sequence", (value) => !(value instanceof GeneratorValue) && sequence(value));
}
