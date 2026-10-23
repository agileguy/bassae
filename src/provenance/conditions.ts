// The tests a rewrite adds (ISC-25, Decisions 20:55). A control-flow-only
// rewrite is LOW only when it adds no test on content and none on the clock or
// chance. Such a test is either one inside the changed lines, or one on an
// unchanged line that reads content now and did not before, because the
// rewrite changed what a variable it reads holds (`set ns.skip = ...`). Each
// test is classed by classifyTest, the trigger rules' own classifier.
//
// classifyTest needs the abstract value of each expression, and the trigger
// rules' interpreter keeps those to itself. This is a smaller evaluation of
// the template's own variables. It is flow-insensitive: a variable is the join
// of every value assigned to it anywhere, each under the strongest test that
// encloses the assignment. Whatever it does not model reads as content, so an
// unknown construct fails closed to MEDIUM:
//   - a macro's parameters, and anything a macro or a call block sets;
//   - a block set's text;
//   - a call of a macro or of an unknown function.
// Assignments are joined until nothing changes; a template that does not
// settle within MAX_PASSES, or that spends WORK_BUDGET, cannot be classified.

import type { LineDiff } from "../diff.ts";
import { parseTemplate } from "../parse/parse.ts";
import { children, type LineMap, type Node } from "../parse/support.ts";
import {
  classifyTest,
  clsOf,
  condOf,
  countArith,
  countsOf,
  eitherRest,
  elementField,
  factsFrom,
  isRuntime,
  type Facts,
  type Fields,
  KEY_FIELD,
  lengthOf,
  listOf,
  mapFields,
  memberField,
  memberPath,
  NO_FACTS,
  NUMBER_KEEPING,
  pathOf,
  readOf,
  restOf,
  rootField,
  stronger,
  strongest,
  type Cond,
  type Field,
  type TestClass,
  type TestEnv,
  truthOf,
  unionFields,
  type Val,
  valueField,
  vocabClass,
} from "../rules/triggers.ts";
import type { Span } from "../types.ts";

/** A test on content, or on the clock or chance, that a rewrite added or made. */
export interface AddedTest {
  cls: "content" | "nondeterministic";
  span: Span;
  excerpt: string;
}

// Passes over the assignments before the values must have settled. A chain of
// variables set in source order settles in two; each link that runs backwards,
// through a loop, costs one more.
const MAX_PASSES = 32;
// Expression evaluations across every pass and the classification of every test.
const WORK_BUDGET = 2_000_000;
// Characters of a test kept as its excerpt.
const MAX_EXCERPT = 200;

/**
 * The content and nondeterministic tests in `text` that `base` does not have at the same place: every such test in
 * the lines `diff` marks changed, and every other one whose class is stronger than the same test's in `base`.
 * Undefined when either text cannot be parsed or classified.
 */
export function addedTests(base: string, text: string, diff: LineDiff): AddedTest[] | undefined {
  const before = testsOf(base);
  const after = testsOf(text);
  if (!before || !after) return undefined;
  const was = new Map<string, TestClass>();
  for (const t of before.tests) was.set(t.key, stronger(was.get(t.key) ?? "none", t.cls));
  const changed = diff.blocks.filter((b) => b.bRange.end > b.bRange.start).map((b) => b.bRange);
  const out: AddedTest[] = [];
  for (const t of after.tests) {
    if (t.cls !== "content" && t.cls !== "nondeterministic") continue;
    if (!changed.some((r) => t.start < r.end && r.start < t.end)) {
      // An unchanged line: the same test, at the same place in the base, already read this much.
      const at = toBase(t.start, diff);
      const prior = at === undefined ? undefined : was.get(keyOf(at, at + (t.end - t.start), t.node.type));
      if (prior !== undefined && stronger(prior, t.cls) === prior) continue;
    }
    out.push({ cls: t.cls, span: after.lines.span(t.start, t.end), excerpt: excerpt(text, t.start, t.end) });
  }
  return out;
}

// Where an offset in the new text was in the base, through the unchanged lines; undefined inside a changed block.
function toBase(p: number, diff: LineDiff): number | undefined {
  let delta = 0;
  for (const b of diff.blocks) {
    if (p < b.bRange.start) break;
    if (p < b.bRange.end) return undefined;
    delta = b.aRange.end - b.bRange.end;
  }
  return p + delta;
}

const keyOf = (start: number, end: number, type: string) => `${start}:${end}:${type}`;

