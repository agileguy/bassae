// Injected-text extraction (ISC-17): every literal a template can emit that is
// not scaffolding, with its span, the strongest test it sits under, and whether
// it lands after the generation-prompt marker.
//
// This is an abstract interpretation of the parsed template, never a render.
// Each expression evaluates to a Val (triggers.ts): the template literals it can
// carry to the output, and how strongly it depends on runtime input. Literals
// reach the output through text, `{{ }}`, set and set blocks, namespace
// attributes, macro parameters and bodies, `caller()`, `~`/`+`/`%`, joins,
// filters and string methods, so all of those carry them. Variables follow
// jinja2's scoping: a `set` replaces the value on the path it is on, `if`
// branches join where they meet, and what a `for` body or a macro sets is gone
// after it, except namespace attributes and mutated lists. A loop's body starts
// from the join of its entry and what the body left on earlier passes, computed
// to a fixpoint, so a loop-carried value is never missed. Macros are inlined at
// every call site, so their emissions inherit the call site's conditions
// (ISC-18).
//
// The walk is bounded: a work budget over every node visit, a cap on literals
// per value, a cap on macro inlining depth (a recursive macro is unrolled
// twice), and explicit-stack walkers for the span helpers. Hitting any bound
// sets `complete` false rather than throwing (ISC-42.1).

import type { InjectedText, Span } from "../types.ts";
import { WHOLE_TEMPLATE, type ParseOutcome } from "../parse/parse.ts";
import { children, type LineMap, type Node } from "../parse/support.ts";
import type { PreToken } from "../parse/prelexer.ts";
import {
  classifyTest,
  clsOf,
  condOf,
  elementField,
  factsFrom,
  genPolarity,
  isRuntime,
  KEY_FIELD,
  listOf,
  mapFields,
  memberField,
  NO_FACTS,
  pathOf,
  rootField,
  sameFields,
  stronger,
  strongest,
  truthOf,
  unionFields,
  valueField,
  type Cond,
  type Facts,
  type Field,
  type Lit,
  type TestClass,
  type TestEnv,
  type Val,
} from "./triggers.ts";

/** A nondeterministic trigger: a use of `random`, or a test that reads the clock (ISC-18.1). */
export interface Trigger {
  span: Span;
  message: string;
}

export interface Extraction {
  items: InjectedText[];
  nondeterministic: Trigger[];
  /** False when a budget stopped the walk before every emission was seen. */
  complete: boolean;
}

// Node visits across every fixpoint pass, every inlined macro and the final
// pass. The corpus maximum is under 200K (gpt-oss inlines its schema renderer
// at each tool parameter).
const WORK_BUDGET = 3_000_000;
// Loop back edges converge in two or three passes on the corpus.
const MAX_PASSES = 8;
// Macro inlining depth, and how often one macro may sit on the stack (a
// recursive macro is unrolled this many times; deeper calls add nothing new).
const MAX_MACRO_DEPTH = 16;
const MAX_RECURSION = 2;
// Literals one value may carry, and literals the whole output may carry.
const MAX_LITS = 2048;
const MAX_OUTPUT_LITS = 50_000;
// A folded constant longer than this is not folded (its parts still count).
const MAX_KONST = 64 * 1024;
// Tokens the text aligner looks ahead before it gives a literal a fallback span.
const ALIGN_LOOKAHEAD = 256;
// Trie steps the scaffolding matcher may take over the whole template.
const MATCH_BUDGET = 20_000_000;
// Scaffolding strings longer than this never match inside other text.
const MAX_PIECE = 4096;
// Total characters of scaffolding put into the trie.
const MAX_TRIE_CHARS = 4 * 1024 * 1024;

const EMPTY: Val = { lits: [], data: "none", truth: "none" };
const WORDISH = /[\p{L}\p{N}]/u;

/** Run the extraction over a parsed template. */
export function extract(outcome: ParseOutcome, text: string, scaffolding: ReadonlySet<string>): Extraction {
  const matcher = new Scaffold(scaffolding);
  if (!outcome.program || !outcome.pre || !outcome.lines) {
    return { items: rawItems(outcome, matcher), nondeterministic: [], complete: false };
  }
  const interp = new Interp(outcome, outcome.lines);
  const lits = interp.run();
  const items = toItems(lits, matcher);
  return { items, nondeterministic: [...interp.nondet.values()], complete: interp.complete && matcher.complete };
}

/** With no AST (parse error or shape cap), every text run between tags is a candidate: it is emitted whenever it is reached. */
export function rawItems(outcome: ParseOutcome, matcher: Scaffold): InjectedText[] {
  const out: InjectedText[] = [];
  if (!outcome.pre || !outcome.lines) return out;
  for (const seg of outcome.pre.textSegments) {
    const r = matcher.residue(seg.value);
    if (r.frags.length === 0) continue;
    const text = seg.value.slice(r.frags[0]![0], r.frags[r.frags.length - 1]![1]);
    out.push({ text, span: outcome.lines.span(seg.start, seg.end), afterGenerationPrompt: false });
  }
  return out;
}

// ---- the interpreter ----

interface Caller {
  body: Node[];
  params: Node[];
  ctx: Ctx;
}

interface Scope {
  /** The macro whose body is running: its namespaces are named apart from the caller's. */
  macro?: string;
  caller?: Caller;
}

/**
 * The variables on one path through the template, in layers: an `if` branch, a
 * `for` body and a macro call each write to their own layer over the one they
 * started from, and a read looks down through the layers.
 */
class State {
  readonly own = new Map<string, Val>();
  constructor(readonly parent?: State) {}

  get(key: string): Val | undefined {
    for (let s: State | undefined = this; s; s = s.parent) {
      const v = s.own.get(key);
      if (v !== undefined) return v;
    }
    return undefined;
  }
}

interface Ctx {
  /** Every test this point sits under. An assignment here carries it (implicit flow). */
  cond?: Cond;
  /** The tests text printed here takes at once: those of enclosing loops and calls. An `if` adds its own test at its join, to the text only one branch prints. */
  emitCond?: Cond;
  /** Inside a loop body within the innermost `if` branch: text printed here is under a test that branch does not see. */
  fresh?: boolean;
  facts: Facts;
  st: State;
  scope?: Scope;
  gen?: number;
  genElse?: number;
  stack: readonly string[];
}

/** What a block prints: its literals, what the printed text reveals, and what its emptiness reveals. */
interface Sink {
  lits: Lit[];
  data: TestClass;
  truth: TestClass;
}

class Interp {
  private readonly macros = new Map<string, Node>();
  private readonly called = new Set<string>();
  private readonly textSpans: Map<Node, Span>;
  private readonly exprSpans = new Map<Node, Span>();
  private readonly genIds = new Map<Node, number>();
  // What each `for` body left in its variables, joined over every pass: the
  // values its next iteration starts from.
  private readonly backs = new Map<Node, Map<string, Val>>();
  // Variables a mutating method changed (`xs.append(x)`). The list is shared,
  // so the change outlives the loop or macro it was made in.
  private readonly mutated = new Set<string>();
  private work = 0;
  private changed = false;
  private outputLits = 0;
  private vias = 0;
  complete = true;
  readonly nondet = new Map<string, Trigger>();

  constructor(
    private readonly outcome: ParseOutcome,
    private readonly lines: LineMap,
  ) {
    this.textSpans = alignText(outcome.program!, outcome.pre!.tokens, outcome.spans, lines);
    collectMacros(outcome.program!, this.macros);
  }

  run(): Lit[] {
    const body = (this.outcome.program!.body as Node[]) ?? [];
    let converged = false;
    for (let pass = 0; pass < MAX_PASSES && this.complete; pass++) {
      this.changed = false;
      this.exec(body, { facts: NO_FACTS, st: new State(), stack: [] }, { lits: [], data: "none", truth: "none" });
      if (!this.changed) {
        converged = true;
        break;
      }
    }
    if (!converged) this.complete = false;
    this.called.clear();
    const out: Sink = { lits: [], data: "none", truth: "none" };
    this.outputLits = 0;
    this.exec(body, { facts: NO_FACTS, st: new State(), stack: [] }, out);
    // A macro no one calls emits nothing, but `random` or a clock test inside it
    // is still a use (ISC-18.1). Walk each one once with unknown arguments.
    for (const [name, m] of this.macros) {
      if (this.called.has(name)) continue;
      const st = new State();
      for (const p of (m.args as Node[]) ?? []) {
        const id = p?.type === "KeywordArgumentExpression" ? (p.key as Node) : p;
        if (id?.type === "Identifier") st.own.set(String(id.value), runtimeVal(rootField(""), undefined));
      }
      this.exec((m.body as Node[]) ?? [], { facts: NO_FACTS, st, scope: { macro: name }, stack: [name] }, { lits: [], data: "none", truth: "none" });
    }
    return out.lits;
  }

  private tick(): boolean {
    if (++this.work <= WORK_BUDGET) return true;
    this.complete = false;
    return false;
  }

  // ---- statements ----

  private exec(body: unknown, c: Ctx, sink: Sink): void {
    if (!Array.isArray(body)) return;
    for (const s of body as Node[]) {
      if (!s || typeof s !== "object" || !this.tick()) return;
      switch (s.type) {
        case "StringLiteral":
          // Text between tags, or a bare `{{ 'x' }}`.
          this.pushLit({ text: String(s.value), span: this.textSpans.get(s) ?? { ...WHOLE_TEMPLATE } }, c, sink);
          break;
        case "Comment":
        case "Break":
        case "Continue":
        case "Macro":
          break;
        case "If":
          this.execIf(s, c, sink);
          break;
        case "For":
          this.execFor(s, c, sink);
          break;
        case "Set": {
          let v: Val;
          if (s.value) v = this.eval(s.value, c);
          else {
            // A set block captures its body; the text is emitted where the name is printed.
            const inner: Sink = { lits: [], data: "none", truth: "none" };
            this.exec(s.body, { ...c, gen: undefined, genElse: undefined }, inner);
            v = { lits: inner.lits, data: inner.data, truth: inner.truth };
          }
          this.assignTo(s.assignee as Node, v, c);
          break;
        }
        case "CallStatement": {
          const call = s.call as Node;
          const callee = call?.callee as Node | undefined;
          const name = callee?.type === "Identifier" ? String(callee.value) : undefined;
          const caller: Caller = { body: (s.body as Node[]) ?? [], params: (s.callerArgs as Node[] | null) ?? [], ctx: c };
          const m = name ? this.macroNamed(name, c) : undefined;
          this.emit(m ? this.callMacro(m, (call.args as Node[]) ?? [], c, caller) : this.eval(call, c), c, sink);
          break;
        }
        case "FilterStatement": {
          const inner: Sink = { lits: [], data: "none", truth: "none" };
          this.exec(s.body, c, inner);
          const f = s.filter as Node;
          this.emit(this.applyFilter({ lits: inner.lits, data: inner.data, truth: inner.truth }, filterName(f), filterArgs(f), c, f), c, sink);
          break;
        }
        default:
          this.emit(this.eval(s, c), c, sink);
      }
    }
  }

  private execIf(s: Node, c: Ctx, sink: Sink): void {
    const test = s.test as Node;
    const tc = this.testCond(test, c);
    const cond = strongest(c.cond, tc);
    const sb = new State(c.st);
    const sa = new State(c.st);
    const body: Ctx = { ...c, cond, fresh: false, st: sb, facts: factsFrom(test, true, c.facts) };
    const alt: Ctx = { ...c, cond, fresh: false, st: sa, facts: factsFrom(test, false, c.facts) };
    const polarity = genPolarity(test);
    if (polarity) {
      let id = this.genIds.get(s);
      if (id === undefined) this.genIds.set(s, (id = this.genIds.size));
      if (polarity === "body") {
        body.gen = id;
        alt.genElse = id;
      } else {
        alt.gen = id;
        body.genElse = id;
      }
    }
    const ob: Sink = { lits: [], data: "none", truth: "none" };
    const oa: Sink = { lits: [], data: "none", truth: "none" };
    this.exec(s.body, body, ob);
    this.exec(s.alternate, alt, oa);
    joinLayers(c.st, sb, sa);
    // A literal both branches print, with no test between the branch and the
    // print, is there whichever way the test goes: it does not depend on it.
    const inB = new Set(ob.lits.map(printKey));
    const inA = new Set(oa.lits.map(printKey));
    for (const l of ob.lits) this.repush(l, !inA.has(printKey(l)), tc, c, sink);
    for (const l of oa.lits) this.repush(l, !inB.has(printKey(l)), tc, c, sink);
    sink.data = stronger(sink.data, stronger(ob.data, oa.data));
    sink.truth = stronger(sink.truth, stronger(ob.truth, oa.truth));
  }

  // Move a literal printed in an `if` branch out to the enclosing sink, under
  // the test when only that branch prints it.
  private repush(l: Lit, oneSided: boolean, test: Cond | undefined, c: Ctx, sink: Sink): void {
    const cond = oneSided ? strongest(l.cond, test) : l.cond;
    if (cond) sink.truth = stronger(sink.truth, cond.test);
    sink.lits.push({ ...l, cond, via: oneSided || c.fresh ? ++this.vias : l.via });
  }

  private execFor(s: Node, c: Ctx, sink: Sink): void {
    let iterNode = s.iterable as Node;
    let filter: Node | undefined;
    if (iterNode?.type === "SelectExpression") {
      filter = iterNode.test as Node;
      iterNode = iterNode.lhs as Node;
    }
    const it = this.eval(iterNode, c);
    const names = loopNames(s.loopvar as Node);
    // The loop's own layer holds what the body sets, across iterations. It
    // starts from the entry values joined with what the body left on earlier
    // passes: the start of a later iteration.
    const head = new State(c.st);
    const back = this.backs.get(s);
    if (back) {
      for (const [k, v] of back) {
        const e = c.st.get(k);
        head.own.set(k, e ? join(e, v) : v);
      }
    }
    const layer = new State(head);
    this.bindLoopVar(s.loopvar as Node, it, { ...c, st: layer });
    // The body runs only when the iterable is non-empty, so it depends on the
    // iterable's emptiness, and on what chose the iterable. The `else` block
    // runs when it is empty, without the loop variables.
    let loop = strongest(condOf(it.truth, this.exprSpan(iterNode)), it.gate);
    if (filter) loop = strongest(loop, this.testCond(filter, { ...c, st: layer }));
    const inner = { cond: strongest(c.cond, loop), emitCond: strongest(c.emitCond, loop), fresh: true };
    this.exec(s.body, { ...c, ...inner, st: layer }, sink);
    const next = new Map(back ?? []);
    let grew = false;
    for (const [k, v] of layer.own) {
      if (names.includes(k)) continue;
      const p = next.get(k);
      const j = p ? join(p, v) : v;
      if (!p || !sameVal(p, j)) {
        next.set(k, j);
        grew = true;
      }
    }
    if (grew) {
      this.backs.set(s, next);
      this.changed = true;
    }
    const els = new State(head);
    this.exec(s.defaultBlock, { ...c, ...inner, st: els }, sink);
    this.escape(c.st, [head, layer, els], false);
  }