// The test's own text, widened to the parentheses its first and last names sit in.
function excerpt(text: string, start: number, end: number): string {
  let depth = 0;
  let low = 0;
  for (let i = start; i < end; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") low = Math.min(low, --depth);
  }
  let s = start;
  for (let need = -low; need > 0 && s > 0; s--) {
    const c = text[s - 1]!;
    if (c === "(") need--;
    else if (c.trim() !== "") break;
  }
  let e = end;
  for (let open = depth - low; open > 0 && e < text.length; e++) {
    const c = text[e]!;
    if (c === ")") open--;
    else if (c.trim() !== "") break;
  }
  const t = text.slice(s, e);
  return t.length > MAX_EXCERPT ? `${t.slice(0, MAX_EXCERPT)}…` : t;
}

interface Test {
  node: Node;
  start: number;
  end: number;
  key: string;
  cls: TestClass;
}

function testsOf(text: string): { tests: Test[]; lines: LineMap } | undefined {
  const outcome = parseTemplate(text);
  if (!outcome.program || !outcome.lines || outcome.tooLarge) return undefined;
  const tests = new Evaluation(outcome.program, outcome.spans, outcome.lines).run();
  return tests && { tests, lines: outcome.lines };
}

// ---- the evaluation ----

const EMPTY: Val = { lits: [], data: "none", truth: "none" };
const CONTENT: Val = { lits: [], data: "content", truth: "content" };
const NONDET: Val = { lits: [], data: "nondeterministic", truth: "nondeterministic" };
const UNKNOWN_ROOT = rootField("");

const BUILTINS = new Set(["namespace", "dict", "range", "raise_exception", "cycler", "joiner", "lipsum", "zip", "enumerate"]);
const NONDET_FNS = new Set(["strftime_now", "random"]);
const SPLIT_METHODS = new Set(["split", "rsplit", "splitlines", "partition", "rpartition"]);
const MUTATORS = new Set(["append", "extend", "insert", "update", "add"]);
const LENGTHS = new Set(["length", "count", "wordcount"]);
const SERIALIZE = new Set(["tojson", "string", "pprint"]);
const ELEMENT_FILTERS = new Set(["first", "last", "min", "max"]);
// The number-keeping filters a count passes through (review round 3, contracts M2), and the ones that keep a list.
const KEEP_FILTERS = new Set([...NUMBER_KEEPING, "list", "sort", "reverse", "unique", "batch", "slice", "bool"]);
const SELECT_FILTERS = new Set(["select", "reject", "selectattr", "rejectattr"]);
const SHAPE_SELECT_TESTS = new Set(["defined", "undefined", "none", "string", "mapping", "iterable", "sequence", "number", "integer", "float", "boolean", "true", "false"]);
const COMPARE_SELECT_TESTS = new Set(["equalto", "==", "eq", "sameas", "ne", "!=", "in"]);
const COMPARISONS = new Set(["==", "!=", "<", ">", "<=", ">=", "in", "not in"]);

type Enclosing = { kind: "if"; test: Node } | { kind: "loop"; iterable: Node; filter?: Node } | { kind: "opaque" };

/** One assignment: what is assigned to `key`, under which enclosing tests. */
interface Assign {
  key: string;
  how: "value" | "element" | "first" | "second" | "namespace" | "content" | "list";
  node?: Node;
  enclosing: Enclosing[];
}

class Evaluation {
  private assigns: Assign[] = [];
  private assigned = new Set<string>();
  private macros = new Set<string>();
  private scope = new Map<string, Val>();
  private work = 0;
  private gates = new Map<Node, Cond | undefined>();
  private spanCache = new Map<Node, Span>();
  private readonly env: TestEnv = { value: (n, facts) => this.value(n, facts) };

  constructor(
    private readonly program: Node,
    private readonly spans: Map<Node, Span>,
    private readonly lines: LineMap,
  ) {}

  run(): Test[] | undefined {
    this.collect(this.program.body, []);
    for (const a of this.assigns) this.assigned.add(a.key);
    let settled = false;
    for (let pass = 0; pass < MAX_PASSES && !settled; pass++) {
      // Each assignment reads what the ones before it set on this pass, so a chain in source order settles in two.
      this.gates.clear();
      const before = new Map(this.scope);
      for (const a of this.assigns) this.scope.set(a.key, join(this.scope.get(a.key), this.valueOf(a)));
      settled = this.scope.size === before.size && [...this.scope].every(([k, v]) => sameVal(before.get(k), v));
      if (this.work > WORK_BUDGET) return undefined;
    }
    if (!settled) return undefined;
    const tests = this.classify();
    return this.work > WORK_BUDGET ? undefined : tests;
  }

  private tick(): boolean {
    return ++this.work <= WORK_BUDGET;
  }