  // After a loop or a macro, only namespace attributes and mutated lists outlive
  // its layers, each as the join of what every way out left. `weak` keeps the
  // value from before too, for a call that may not have run.
  private escape(into: State, exits: State[], weak: boolean): void {
    const keys = new Set<string>();
    for (const x of exits) for (const k of x.own.keys()) if (k.includes(".") || this.mutated.has(k)) keys.add(k);
    for (const k of keys) {
      let v = weak ? into.get(k) : undefined;
      for (const x of exits) {
        const xv = x.get(k);
        if (xv) v = v && v !== xv ? join(v, xv) : xv;
      }
      if (v) into.own.set(k, v);
    }
  }

  private bindLoopVar(lv: Node, it: Val, c: Ctx): void {
    if (lv?.type === "Identifier") {
      this.assign(String(lv.value), elemOf(it), c);
    } else if (lv?.type === "TupleLiteral" || lv?.type === "ArrayLiteral") {
      const names = ((lv.value as Node[]) ?? []).filter((x) => x?.type === "Identifier");
      if (it.pairs && names.length === 2) {
        this.assign(String(names[0]!.value), keysOf(it), c);
        this.assign(String(names[1]!.value), valuesOf(it), c);
      } else {
        const e = elemOf(it);
        for (const n of names) this.assign(String(n.value), elemOf(e), c);
      }
    }
  }

  private emit(v: Val, c: Ctx, sink: Sink): void {
    for (const l of v.lits) this.pushLit(l, c, sink);
    if (v.keys) for (const l of v.keys) this.pushLit(l, c, sink);
    sink.data = stronger(sink.data, v.data);
    // Whether the output is empty reveals whether each printed value is, and
    // the tests that chose to print it.
    if (isRuntime(v)) sink.truth = stronger(sink.truth, stronger(truthOf(v), c.cond?.test ?? "none"));
  }

  private pushLit(l: Lit, c: Ctx, sink: Sink): void {
    // Text with no letter or digit (whitespace, punctuation) is never injected
    // text, and is never taken as the generation-prompt marker.
    if (!WORDISH.test(l.text)) return;
    if (++this.outputLits > MAX_OUTPUT_LITS) {
      this.complete = false;
      return;
    }
    const cond = strongest(l.cond, c.emitCond);
    if (cond) sink.truth = stronger(sink.truth, cond.test);
    sink.lits.push({ text: l.text, span: l.span, cond, via: c.fresh ? ++this.vias : l.via, gen: l.gen ?? c.gen, genElse: l.genElse ?? c.genElse });
  }

  // ---- variables ----

  private lookup(name: string, c: Ctx): Val | undefined {
    return c.st.get(name);
  }

  private macroNamed(name: string, c: Ctx): string | undefined {
    const bound = this.lookup(name, c);
    if (bound) return bound.macro;
    return this.macros.has(name) ? name : undefined;
  }

  private assignTo(target: Node, v: Val, c: Ctx): void {
    if (!target || typeof target !== "object") return;
    if (target.type === "Identifier") {
      const name = String(target.value);
      this.assign(name, v, c, c.st.get(name));
    } else if (target.type === "MemberExpression") {
      // `set ns.attr = v`: the namespace's attribute slot.
      const k = this.slot(target, c);
      if (k !== undefined) this.assign(k, v, c, c.st.get(k));
    } else if (target.type === "TupleLiteral" || target.type === "ArrayLiteral") {
      const e = elemOf(v);
      for (const n of (target.value as Node[]) ?? []) this.assignTo(n, e, c);
    }
  }

  // Join `v` into the variable at `key`. The assignment's own conditions travel
  // with it: onto every literal (the text is only there when the test passed)
  // and onto the value's gate (its truthiness now depends on the test). A
  // literal the variable already held, read back through `before` (`set c =
  // c.split('</think>')[-1]`), keeps its own conditions: the test can keep or
  // drop that text but did not put it there.
  // A mutating method weakly updates its receiver (it may not have run), and
  // the change outlives the scope it was made in.
  private assign(key: string, v: Val, c: Ctx, before?: Val, mutate = false): void {
    const held = before && c.cond && before.lits.length > 0 ? new Set([...before.lits, ...(before.keys ?? [])]) : undefined;
    let w = c.cond ? this.under(v, c.cond, held) : v;
    if (w.nsInit) {
      const init = w.nsInit;
      const id = c.scope?.macro ? `${c.scope.macro}::${key}` : key;
      w = { ...w, ns: id, nsInit: undefined };
      for (const [attr, av] of init) this.assign(`${id}.${attr}`, av, c);
    }
    if (mutate) {
      this.mutated.add(key);
      if (before) w = join(before, w);
    }
    if (w.lits.length > MAX_LITS) {
      w = { ...w, lits: w.lits.slice(0, MAX_LITS) };
      this.complete = false;
    }
    c.st.own.set(key, w);
  }

  // The key of a namespace attribute, `ns.attr`, when `target` names one.
  private slot(target: Node, c: Ctx): string | undefined {
    const prop = target.property as Node;
    const attr = !target.computed && prop?.type === "Identifier" ? String(prop.value) : undefined;
    const o = this.eval(target.object, c);
    return o.ns !== undefined && attr !== undefined ? `${o.ns}.${attr}` : undefined;
  }

  // `v` under one more test: on its gate, and on every literal not in `held`.
  // Each literal it touches gets a new provenance even when the test is a
  // constant, so a literal printed on both sides of an `if` is only taken as
  // printed either way when no test stands between the two prints.
  private under(v: Val, cond: Cond | undefined, held?: ReadonlySet<Lit>): Val {
    const mark = (l: Lit): Lit => (held?.has(l) ? l : { ...l, cond: strongest(l.cond, cond), via: ++this.vias });
    return { ...v, lits: v.lits.map(mark), keys: v.keys?.map(mark), gate: strongest(v.gate, cond) };
  }

  // ---- expressions ----

  private eval(n: unknown, c: Ctx): Val {
    if (!n || typeof n !== "object" || !this.tick()) return EMPTY;
    const node = n as Node;
    switch (node.type) {
      case "StringLiteral": {
        const s = String(node.value);
        return { lits: [{ text: s, span: this.litSpan(node) }], data: "none", truth: "none", konst: s };
      }
      case "IntegerLiteral":
      case "FloatLiteral":
        return { lits: [], data: "none", truth: "none", konst: Number(node.value) };
      case "Identifier":
        return this.ident(node, c);
      case "MemberExpression":
        return this.member(node, c);
      case "CallExpression":
        return this.call(node, c);
      case "FilterExpression": {
        const o = this.eval(node.operand, c);
        const f = node.filter as Node;
        return this.applyFilter(o, filterName(f), filterArgs(f), c, f);
      }
      case "TestExpression":
        return boolVal(this.testClass(node, c));
      case "UnaryExpression": {
        if (String((node.operator as { value?: unknown })?.value) === "not") return boolVal(this.testClass(node.argument as Node, c));
        return this.eval(node.argument, c);
      }
      case "BinaryExpression":
        return this.binary(node, c);
      case "Ternary": {
        const test = node.condition as Node;
        const cond = this.testCond(test, c);
        const t = this.eval(node.trueExpr, { ...c, facts: factsFrom(test, true, c.facts) });
        const f = this.eval(node.falseExpr, { ...c, facts: factsFrom(test, false, c.facts) });
        return this.under(join(t, f), cond);
      }
      case "SelectExpression": {
        // `x if c` with no else.
        const test = node.test as Node;
        return this.under(this.eval(node.lhs, { ...c, facts: factsFrom(test, true, c.facts) }), this.testCond(test, c));
      }
      case "ArrayLiteral":
      case "TupleLiteral": {
        let v: Val = { lits: [], data: "none", truth: "none" };
        const konsts: string[] = [];
        let allKonst = true;
        for (const el of (node.value as Node[]) ?? []) {
          const e = this.eval(el, c);
          if (typeof e.konst === "string") konsts.push(e.konst);
          else allKonst = false;
          v = join(v, { ...e, konst: undefined, konstList: undefined, ns: undefined, macro: undefined, path: undefined });
        }
        return { ...v, truth: "none", konst: undefined, konstList: allKonst ? konsts : undefined };
      }
      case "ObjectLiteral": {
        const map = node.value as Map<unknown, unknown>;
        let v: Val = { lits: [], data: "none", truth: "none" };
        const keys: Lit[] = [];
        if (map instanceof Map) {
          for (const [k, val] of map) {
            const kv = this.eval(k, c);
            keys.push(...kv.lits);
            const vv = this.eval(val, c);
            v = join(v, { ...vv, konst: undefined, konstList: undefined, ns: undefined, macro: undefined, path: undefined, fields: undefined });
          }
        }
        return { ...v, keys: [...(v.keys ?? []), ...keys], truth: "none" };
      }
      case "KeywordArgumentExpression":
        return this.eval(node.value, c);
      case "SpreadExpression":
      case "KeywordSpreadExpression":
        return this.eval(node.argument, c);
      default:
        return EMPTY;
    }
  }