  // ---- assignments ----

  private collect(body: unknown, enclosing: Enclosing[]): void {
    if (!Array.isArray(body)) return;
    for (const s of body as Node[]) {
      if (!s || typeof s !== "object") continue;
      switch (s.type) {
        case "If": {
          const inner = [...enclosing, { kind: "if" as const, test: s.test as Node }];
          this.mutations(s.test, enclosing);
          this.collect(s.body, inner);
          this.collect(s.alternate, inner);
          break;
        }
        case "For": {
          let iterable = s.iterable as Node;
          let filter: Node | undefined;
          if (iterable?.type === "SelectExpression") {
            filter = iterable.test as Node;
            iterable = iterable.lhs as Node;
          }
          this.mutations(iterable, enclosing);
          this.bind(s.loopvar as Node, iterable, enclosing, true);
          const inner = [...enclosing, { kind: "loop" as const, iterable, filter }];
          this.collect(s.body, inner);
          this.collect(s.defaultBlock, inner);
          break;
        }
        case "Set": {
          const target = s.assignee as Node;
          if (s.value) {
            this.mutations(s.value, enclosing);
            const value = s.value as Node;
            const callee = value.type === "CallExpression" ? (value.callee as Node) : undefined;
            if (target?.type === "Identifier" && callee?.type === "Identifier" && callee.value === "namespace") {
              const name = String(target.value);
              this.assigns.push({ key: name, how: "namespace", enclosing });
              for (const arg of (value.args as Node[]) ?? []) {
                if (arg?.type === "KeywordArgumentExpression") this.assigns.push({ key: `${name}.${String((arg.key as Node).value)}`, how: "value", node: arg.value as Node, enclosing });
              }
            } else this.bind(target, value, enclosing, false);
          } else {
            // A set block holds the text its body prints.
            for (const name of names(target)) this.assigns.push({ key: name, how: "content", enclosing });
            this.collect(s.body, enclosing);
          }
          break;
        }
        case "Macro": {
          this.macros.add(String((s.name as Node)?.value));
          const inner = [...enclosing, { kind: "opaque" as const }];
          for (const p of (s.args as Node[]) ?? []) {
            const name = p?.type === "KeywordArgumentExpression" ? String((p.key as Node).value) : p?.type === "Identifier" ? String(p.value) : undefined;
            if (name !== undefined) this.assigns.push({ key: name, how: "content", enclosing: inner });
          }
          this.collect(s.body, inner);
          break;
        }
        case "CallStatement": {
          this.mutations(s.call, enclosing);
          const inner = [...enclosing, { kind: "opaque" as const }];
          for (const p of (s.callerArgs as Node[] | null) ?? []) for (const name of names(p)) this.assigns.push({ key: name, how: "content", enclosing: inner });
          this.collect(s.body, inner);
          break;
        }
        case "FilterStatement":
          this.collect(s.body, enclosing);
          break;
        default:
          this.mutations(s, enclosing);
      }
    }
  }

  // `for x in it` binds an element, `for k, v in it` a key and a value (or two elements); `set a, b = t` two elements.
  private bind(target: Node, value: Node, enclosing: Enclosing[], loop: boolean): void {
    if (target?.type === "Identifier") {
      this.assigns.push({ key: String(target.value), how: loop ? "element" : "value", node: value, enclosing });
    } else if (target?.type === "MemberExpression" && !target.computed && (target.object as Node)?.type === "Identifier") {
      this.assigns.push({ key: `${String((target.object as Node).value)}.${String((target.property as Node).value)}`, how: "value", node: value, enclosing });
    } else if (target?.type === "TupleLiteral" || target?.type === "ArrayLiteral") {
      const parts = ((target.value as Node[]) ?? []).filter((x) => x?.type === "Identifier");
      parts.forEach((p, i) => this.assigns.push({ key: String(p.value), how: loop && parts.length === 2 ? (i === 0 ? "first" : "second") : "element", node: value, enclosing }));
    }
  }

  // `x.append(v)` and the like put `v` into `x`.
  private mutations(root: unknown, enclosing: Enclosing[]): void {
    const stack: unknown[] = [root];
    while (stack.length) {
      const n = stack.pop() as Node | undefined;
      if (!n || typeof n !== "object") continue;
      if (!Array.isArray(n) && n.type === "CallExpression") {
        const callee = n.callee as Node;
        if (callee?.type === "MemberExpression" && !callee.computed && MUTATORS.has(String((callee.property as Node)?.value))) {
          const target = callee.object as Node;
          const key = target?.type === "Identifier" ? String(target.value) : target?.type === "MemberExpression" && !target.computed && (target.object as Node)?.type === "Identifier" ? `${String((target.object as Node).value)}.${String((target.property as Node).value)}` : undefined;
          for (const arg of (n.args as Node[]) ?? []) if (key !== undefined) this.assigns.push({ key, how: "list", node: arg, enclosing });
        }
      }
      for (const c of children(n)) if (c && typeof c === "object") stack.push(c);
    }
  }

  private valueOf(a: Assign): Val {
    let v: Val;
    switch (a.how) {
      case "namespace":
        v = { ...EMPTY, ns: a.key };
        break;
      case "content":
        v = CONTENT;
        break;
      case "element":
        v = elemOf(this.value(a.node!, NO_FACTS));
        break;
      case "first": {
        const it = this.value(a.node!, NO_FACTS);
        v = it.pairs ? keysOf(it) : elemOf(it);
        break;
      }
      case "second": {
        const it = this.value(a.node!, NO_FACTS);
        v = it.pairs ? valuesOf(it) : elemOf(it);
        break;
      }
      case "list": {
        const x = this.value(a.node!, NO_FACTS);
        v = { lits: [], data: readOf(x), truth: "none", gate: x.gate, fields: x.fields ? mapFields(x.fields, listOf) : undefined, rest: x.rest };
        break;
      }
      default:
        v = this.value(a.node!, NO_FACTS);
    }
    let gate: Cond | undefined;
    for (const e of a.enclosing) gate = strongest(gate, this.gateOf(e));
    return under(v, gate);
  }

  // The test an enclosing statement puts on what it holds.
  private gateOf(e: Enclosing): Cond | undefined {
    if (e.kind === "opaque") return { test: "content", span: { start: 0, end: 0, line: 1, col: 1 } };
    const at = e.kind === "if" ? e.test : e.iterable;
    if (this.gates.has(at)) return this.gates.get(at);
    let gate: Cond | undefined;
    if (e.kind === "if") gate = condOf(classifyTest(e.test, this.env, NO_FACTS), this.spanOf(e.test));
    else {
      const it = this.value(e.iterable, NO_FACTS);
      gate = strongest(condOf(truthOf(it), this.spanOf(e.iterable)), e.filter ? condOf(classifyTest(e.filter, this.env, NO_FACTS), this.spanOf(e.filter)) : undefined);
    }
    this.gates.set(at, gate);
    return gate;
  }

  // ---- values ----

  private value(n: unknown, facts: Facts): Val {
    if (!n || typeof n !== "object" || !this.tick()) return CONTENT;
    const node = n as Node;
    switch (node.type) {
      case "StringLiteral":
        return { ...EMPTY, konst: String(node.value) };
      case "IntegerLiteral":
      case "FloatLiteral":
        return { ...EMPTY, konst: Number(node.value) };
      case "Identifier":
        return refine(this.ident(String(node.value)), node, facts);
      case "MemberExpression":
        return refine(this.member(node, facts), node, facts);
      case "FilterExpression":
        return this.filter(this.value(node.operand, facts), node.filter as Node, facts);
      case "CallExpression":
        return this.call(node, facts);
      case "TestExpression":
        return boolVal(classifyTest(node, this.env, facts));
      case "UnaryExpression":
        if (op(node) === "not") return boolVal(classifyTest(node.argument as Node, this.env, facts));
        return this.value(node.argument, facts);
      case "BinaryExpression": {
        const o = op(node);
        if (o === "and" || o === "or") {
          // The value is one of the operands; the right one only when the left one says so.
          const l = this.value(node.left, facts);
          const r = this.value(node.right, factsFrom(node.left as Node, o === "and", facts));
          return join(l, under(r, condOf(classifyTest(node.left as Node, this.env, facts), this.spanOf(node.left as Node))));
        }
        if (COMPARISONS.has(o)) return boolVal(classifyTest(node, this.env, facts));
        const l = this.value(node.left, facts);
        const r = this.value(node.right, facts);
        const d = stronger(readOf(l), readOf(r));
        return countArith(l, r, o) ?? { lits: [], data: d, truth: d, gate: strongest(l.gate, r.gate) };
      }
      case "Ternary": {
        const c = node.condition as Node;
        const t = this.value(node.trueExpr, factsFrom(c, true, facts));
        const f = this.value(node.falseExpr, factsFrom(c, false, facts));
        return under(join(t, f), condOf(classifyTest(c, this.env, facts), this.spanOf(c)));
      }
      case "SelectExpression": {
        const c = node.test as Node;
        return under(this.value(node.lhs, factsFrom(c, true, facts)), condOf(classifyTest(c, this.env, facts), this.spanOf(c)));
      }
      case "ArrayLiteral":
      case "TupleLiteral": {
        let v: Val | undefined;
        const konsts: string[] = [];
        let allKonst = true;
        for (const el of (node.value as Node[]) ?? []) {
          const e = this.value(el, facts);
          if (typeof e.konst === "string" && !isRuntime(e)) konsts.push(e.konst);
          else allKonst = false;
          v = join(v, { ...e, konst: undefined, konstList: undefined, ns: undefined });
        }
        return { ...(v ?? EMPTY), truth: "none", konst: undefined, konstList: allKonst ? konsts : undefined };
      }
      case "ObjectLiteral": {
        let v: Val | undefined;
        const map = node.value;
        if (map instanceof Map) for (const val of map.values()) v = join(v, { ...this.value(val, facts), konst: undefined, konstList: undefined, ns: undefined, fields: undefined, rest: undefined });
        return { ...(v ?? EMPTY), truth: "none" };
      }
      case "KeywordArgumentExpression":
        return this.value(node.value, facts);
      case "SpreadExpression":
      case "KeywordSpreadExpression":
        return this.value(node.argument, facts);
      default:
        return CONTENT;
    }
  }