  private ident(n: Node, c: Ctx): Val {
    const name = String(n.value);
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
    const bound = this.lookup(name, c);
    if (bound) return refine(bound, name, c);
    if (this.macros.has(name)) return { ...EMPTY, macro: name };
    if (name === "random") this.flagNondet(n, "uses `random`");
    if (BUILTINS.has(name)) return EMPTY;
    return refine(runtimeVal(rootField(name), name), name, c);
  }

  private member(n: Node, c: Ctx): Val {
    const o = this.eval(n.object, c);
    const prop = n.property as Node;
    let key: string | number | undefined;
    let keyGate: Cond | undefined;
    if (!n.computed) {
      if (prop?.type === "Identifier") key = String(prop.value);
    } else if (prop?.type === "SliceExpression") {
      // A slice keeps the container: `messages[1:]` is still the messages.
      for (const part of [prop.start, prop.stop, prop.step]) if (part) keyGate = strongest(keyGate, this.eval(part, c).gate);
      return { ...o, path: undefined, konst: undefined, konstList: undefined, gate: strongest(o.gate, keyGate) };
    } else {
      const kv = this.eval(prop, c);
      if (typeof kv.konst === "string" || typeof kv.konst === "number") key = kv.konst;
      keyGate = strongest(kv.gate, condOf(kv.data === "presence" ? "none" : kv.data, this.exprSpan(prop)));
    }
    if (o.ns !== undefined && typeof key === "string") {
      const v = c.st.get(`${o.ns}.${key}`);
      return v ? refine(v, pathOf(n), c) : EMPTY;
    }
    if (o.macro !== undefined) return EMPTY;
    const fields = o.fields ? mapFields(o.fields, (f) => memberField(f, typeof key === "string" ? key : undefined)) : undefined;
    const path = o.path !== undefined && typeof key === "string" ? `${o.path}.${key}` : undefined;
    const v: Val = {
      lits: o.lits,
      data: fields ? clsOf(fields) : o.data,
      truth: fields ? "presence" : o.truth,
      gate: strongest(o.gate, keyGate),
      fields,
      path,
    };
    return refine(v, path, c);
  }

  private call(n: Node, c: Ctx): Val {
    const callee = n.callee as Node;
    const args = (n.args as Node[]) ?? [];
    if (callee?.type === "Identifier") {
      const name = String(callee.value);
      const m = this.macroNamed(name, c);
      if (m) return this.callMacro(m, args, c);
      if (!this.lookup(name, c)) {
        switch (name) {
          case "caller":
            return this.callCaller(args, c);
          case "namespace": {
            const init = new Map<string, Val>();
            for (const a of args) {
              if (a?.type !== "KeywordArgumentExpression") continue;
              init.set(String((a.key as Node).value), this.eval(a.value, c));
            }
            return { ...EMPTY, nsInit: init };
          }
          case "strftime_now":
            for (const a of args) this.eval(a, c);
            return { lits: [], data: "nondeterministic", truth: "nondeterministic" };
          case "random": {
            this.flagNondet(callee, "calls `random`");
            const nd = condOf("nondeterministic", this.exprSpan(n));
            let v: Val = EMPTY;
            for (const a of args) v = join(v, this.eval(a, c));
            return { ...this.under(v, nd), data: "nondeterministic", truth: "nondeterministic" };
          }
          case "raise_exception":
            // The message goes to the exception, never into the prompt.
            for (const a of args) this.eval(a, c);
            return EMPTY;
          case "dict": {
            let v: Val = EMPTY;
            const keys: Lit[] = [];
            for (const a of args) {
              if (a?.type === "KeywordArgumentExpression") keys.push({ text: String((a.key as Node).value), span: this.exprSpan(a.key as Node) });
              v = join(v, { ...this.eval(a, c), konst: undefined, fields: undefined, path: undefined });
            }
            return { ...v, keys, truth: "none" };
          }
        }
      }
      // Any other function (range, a runtime callable): its result carries the
      // arguments' data, never their text.
      let data: TestClass = "none";
      let gate: Cond | undefined;
      for (const a of args) {
        const v = this.eval(a, c);
        data = stronger(data, v.data);
        gate = strongest(gate, v.gate);
      }
      if (name === "random") this.flagNondet(callee, "calls `random`");
      return { lits: [], data, truth: data, gate };
    }
    if (callee?.type === "MemberExpression") {
      const r = this.eval(callee.object, c);
      const prop = callee.property as Node;
      const method = !callee.computed && prop?.type === "Identifier" ? String(prop.value) : prop?.type === "StringLiteral" ? String(prop.value) : "";
      return this.method(r, method, args, c, callee.object as Node);
    }
    this.eval(callee, c);
    for (const a of args) this.eval(a, c);
    return EMPTY;
  }

  private callMacro(name: string, argNodes: Node[], c: Ctx, caller?: Caller): Val {
    const m = this.macros.get(name);
    if (!m) return EMPTY;
    if (c.stack.length >= MAX_MACRO_DEPTH) return EMPTY;
    let depth = 0;
    for (const s of c.stack) if (s === name) depth++;
    if (depth >= MAX_RECURSION) return EMPTY;
    this.called.add(name);
    const formals = ((m.args as Node[]) ?? []).map((p) => {
      const kw = p?.type === "KeywordArgumentExpression";
      const id = kw ? (p.key as Node) : p;
      return { name: id?.type === "Identifier" ? String(id.value) : "", def: kw ? (p.value as Node) : undefined };
    });
    // The parameters are the macro's own layer; its `set` shadows them.
    const layer = new State(c.st);
    let pos = 0;
    for (const a of argNodes) {
      if (a?.type === "KeywordArgumentExpression") layer.own.set(String((a.key as Node).value), this.eval(a.value, c));
      else if (pos < formals.length) layer.own.set(formals[pos++]!.name, this.eval(a, c));
      else this.eval(a, c);
    }
    for (const f of formals) if (!layer.own.has(f.name)) layer.own.set(f.name, f.def ? this.eval(f.def, c) : EMPTY);
    // The body runs under the call site's conditions: its text inherits them.
    const inner: Ctx = { cond: c.cond, emitCond: c.emitCond, facts: NO_FACTS, st: layer, scope: { macro: name, caller }, gen: c.gen, genElse: c.genElse, stack: [...c.stack, name] };
    const sink: Sink = { lits: [], data: "none", truth: "none" };
    this.exec(m.body, inner, sink);
    this.escape(c.st, [layer], true);
    return { lits: sink.lits, data: sink.data, truth: sink.truth };
  }