  private ident(name: string): Val {
    switch (name) {
      case "true":
      case "True":
        return { ...EMPTY, konst: true };
      case "false":
      case "False":
        return { ...EMPTY, konst: false };
      case "none":
      case "None":
        return { ...EMPTY, konst: null };
    }
    const root = rootField(name);
    const runtime: Val = { lits: [], data: root.cls, truth: "presence", fields: [root] };
    const bound = this.scope.get(name);
    // A runtime variable the template also sets may still be the caller's value where it is read.
    if (bound) return root === UNKNOWN_ROOT ? bound : join(bound, runtime);
    if (this.assigned.has(name)) return EMPTY; // set, but not evaluated yet on this pass
    if (NONDET_FNS.has(name)) return NONDET;
    if (name === "caller") return CONTENT;
    if (BUILTINS.has(name) || this.macros.has(name)) return EMPTY;
    return runtime;
  }

  private member(n: Node, facts: Facts): Val {
    const o = this.value(n.object, facts);
    const prop = n.property as Node;
    if (n.computed && prop?.type === "SliceExpression") {
      // A slice keeps the container.
      let gate = o.gate;
      for (const part of [prop.start, prop.stop, prop.step]) if (part) gate = strongest(gate, condOf(readOf(this.value(part, facts)), this.spanOf(part as Node)));
      return { ...o, konst: undefined, konstList: undefined, gate };
    }
    let key: string | undefined;
    let gate = o.gate;
    if (!n.computed) key = prop?.type === "Identifier" ? String(prop.value) : undefined;
    else {
      const k = this.value(prop, facts);
      if (typeof k.konst === "string" && !isRuntime(k)) key = k.konst;
      // A runtime index chooses the entry.
      gate = strongest(gate, condOf(readOf(k), this.spanOf(prop)));
    }
    if (o.ns !== undefined) return key === undefined ? CONTENT : under(this.scope.get(`${o.ns}.${key}`) ?? EMPTY, gate);
    if (!o.fields) return { lits: [], data: o.data, truth: o.truth, gate };
    const fields = mapFields(o.fields, (f) => memberField(f, key));
    return { lits: [], data: clsOf(fields), truth: "presence", gate, fields, rest: o.rest };
  }

  private call(n: Node, facts: Facts): Val {
    const callee = n.callee as Node;
    const args = ((n.args as Node[]) ?? []).map((a) => this.value(a, facts));
    const argData = args.reduce<TestClass>((d, a) => stronger(d, readOf(a)), "none");
    if (callee?.type === "Identifier") {
      const name = String(callee.value);
      if (NONDET_FNS.has(name)) return NONDET;
      if (name === "range") {
        const r = args.reduce<Val | undefined>((v, a) => join(v, a), undefined) ?? EMPTY;
        return { lits: [], data: r.data, truth: r.truth, gate: r.gate, fields: r.fields ? mapFields(r.fields, listOf) : undefined, rest: r.rest };
      }
      if (name === "raise_exception" || name === "namespace") return EMPTY;
      if (name === "dict" || name === "zip" || name === "enumerate" || name === "cycler" || name === "joiner") return { lits: [], data: argData, truth: argData };
      // A macro's output, a caller() body or an unknown function: not modelled.
      return CONTENT;
    }
    if (callee?.type !== "MemberExpression" || callee.computed) return CONTENT;
    const method = String((callee.property as Node)?.value);
    const r = this.value(callee.object, facts);
    const d = stronger(readOf(r), argData);
    switch (method) {
      case "items":
        return { ...r, konst: undefined, pairs: true };
      case "keys":
        return keysOf(r);
      case "values":
        return valuesOf(r);
      case "get": {
        const key = args[0] && typeof args[0].konst === "string" && !isRuntime(args[0]) ? args[0].konst : undefined;
        const got = r.ns !== undefined && key !== undefined ? (this.scope.get(`${r.ns}.${key}`) ?? EMPTY) : r.fields ? { lits: [], data: clsOf(mapFields(r.fields, (f) => memberField(f, key))), truth: "presence" as const, fields: mapFields(r.fields, (f) => memberField(f, key)), rest: r.rest } : { lits: [], data: r.data, truth: r.truth };
        const keyGate = args[0] && isRuntime(args[0]) ? condOf(readOf(args[0]), this.spanOf((n.args as Node[])[0]!)) : undefined;
        return under(args[1] ? join(got, args[1]) : got, strongest(r.gate, keyGate));
      }
      case "pop":
        return elemOf(r);
      case "copy":
        return r;
    }
    if (MUTATORS.has(method)) return EMPTY;
    if (SPLIT_METHODS.has(method)) return { lits: [], data: d, truth: d, gate: r.gate, fields: r.fields ? mapFields(r.fields, listOf) : undefined, rest: r.rest };
    // A string method, a test such as startswith(), or one this list does not know: its result reads the receiver and the arguments.
    return { lits: [], data: d, truth: d, gate: r.gate };
  }

  private filter(o: Val, f: Node, facts: Facts): Val {
    const name = filterName(f);
    const argNodes = f?.type === "CallExpression" ? ((f.args as Node[]) ?? []) : [];
    const args = argNodes.map((a) => this.value(a, facts));
    if (LENGTHS.has(name)) return lengthOf(o);
    // A count's digits are the count.
    if (name === "string" && countsOf(o)) return { ...o, konst: undefined, konstList: undefined };
    if (SERIALIZE.has(name)) return { lits: [], data: o.fields ? clsOf(o.fields) : o.data, truth: o.truth, gate: o.gate };
    if (ELEMENT_FILTERS.has(name)) return elemOf(o);
    if (name === "random") return NONDET;
    if (KEEP_FILTERS.has(name)) return { ...o, konst: undefined, konstList: undefined };
    if (name === "items" || name === "dictsort") return { ...o, konst: undefined, pairs: true };
    if (name === "default" || name === "d") return args[0] ? join(o, args[0]) : o;
    if (name === "map") {
      const attr = kwargKonst(argNodes, "attribute");
      if (attr !== undefined && o.fields) {
        const fs = mapFields(mapFields(o.fields, elementField), (x) => memberPath(x, attr));
        return { lits: [], data: clsOf(fs), truth: o.truth, gate: o.gate, fields: mapFields(fs, listOf), rest: o.rest };
      }
      return { lits: [], data: readOf(o), truth: o.truth, gate: o.gate };
    }
    if (SELECT_FILTERS.has(name)) return { ...o, konst: undefined, truth: stronger(o.truth, selectClass(o, name, args)) };
    if (name === "attr") {
      const key = args[0] && typeof args[0].konst === "string" ? args[0].konst : undefined;
      if (o.fields) {
        const fs = mapFields(o.fields, (x) => memberField(x, key));
        return { lits: [], data: clsOf(fs), truth: "presence", gate: o.gate, fields: fs, rest: o.rest };
      }
    }
    // A string filter (lower, trim, replace, join, ...) or one this list does not know: its result reads the value and the arguments.
    const d = args.reduce<TestClass>((x, a) => stronger(x, readOf(a)), o.data);
    return { lits: [], data: d, truth: d, gate: o.gate };
  }

  // ---- the tests ----