  private callCaller(args: Node[], c: Ctx): Val {
    const cr = c.scope?.caller;
    if (!cr || c.stack.length >= MAX_MACRO_DEPTH) return EMPTY;
    const layer = new State(cr.ctx.st);
    let pos = 0;
    for (const a of args) {
      const v = this.eval(a, c);
      const p = cr.params[pos++];
      const id = p?.type === "KeywordArgumentExpression" ? (p.key as Node) : p;
      if (id?.type === "Identifier") layer.own.set(String(id.value), v);
    }
    const inner: Ctx = {
      ...cr.ctx,
      cond: strongest(c.cond, cr.ctx.cond),
      emitCond: strongest(c.emitCond, cr.ctx.emitCond),
      fresh: false,
      st: layer,
      stack: [...c.stack, "caller()"],
    };
    const sink: Sink = { lits: [], data: "none", truth: "none" };
    this.exec(cr.body, inner, sink);
    this.escape(c.st, [layer], true);
    return { lits: sink.lits, data: sink.data, truth: sink.truth };
  }

  private method(r: Val, m: string, argNodes: Node[], c: Ctx, receiver: Node): Val {
    const a = argNodes.map((x) => this.eval(x, c));
    const base = { gate: strongest(r.gate, a.reduce<Cond | undefined>((g, x) => strongest(g, x.gate), undefined)) };
    switch (m) {
      case "upper":
      case "lower":
      case "title":
      case "capitalize":
      case "strip":
      case "lstrip":
      case "rstrip":
      case "swapcase":
        // Case and whitespace changes keep the text and its emptiness.
        return { ...base, lits: r.lits, data: r.data, truth: r.truth, konst: typeof r.konst === "string" ? caseMap(r.konst, m) : undefined };
      case "replace":
        return { ...base, lits: [...r.lits, ...(a[1]?.lits ?? [])], data: r.data, truth: r.data };
      case "format":
        return { ...base, lits: [...r.lits, ...a.flatMap((x) => [...x.lits, ...(x.keys ?? [])])], data: maxData(r, a), truth: maxData(r, a) };
      case "join": {
        const list = a[0] ?? EMPTY;
        const konst = typeof r.konst === "string" && list.konstList ? list.konstList.join(r.konst) : undefined;
        const lits = [...list.lits, ...(list.keys ?? []), ...r.lits];
        return { ...base, lits: this.folded(lits, konst, receiver), data: list.data, truth: list.truth, konst };
      }
      case "split":
      case "rsplit":
      case "splitlines":
      case "partition":
      case "rpartition":
        return { ...base, lits: r.lits, data: r.data, truth: r.data };
      case "get": {
        const k = a[0]?.konst;
        const fields = r.fields ? mapFields(r.fields, (f) => memberField(f, typeof k === "string" ? k : undefined)) : undefined;
        return { ...base, lits: [...r.lits, ...(a[1]?.lits ?? [])], data: fields ? clsOf(fields) : r.data, truth: fields ? "presence" : r.truth, fields };
      }
      case "items":
      case "keys":
      case "values":
        if (m === "keys") return { ...base, lits: r.keys ?? [], data: r.fields ? "presence" : r.data, truth: r.truth };
        if (m === "values") return { ...base, lits: r.lits, data: r.data, truth: r.truth, fields: r.fields ? mapFields(r.fields, (f) => listOf(valueField(f))) : undefined };
        return { ...base, lits: r.lits, keys: r.keys, data: r.data, truth: r.truth, fields: r.fields, pairs: true };
      case "append":
      case "extend":
      case "insert":
      case "update":
      case "add": {
        // A mutating method: the receiver now holds the argument too.
        const v = { ...(a[a.length - 1] ?? EMPTY), konst: undefined, konstList: undefined, ns: undefined, macro: undefined, path: undefined };
        const k = receiver?.type === "Identifier" ? String(receiver.value) : receiver?.type === "MemberExpression" ? this.slot(receiver, c) : undefined;
        if (k !== undefined) this.assign(k, v, c, c.st.get(k), true);
        return EMPTY;
      }
      case "pop":
        return { ...base, lits: r.lits, data: r.data, truth: r.truth };
      default:
        // startswith, endswith, find, count, isdigit and the rest compute from
        // the receiver's text: they reveal it.
        return { ...base, lits: [], data: maxData(r, a), truth: maxData(r, a) };
    }
  }

  private applyFilter(o: Val, name: string, argNodes: Node[], c: Ctx, fnode: Node): Val {
    const a = argNodes.map((x) => this.eval(x, c));
    const gate = strongest(o.gate, a.reduce<Cond | undefined>((g, x) => strongest(g, x.gate), undefined));
    const keep = { lits: o.lits, data: o.data, truth: o.truth, gate };
    switch (name) {
      case "default":
      case "d": {
        // The default is printed only when the operand is undefined: a presence test.
        const dv = this.under(a[0] ?? EMPTY, condOf("presence", this.exprSpan(fnode)));
        return join(o, dv);
      }
      case "join": {
        const sep = a[0];
        const konst = o.konstList && (sep === undefined || typeof sep.konst === "string") ? o.konstList.join(sep ? (sep.konst as string) : "") : undefined;
        const lits = [...o.lits, ...(o.keys ?? []), ...(sep?.lits ?? [])];
        return { ...keep, lits: this.folded(lits, konst, fnode), konst };
      }
      case "replace":
        return { ...keep, lits: [...o.lits, ...(a[1]?.lits ?? [])], truth: o.data };
      case "format":
        return { ...keep, lits: [...o.lits, ...a.flatMap((x) => x.lits)], data: maxData(o, a), truth: maxData(o, a) };
      case "upper":
      case "lower":
      case "title":
      case "capitalize":
      case "trim": {
        const konst = typeof o.konst === "string" ? caseMap(o.konst, name) : undefined;
        return { ...keep, lits: konst !== undefined && konst !== o.konst ? this.folded(o.lits, konst, fnode) : o.lits, konst };
      }
      case "string":
      case "tojson":
      case "pprint":
        return { ...keep, lits: [...o.lits, ...(o.keys ?? [])], konst: name === "string" && typeof o.konst === "string" ? o.konst : undefined };
      case "safe":
      case "e":
      case "escape":
      case "forceescape":
      case "indent":
      case "center":
      case "wordwrap":
      case "truncate":
      case "striptags":
      case "urlencode":
        return keep;
      case "list":
      case "reverse":
      case "sort":
      case "unique":
      case "batch":
      case "slice":
        return { ...keep, keys: o.keys, fields: o.fields, konstList: name === "list" ? o.konstList : undefined };
      case "items":
      case "dictsort":
        return { ...keep, keys: o.keys, fields: o.fields, pairs: true };
      case "first":
      case "last":
      case "min":
      case "max": {
        const fields = o.fields ? mapFields(o.fields, elementField) : undefined;
        return { ...keep, data: fields ? clsOf(fields) : o.data, truth: fields ? "presence" : o.truth, fields };
      }
      case "length":
      case "count":
      case "wordcount":
        return { lits: [], data: o.truth, truth: o.truth, gate };
      case "int":
      case "float":
      case "abs":
      case "round":
      case "sum":
        return { lits: [], data: o.data, truth: o.data, gate };
      case "map": {
        const attr = kwargKonst(argNodes, "attribute");
        const efs = o.fields ? mapFields(o.fields, elementField) : undefined;
        if (attr !== undefined && efs) {
          const fs = mapFields(efs, (f) => memberField(f, attr));
          return { ...keep, data: clsOf(fs), fields: mapFields(fs, listOf) };
        }
        return keep;
      }
      case "selectattr":
      case "rejectattr":
      case "select":
      case "reject": {
        // Which elements survive depends on the test applied to each one.
        const efs = o.fields ? mapFields(o.fields, elementField) : undefined;
        let read: TestClass;
        let testArg: Val | undefined;
        if (name === "selectattr" || name === "rejectattr") {
          const attr = typeof a[0]?.konst === "string" ? a[0].konst : undefined;
          const fs = efs ? mapFields(efs, (f) => memberField(f, attr)) : undefined;
          read = fs ? clsOf(fs) : o.data;
          testArg = a[1];
        } else {
          read = efs ? clsOf(efs) : o.data;
          testArg = a[0];
        }
        const test = typeof testArg?.konst === "string" ? testArg.konst : "";
        const sel: TestClass = test === "" || SHAPE_SELECT_TESTS.has(test) ? (read === "none" ? "none" : "presence") : read;
        return { ...keep, keys: o.keys, fields: o.fields, truth: stronger(o.truth, sel) };
      }
      case "random": {
        this.flagNondet(fnode, "uses the `random` filter");
        const nd = condOf("nondeterministic", this.exprSpan(fnode));
        return { ...this.under({ ...keep, lits: [...o.lits, ...(o.keys ?? [])] }, nd), data: "nondeterministic", truth: "nondeterministic" };
      }
      default:
        return keep;
    }
  }