  /** Every test in the program, classed: if, loop filter, ternary and `x if c` conditions, `and`/`or` operands, comparisons, `is` tests, and select filters. */
  private classify(): Test[] {
    const out: Test[] = [];
    const seen = new Set<Node>();
    const add = (node: Node, cls: TestClass) => {
      const s = this.spanOf(node);
      if (s.start < s.end) out.push({ node, start: s.start, end: s.end, key: keyOf(s.start, s.end, node.type), cls });
    };
    const decompose = (n: Node, facts: Facts): void => {
      if (!n || typeof n !== "object" || seen.has(n)) return;
      seen.add(n);
      if (n.type === "BinaryExpression" && (op(n) === "and" || op(n) === "or")) {
        decompose(n.left as Node, facts);
        decompose(n.right as Node, factsFrom(n.left as Node, op(n) === "and", facts));
      } else if (n.type === "UnaryExpression" && op(n) === "not") decompose(n.argument as Node, facts);
      else if (n.type === "Ternary") {
        const c = n.condition as Node;
        decompose(c, facts);
        decompose(n.trueExpr as Node, factsFrom(c, true, facts));
        decompose(n.falseExpr as Node, factsFrom(c, false, facts));
      } else add(n, classifyTest(n, this.env, facts));
    };
    const stack: unknown[] = [this.program];
    while (stack.length) {
      const n = stack.pop() as Node | undefined;
      if (!n || typeof n !== "object") continue;
      if (!Array.isArray(n)) {
        switch (n.type) {
          case "If":
            decompose(n.test as Node, NO_FACTS);
            break;
          case "For":
            if ((n.iterable as Node)?.type === "SelectExpression") decompose((n.iterable as Node).test as Node, NO_FACTS);
            break;
          case "Ternary":
            decompose(n.condition as Node, NO_FACTS);
            break;
          case "SelectExpression":
            decompose(n.test as Node, NO_FACTS);
            break;
          case "BinaryExpression":
            if (op(n) === "and" || op(n) === "or" || COMPARISONS.has(op(n))) decompose(n, NO_FACTS);
            break;
          case "TestExpression":
            decompose(n, NO_FACTS);
            break;
          case "UnaryExpression":
            if (op(n) === "not") decompose(n, NO_FACTS);
            break;
          case "FilterExpression": {
            const f = n.filter as Node;
            const name = filterName(f);
            if (SELECT_FILTERS.has(name) && !seen.has(f)) {
              seen.add(f);
              const args = (f?.type === "CallExpression" ? ((f.args as Node[]) ?? []) : []).map((a) => this.value(a, NO_FACTS));
              add(f, selectClass(this.value(n.operand, NO_FACTS), name, args));
            }
            break;
          }
        }
      }
      // Pushed in reverse so the walk is in source order, an enclosing test before the ones inside it.
      const kids = children(n);
      for (let i = kids.length - 1; i >= 0; i--) if (kids[i] && typeof kids[i] === "object") stack.push(kids[i]);
    }
    return out;
  }

  /** From the first name or string in `n` to the end of the last one; empty at offset 0 when it has none. */
  private spanOf(n: Node): Span {
    let span = this.spanCache.get(n);
    if (!span) {
      let start = Infinity;
      let end = -1;
      const stack: unknown[] = [n];
      while (stack.length) {
        const x = stack.pop();
        if (!x || typeof x !== "object") continue;
        const s = this.spans.get(x as Node);
        if (s) {
          start = Math.min(start, s.start);
          end = Math.max(end, s.end);
        }
        for (const c of children(x)) if (c && typeof c === "object") stack.push(c);
      }
      span = end < 0 ? this.lines.span(0, 0) : this.lines.span(start, end);
      this.spanCache.set(n, span);
    }
    return span;
  }
}

// ---- value helpers ----

function op(n: Node): string {
  return String((n.operator as { value?: unknown } | undefined)?.value ?? "");
}

function names(n: Node): string[] {
  if (n?.type === "Identifier") return [String(n.value)];
  if (n?.type === "TupleLiteral" || n?.type === "ArrayLiteral") return ((n.value as Node[]) ?? []).filter((x) => x?.type === "Identifier").map((x) => String(x.value));
  return [];
}

function filterName(f: Node): string {
  if (f?.type === "Identifier") return String(f.value);
  if (f?.type === "CallExpression") return String((f.callee as Node | undefined)?.value ?? "");
  return "";
}

function kwargKonst(args: Node[], key: string): string | undefined {
  for (const a of args) if (a?.type === "KeywordArgumentExpression" && String((a.key as Node).value) === key && (a.value as Node)?.type === "StringLiteral") return String((a.value as Node).value);
  return undefined;
}

function boolVal(cls: TestClass): Val {
  return { lits: [], data: cls, truth: cls };
}

function under(v: Val, gate: Cond | undefined): Val {
  return gate ? { ...v, gate: strongest(v.gate, gate) } : v;
}

// A guard in force (`x is string`) says what shape a plain reference is.
function refine(v: Val, n: Node, facts: Facts): Val {
  if (facts.size === 0) return v;
  const path = pathOf(n);
  const shape = path === undefined ? undefined : facts.get(path);
  return shape ? { ...v, path, shape } : v;
}