  private binary(n: Node, c: Ctx): Val {
    const o = String((n.operator as { value?: unknown })?.value ?? "");
    if (o === "and" || o === "or") {
      // The value is one of the operands; the right one only when the left one
      // decides so, so its text depends on the left side as a test.
      const l = this.eval(n.left, c);
      const lc = this.testCond(n.left as Node, c);
      const r = this.eval(n.right, { ...c, facts: factsFrom(n.left as Node, o === "and", c.facts) });
      return join(l, this.under(r, lc));
    }
    if (o === "in" || o === "not in" || o === "==" || o === "!=" || o === "<" || o === ">" || o === "<=" || o === ">=") {
      return boolVal(this.testClass(n, c));
    }
    const l = this.eval(n.left, c);
    const r = this.eval(n.right, c);
    const gate = strongest(l.gate, r.gate);
    const data = stronger(l.data, r.data);
    if (o === "~" || o === "+") {
      // Concatenation: fold two constants into one literal, so text assembled
      // from fragments is matched (and URL-scanned) whole.
      let konst: string | undefined;
      if (o === "~" && l.konst !== undefined && r.konst !== undefined) konst = konstText(l.konst) + konstText(r.konst);
      else if (o === "+" && typeof l.konst === "string" && typeof r.konst === "string") konst = l.konst + r.konst;
      if (konst !== undefined && konst.length > MAX_KONST) konst = undefined;
      const lits = [...l.lits, ...r.lits];
      return { lits: this.folded(lits, konst, n), keys: concatKeys(l, r), data, truth: stronger(l.truth, r.truth), gate, konst };
    }
    return { lits: [...l.lits, ...r.lits], data, truth: stronger(l.truth, r.truth), gate };
  }

  // Replace the literals a constant was folded from with one literal for the
  // folded text, spanned over the expression and under the strongest of their
  // conditions.
  private folded(lits: Lit[], konst: string | undefined, at: Node): Lit[] {
    if (konst === undefined || lits.length === 0) return lits;
    let cond: Cond | undefined;
    for (const l of lits) cond = strongest(cond, l.cond);
    return [{ text: konst, span: this.exprSpan(at), cond }];
  }

  // ---- tests ----

  private testEnv(c: Ctx): TestEnv {
    return { value: (x, f) => this.eval(x, f === c.facts ? c : { ...c, facts: f }) };
  }

  private testClass(n: Node, c: Ctx): TestClass {
    return classifyTest(n, this.testEnv(c), c.facts);
  }

  /** `n` used as a condition: its class and span. A clock or random test is recorded as a trigger (ISC-18.1). */
  private testCond(n: Node, c: Ctx): Cond | undefined {
    const cls = this.testClass(n, c);
    if (cls === "nondeterministic") this.flagNondet(n, "a test depends on the clock or on chance");
    return condOf(cls, this.exprSpan(n));
  }

  private flagNondet(n: Node, message: string): void {
    const span = this.exprSpan(n);
    const key = `${span.start}:${span.end}:${message}`;
    if (!this.nondet.has(key)) this.nondet.set(key, { span, message });
  }

  // ---- spans ----

  private litSpan(n: Node): Span {
    return this.outcome.spans.get(n) ?? this.textSpans.get(n) ?? this.exprSpan(n);
  }

  /** The span from the first to the last located leaf under `n`, or the whole template when none is located. */
  private exprSpan(n: Node): Span {
    const cached = this.exprSpans.get(n);
    if (cached) return cached;
    let first: Span | undefined;
    let end = -1;
    const stack: unknown[] = [n];
    let steps = 0;
    while (stack.length && steps++ < 100_000) {
      const x = stack.pop();
      if (!x || typeof x !== "object") continue;
      const s = this.outcome.spans.get(x as Node) ?? this.textSpans.get(x as Node);
      if (s) {
        if (!first || s.start < first.start) first = s;
        if (s.end > end) end = s.end;
      }
      for (const ch of children(x)) if (ch && typeof ch === "object") stack.push(ch);
    }
    const span = first ? { ...first, end: Math.max(end, first.end) } : { ...WHOLE_TEMPLATE };
    this.exprSpans.set(n, span);
    return span;
  }
}

// ---- values ----

const BUILTINS = new Set(["namespace", "dict", "range", "strftime_now", "raise_exception", "cycler", "joiner", "lipsum", "caller", "zip", "enumerate"]);
const SHAPE_SELECT_TESTS = new Set(["defined", "undefined", "none", "string", "mapping", "iterable", "sequence", "number", "integer", "float", "boolean", "true", "false"]);

function runtimeVal(field: Field, path: string | undefined): Val {
  return { lits: [], data: field.cls, truth: "presence", fields: [field], path };
}

function boolVal(cls: TestClass): Val {
  return { lits: [], data: cls, truth: cls };
}

// A guard in force (`if x is string`) refines what a membership test on `x` means.
function refine(v: Val, path: string | undefined, c: Ctx): Val {
  if (path === undefined) return v.path === undefined ? v : { ...v, path: undefined };
  const shape = c.facts.get(path);
  if (v.path === path && v.shape === shape) return v;
  return { ...v, path, shape };
}

/** Where two branches meet: each variable either branch set takes the join of both branches' values. */
function joinLayers(into: State, a: State, b: State): void {
  for (const k of new Set([...a.own.keys(), ...b.own.keys()])) {
    const va = a.get(k);
    const vb = b.get(k);
    const v = va && vb && va !== vb ? join(va, vb) : (va ?? vb);
    if (v) into.own.set(k, v);
  }
}

function printKey(l: Lit): string {
  return `${litKey(l)}:${l.via ?? ""}`;
}

/** The names a `for` target binds: `x`, or `k, v`. */
function loopNames(lv: Node): string[] {
  if (lv?.type === "Identifier") return [String(lv.value)];
  if (lv?.type === "TupleLiteral" || lv?.type === "ArrayLiteral") return ((lv.value as Node[]) ?? []).filter((x) => x?.type === "Identifier").map((x) => String(x.value));
  return [];
}

// An element, key or value of `it`. With no schema, an element's emptiness is
// as telling as the whole value's: the parts of a string the template built
// are no more content-revealing than the string.
function elemOf(it: Val): Val {
  const fields = it.fields ? mapFields(it.fields, elementField) : undefined;
  return {
    lits: [...it.lits, ...(it.keys ?? [])],
    data: fields ? clsOf(fields) : it.data,
    truth: fields ? "presence" : it.truth,
    gate: it.gate,
    fields,
  };
}

function keysOf(it: Val): Val {
  const d: TestClass = it.fields ? "presence" : it.data === "none" ? "none" : "presence";
  return { lits: it.keys ?? [], data: d, truth: d, gate: it.gate, fields: it.fields ? [KEY_FIELD] : undefined };
}

function valuesOf(it: Val): Val {
  const fields = it.fields ? mapFields(it.fields, valueField) : undefined;
  return { lits: it.lits, data: fields ? clsOf(fields) : it.data, truth: fields ? "presence" : it.truth, gate: it.gate, fields };
}

function maxData(r: Val, a: Val[]): TestClass {
  let d = r.data;
  for (const x of a) d = stronger(d, x.data);
  return d;
}

function concatKeys(l: Val, r: Val): Lit[] | undefined {
  if (!l.keys && !r.keys) return undefined;
  return [...(l.keys ?? []), ...(r.keys ?? [])];
}

function konstText(k: string | number | boolean | null): string {
  if (k === null) return "None";
  if (typeof k === "boolean") return k ? "True" : "False";
  return String(k);
}

function caseMap(s: string, how: string): string | undefined {
  switch (how) {
    case "upper":
      return s.toUpperCase();
    case "lower":
      return s.toLowerCase();
    case "strip":
    case "trim":
      return s.trim();
    case "lstrip":
      return s.trimStart();
    case "rstrip":
      return s.trimEnd();
    case "title":
      return s.replace(/\w\S*/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase());
    case "capitalize":
      return s ? s[0]!.toUpperCase() + s.slice(1).toLowerCase() : s;
    default:
      return undefined;
  }
}

function litKey(l: Lit): string {
  return `${l.span.start}:${l.span.end}:${l.text}`;
}

// Union of literal lists, keeping one entry per literal with the strongest
// condition seen for it.
function unionLits(a: Lit[], b: Lit[]): Lit[] {
  if (b.length === 0) return a;
  if (a.length === 0) return b;
  const index = new Map<string, number>();
  const out = a.slice();
  out.forEach((l, i) => index.set(litKey(l), i));
  for (const l of b) {
    const i = index.get(litKey(l));
    if (i === undefined) {
      index.set(litKey(l), out.length);
      out.push(l);
    } else {
      const cur = out[i]!;
      const cond = strongest(cur.cond, l.cond);
      if (cond !== cur.cond) out[i] = { ...cur, cond };
    }
  }
  return out;
}

/** The least value both `a` and `b` fit: every literal of either, the stronger classes, and only the facts both agree on. */
function join(a: Val, b: Val): Val {
  const keys = a.keys || b.keys ? unionLits(a.keys ?? [], b.keys ?? []) : undefined;
  return {
    lits: unionLits(a.lits, b.lits),
    keys,
    data: stronger(a.data, b.data),
    truth: stronger(a.truth, b.truth),
    gate: strongest(a.gate, b.gate),
    fields: unionFields(a.fields, b.fields),
    path: a.path === b.path ? a.path : undefined,
    shape: a.shape === b.shape ? a.shape : undefined,
    konst: a.konst === b.konst ? a.konst : undefined,
    konstList: a.konstList && b.konstList && a.konstList.join("\u0000") === b.konstList.join("\u0000") ? a.konstList : undefined,
    ns: a.ns === b.ns ? a.ns : undefined,
    macro: a.macro === b.macro ? a.macro : undefined,
    pairs: a.pairs && b.pairs ? true : undefined,
    nsInit: a.nsInit ?? b.nsInit,
  };
}

function sameVal(a: Val, b: Val): boolean {
  if (a.lits.length !== b.lits.length || (a.keys?.length ?? 0) !== (b.keys?.length ?? 0)) return false;
  if (a.data !== b.data || a.truth !== b.truth || a.gate?.test !== b.gate?.test) return false;
  if (!sameFields(a.fields, b.fields) || a.konst !== b.konst || a.ns !== b.ns || a.macro !== b.macro || a.pairs !== b.pairs) return false;
  if ((a.konstList === undefined) !== (b.konstList === undefined)) return false;
  for (let i = 0; i < a.lits.length; i++) if (a.lits[i]!.cond?.test !== b.lits[i]!.cond?.test) return false;
  return true;
}

function filterName(f: Node): string {
  if (!f || typeof f !== "object") return "";
  if (f.type === "Identifier") return String(f.value);
  if (f.type === "CallExpression") return String((f.callee as Node | undefined)?.value ?? "");
  return "";
}

function filterArgs(f: Node): Node[] {
  return f?.type === "CallExpression" ? ((f.args as Node[]) ?? []) : [];
}

function kwargKonst(args: Node[], key: string): string | undefined {
  for (const a of args) {
    if (a?.type === "KeywordArgumentExpression" && String((a.key as Node).value) === key) {
      const v = a.value as Node;
      if (v?.type === "StringLiteral") return String(v.value);
    }
  }
  return undefined;
}

function collectMacros(program: Node, out: Map<string, Node>): void {
  const stack: unknown[] = [program];
  while (stack.length) {
    const x = stack.pop();
    if (!x || typeof x !== "object") continue;
    if (Array.isArray(x)) {
      for (const el of x) stack.push(el);
      continue;
    }
    const n = x as Node;
    if (n.type === "Macro") {
      const name = (n.name as Node)?.value;
      if (typeof name === "string" && !out.has(name)) out.set(name, n);
    }
    // Macros are statements; only statement bodies can hold one.
    for (const k of ["body", "alternate", "defaultBlock"]) if (Array.isArray(n[k])) stack.push(n[k]);
  }
}

// ---- spans for template text ----

/**
 * Spans for the StringLiterals in statement bodies: text between tags and bare
 * `{{ 'x' }}` outputs. The library gives them no position and the pre-lexer
 * correlation skips them, so they are found here by walking the bodies in source
 * order with a cursor that every located leaf advances. The library has already
 * trimmed whitespace (trim_blocks, lstrip_blocks, `-`), so a literal is located
 * inside a text token; text the library merged across `{% generation %}` tags is
 * spanned from its first piece to its last.
 */