function elemOf(it: Val): Val {
  const fields = it.fields ? mapFields(it.fields, elementField) : undefined;
  return { lits: [], data: fields ? clsOf(fields) : it.data, truth: fields ? "presence" : it.truth, gate: it.gate, fields, rest: it.rest };
}

function keysOf(it: Val): Val {
  const d: TestClass = it.fields ? "presence" : it.data === "none" ? "none" : "presence";
  return { lits: [], data: d, truth: d, gate: it.gate, fields: it.fields ? [KEY_FIELD] : undefined, rest: it.rest };
}

function valuesOf(it: Val): Val {
  const fields = it.fields ? mapFields(it.fields, valueField) : undefined;
  return { lits: [], data: fields ? clsOf(fields) : it.data, truth: fields ? "presence" : it.truth, gate: it.gate, fields, rest: it.rest };
}

// Which elements `select`, `reject`, `selectattr` and `rejectattr` keep depends on the test they apply to each one,
// judged as the injection rules judge it: a shape test reads presence, a comparison with a vocabulary value reads the
// field against its vocabulary, any other test reads the field.
function selectClass(o: Val, name: string, args: Val[]): TestClass {
  const efs = o.fields ? mapFields(o.fields, elementField) : undefined;
  const byAttr = name === "selectattr" || name === "rejectattr";
  const attr = byAttr ? args[0] : undefined;
  if (attr && (typeof attr.konst !== "string" || isRuntime(attr))) return "content"; // an attribute chosen at runtime
  const fs: Fields | undefined = efs && byAttr ? mapFields(efs, (f) => memberPath(f, attr?.konst as string | undefined)) : efs;
  const testAt = byAttr ? 1 : 0;
  const read: TestClass = fs ? clsOf(fs) : o.data;
  const testArg = args[testAt];
  if (testArg && (typeof testArg.konst !== "string" || isRuntime(testArg))) return stronger(read, "content");
  const test = typeof testArg?.konst === "string" ? testArg.konst : "";
  let sel: TestClass = test === "" || SHAPE_SELECT_TESTS.has(test) ? (read === "none" ? "none" : "presence") : ((fs && vocabSelect(fs, test, args[testAt + 1])) ?? read);
  for (const x of args.slice(testAt + 1)) sel = stronger(sel, readOf(x));
  return stronger(sel, o.gate?.test ?? "none");
}

function vocabSelect(fs: Fields, test: string, value: Val | undefined): TestClass | undefined {
  if (!value || !COMPARE_SELECT_TESTS.has(test) || isRuntime(value)) return undefined;
  const values = test === "in" ? value.konstList : value.konst !== undefined ? [value.konst] : undefined;
  let cls: TestClass | undefined;
  for (const v of values ?? []) {
    const c = vocabClass(fs, v);
    if (c === undefined) return undefined;
    cls = cls === undefined ? c : stronger(cls, c);
  }
  return cls;
}

/** Either value: every field, class and test of both. */
function join(a: Val | undefined, b: Val): Val {
  if (!a) return b;
  const fields = a.fields && b.fields ? unionFields(a.fields, b.fields) : (a.fields ?? b.fields);
  return {
    lits: [],
    data: stronger(a.data, b.data),
    truth: stronger(a.truth, b.truth),
    gate: strongest(a.gate, b.gate),
    fields,
    rest: fields ? eitherRest(a.fields ? a.rest : restOf(a), b.fields ? b.rest : restOf(b)) : undefined,
    konst: a.konst === b.konst ? a.konst : undefined,
    konstList: a.konstList && b.konstList && a.konstList.join("\0") === b.konstList.join("\0") ? a.konstList : undefined,
    ns: a.ns === b.ns ? a.ns : undefined,
    pairs: a.pairs || b.pairs ? true : undefined,
  };
}

const fieldIds = new WeakMap<Field, number>();
let nextFieldId = 0;
function fieldId(f: Field): number {
  let id = fieldIds.get(f);
  if (id === undefined) fieldIds.set(f, (id = nextFieldId++));
  return id;
}

function sameVal(a: Val | undefined, b: Val): boolean {
  if (!a) return false;
  const fs = (v: Val) => (v.fields ? v.fields.map(fieldId).sort((x, y) => x - y).join(",") : "-");
  return (
    a.data === b.data &&
    a.truth === b.truth &&
    a.gate?.test === b.gate?.test &&
    a.rest === b.rest &&
    a.konst === b.konst &&
    (a.konstList?.join("\0") ?? null) === (b.konstList?.join("\0") ?? null) &&
    a.ns === b.ns &&
    a.pairs === b.pairs &&
    fs(a) === fs(b)
  );
}