export function alignText(program: Node, tokens: PreToken[], leafSpans: Map<Node, Span>, lines: LineMap): Map<Node, Span> {
  const out = new Map<Node, Span>();
  let cursor = 0;
  const advance = (expr: unknown): void => {
    const stack: unknown[] = [expr];
    let steps = 0;
    while (stack.length && steps++ < 100_000) {
      const x = stack.pop();
      if (!x || typeof x !== "object") continue;
      const s = leafSpans.get(x as Node);
      if (s && s.end > cursor) cursor = s.end;
      for (const ch of children(x)) if (ch && typeof ch === "object") stack.push(ch);
    }
  };
  const locate = (v: string): Span | undefined => {
    if (!WORDISH.test(v)) return undefined;
    const trimmed = v.trim();
    let lo = 0;
    let hi = tokens.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tokens[mid]!.end <= cursor) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < tokens.length && i < lo + ALIGN_LOOKAHEAD; i++) {
      const t = tokens[i]!;
      if (t.type === "text") {
        const from = Math.max(0, cursor - t.start);
        let at = t.value.indexOf(v, from);
        let len = v.length;
        if (at < 0) {
          at = t.value.indexOf(trimmed, from);
          len = trimmed.length;
        }
        if (at >= 0) return lines.span(t.start + at, t.start + at + len);
        // Merged across generation tags: this token holds the first piece.
        const piece = t.value.slice(from).trim();
        if (piece && trimmed.startsWith(piece)) {
          const start = t.start + t.value.indexOf(piece, from);
          let got = piece.length;
          let end = start + piece.length;
          for (let j = i + 1; j < tokens.length && j < i + ALIGN_LOOKAHEAD && got < trimmed.length; j++) {
            if (tokens[j]!.type !== "text") continue;
            got += tokens[j]!.value.length;
            end = tokens[j]!.end;
          }
          return lines.span(start, end);
        }
      } else if (t.type === "string" && t.inTag && t.start >= cursor && v.startsWith(t.value)) {
        // A bare output string, possibly several adjacent literals the parser merged.
        let acc = "";
        let end = t.start;
        for (let j = i; j < tokens.length && tokens[j]!.type === "string" && acc !== v && v.startsWith(acc + tokens[j]!.value); j++) {
          acc += tokens[j]!.value;
          end = tokens[j]!.end;
        }
        if (acc === v) return lines.span(t.start, end);
      }
    }
    return undefined;
  };

  // Statements in source order on an explicit stack (ISC-31): a body expands to
  // its statements, a statement to its parts, and an expression part advances
  // the cursor past its located leaves.
  type Work = { k: "body"; v: unknown } | { k: "stmt"; v: unknown } | { k: "expr"; v: unknown };
  const stack: Work[] = [{ k: "body", v: program.body }];
  let steps = 0;
  while (stack.length && steps++ < 2_000_000) {
    const w = stack.pop()!;
    if (w.k === "expr") {
      advance(w.v);
      continue;
    }
    if (w.k === "body") {
      if (Array.isArray(w.v)) for (let i = w.v.length - 1; i >= 0; i--) stack.push({ k: "stmt", v: w.v[i] });
      continue;
    }
    const n = w.v as Node;
    if (!n || typeof n !== "object") continue;
    let parts: Work[];
    switch (n.type) {
      case "StringLiteral": {
        const s = locate(String(n.value));
        if (s) {
          out.set(n, s);
          cursor = s.end;
        }
        continue;
      }
      case "If":
        parts = [{ k: "expr", v: n.test }, { k: "body", v: n.body }, { k: "body", v: n.alternate }];
        break;
      case "For":
        parts = [{ k: "expr", v: n.loopvar }, { k: "expr", v: n.iterable }, { k: "body", v: n.body }, { k: "body", v: n.defaultBlock }];
        break;
      case "Set":
        parts = [{ k: "expr", v: n.assignee }, { k: "expr", v: n.value }, { k: "body", v: n.body }];
        break;
      case "Macro":
        parts = [{ k: "expr", v: n.args }, { k: "body", v: n.body }];
        break;
      case "CallStatement":
        parts = [{ k: "expr", v: n.call }, { k: "expr", v: n.callerArgs }, { k: "body", v: n.body }];
        break;
      case "FilterStatement":
        parts = [{ k: "expr", v: n.filter }, { k: "body", v: n.body }];
        break;
      case "Comment":
      case "Break":
      case "Continue":
        continue;
      default:
        advance(n); // an output expression
        continue;
    }
    for (let i = parts.length - 1; i >= 0; i--) stack.push(parts[i]!);
  }
  return out;
}

// ---- scaffolding ----

interface TrieNode {
  next: Map<number, TrieNode>;
  end: boolean;
}

/** The residue of a literal: the non-scaffolding runs that hold a letter or digit, and where the last scaffolding match ended. */
export interface Residue {
  frags: [number, number][];
  lastPieceEnd: number;
}

// Word characters for the boundary rule, by UTF-16 unit. A surrogate half is
// taken as a word character, so an astral letter never starts a false match.
const wordCache = new Uint8Array(65536); // 0 unknown, 1 word, 2 not
function isWordUnit(u: number): boolean {
  if (u < 128) return (u >= 48 && u <= 57) || (u >= 65 && u <= 90) || (u >= 97 && u <= 122) || u === 95;
  if (u >= 0xd800 && u <= 0xdfff) return true;
  let w = wordCache[u]!;
  if (w === 0) wordCache[u] = w = WORDISH.test(String.fromCharCode(u)) ? 1 : 2;
  return w === 1;
}

/**
 * Removes scaffolding from a literal. A scaffolding string matches anywhere its
 * edges are not word characters (`<|im_start|>`), and only at word boundaries
 * where they are (`assistant`, `system`), so a role name inside a word is not
 * scaffolding. Longest match wins. Only strings with a letter or digit are
 * loaded: punctuation and whitespace never decide whether residue exists.
 */
export class Scaffold {
  private readonly root: TrieNode = { next: new Map(), end: false };
  private work = 0;
  private readonly cache = new Map<string, Residue>();
  complete = true;

  constructor(pieces: Iterable<string>) {
    let total = 0;
    for (const p of pieces) {
      if (!p || p.length > MAX_PIECE || !WORDISH.test(p)) continue;
      total += p.length;
      if (total > MAX_TRIE_CHARS) break; // more residue, never less: the safe side
      let node = this.root;
      for (let i = 0; i < p.length; i++) {
        const u = p.charCodeAt(i);
        let nx = node.next.get(u);
        if (!nx) node.next.set(u, (nx = { next: new Map(), end: false }));
        node = nx;
      }
      node.end = true;
    }
  }

  residue(text: string): Residue {
    const hit = this.cache.get(text);
    if (hit) return hit;
    const frags: [number, number][] = [];
    let lastPieceEnd = -1;
    let segStart = 0;
    let i = 0;
    const n = text.length;
    while (i < n) {
      let matchEnd = -1;
      const u = text.charCodeAt(i);
      if (this.complete && (!isWordUnit(u) || i === 0 || !isWordUnit(text.charCodeAt(i - 1)))) {
        let node: TrieNode | undefined = this.root;
        for (let j = i; j < n; ) {
          if (++this.work > MATCH_BUDGET) {
            this.complete = false;
            break;
          }
          node = node.next.get(text.charCodeAt(j));
          if (!node) break;
          j++;
          if (node.end && (!isWordUnit(text.charCodeAt(j - 1)) || j === n || !isWordUnit(text.charCodeAt(j)))) matchEnd = j;
        }
      }
      if (matchEnd > i) {
        pushFrag(text, segStart, i, frags);
        lastPieceEnd = matchEnd;
        i = matchEnd;
        segStart = i;
      } else i++;
    }
    pushFrag(text, segStart, n, frags);
    const r = { frags, lastPieceEnd };
    if (this.cache.size < 100_000) this.cache.set(text, r);
    return r;
  }
}

function pushFrag(text: string, s: number, e: number, out: [number, number][]): void {
  while (s < e && /\s/.test(text[s]!)) s++;
  while (e > s && /\s/.test(text[e - 1]!)) e--;
  if (e > s && WORDISH.test(text.slice(s, e))) out.push([s, e]);
}

// ---- items ----

/**
 * Turn the ordered output literals into injected-text items. The generation-
 * prompt marker is the first literal emitted in an `add_generation_prompt`
 * branch: residue after its last scaffolding match, and every literal emitted
 * after it in program order, is prefilled assistant text (ISC-17.2). The
 * branch's `else` is exclusive with it and is never after it.
 */
export function toItems(lits: Lit[], matcher: Scaffold): InjectedText[] {
  const items = new Map<string, InjectedText>();
  const seen = new Set<number>();
  let after = false;
  const add = (l: Lit, frags: [number, number][], afterGen: boolean): void => {
    if (frags.length === 0) return;
    const text = l.text.slice(frags[0]![0], frags[frags.length - 1]![1]);
    const key = `${l.span.start}:${l.span.end}:${afterGen}:${text}`;
    const prev = items.get(key);
    const cond = strongest(prev?.condition as Cond | undefined, l.cond);
    items.set(key, { text, span: l.span, condition: cond ? { span: cond.span, test: cond.test } : undefined, afterGenerationPrompt: afterGen });
  };
  for (const l of lits) {
    const r = matcher.residue(l.text);
    if (l.genElse !== undefined && seen.has(l.genElse)) {
      add(l, r.frags, false);
    } else if (l.gen !== undefined && !seen.has(l.gen)) {
      seen.add(l.gen);
      const cut = r.lastPieceEnd >= 0 ? r.lastPieceEnd : l.text.length;
      add(l, r.frags.filter((f) => f[0] < cut), after);
      add(l, r.frags.filter((f) => f[0] >= cut), true);
      after = true;
    } else {
      add(l, r.frags, after);
    }
  }
  return [...items.values()];
}

