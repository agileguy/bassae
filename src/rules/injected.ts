// Injected-text extraction (ISC-17): every literal a template can emit that is
// not scaffolding, with its span, the strongest test it sits under, and whether
// it lands after the generation-prompt marker.
//
// This is an abstract interpretation of the parsed template, never a render.
// Each expression evaluates to a Val (triggers.ts): the template literals it can
// carry to the output, and how strongly it depends on runtime input. Literals
// reach the output through text, `{{ }}`, set and set blocks, namespace
// attributes, macro parameters and bodies, `caller()`, `~`/`+`/`%`, joins,
// filters, string methods and calls the walk has no rule for, so all of those
// carry them. Variables follow jinja2's scoping: a `set` replaces the value on
// the path it is on, `if` branches join where they meet, and what a `for` body
// or a macro sets is gone after it, except namespace attributes and mutated
// lists. A macro's extra arguments are its `varargs` and `kwargs`. A loop's body starts
// from the join of its entry and what the body left on earlier passes, computed
// to a fixpoint, so a loop-carried value is never missed. Macros are inlined at
// every call site, so their emissions inherit the call site's conditions
// (ISC-18); a call the walk cannot resolve runs every macro the template used
// as a value. An assignment under a test carries the test onto its literals,
// except text the test only moves: what the variable already held, and text
// split out of the value the test reads, when that text is printed another way.
// Text a test chooses without wrapping it takes the test as well: a literal
// only one arm of an `if` leaves in a variable, and text picked by a subscript
// key, slice bound, `.get` key, replace needle or repeat count.
//
// The walk is bounded: a work budget over every node visit and every literal
// copied, a cap on literals per value, a budget on folded constants, a cap on
// macro inlining depth (a recursive macro is unrolled twice), and explicit-
// stack walkers for the span helpers. Hitting any bound sets `complete` false
// rather than throwing (ISC-42.1), and the text between tags is still reported.

import type { InjectedText, Span, TriggerCandidate, TriggerOp } from "../types.ts";
import { scanBlobs, scanUrls } from "./textscan.ts";
import { WHOLE_TEMPLATE, type ParseOutcome } from "../parse/parse.ts";
import { children, type LineMap, type Node } from "../parse/support.ts";
import type { PreToken } from "../parse/prelexer.ts";
import {
  classifyTest,
  clsOf,
  condOf,
  countArith,
  countField,
  countedIn,
  countPick,
  countsOf,
  countTest,
  eitherNums,
  eitherRest,
  elementField,
  factsFrom,
  FLAG_FILTERS,
  flagNumbers,
  genPolarity,
  isRuntime,
  isSlice,
  keyed,
  keyField,
  lengthOf,
  listOf,
  mapFields,
  memberField,
  memberPath,
  NO_FACTS,
  NUMBER_KEEPING,
  orderedOf,
  orderOf,
  pathOf,
  presenceOf,
  readOf,
  rangeOf,
  recordOf,
  restOf,
  rootField,
  sameFields,
  stronger,
  strongest,
  truthOf,
  unionFields,
  valueField,
  vocabClass,
  type Cond,
  type Facts,
  type Field,
  type Fields,
  type Frame,
  type GenAt,
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
  /** URLs and blobs only the printed text as a whole holds: across literals printed one after another, or in a folded literal (ISC-19, ISC-20). */
  joined: { urls: InjectedText[]; blobs: InjectedText[] };
  nondeterministic: Trigger[];
  /** Every literal compared with runtime input, from the same walk (ISC-22.1). */
  triggers: TriggerCandidate[];
  /** Every input path read at a member, through set names and macro arguments, from the same walk. */
  reads: string[];
  /** False when a budget stopped the walk before every emission was seen, or there were more trigger candidates than MAX_TRIGGERS. */
  complete: boolean;
}

/** A test the walk classed (ISC-25): an `if` or loop test or one part of it, an inline if, a comparison, an `is` test, a select filter, a loop's iterable, or a key, bound or count that chooses text. */
export interface ClassedTest {
  node: Node;
  span: Span;
  /** The strongest class any call site or path gave it. */
  cls: TestClass;
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
const MAX_LITS = 256;
const MAX_OUTPUT_LITS = 50_000;
// A folded constant longer than this is not folded (its parts still count).
const MAX_KONST = 64 * 1024;
// Characters of folded constants in one pass over the template. A chain of
// `set s = s ~ 'x'` folds ever longer strings; past this, the pieces stay as
// written, which the matcher reads as more residue, never less.
const KONST_BUDGET = 4 * 1024 * 1024;
// Characters of printed text joined for the URL and blob scans.
const JOIN_BUDGET = 16 * 1024 * 1024;
// Tokens the text aligner looks ahead before it gives a literal a fallback span.
const ALIGN_LOOKAHEAD = 256;
// Trie steps the scaffolding matcher may take over the whole template.
const MATCH_BUDGET = 20_000_000;
// Scaffolding strings longer than this never match inside other text.
const MAX_PIECE = 4096;
// Total characters of scaffolding put into the trie.
const MAX_TRIE_CHARS = 4 * 1024 * 1024;
// Trigger candidates listed for one template. Past this the list is cut and
// the walk is incomplete, never silently short (ISC-22.1).
const MAX_TRIGGERS = 1024;
// Read paths only shape what a probe adds, so a cut list costs a probe detail, never a verdict.
const MAX_READS = 1024;
// Ordering a literal from the other side: `40 < n` is `n > 40`.
const FLIPPED: Readonly<Record<string, TriggerOp>> = { "<": ">", ">": "<", "<=": ">=", ">=": "<=", "==": "==", "!=": "!=" };
// The select filters' comparison tests, as the operator each one is (ISC-22.1).
const SELECT_OPS: Readonly<Record<string, TriggerOp>> = {
  equalto: "==", "==": "==", eq: "==", sameas: "==", ne: "!=", "!=": "!=", in: "==",
  lt: "<", lessthan: "<", "<": "<", le: "<=", "<=": "<=", gt: ">", greaterthan: ">", ">": ">", ge: ">=", ">=": ">=",
};
// Methods that look for their argument in the receiver's text: the literal is inside the input.
const SEARCH_OPS: Readonly<Record<string, TriggerOp>> = { startswith: "startswith", endswith: "endswith", find: "in", rfind: "in", index: "in", rindex: "in", count: "in" };

const EMPTY: Val = { lits: [], data: "none", truth: "none" };
const WORDISH = /[\p{L}\p{N}]/u;
const NON_SPACE = /\S/u;

/** Run the extraction over a parsed template. */
export function extract(outcome: ParseOutcome, text: string, scaffolding: ReadonlySet<string>): Extraction {
  const matcher = new Scaffold(scaffolding);
  if (!outcome.program || !outcome.pre || !outcome.lines) {
    return { items: rawItems(outcome, matcher), joined: { urls: [], blobs: [] }, nondeterministic: [], triggers: [], reads: [], complete: false };
  }
  const interp = new Interp(outcome, outcome.lines);
  const lits = interp.run();
  const items = toItems(lits, matcher);
  const joined = joinedText(lits, matcher);
  if (!interp.complete) {
    // Out of budget, the walk may have stopped before some text: every text run
    // between tags it did not reach is still reported, as on the no-AST path.
    const seen = new Set(items.map((i) => i.span.start));
    for (const r of rawItems(outcome, matcher)) if (!seen.has(r.span.start)) items.push(r);
  }
  // A list cut at the cap is never passed off as whole (ISC-22.1).
  const triggers = [...interp.triggers.values()];
  return { items, joined, nondeterministic: [...interp.nondet.values()], triggers, reads: [...interp.reads], complete: interp.complete && !interp.triggersCut && matcher.complete && joined.complete };
}

/**
 * Every test in a parsed template, classed by the extraction's own walk (ISC-25). Undefined with no AST, or when a
 * budget or cap stopped the walk: a test it did not reach, or reached with a value cut short, may be stronger than it
 * reads.
 */
export function classedTests(outcome: ParseOutcome): ClassedTest[] | undefined {
  if (!outcome.program || !outcome.pre || !outcome.lines) return undefined;
  const interp = new Interp(outcome, outcome.lines);
  interp.run();
  return interp.complete ? interp.classedTests() : undefined;
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
  /** Literals held, at the test, in the values the enclosing content tests read. */
  subject?: ReadonlySet<Lit>;
  facts: Facts;
  /** The block this point is in. Unset at the top level. */
  path?: Frame;
  st: State;
  scope?: Scope;
  gen?: number;
  genElse?: number;
  stack: readonly string[];
  /** The input the innermost loop's element is read from: what `loop.previtem` and `loop.nextitem` read (ISC-22.1). */
  loopItem?: string;
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
  private readonly testSpans = new Map<Node, Span>();
  private readonly genIds = new Map<Node, number>();
  // What each `for` body left in its variables, joined over every pass: the
  // values its next iteration starts from.
  private readonly backs = new Map<Node, Map<string, Val>>();
  // Variables a mutating method changed (`xs.append(x)`). The list is shared,
  // so the change outlives the loop or macro it was made in.
  private readonly mutated = new Set<string>();
  // Macros the template used as values (`set f = m`, `[m]`, `{'k': m}`). A
  // call the extraction cannot resolve may reach any of them.
  private readonly escaped = new Set<string>();
  // The same for strftime_now and random put in a list or dict, or passed to
  // a function: a call through a value the walk lost track of may be them.
  private readonly escapedFns = new Set<string>();
  // What each filter last read as its operand, in which context: a count
  // test that looks through `|int` takes it from here, not from a second walk
  // of the operand (review round 3, runtime S3-1).
  private readonly operands = new WeakMap<Node, { c: Ctx; v: Val }>();
  private work = 0;
  private changed = false;
  private outputLits = 0;
  private vias = 0;
  private konstChars = 0;
  complete = true;
  readonly nondet = new Map<string, Trigger>();
  // The final pass records each test it classes, with the strongest class any
  // call site gives it (ISC-25), and each literal compared with runtime input
  // (ISC-22.1). The passes before it run on values not yet settled.
  private recording = false;
  private readonly tests = new Map<Node, TestClass>();
  readonly triggers = new Map<string, TriggerCandidate>();
  readonly reads = new Set<string>();
  triggersCut = false;

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
      this.konstChars = 0;
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
    this.konstChars = 0;
    this.recording = true;
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

  /** The tests the final pass classed, in source order, an enclosing one before those inside it. */
  classedTests(): ClassedTest[] {
    const out: ClassedTest[] = [];
    for (const [node, cls] of this.tests) out.push({ node, span: this.testSpan(node), cls });
    return out.sort((a, b) => a.span.start - b.span.start || b.span.end - a.span.end);
  }

  private tick(): boolean {
    return this.spend(1);
  }

  // Charge work by the literals an operation copies, so a value that gathers a
  // new literal on every statement (`set s = s ~ '...'` repeated) costs what it
  // copies and runs out of budget instead of time.
  private spend(n: number): boolean {
    this.work += n;
    if (this.work <= WORK_BUDGET) return true;
    this.complete = false;
    return false;
  }

  // Where a value holds the flag is kept to MAX_GEN_AT entries, so a join costs
  // the same however often it runs. Past that it is dropped and the template is
  // incomplete, as a read of it may be the flag (review round 3, runtime R3-1).
  private capped(v: Val): Val {
    if (!v.genAt || genSize(v.genAt, MAX_GEN_AT) <= MAX_GEN_AT) return v;
    this.complete = false;
    return { ...v, genAt: undefined };
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
          this.emit(m ? this.callMacro(m, (call.args as Node[]) ?? [], c, caller) : this.eval(call, c), c, sink, s);
          break;
        }
        case "FilterStatement": {
          const inner: Sink = { lits: [], data: "none", truth: "none" };
          this.exec(s.body, c, inner);
          const f = s.filter as Node;
          // `replace` on a body of plain text works out the text it leaves, so
          // a closer it removes is not printed (review round 2, security N4).
          // Other filters keep the body's own text.
          const body = (s.body as Node[]) ?? [];
          const plain = filterName(f) === "replace" && body.every((b) => b?.type === "StringLiteral");
          const konst = plain ? body.map((b) => String(b.value)).join("") : undefined;
          this.emit(this.applyFilter({ lits: inner.lits, data: inner.data, truth: inner.truth, konst }, filterName(f), filterArgs(f), c, f), c, sink, s);
          break;
        }
        default:
          this.emit(this.eval(s, c), c, sink, s);
      }
    }
  }

  private execIf(s: Node, c: Ctx, sink: Sink): void {
    const test = s.test as Node;
    const tc = this.testCond(test, c);
    const cond = strongest(c.cond, tc);
    const subject = this.subjectOf(test, tc, c);
    const sb = new State(c.st);
    const sa = new State(c.st);
    const [yes, no] = arms(c.path);
    const body: Ctx = { ...c, cond, subject, fresh: false, st: sb, facts: factsFrom(test, true, c.facts), path: yes };
    const alt: Ctx = { ...c, cond, subject, fresh: false, st: sa, facts: factsFrom(test, false, c.facts), path: no };
    const polarity = this.genOf(test, c);
    if (polarity) {
      const id = this.genId(s);
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
    this.spend(this.joinBranches(c.st, sb, sa, tc, yes, no) + ob.lits.length + oa.lits.length);
    // A literal both branches print, with no test between the branch and the
    // print, is there whichever way the test goes: it does not depend on it.
    const inB = new Set(ob.lits.map(printKey));
    const inA = new Set(oa.lits.map(printKey));
    for (const l of ob.lits) this.repush(l, !inA.has(printKey(l)), tc, c, sink);
    for (const l of oa.lits) this.repush(l, !inB.has(printKey(l)), tc, c, sink);
    sink.data = stronger(sink.data, stronger(ob.data, oa.data));
    sink.truth = stronger(sink.truth, stronger(ob.truth, oa.truth));
  }

  // Where an `if`'s branches meet, each variable either branch set takes the
  // join of both branches' values. A literal only one branch's value holds is
  // there only when the test went that way (`set x = '...'` then `if not T`
  // `set x = ''`), so it takes the test, as a print in one branch does. Each
  // literal is in the arm that left it, so a closer one branch overwrites does
  // not close a header (review round 2, security N4).
  private joinBranches(into: State, a: State, b: State, test: Cond | undefined, yes: Frame, no: Frame): number {
    let copied = 0;
    for (const k of new Set([...a.own.keys(), ...b.own.keys()])) {
      const va = a.get(k);
      const vb = b.get(k);
      let v: Val | undefined;
      if (va && vb) v = va === vb ? va : join(inArm(this.oneSided(va, vb, test), yes), inArm(this.oneSided(vb, va, test), no));
      else if (va) v = inArm(va, yes);
      else if (vb) v = inArm(vb, no);
      if (v) into.own.set(k, v);
      copied += (va?.lits.length ?? 0) + (vb?.lits.length ?? 0);
    }
    return copied;
  }

  // `v` with `test` on each literal `other` does not hold.
  private oneSided(v: Val, other: Val, test: Cond | undefined): Val {
    if (!test) return v;
    const there = new Set<string>();
    for (const l of other.lits) there.add(litKey(l));
    for (const l of other.keys ?? []) there.add(litKey(l));
    const mark = (l: Lit): Lit => (there.has(litKey(l)) ? l : { ...l, cond: strongest(l.cond, test), via: ++this.vias });
    return { ...v, lits: v.lits.map(mark), keys: v.keys?.map(mark) };
  }

  // Move a literal printed in an `if` branch out to the enclosing sink, under
  // the test when only that branch prints it.
  private repush(l: Lit, oneSided: boolean, test: Cond | undefined, c: Ctx, sink: Sink): void {
    const cond = oneSided ? strongest(l.cond, test) : l.cond;
    if (cond && WORDISH.test(l.text)) sink.truth = stronger(sink.truth, cond.test);
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
    // A loop over computed text (`m.content.split('x')[1:]`) runs only when the
    // text holds what it looks for: its iterable is a test too (ISC-25).
    this.classed(iterNode, loop?.test ?? "none");
    if (filter) loop = strongest(loop, this.testCond(filter, { ...c, st: layer }));
    const inner = { cond: strongest(c.cond, loop), emitCond: strongest(c.emitCond, loop), fresh: true };
    const [each, none] = arms(c.path);
    LOOP_BODIES.add(each);
    // A filter that holds only with the flag set, or a count of passes above 0
    // only with it (`range(add_generation_prompt|int)`), makes the body a
    // generation-prompt branch, and its `else` the arm exclusive with it.
    const flagged = (filter && this.genOf(filter, { ...c, st: layer }) === "body") || this.flagRange(iterNode, c);
    const gen = flagged ? this.genId(s) : undefined;
    this.exec(s.body, { ...c, ...inner, st: layer, path: each, gen: gen ?? c.gen, loopItem: elemSrc(it) }, sink);
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
    this.exec(s.defaultBlock, { ...c, ...inner, st: els, path: none, genElse: gen ?? c.genElse }, sink);
    this.escape(c.st, [head, layer, els], false, [none, each, none]);
  }

  // After a loop or a macro, only namespace attributes and mutated lists outlive
  // its layers, each as the join of what every way out left. `weak` keeps the
  // value from before too, for a call that may not have run, in a block of its
  // own below `here`. A loop's ways out are its body or its `else`: each
  // literal is in the arm that left it (review round 2, security N4).
  private escape(into: State, exits: State[], weak: boolean, ways?: readonly Frame[], here?: Frame): void {
    const keys = new Set<string>();
    for (const x of exits) for (const k of x.own.keys()) if (k.includes(".") || this.mutated.has(k)) keys.add(k);
    for (const k of keys) {
      const before = weak ? into.get(k) : undefined;
      let v = before && inArm(before, { up: here ?? ROOT });
      exits.forEach((x, i) => {
        let xv = x.get(k);
        if (xv && ways) xv = inArm(xv, ways[i]!);
        if (xv) v = v && v !== xv ? join(v, xv) : xv;
      });
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
        this.assign(String(names[1]!.value), withHeld(valuesOf(it), heldAt(heldAt(it.genAt, null), 1)), c);
      } else {
        const e = elemOf(it);
        for (const n of names) this.assign(String(n.value), entryOf(e, (lv.value as Node[]).indexOf(n)), c);
      }
    }
  }

  private emit(v: Val, c: Ctx, sink: Sink, at: Node): void {
    if (!this.spend(v.lits.length)) return;
    // Runtime text separates the literals printed before and after it.
    if (isRuntime(v) && v.lits.length === 0 && !v.keys?.length) this.pushLit({ text: "", span: this.exprSpan(at), brk: true }, c, sink);
    for (const l of v.lits) this.pushLit(l, c, sink);
    if (v.keys) for (const l of v.keys) this.pushLit(l, c, sink);
    sink.data = stronger(sink.data, v.data);
    // Whether the output is empty reveals whether each printed value is, and
    // the tests that chose to print it.
    if (isRuntime(v)) sink.truth = stronger(sink.truth, stronger(truthOf(v), c.cond?.test ?? "none"));
  }

  private pushLit(l: Lit, c: Ctx, sink: Sink): void {
    if (l.text === "" && !l.brk) return;
    // Whitespace never continues a URL or a blob: it separates the literals
    // around it as runtime text does. One break stands for a run of them.
    if (l.brk || !NON_SPACE.test(l.text)) {
      if (!sink.lits.at(-1)?.brk) sink.lits.push({ text: "", span: l.span, brk: true });
      return;
    }
    if (++this.outputLits > MAX_OUTPUT_LITS) {
      this.complete = false;
      return;
    }
    const cond = strongest(l.cond, c.emitCond);
    // Punctuation is never injected text and is never the generation-prompt
    // marker; it is kept only to join the literals around it (`http{{ ':' }}//`).
    if (cond && WORDISH.test(l.text)) sink.truth = stronger(sink.truth, cond.test);
    const at = placed(l.at, c.path ?? ROOT);
    sink.lits.push({ text: l.text, span: l.span, at, cond, via: c.fresh ? ++this.vias : l.via, routed: l.routed, gen: l.gen ?? c.gen, genElse: l.genElse ?? c.genElse, folded: l.folded });
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
      ((target.value as Node[]) ?? []).forEach((n, i) => this.assignTo(n, entryOf(v, i), c));
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
    this.spend(v.lits.length + (before?.lits.length ?? 0));
    const held = before && c.cond && before.lits.length > 0 ? new Set([...before.lits, ...(before.keys ?? [])]) : undefined;
    let w = c.cond ? this.under(v, c.cond, held, c.subject) : v;
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
    // One entry per literal: `set s = s ~ 'x'` in a loop would otherwise grow
    // the list by a copy of every literal on each pass.
    w = { ...w, lits: uniqueLits(w.lits) };
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
  // printed either way when no test stands between the two prints. A literal in
  // `subject` was already in what the test read, so it is marked as routed; a
  // content test that is not routing it clears the mark.
  private under(v: Val, cond: Cond | undefined, held?: ReadonlySet<Lit>, subject?: ReadonlySet<Lit>): Val {
    const mark = (l: Lit): Lit => {
      if (held?.has(l)) return l;
      const routed = subject?.has(l) ? true : cond?.test === "content" ? undefined : l.routed;
      return { ...l, cond: strongest(l.cond, cond), via: ++this.vias, routed };
    };
    return { ...v, lits: v.lits.map(mark), keys: v.keys?.map(mark), gate: strongest(v.gate, cond) };
  }

  // The literals a content test reads: those held by every variable its test
  // names, plus the enclosing tests' (a branch can route text either read).
  private subjectOf(test: Node, tc: Cond | undefined, c: Ctx): ReadonlySet<Lit> | undefined {
    if (tc?.test !== "content") return c.subject;
    const out = new Set<Lit>(c.subject);
    const seen = new Set<string>();
    let budget = 256;
    const walk = (n: unknown): void => {
      if (!n || typeof n !== "object" || --budget < 0) return;
      if (Array.isArray(n)) {
        for (const x of n) walk(x);
        return;
      }
      const node = n as Node;
      if (node.type === "Identifier") {
        const name = String(node.value);
        if (seen.has(name)) return;
        seen.add(name);
        const v = c.st.get(name);
        if (v) for (const l of [...v.lits, ...(v.keys ?? [])]) out.add(l);
        return;
      }
      for (const [k, x] of Object.entries(node)) {
        if (k === "property" && node.type === "MemberExpression" && !node.computed) continue;
        walk(x);
      }
    };
    walk(test);
    return out;
  }

  // ---- expressions ----

  private eval(n: unknown, c: Ctx): Val {
    if (!n || typeof n !== "object" || !this.tick()) return EMPTY;
    const node = n as Node;
    switch (node.type) {
      case "StringLiteral": {
        const s = String(node.value);
        return { lits: [{ text: s, span: this.litSpan(node), at: c.path }], data: "none", truth: "none", konst: s };
      }
      case "IntegerLiteral":
      case "FloatLiteral":
        return { lits: [], data: "none", truth: "none", konst: Number(node.value) };
      case "Identifier":
        return this.ident(node, c);
      case "MemberExpression": {
        // The container and the subscript are each evaluated once, for a pick
        // by the flag and for the member (review round 3, runtime S3-1).
        const o = this.eval(node.object, c);
        const prop = node.property as Node;
        const kv = node.computed && prop?.type !== "SliceExpression" ? this.eval(prop, c) : undefined;
        const picked = kv?.genFlag ? this.flagPick(node, o, c) : undefined;
        if (picked) return picked;
        const v = this.member(node, c, o, kv);
        // A slice keeps what every entry holds of the flag, at new places
        // (review round 3, contracts M3).
        return prop?.type === "SliceExpression" ? { ...v, genFlag: undefined, genAt: everyHeld(v.genAt) } : v;
      }
      case "CallExpression":
        return this.call(node, c);
      case "FilterExpression": {
        const o = this.eval(node.operand, c);
        this.operands.set(node, { c, v: o });
        const f = node.filter as Node;
        const name = filterName(f);
        const v = this.applyFilter(o, name, filterArgs(f), c, f);
        return this.capped({ ...v, ...filterGen(o, name, filterArgs(f)) });
      }
      case "TestExpression":
        return this.flagged(boolVal(this.testClass(node, c)), node, c);
      case "UnaryExpression": {
        if (String((node.operator as { value?: unknown })?.value) === "not") return this.flagged(boolVal(this.testClass(node.argument as Node, c)), node, c);
        return this.eval(node.argument, c);
      }
      case "BinaryExpression":
        return this.binary(node, c);
      case "Ternary": {
        const test = node.condition as Node;
        const cond = this.testCond(test, c);
        const [yes, no] = arms(c.path);
        let t = this.eval(node.trueExpr, { ...c, facts: factsFrom(test, true, c.facts), path: yes });
        let f = this.eval(node.falseExpr, { ...c, facts: factsFrom(test, false, c.facts), path: no });
        // The arm only the flag chooses is a generation-prompt branch.
        const p = this.genOf(test, c);
        if (p) {
          const id = this.genId(node);
          t = genArm(t, p === "body" ? id : undefined, p === "body" ? undefined : id);
          f = genArm(f, p === "body" ? undefined : id, p === "body" ? id : undefined);
        }
        const v = this.under(join(inArm(t, yes), inArm(f, no)), cond, undefined, this.subjectOf(test, cond, c));
        // Truthy only when the flag is set: each arm is the flag, is false, or runs only with the flag.
        return (p === "body" || flagOrFalse(t)) && (p === "alternate" || flagOrFalse(f)) ? { ...v, genFlag: true } : v;
      }
      case "SelectExpression": {
        // `x if c` with no else.
        const test = node.test as Node;
        const cond = this.testCond(test, c);
        const p = this.genOf(test, c);
        let v = this.eval(node.lhs, { ...c, facts: factsFrom(test, true, c.facts), path: arms(c.path)[0] });
        if (p === "body") v = { ...genArm(v, this.genId(node), undefined), genFlag: true };
        return this.under(v, cond, undefined, this.subjectOf(test, cond, c));
      }
      case "ArrayLiteral":
      case "TupleLiteral": {
        let v: Val = { lits: [], data: "none", truth: "none" };
        const konsts: string[] = [];
        let allKonst = true;
        const els = (node.value as Node[]) ?? [];
        const held: (Held | undefined)[] = [];
        els.forEach((el) => {
          const e = this.eval(el, c);
          this.holds(e);
          if (typeof e.konst === "string") konsts.push(e.konst);
          else allKonst = false;
          held.push(heldOf(e));
          // A list of its elements' fields: `[messages|length]` is a list of one count, not a count (review round 3, contracts S3).
          v = join(v, { ...e, keys: deeper(e.keys), fields: e.fields && mapFields(e.fields, listOf), konst: undefined, konstList: undefined, ns: undefined, macro: undefined, path: undefined, src: undefined });
        });
        return this.capped({ ...v, truth: "none", konst: undefined, konstList: allKonst ? konsts : undefined, genAt: gathered(held) });
      }
      case "ObjectLiteral": {
        const map = node.value as Map<unknown, unknown>;
        // An empty dict to start from, which adds nothing to what a value may be.
        let v: Val = { lits: [], keys: [], data: "none", truth: "none" };
        const keys: Lit[] = [];
        const held = new Map<string, Held>();
        let konstKeys: string[] | undefined = [];
        if (map instanceof Map) {
          for (const [k, val] of map) {
            const kv = this.eval(k, c);
            keys.push(...kv.lits.map(own));
            if (typeof kv.konst === "string" && !kv.gate) konstKeys?.push(kv.konst);
            else konstKeys = undefined;
            const vv = this.eval(val, c);
            this.holds(vv);
            if (typeof kv.konst === "string") keyHeld(held, kv.konst, heldOf(vv));
            // A value keeps its fields as a member: a count is still a count (review round 3, contracts M2).
            v = join(v, { ...vv, keys: deeper(vv.keys), fields: vv.fields && mapFields(vv.fields, recordOf), konst: undefined, konstList: undefined, ns: undefined, macro: undefined, path: undefined, src: undefined });
          }
        }
        return this.capped({ ...v, keys: [...(v.keys ?? []), ...keys], truth: "none", genAt: held.size ? [...held] : undefined, konstKeys });
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
    if (this.macros.has(name)) {
      if (!this.escaped.has(name)) {
        this.escaped.add(name);
        this.changed = true;
      }
      return { ...EMPTY, macro: name };
    }
    if (name === "random") this.flagNondet(n, "uses `random`");
    // The clock and chance are values too: `set f = strftime_now` then `f()`.
    if (NONDET_FNS.has(name)) return { ...EMPTY, fns: [name] };
    if (BUILTINS.has(name)) return EMPTY;
    const v = refine({ ...runtimeVal(rootField(name), name), src: name }, name, c);
    return name === "add_generation_prompt" ? { ...v, genFlag: true } : v;
  }

  private member(n: Node, c: Ctx, o: Val, pre: Val | undefined): Val {
    const prop = n.property as Node;
    let key: string | number | undefined;
    let keyGate: Cond | undefined;
    let counted: Cond | undefined;
    if (!n.computed) {
      if (prop?.type === "Identifier") key = String(prop.value);
    } else if (prop?.type === "SliceExpression") {
      const parts = [prop.start, prop.stop, prop.step] as (Node | undefined)[];
      const vals = parts.map((p) => (p ? this.eval(p, c) : undefined));
      if (vals.every((v) => v === undefined || Number.isInteger(v.konst))) {
        const [start, stop, step] = vals.map((v) => v?.konst as number | undefined);
        const cut = this.sliced(o, start, stop, step, vals, n);
        if (cut) return cut;
      }
      // A slice keeps the container: `messages[1:]` is still the messages.
      parts.forEach((part, i) => {
        if (part) keyGate = strongest(keyGate, strongest(this.selCond(vals[i]!, part), this.positionCond(o, vals[i]!, part, c, i === 2 ? "step" : "bound")));
      });
      return { ...o, lits: this.choose(o.lits, keyGate), keys: o.keys && this.choose(o.keys, keyGate), path: undefined, konst: undefined, konstList: undefined, gate: strongest(o.gate, keyGate) };
    } else {
      const kv = pre ?? this.eval(prop, c);
      if (typeof kv.konst === "string" || typeof kv.konst === "number") key = kv.konst;
      const items = Number.isInteger(kv.konst) ? (typeof o.konst === "string" ? Array.from(o.konst) : o.konstList) : undefined;
      if (items) {
        const i = kv.konst as number;
        // Past either end the subscript is undefined, which prints nothing.
        const cut = this.cut(o, items[i < 0 ? i + items.length : i] ?? "", [kv], n);
        if (cut) return cut;
      }
      counted = this.positionCond(o, kv, prop, c, "index");
      // A position in a sorted list is chosen by what the sort compared (review round 3, contracts S1).
      if (typeof kv.konst !== "string") counted = strongest(counted, this.choiceCond(orderOf(o.fields), prop));
      // A role looking up a dict of constant keys is compared with each key (review round 2, ruling c).
      const kd = keyed(kv, o);
      keyGate = this.selCond(kd, prop);
      // Any runtime key looking one up is a trigger candidate for each key (ISC-22.1).
      if (o.konstKeys) for (const k of o.konstKeys) this.candidate(k, "==", kv, readOf(kd), n);
    }
    keyGate = strongest(keyGate, counted);
    if (o.ns !== undefined && typeof key === "string") {
      const v = c.st.get(`${o.ns}.${key}`);
      return v ? refine(v, pathOf(n), c) : EMPTY;
    }
    if (o.macro !== undefined) return EMPTY;
    const fields = o.fields ? mapFields(o.fields, (f) => (typeof key === "number" ? positionField(f, key, memberField(f, undefined)) : memberField(f, key))) : undefined;
    const path = o.path !== undefined && typeof key === "string" ? `${o.path}.${key}` : undefined;
    const inner = entryKeys(o.keys);
    const v: Val = {
      // The key chooses which entry is printed: the entries depend on it. An
      // entry may be a dict whose keys a loop or filter prints (review round
      // 3, contracts M1).
      lits: this.choose(o.lits, keyGate),
      keys: inner && this.choose(inner, keyGate),
      data: fields ? clsOf(fields) : o.data,
      truth: fields ? presenceOf(fields) : o.truth,
      gate: strongest(o.gate, keyGate),
      fields,
      rest: o.rest,
      path,
      src: o.src === "loop" && (key === "previtem" || key === "nextitem") ? c.loopItem : o.src === undefined ? undefined : typeof key === "string" ? `${o.src}.${key}` : `${o.src}[]`,
    };
    if (this.recording && v.src !== undefined && typeof key === "string" && this.reads.size < MAX_READS) this.reads.add(v.src);
    return refine(withHeld(v, entryHeld(o.genAt, key)), path, c);
  }

  private call(n: Node, c: Ctx): Val {
    const callee = n.callee as Node;
    const args = (n.args as Node[]) ?? [];
    if (callee?.type === "Identifier") {
      const name = String(callee.value);
      const m = this.macroNamed(name, c);
      const bound = this.lookup(name, c);
      // A macro reached through a variable runs only where the variable is set.
      if (m) return this.callMacro(m, args, gated(c, bound?.gate));
      if (!bound) {
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
          case "range": {
            const a = args.map((x) => this.eval(x, c));
            for (const v of a) this.holds(v);
            return rangeOf(a);
          }
          case "dict": {
            let v: Val = { ...EMPTY, keys: [] };
            const keys: Lit[] = [];
            const held = new Map<string, Held>();
            for (const a of args) {
              // A keyword's value is an entry; `dict(D)` copies D's keys and members.
              const kw = a?.type === "KeywordArgumentExpression";
              if (kw) keys.push({ text: String((a.key as Node).value), span: this.exprSpan(a.key as Node) });
              const av = this.eval(a, c);
              this.holds(av);
              if (kw) keyHeld(held, String((a.key as Node).value), heldOf(av));
              else for (const [k, h] of av.genAt ?? []) if (typeof k === "string") keyHeld(held, k, h);
              v = join(v, { ...av, keys: kw ? deeper(av.keys) : av.keys, fields: kw && av.fields ? mapFields(av.fields, recordOf) : av.fields, konst: undefined, path: undefined, src: undefined });
            }
            return this.capped({ ...v, keys: [...(v.keys ?? []), ...keys], truth: "none", genAt: held.size ? [...held] : undefined });
          }
        }
      }
      // Any other function (range, zip, a runtime callable, a value called as
      // one): its result carries the arguments' data, and may hold their text
      // or the called value's, so it keeps those too.
      let data: TestClass = "none";
      let gate: Cond | undefined;
      const lits: Lit[] = [...(bound?.lits ?? []), ...(bound?.keys ?? [])];
      for (const a of args) {
        const v = this.eval(a, c);
        this.holds(v);
        data = stronger(data, v.data);
        gate = strongest(gate, v.gate);
        lits.push(...v.lits, ...(v.keys ?? []));
      }
      if (name === "random") this.flagNondet(callee, "calls `random`");
      const out: Val = { lits, data, truth: data, gate };
      // A local that is not a known macro may hold one taken from a list or
      // dict, or the clock bound to it.
      return bound ? join(join(out, this.callFns(bound.fns, n)), this.callEscaped(args, c, bound.gate)) : out;
    }
    if (callee?.type === "MemberExpression") {
      const r = this.eval(callee.object, c);
      const prop = callee.property as Node;
      const method = !callee.computed && prop?.type === "Identifier" ? String(prop.value) : prop?.type === "StringLiteral" ? String(prop.value) : "";
      if (method === "cycle" && r.fields?.includes(rootField("loop"))) return this.loopCycle(r, args, c, n);
      const out = this.method(r, method, args, c, callee.object as Node, n);
      if (KNOWN_METHODS.has(method)) return this.capped({ ...out, ...methodGen(r, method, args) });
      // `d.k()` with no such string, list or dict method: an entry holding a
      // macro or the clock.
      const slot = r.ns !== undefined ? c.st.get(`${r.ns}.${method}`)?.fns : undefined;
      return join(join(out, this.callFns([...(r.fns ?? []), ...(slot ?? [])], n)), this.callEscaped(args, c, r.gate));
    }
    const fv = this.eval(callee, c);
    for (const a of args) this.holds(this.eval(a, c));
    return join(this.callFns(fv.fns, n), this.callEscaped(args, c, fv.gate));
  }

  // `loop.cycle(a, b, ...)`: the argument at the loop position modulo their
  // number. Past two that is a threshold on the position (`loop.index0 % 40
  // == 39`); two alternate, which is parity (Decisions 20:55; review round 2,
  // item 1). Either way the position chooses it.
  private loopCycle(loop: Val, args: Node[], c: Ctx, at: Node): Val {
    const a = args.map((x) => this.eval(x, c));
    const index0 = runtimeVal(memberField(rootField("loop"), "index0"), undefined);
    const pos = countArith(index0, { ...EMPTY, konst: a.length }, "%");
    const sel = pos ? this.selCond(pos, at) : undefined;
    let gate = strongest(loop.gate, sel);
    let data: TestClass = "presence";
    for (const x of a) {
      this.holds(x);
      gate = strongest(gate, x.gate);
      data = stronger(data, x.data);
    }
    return { lits: this.choose(a.flatMap((x) => [...x.lits, ...(x.keys ?? [])]), sel), data, truth: data, gate };
  }

  // A call through a value that may be strftime_now or random, or one the
  // walk lost track of after either went into a list, dict or function.
  private callFns(fns: string[] | undefined, at: Node): Val {
    let v: Val = EMPTY;
    for (const f of new Set([...(fns ?? []), ...this.escapedFns])) {
      if (f === "random") this.flagNondet(at, "calls `random`");
      v = { lits: [], data: "nondeterministic", truth: "nondeterministic" };
    }
    return v;
  }

  // `v` goes where the walk does not follow a value it calls: a list or dict
  // entry, or a function argument.
  private holds(v: Val): void {
    for (const f of v.fns ?? []) {
      if (this.escapedFns.has(f)) continue;
      this.escapedFns.add(f);
      this.changed = true;
    }
  }

  // A call the extraction cannot resolve runs every macro the template used as
  // a value, under the call site's conditions and the callee's own gate.
  private callEscaped(args: Node[], c: Ctx, gate: Cond | undefined): Val {
    let v: Val = EMPTY;
    for (const name of [...this.escaped]) v = join(v, this.callMacro(name, args, gated(c, gate)));
    return v;
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
    // Arguments past the formals reach the body as `varargs` and `kwargs`.
    const layer = new State(c.st);
    let varargs: Val = { lits: [], data: "none", truth: "presence" };
    let kwargs: Val = { lits: [], keys: [], data: "none", truth: "presence" };
    let pos = 0;
    for (const a of argNodes) {
      if (a?.type === "KeywordArgumentExpression") {
        const key = a.key as Node;
        const v = this.eval(a.value, c);
        layer.own.set(String(key.value), v);
        if (!formals.some((f) => f.name === String(key.value))) kwargs = join(kwargs, { ...element(v), keys: [...(deeper(v.keys) ?? []), { text: String(key.value), span: this.exprSpan(key) }] });
      } else if (pos < formals.length) layer.own.set(formals[pos++]!.name, this.eval(a, c));
      else {
        const v = element(this.eval(a, c));
        varargs = join(varargs, { ...v, keys: deeper(v.keys) });
      }
    }
    if (!formals.some((f) => f.name === "varargs")) layer.own.set("varargs", varargs);
    if (!formals.some((f) => f.name === "kwargs")) layer.own.set("kwargs", kwargs);
    for (const f of formals) if (!layer.own.has(f.name)) layer.own.set(f.name, f.def ? this.eval(f.def, c) : EMPTY);
    // The body runs under the call site's conditions: its text inherits them.
    const inner: Ctx = { cond: c.cond, emitCond: c.emitCond, facts: NO_FACTS, st: layer, scope: { macro: name, caller }, gen: c.gen, genElse: c.genElse, path: c.path, stack: [...c.stack, name] };
    const sink: Sink = { lits: [], data: "none", truth: "none" };
    this.exec(m.body, inner, sink);
    this.escape(c.st, [layer], true, undefined, c.path);
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
      // Printed where the macro calls caller(), inside the call statement.
      path: c.path,
      stack: [...c.stack, "caller()"],
    };
    const sink: Sink = { lits: [], data: "none", truth: "none" };
    this.exec(cr.body, inner, sink);
    this.escape(c.st, [layer], true, undefined, c.path);
    return { lits: sink.lits, data: sink.data, truth: sink.truth };
  }

  private method(r: Val, m: string, argNodes: Node[], c: Ctx, receiver: Node, call: Node): Val {
    const a = argNodes.map((x) => this.eval(x, c));
    const base = { gate: strongest(r.gate, a.reduce<Cond | undefined>((g, x) => strongest(g, x.gate), undefined)) };
    const known = this.konstMethod(r, m, a, argNodes, receiver);
    if (known) return known;
    // `m.content.startswith('x')` and `m.content.find('x')` look for the literal in the
    // input, as `'x' in m.content` does; a tuple gives one candidate per element.
    if (Object.hasOwn(SEARCH_OPS, m) && argNodes[0]) {
      const cls = (m === "count" && a.length === 1 ? countedIn(r, a[0]) : undefined) ?? readOf(r);
      for (const k of this.literalsIn(argNodes[0], a[0]!, c)) this.candidate(k, SEARCH_OPS[m]!, r, cls, call);
    }
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
        return { ...base, lits: r.lits, data: r.data, truth: r.truth, konst: typeof r.konst === "string" ? caseMap(r.konst, m) : undefined, src: r.src };
      case "replace":
        return { ...base, ...this.replaced(r, a, argNodes, receiver) };
      case "format":
        return { ...base, lits: [...r.lits, ...a.flatMap((x) => [...x.lits, ...(x.keys ?? [])])], data: maxData(r, a), truth: maxData(r, a) };
      case "join": {
        const list = a[0] ?? EMPTY;
        const konst = this.fold(typeof r.konst === "string" && list.konstList ? list.konstList.join(r.konst) : undefined);
        const lits = [...list.lits, ...(list.keys ?? []), ...r.lits];
        return { ...base, lits: this.folded(lits, konst, receiver), data: list.data, truth: list.truth, konst };
      }
      case "split":
      case "rsplit":
      case "splitlines":
      case "partition":
      case "rpartition":
        // The pieces are computed from the input, not read from it (ISC-22.1).
        return { ...base, lits: r.lits, data: r.data, truth: r.data };
      case "get": {
        const k = a[0]?.konst;
        const fields = r.fields ? mapFields(r.fields, (f) => memberField(f, typeof k === "string" ? k : undefined)) : undefined;
        // The key chooses an entry or the default: what comes back, and
        // whether it is anything, depend on it (review round 2, item 2). A
        // count picks an entry whose key is a number by a threshold (contracts
        // D1t). The value may be the default instead, which an empty list or
        // dict adds nothing to.
        let sel = argNodes[0] ? this.selCond(keyed(a[0]!, r), argNodes[0]) : undefined;
        const pick = argNodes[0] ? countPick(a[0]!, (r.keys ?? []).map((l) => l.text)) : undefined;
        if (pick) {
          sel = strongest(sel, condOf(pick === "presence" ? "none" : pick, this.exprSpan(argNodes[0]!)));
          this.classed(argNodes[0]!, pick);
        }
        // A runtime key looking up a dict of constant keys is compared with each key.
        if (argNodes[0] && r.konstKeys) for (const key of r.konstKeys) this.candidate(key, "==", a[0]!, readOf(keyed(a[0]!, r)), call);
        const dflt = a[1] && !a[1].fields ? restOf(a[1]) : a[1]?.data;
        const inner = [...(entryKeys(r.keys) ?? []), ...(a[1]?.keys ?? [])];
        return { ...base, gate: strongest(base.gate, sel), lits: this.choose([...r.lits, ...(a[1]?.lits ?? [])], sel), keys: inner.length ? this.choose(inner, sel) : undefined, data: fields ? clsOf(fields) : r.data, truth: fields ? presenceOf(fields) : r.truth, fields, rest: fields ? eitherRest(r.rest, dflt) : undefined, src: typeof k === "string" && r.src !== undefined ? `${r.src}.${k}` : undefined };
      }
      case "items":
      case "keys":
      case "values":
        if (m === "keys") return { ...base, lits: r.keys ?? [], data: r.fields ? clsOf(mapFields(r.fields, keyField)) : r.data, truth: r.truth };
        if (m === "values") return { ...base, lits: r.lits, keys: heldKeys(r.keys), data: r.data, truth: r.truth, fields: r.fields ? mapFields(r.fields, (f) => listOf(valueField(f))) : undefined, rest: r.rest };
        return { ...base, lits: r.lits, keys: r.keys, data: r.data, truth: r.truth, fields: r.fields, rest: r.rest, pairs: true };
      case "append":
      case "extend":
      case "insert":
      case "update":
      case "add": {
        // A mutating method: the receiver now holds the argument too.
        for (const x of a) this.holds(x);
        const arg = a[a.length - 1] ?? EMPTY;
        // An appended dict is an entry, whose keys a lookup prints.
        const v = { ...arg, keys: m === "extend" || m === "update" ? arg.keys : deeper(arg.keys), konst: undefined, konstList: undefined, ns: undefined, macro: undefined, path: undefined, src: undefined };
        const k = receiver?.type === "Identifier" ? String(receiver.value) : receiver?.type === "MemberExpression" ? this.slot(receiver, c) : undefined;
        if (k !== undefined) this.assign(k, v, c, c.st.get(k), true);
        return EMPTY;
      }
      case "pop":
        return { ...base, lits: r.lits, data: r.data, truth: r.truth };
      case "count": {
        // How often a value occurs in runtime text or a runtime list grows with
        // it, as its length does: past 1 a test on it is a threshold. Compared
        // with 0 or 1 it is as telling as `x in s` (review round 2, runtime
        // N2). A constant counted in a list of vocabulary values is judged
        // against the vocabulary.
        const d = (a.length === 1 ? countedIn(r, a[0]) : undefined) ?? maxData(r, a);
        if (!isRuntime(r) || countsOf(r)) return { ...base, lits: [], data: d, truth: d };
        return { ...base, lits: [], data: d, truth: d, fields: [countField(0, d === "nondeterministic" ? "nondeterministic" : "content")] };
      }
      default:
        // startswith, endswith, find, count, isdigit and the rest compute from
        // the receiver's text: they reveal it and print none of it.
        if (TEXTLESS_METHODS.has(m)) return { ...base, lits: [], data: maxData(r, a), truth: maxData(r, a) };
        // Any other method (ljust, zfill, removeprefix, encode, format_map,
        // loop.cycle, or one this list does not know) may return the
        // receiver's text or its arguments', so it keeps them all: extracting
        // too much costs a MEDIUM, dropping text would pass it silently. A
        // name that is no Python method calls a dict entry, which never
        // returns the dict's keys.
        return { ...base, lits: [...r.lits, ...(KNOWN_METHODS.has(m) ? (r.keys ?? []) : []), ...a.flatMap((x) => [...x.lits, ...(x.keys ?? [])])], data: maxData(r, a), truth: maxData(r, a) };
    }
  }

  private applyFilter(o: Val, name: string, argNodes: Node[], c: Ctx, fnode: Node): Val {
    const a = argNodes.map((x) => this.eval(x, c));
    const gate = strongest(o.gate, a.reduce<Cond | undefined>((g, x) => strongest(g, x.gate), undefined));
    // A dict's text holds its keys, so a filter that keeps the text keeps them
    // (review round 3, contracts M1).
    const keep = { lits: o.keys ? [...o.lits, ...o.keys] : o.lits, data: o.data, truth: o.truth, gate };
    const known = this.konstFilter(o, name, a, argNodes, fnode);
    if (known) return known;
    switch (name) {
      case "default":
      case "d": {
        // The default is printed only when the operand is undefined: a presence
        // test, whose arms print one or the other (review round 3, runtime R3-3).
        const dv = this.under(a[0] ?? EMPTY, condOf("presence", this.exprSpan(fnode)));
        const [yes, no] = arms(c.path);
        return join(inArm(o, yes), inArm(dv, no));
      }
      case "join": {
        const sep = a[0];
        const konst = this.fold(o.konstList && (sep === undefined || typeof sep.konst === "string") ? o.konstList.join(sep ? (sep.konst as string) : "") : undefined);
        const lits = [...o.lits, ...(o.keys ?? []), ...(sep?.lits ?? [])];
        return { ...keep, lits: this.folded(lits, konst, fnode), konst };
      }
      case "replace":
        return { ...keep, ...this.replaced({ ...o, lits: keep.lits }, a, argNodes, fnode) };
      case "format":
        return { ...keep, lits: [...keep.lits, ...a.flatMap((x) => [...x.lits, ...(x.keys ?? [])])], data: maxData(o, a), truth: maxData(o, a) };
      case "upper":
      case "lower":
      case "title":
      case "capitalize":
      case "trim": {
        const konst = typeof o.konst === "string" ? caseMap(o.konst, name) : undefined;
        return { ...keep, lits: konst !== undefined && konst !== o.konst ? this.folded(o.lits, konst, fnode) : keep.lits, konst, src: o.src, ...(NUMBER_KEEPING.has(name) ? countKept(o) : {}) };
      }
      case "string":
      case "tojson":
      case "pprint":
        // The text holds every field, so a test on it reads the strongest one.
        // A count's digits are the count (`messages|length|string == '41'`).
        return { ...keep, lits: [...o.lits, ...(o.keys ?? [])], data: o.fields ? stronger(o.data, clsOf(o.fields)) : o.data, konst: name === "string" && typeof o.konst === "string" ? o.konst : undefined, src: name === "string" ? o.src : undefined, ...countKept(o) };
      case "safe":
      case "e":
      case "escape":
        return { ...keep, src: o.src, ...countKept(o) };
      case "forceescape":
      case "indent":
      case "center":
      case "wordwrap":
      case "striptags":
      case "urlencode":
        return keep;
      case "truncate":
        // How much survives depends on the length argument.
        return { ...keep, lits: this.choose(keep.lits, this.argsCond(a, argNodes)) };
      case "batch": {
        // `batch(n)` divides the count by n: its length is a threshold on the
        // conversation's unless n is ±1 (ISC-18).
        // Each row is a list of elements: a dict's keys are one lookup further down.
        const s = seqOf(o);
        const keys = o.pairs ? s.keys : deeper(s.keys);
        const cond = argNodes[0] ? this.choiceCond(positionTest(o, a[0]!, "step"), argNodes[0]) : undefined;
        return { ...keep, lits: this.choose(s.lits, cond), keys: keys && this.choose(keys, cond), gate: strongest(gate, cond), fields: o.fields, rest: o.rest };
      }
      case "list":
      case "reverse":
      case "sort":
      case "unique":
      case "slice": {
        // The elements, in another order or fewer of them: `.items()` pairs
        // stay pairs, except sliced into lists of them. What `sort` and
        // `unique` compare decides where template text lands and whether it
        // survives; a loop over them still runs once per element.
        const s = seqOf(o);
        const [cls, by] = name === "sort" || name === "unique" ? this.orderCond(o, argNodes, fnode) : ["none" as TestClass, undefined];
        return { ...keep, lits: this.choose(s.lits, by), keys: s.keys && this.choose(s.keys, by), truth: name === "unique" ? stronger(o.truth, cls) : o.truth, fields: by && o.fields ? mapFields(o.fields, (f) => orderedOf(f, cls)) : o.fields, rest: o.rest, pairs: name === "slice" ? undefined : o.pairs, konstList: name === "list" ? o.konstList : undefined, src: name === "slice" ? undefined : o.src };
      }
      case "items":
      case "dictsort":
        return { ...keep, lits: o.lits, keys: o.keys, fields: o.fields, rest: o.rest, pairs: true };
      case "first":
      case "last":
      case "min":
      case "max": {
        const e = elemOf(o);
        // A pair's first is its key and its last its value.
        const end = name === "first" ? 0 : name === "last" ? -1 : undefined;
        const fields = o.fields && !o.pairs && end !== undefined ? mapFields(o.fields, (f) => positionField(f, end, elementField(f))) : e.fields;
        // What `min` and `max` compare chooses the element, and what a sort
        // compared chooses the first or last (review round 3, contracts S1).
        const by = end === undefined ? this.orderCond(o, argNodes, fnode)[1] : this.choiceCond(orderOf(o.fields), fnode);
        const pick = strongest(this.argsCond(a, argNodes), by);
        return { ...keep, lits: this.choose(e.lits, pick), keys: e.keys && this.choose(e.keys, pick), data: fields ? clsOf(fields) : e.data, truth: fields ? presenceOf(fields) : e.truth, gate: strongest(gate, by), fields, rest: e.rest, src: elemSrc(o) };
      }
      case "length":
      case "count":
      case "wordcount":
        // A count of conversation data: compared with 0 or 1 it is presence,
        // with a threshold further away it is content (ISC-18).
        return lengthOf(o, gate);
      case "int":
      case "float":
      case "abs":
      case "round":
      case "sum":
        // A number kept, or the sum of a list of counts, is still the count.
        return { lits: [], data: o.data, truth: o.data, gate, ...countKept(name === "sum" && o.fields ? { ...o, fields: mapFields(o.fields, elementField) } : o) };
      case "map": {
        const attr = kwargKonst(argNodes, "attribute");
        const efs = o.fields ? mapFields(o.fields, o.pairs ? pairField : elementField) : undefined;
        const s = seqOf(o);
        if (attr !== undefined && efs) {
          const fs = mapFields(efs, (f) => memberPath(f, attr));
          return { ...keep, lits: s.lits, keys: s.keys, data: clsOf(fs), fields: mapFields(fs, (f) => orderedOf(listOf(f), orderOf(o.fields))), rest: o.rest };
        }
        // An attribute name computed at runtime chooses which entries are printed.
        const by = this.argsCond(a, argNodes);
        return { ...keep, lits: this.choose(s.lits, by), keys: s.keys && this.choose(s.keys, by) };
      }
      case "selectattr":
      case "rejectattr":
      case "select":
      case "reject": {
        // Which elements survive depends on the test applied to each one.
        // Pairs are tested as pairs and stay pairs (review round 3, runtime R3-5).
        const efs = o.fields ? mapFields(o.fields, o.pairs ? pairField : elementField) : undefined;
        let fs: Fields | undefined;
        let testAt: number;
        let attr: string | undefined;
        if (name === "selectattr" || name === "rejectattr") {
          attr = typeof a[0]?.konst === "string" ? a[0].konst : undefined;
          fs = efs ? mapFields(efs, (f) => memberPath(f, attr)) : undefined;
          testAt = 1;
        } else {
          fs = efs;
          testAt = 0;
        }
        const read: TestClass = fs ? clsOf(fs) : o.data;
        const testArg = a[testAt];
        const test = typeof testArg?.konst === "string" ? testArg.konst : "";
        let sel: TestClass = test === "" || SHAPE_SELECT_TESTS.has(test) ? (read === "none" ? "none" : fs ? presenceOf(fs) : "presence") : ((fs && (vocabSelect(fs, test, a[testAt + 1]) ?? countSelect(fs, test, a[testAt + 1], o))) ?? read);
        // What the elements are compared with (`select('in', x)`) decides too.
        for (const x of a.slice(testAt + 1)) sel = stronger(sel, x.data);
        this.classed(fnode, sel);
        // `selectattr('role', 'equalto', 'user')` compares each element's role with the literal.
        const each = SELECT_OPS[test];
        const value = a[testAt + 1];
        if (each && value && argNodes[testAt + 1]) {
          const src = elemSrc(o);
          const named = name === "selectattr" || name === "rejectattr";
          const input: Val = { ...o, src: !named ? src : src !== undefined && attr !== undefined ? `${src}.${attr}` : undefined };
          const values = test === "in" ? this.literalsIn(argNodes[testAt + 1]!, value, c) : [constOf(value)];
          for (const k of values) this.candidate(k, each, input, sel === "none" ? "presence" : sel, fnode);
        }
        const cond = strongest(this.argsCond(a, argNodes), condOf(sel === "presence" ? "none" : sel, this.exprSpan(fnode)));
        return { ...keep, lits: this.choose(o.lits, cond), keys: o.keys && this.choose(o.keys, cond), fields: o.fields, rest: o.rest, truth: stronger(o.truth, sel), pairs: o.pairs, src: o.src };
      }
      case "attr": {
        // `x|attr(k)` reads the member `k` as `x.k` does, so a member the
        // schema doesn't document is undocumented here too (review round 3,
        // contracts S2). A name computed at runtime chooses the member.
        const k = typeof a[0]?.konst === "string" ? a[0].konst : undefined;
        const fields = o.fields ? mapFields(o.fields, (f) => memberField(f, k)) : undefined;
        const by = this.argsCond(a, argNodes);
        const inner = entryKeys(o.keys);
        return { ...keep, lits: this.choose(o.lits, by), keys: inner && this.choose(inner, by), data: fields ? clsOf(fields) : o.data, truth: fields ? presenceOf(fields) : o.truth, gate: strongest(gate, by), fields, rest: fields ? o.rest : undefined, src: k !== undefined && o.src !== undefined ? `${o.src}.${k}` : undefined };
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
      let r = this.eval(n.right, { ...c, facts: factsFrom(n.left as Node, o === "and", c.facts), path: arms(c.path)[1] });
      // The right operand is printed only when the left one is truthy (`and`)
      // or falsy (`or`): when that takes the flag, only in the generation prompt.
      const p = this.genOf(n.left as Node, c);
      if (p === (o === "and" ? "body" : "alternate")) r = genArm(r, this.genId(n), undefined);
      const v = join(l, this.under(r, lc));
      // Truthy only when the flag is set.
      const flag = o === "and" ? p === "body" || r.genFlag : (p === "body" || flagOrFalse(l)) && flagOrFalse(r);
      return flag ? { ...v, genFlag: true } : v;
    }
    if (o === "in" || o === "not in" || o === "==" || o === "!=" || o === "<" || o === ">" || o === "<=" || o === ">=") {
      return this.flagged(boolVal(this.testClass(n, c)), n, c);
    }
    const l = this.eval(n.left, c);
    const r = this.eval(n.right, c);
    const gate = strongest(l.gate, r.gate);
    const data = stronger(l.data, r.data);
    // Arithmetic on a count keeps it a count, shifted or scaled. Text is never
    // a count: `'a' + 'b'` folds and `'text' * n` is chosen below.
    if (o !== "~" && typeof l.konst !== "string" && typeof r.konst !== "string") {
      const counted = countArith(l, r, o);
      if (counted) return { ...counted, lits: [...l.lits, ...r.lits], gate: strongest(gate, counted.gate) };
    }
    if (o === "~" || o === "+") {
      // Concatenation: fold two constants into one literal, so text assembled
      // from fragments is matched (and URL-scanned) whole.
      let konst: string | undefined;
      if (o === "~" && l.konst !== undefined && r.konst !== undefined) konst = konstText(l.konst) + konstText(r.konst);
      else if (o === "+" && typeof l.konst === "string" && typeof r.konst === "string") konst = l.konst + r.konst;
      konst = this.fold(konst);
      // A runtime operand with no text of its own separates the others'.
      const gap: Lit[] = (isRuntime(l) && !l.lits.length) || (isRuntime(r) && !r.lits.length) ? [{ text: "", span: this.exprSpan(n), brk: true }] : [];
      const lits = [...l.lits, ...gap, ...r.lits];
      return { lits: this.folded(lits, konst, n), keys: concatKeys(l, r), data, truth: stronger(l.truth, r.truth), gate, konst };
    }
    if (o === "*") {
      // `'text' * n` with a known count is the text n times, or none. With
      // the flag as the count, the text is printed only in the generation
      // prompt (review round 2, security N4).
      const [text, count, countNode] = typeof l.konst === "string" ? [l, r, n.right as Node] : [r, l, n.left as Node];
      const times = typeof count.konst === "boolean" ? Number(count.konst) : count.konst;
      if (typeof text.konst === "string" && typeof times === "number" && Number.isInteger(times) && text.konst.length * Math.max(0, times) <= MAX_KONST) {
        const konst = this.fold(text.konst.repeat(Math.max(0, times)));
        if (konst !== undefined) return { lits: konst === "" ? [] : this.folded(text.lits, konst, n), data: "none", truth: "none", gate, konst };
      }
      if (typeof text.konst === "string" && this.flagCount(countNode, c)) {
        const v = genArm(inArm(text, arms(c.path)[0]), this.genId(n), undefined);
        return { lits: v.lits, data, truth: stronger(l.truth, r.truth), gate, genFlag: text.konst !== "" ? true : undefined };
      }
      // `'text' * n`: the count decides whether the text is printed at all.
      const lits = [...this.choose(l.lits, this.selCond(r, n.right as Node)), ...this.choose(r.lits, this.selCond(l, n.left as Node))];
      return { lits, data, truth: stronger(l.truth, r.truth), gate };
    }
    return { lits: [...l.lits, ...r.lits], data, truth: stronger(l.truth, r.truth), gate };
  }

  // A value used to choose text (a subscript key, a slice bound, a `.get`
  // key, a repeat count): the test that choice amounts to, its own gate or the
  // class of what it reads. Data known only by its shape chooses nothing that
  // matters. A choice by the clock is a nondeterministic trigger (ISC-18.1).
  private selCond(v: Val, at: Node): Cond | undefined {
    if (v.data === "nondeterministic") this.flagNondet(at, "the clock or chance chooses template text");
    const cond = strongest(v.gate, condOf(v.data === "presence" ? "none" : v.data, this.exprSpan(at)));
    this.classed(at, cond?.test ?? "none");
    return cond;
  }

  // The count test a subscript, slice bound or step `kv` (written `at`) on
  // `o` makes (ISC-18). A count reaches the key through a filter that keeps
  // the number (`d[messages|length|string]`).
  private positionCond(o: Val, kv: Val, at: Node, c: Ctx, role: KeyRole): Cond | undefined {
    const inner = numberKept(at);
    if (inner === at) return this.choiceCond(positionTest(o, kv, role), at);
    // `kv` was just evaluated from `at`, reading `inner` on the way.
    let f = at;
    while ((f.operand as Node) !== inner) f = f.operand as Node;
    const seen = this.operands.get(f);
    return this.choiceCond(positionTest(o, seen?.c === c ? seen.v : this.eval(inner, c), role), at);
  }

  // A slice with constant bounds the template can work out: of a constant
  // string or list, or one that is empty at any length (`x[:0]`, `x[5:2]`).
  private sliced(o: Val, start: number | undefined, stop: number | undefined, step: number | undefined, keys: (Val | undefined)[], at: Node): Val | undefined {
    const text = typeof o.konst === "string" ? Array.from(o.konst) : undefined;
    const items = text ?? o.konstList;
    if (items) {
      const picked = slicePositions(items.length, start, stop, step)?.map((i) => items[i]!);
      if (!picked) return undefined;
      return text ? this.cut(o, picked.join(""), keys, at) : { ...o, konstList: picked, path: undefined };
    }
    return emptySlice(start, stop, step) ? this.cut(o, "", keys, at) : undefined;
  }

  // Known text cut from `o` by constant keys: no text at all when it is empty,
  // so the literals either side of it join up (ISC-22).
  private cut(o: Val, s: string, keys: (Val | undefined)[], at: Node): Val | undefined {
    let gate: Cond | undefined;
    for (const k of keys) gate = strongest(gate, k?.gate);
    if (s === "") return { lits: [], data: "none", truth: "none", gate: strongest(o.gate, gate), konst: "", konstList: [] };
    const konst = this.fold(s);
    return konst === undefined ? undefined : { lits: this.choose(this.folded(o.lits, konst, at), gate), data: "none", truth: "none", gate: strongest(o.gate, gate), konst };
  }

  // A string method on constant text, worked out as Python does:
  // `'x.x'.split('x')`, `' .'.lstrip()`, `'x.x'.strip('x')`. Undefined when an
  // argument is not constant or Python would raise (review round 3, runtime
  // R3-3).
  private konstMethod(r: Val, m: string, a: Val[], argNodes: Node[], at: Node): Val | undefined {
    if (typeof r.konst !== "string") return undefined;
    const s = r.konst;
    switch (m) {
      case "strip":
      case "lstrip":
      case "rstrip": {
        const p = params(argNodes, a, ["chars"], true);
        const chars = p && strArg(p[0]);
        return chars === undefined ? undefined : this.konstText(r, pyStrip(s, chars, m !== "rstrip", m !== "lstrip"), a, at);
      }
      case "split":
      case "rsplit": {
        const p = params(argNodes, a, ["sep", "maxsplit"]);
        const sep = p && strArg(p[0]);
        const max = p && intArg(p[1], -1);
        return sep === undefined || sep === "" || max === undefined ? undefined : this.konstItems(r, pySplit(s, sep, max, m === "rsplit"), a);
      }
      case "splitlines": {
        const p = params(argNodes, a, ["keepends"]);
        const keep = p && intArg(p[0], 0);
        return keep === undefined ? undefined : this.konstItems(r, pyLines(s, keep !== 0), a);
      }
      case "partition":
      case "rpartition": {
        // The separator is one of the parts.
        const p = params(argNodes, a, ["sep"], true);
        const sep = p?.[0]?.konst;
        if (typeof sep !== "string" || sep === "") return undefined;
        const i = m === "partition" ? s.indexOf(sep) : s.lastIndexOf(sep);
        const parts = i >= 0 ? [s.slice(0, i), sep, s.slice(i + sep.length)] : m === "partition" ? [s, "", ""] : ["", "", s];
        return this.konstItems(r, parts, a, [...r.lits, ...p![0]!.lits]);
      }
      default:
        return undefined;
    }
  }

  // A filter on a constant string or list, worked out as Python Jinja2 does:
  // `'x.x'|trim('x')`, `'.x'|first`, `('.x'|list)[0]`, `'.x'|list|unique|first`.
  // Undefined when an argument is not constant or the result is undefined
  // (review round 3, runtime R3-3).
  private konstFilter(o: Val, name: string, a: Val[], argNodes: Node[], at: Node): Val | undefined {
    const text = typeof o.konst === "string" ? Array.from(o.konst) : undefined;
    const items = text ?? o.konstList;
    if (!items) return undefined;
    switch (name) {
      case "trim": {
        const p = params(argNodes, a, ["chars"]);
        const chars = p && strArg(p[0]);
        return text && chars !== undefined ? this.konstText(o, pyStrip(o.konst as string, chars, true, true), a, at) : undefined;
      }
      case "first":
      case "last":
        // The first or last of nothing is undefined.
        return items.length > 0 && argNodes.length === 0 ? this.konstText(o, items[name === "first" ? 0 : items.length - 1]!, a, at) : undefined;
      case "list":
        return argNodes.length === 0 ? this.konstItems(o, items, a) : undefined;
      case "reverse":
        if (argNodes.length > 0) return undefined;
        return text ? this.konstText(o, text.reverse().join(""), a, at) : this.konstItems(o, [...items].reverse(), a);
      case "unique": {
        // Compared lower-cased unless `case_sensitive`; the first of each is kept.
        const p = params(argNodes, a, ["case_sensitive", "attribute"]);
        const exact = p?.[0]?.konst ?? false;
        if (!p || p[1] || typeof exact !== "boolean") return undefined;
        const seen = new Set<string>();
        return this.konstItems(o, items.filter((x) => !seen.has(exact ? x : x.toLowerCase()) && !!seen.add(exact ? x : x.toLowerCase())), a);
      }
      default:
        return undefined;
    }
  }

  // Constant text `s` worked out from `o` with the constant arguments `keys`:
  // `o` itself when unchanged.
  private konstText(o: Val, s: string, keys: Val[], at: Node): Val | undefined {
    if (s !== o.konst) return this.cut(o, s, keys, at);
    let gate = o.gate;
    for (const k of keys) gate = strongest(gate, k.gate);
    return { lits: o.lits, data: o.data, truth: o.truth, gate, konst: s };
  }

  // A constant list cut from `o` with the constant arguments `keys`. It may
  // print any of the literals it was cut from, `lits`.
  private konstItems(o: Val, items: string[], keys: Val[], lits = o.lits): Val | undefined {
    if (this.fold(items.join("")) === undefined) return undefined;
    let gate: Cond | undefined;
    for (const k of keys) gate = strongest(gate, k.gate);
    return { lits: items.some((x) => x !== "") ? this.choose(lits, gate) : [], data: "none", truth: "none", gate: strongest(o.gate, gate), konstList: items };
  }

  // What `min`, `max`, `sort` and `unique` compare: each element, or the
  // `attribute=` path of each, read part by part (review round 2, runtime N7).
  // Its class, and the condition it puts on what it chooses.
  private orderCond(o: Val, argNodes: Node[], at: Node): [TestClass, Cond | undefined] {
    const attr = kwargKonst(argNodes, "attribute");
    const efs = o.fields ? mapFields(o.fields, o.pairs ? pairField : elementField) : undefined;
    const cls = stronger(efs ? clsOf(attr === undefined ? efs : mapFields(efs, (f) => memberPath(f, attr))) : o.data, o.rest ?? "none");
    return [cls, this.choiceCond(cls, at)];
  }

  // A test of class `cls` as the condition it puts on what it chooses.
  private choiceCond(cls: TestClass | undefined, at: Node): Cond | undefined {
    if (cls === "nondeterministic") this.flagNondet(at, "the clock or chance chooses template text");
    if (cls === undefined) return undefined;
    this.classed(at, cls);
    return condOf(cls === "presence" ? "none" : cls, this.exprSpan(at));
  }

  // The strongest choice among a filter's or method's arguments.
  private argsCond(a: Val[], nodes: Node[]): Cond | undefined {
    let cond: Cond | undefined;
    a.forEach((x, i) => {
      if (typeof x.konst !== "string" && nodes[i]) cond = strongest(cond, this.selCond(x, nodes[i]!));
    });
    return cond;
  }

  // Literals a choice decides: each takes its test, with a new provenance, and
  // is in a block of its own, so a chosen closer closes nothing (review round
  // 2, security N4).
  private choose(lits: Lit[], cond: Cond | undefined): Lit[] {
    if (!cond) return lits;
    return lits.map((l) => ({ ...l, cond: strongest(l.cond, cond), via: ++this.vias, at: { up: l.at ?? ROOT } }));
  }

  // `s.replace(old, new)` and `s|replace(old, new)`: `new` is printed only
  // where `s` holds `old`, so it depends on what `s` is; text of `s`
  // survives only where `old` does not match it.
  private replaced(s: Val, a: Val[], argNodes: Node[], at: Node): Pick<Val, "lits" | "data" | "truth" | "konst"> {
    // Constant text and arguments: the replaced text, or none (review round 2, security N4).
    const konst = this.fold(replaceKonst(s.konst, a));
    if (konst !== undefined) return { lits: konst === "" ? [] : this.folded([...s.lits, ...(a[1]?.lits ?? [])], konst, at), data: "none", truth: "none", konst };
    const old = argNodes[0] ? this.selCond(a[0]!, argNodes[0]) : undefined;
    const into = strongest(old, condOf(s.data === "presence" ? "none" : s.data, this.exprSpan(at)));
    return { lits: [...this.choose(s.lits, old), ...this.choose(a[1]?.lits ?? [], into)], data: s.data, truth: s.data };
  }

  // Replace the literals a constant was folded from with one literal for the
  // folded text, spanned over the expression and under the strongest of their
  // conditions.
  // A folded constant, or none when it is too long or the budget is spent.
  private fold(konst: string | undefined): string | undefined {
    if (konst === undefined || konst.length > MAX_KONST || this.konstChars + konst.length > KONST_BUDGET) return undefined;
    this.konstChars += konst.length;
    return konst;
  }

  // The folded text is there only where every piece is: in the deepest block
  // of theirs (review round 2, security N4). Pieces with one text are one piece
  // made on different paths, in the block either is in.
  private folded(lits: Lit[], konst: string | undefined, at: Node): Lit[] {
    if (konst === undefined || lits.length === 0) return lits;
    let cond: Cond | undefined;
    const pieces = new Map<string, Frame | undefined>();
    for (const l of lits) {
      cond = strongest(cond, l.cond);
      pieces.set(l.text, pieces.has(l.text) ? either(pieces.get(l.text), l.at) : l.at);
    }
    let made: Frame | undefined;
    for (const f of pieces.values()) if (f) made = made ? placed(f, made) : f;
    return [{ text: konst, span: this.exprSpan(at), cond, folded: true, at: made }];
  }

  // ---- the generation flag ----

  // Which arm of a test runs only with add_generation_prompt set (genPolarity).
  private genOf(test: Node, c: Ctx): "body" | "alternate" | undefined {
    return genPolarity(test, (x) => this.isFlag(x, c));
  }

  // The flag as an expression: the flag, a copy of it, a value true only when
  // it is set, or an entry read out of a list, tuple or dict holding it, by a
  // subscript, a filter or a method (`d.get('g')`). Tests and comparisons are
  // left to genPolarity, which reads them apart.
  private isFlag(x: Node, c: Ctx): boolean {
    const method = x.type === "CallExpression" && (x.callee as Node)?.type === "MemberExpression";
    return (FLAG_NODES.has(x.type) || method) && this.eval(x, c).genFlag === true;
  }

  // True when `x` is a count above 0 only with the flag set
  // (`add_generation_prompt|int`), so a loop over `range(x)` or text repeated
  // `x` times is there only in the generation prompt.
  private flagCount(x: Node, c: Ctx): boolean {
    const k = flagNumbers(x, (y) => this.isFlag(y, c));
    return k !== undefined && k.set.every((v) => v >= 1) && k.unset.every((v) => v <= 0);
  }

  private flagRange(iter: Node, c: Ctx): boolean {
    const callee = iter?.type === "CallExpression" ? (iter.callee as Node) : undefined;
    const args = (iter?.args as Node[] | undefined) ?? [];
    if (callee?.type !== "Identifier" || callee.value !== "range" || args.length !== 1) return false;
    return !this.lookup("range", c) && !this.macros.has("range") && this.flagCount(args[0]!, c);
  }

  // An entry of a list of constants picked by the flag as a number
  // (`['', X][add_generation_prompt|int]`): the one for the flag set is
  // printed only in the generation prompt, the one for it unset only in the
  // arm exclusive with it (review round 2, security N4).
  private flagPick(n: Node, o: Val, c: Ctx): Val | undefined {
    const prop = n.property as Node;
    if (!n.computed || (prop?.type !== "Identifier" && prop?.type !== "FilterExpression")) return undefined;
    // Called only when the subscript is the flag, already evaluated.
    const k = flagNumbers(prop, (y) => y === prop || this.isFlag(y, c));
    if (!k) return undefined;
    const items = o.konstList;
    if (!items) return undefined;
    const entry = (i: number): string => (Number.isInteger(i) ? items[i < 0 ? i + items.length : i] : undefined) ?? "";
    const set = new Set(k.set.map(entry));
    const unset = new Set(k.unset.map(entry));
    const id = this.genId(n);
    const [yes, no] = arms(c.path);
    const lits = o.lits.flatMap((l): Lit[] => {
      if (set.has(l.text) && unset.has(l.text)) return [l];
      if (set.has(l.text)) return [{ ...l, at: placed(l.at, yes), gen: l.gen ?? id }];
      if (unset.has(l.text)) return [{ ...l, at: placed(l.at, no), genElse: l.genElse ?? id }];
      return [];
    });
    const one = set.size === 1 && unset.size === 1 && [...set][0] === [...unset][0] ? [...set][0] : undefined;
    const flag = [...set].every((x) => x !== "") && [...unset].every((x) => x === "");
    return { lits, data: "none", truth: "none", gate: o.gate, konst: one, genFlag: flag ? true : undefined };
  }

  // A test's value: the flag when the test holds only with the flag set.
  private flagged(v: Val, test: Node, c: Ctx): Val {
    return this.genOf(test, c) === "body" ? { ...v, genFlag: true } : v;
  }

  private genId(n: Node): number {
    let id = this.genIds.get(n);
    if (id === undefined) this.genIds.set(n, (id = this.genIds.size));
    return id;
  }

  // ---- tests ----

  private testEnv(c: Ctx): TestEnv {
    return {
      value: (x, f) => this.eval(x, f === c.facts ? c : { ...c, facts: f }),
      tested: this.recording ? (x, cls, operands, own) => this.tested(x, cls, operands, own ?? cls, c) : undefined,
    };
  }

  // A test classifyTest classed whole. A comparison or membership test that
  // names a literal on one side and runtime input on the other is a trigger
  // candidate, phrased as the input against the literal (ISC-22.1).
  // A candidate takes the comparison's own class: a part's `type` against a
  // documented kind is presence even where a content test chose the part, as
  // that test is listed apart (ISC-22.1). Divergence keeps the gated class.
  private tested(n: Node, gated: TestClass, operands: readonly [Val, Val] | undefined, cls: TestClass, c: Ctx): void {
    this.classed(n, gated);
    if (!operands || n.type !== "BinaryExpression") return;
    const o = String((n.operator as { value?: unknown })?.value ?? "");
    const [a, b] = operands;
    if (o === "in" || o === "not in") {
      // `'x' in m.content` puts the literal inside the input; `m.role in
      // ['a', 'b']` tests the input against each literal in turn.
      if (constOf(a) !== undefined) this.candidate(constOf(a), o, b, cls, n);
      else for (const k of this.literalsIn(n.right as Node, b, c)) this.candidate(k, o === "in" ? "==" : "!=", a, cls, n);
      return;
    }
    // `40 < n` is `n > 40`: the candidate reads input first.
    const flipped = FLIPPED[o];
    if (!flipped) return;
    const eq = o === "==" || o === "!=";
    if (constOf(b) !== undefined) this.candidate(constOf(b), eq && isSlice(n.left as Node) ? "slice" : (o as TriggerOp), a, cls, n);
    else if (constOf(a) !== undefined) this.candidate(constOf(a), eq && isSlice(n.right as Node) ? "slice" : flipped, b, cls, n);
  }

  // The literals a test compares its input with, one by one: a list or tuple
  // literal's constant elements, or a template value's constant strings, dict
  // keys or text (`m.content in 'abc'` passes for the literal itself).
  private literalsIn(n: Node, v: Val, c: Ctx): unknown[] {
    if (n?.type === "ArrayLiteral" || n?.type === "TupleLiteral") return ((n.value as Node[]) ?? []).map((el) => constOf(this.eval(el, c)));
    if (v.konstKeys) return v.konstKeys;
    if (isRuntime(v)) return [];
    return v.konstList ?? [v.konst];
  }

  private classed(n: Node, cls: TestClass): void {
    if (!this.recording) return;
    const was = this.tests.get(n);
    if (was === undefined || stronger(was, cls) !== was) this.tests.set(n, cls);
  }

  // One trigger candidate: `input op value` at `at`. A literal that is no string
  // or number (a boolean, none) names no value a probe could send. One entry per
  // place, operator, literal and input, with the strongest class seen.
  private candidate(value: unknown, op: TriggerOp, input: Val, cls: TestClass, at: Node): void {
    if (!this.recording || cls === "none" || !isRuntime(input)) return;
    if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) return;
    const span = this.testSpan(at);
    const key = `${span.start}:${span.end}:${op}:${typeof value}:${value}:${input.src ?? ""}`;
    const was = this.triggers.get(key);
    if (was) {
      if (stronger(was.test, cls) !== was.test) was.test = cls;
      return;
    }
    if (this.triggers.size >= MAX_TRIGGERS) {
      this.triggersCut = true;
      return;
    }
    this.triggers.set(key, { value, op, ...(input.src !== undefined ? { input: input.src } : {}), test: cls, span });
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

  // A test's whole text (ISC-22.1). exprSpan reaches names and strings only, so
  // this widens it to the brackets its ends sit in (`m.content.find('x')`) and
  // to a number the comparison begins or ends with (`messages|length > 40`).
  private testSpan(n: Node): Span {
    let span = this.testSpans.get(n);
    if (!span) this.testSpans.set(n, (span = this.widened(n)));
    return span;
  }

  private widened(n: Node): Span {
    const s = this.exprSpan(n);
    const toks = this.outcome.pre?.tokens;
    if (!toks || s.end <= s.start) return s;
    let lo = tokenFrom(toks, s.start);
    let hi = tokenFrom(toks, s.end) - 1;
    if (toks[lo]?.start !== s.start || toks[hi]?.end !== s.end) return s;
    let depth = 0;
    for (let k = lo; k <= hi; k++) depth += parenStep(toks[k]!);
    for (; depth > 0 && hi + 1 < toks.length && toks[hi + 1]!.inTag; depth += parenStep(toks[++hi]!));
    for (; depth < 0 && lo > 0 && toks[lo - 1]!.inTag; depth += parenStep(toks[--lo]!));
    if (n.type === "BinaryExpression") {
      if (this.exprSpan(n.right as Node).end === 0) hi = numberReach(toks, hi, 1);
      if (this.exprSpan(n.left as Node).end === 0) lo = numberReach(toks, lo, -1);
    }
    return this.outcome.lines!.span(toks[lo]!.start, toks[hi]!.end);
  }
}

// ---- values ----

const BUILTINS = new Set(["namespace", "dict", "range", "strftime_now", "raise_exception", "cycler", "joiner", "lipsum", "caller", "zip", "enumerate"]);
// The functions whose result is the clock or chance.
const NONDET_FNS = new Set(["strftime_now", "random"]);
const SHAPE_SELECT_TESTS = new Set(["defined", "undefined", "none", "string", "mapping", "iterable", "sequence", "number", "integer", "float", "boolean", "true", "false"]);

// `selectattr('type', 'equalto', 'image')` compares each element with a
// constant, so it reads the field against its vocabulary as `==` does (ISC-18).
const COMPARE_SELECT_TESTS = new Set(["equalto", "==", "eq", "sameas", "ne", "!=", "in"]);

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

// `select('gt', 40)` on counts compares each with the constant as `>` does: a
// threshold, or presence within 1 (review round 3, contracts S3).
const ORDER_SELECT_TESTS = new Set(["eq", "equalto", "==", "ne", "!=", "lt", "lessthan", "<", "le", "<=", "gt", "greaterthan", ">", "ge", ">="]);

function countSelect(fs: Fields, test: string, value: Val | undefined, list: Val): TestClass | undefined {
  if (!value || !ORDER_SELECT_TESTS.has(test)) return undefined;
  return countTest({ lits: [], data: "presence", truth: "presence", fields: fs, rest: list.rest, restNums: list.restNums }, value);
}

function runtimeVal(field: Field, path: string | undefined): Val {
  return { lits: [], data: field.cls, truth: presenceOf([field]), fields: [field], path };
}

/** The index of the first token that starts at or after `offset`. */
function tokenFrom(toks: readonly PreToken[], offset: number): number {
  let lo = 0;
  let hi = toks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (toks[mid]!.start < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// +1 for a bracket that opens, -1 for one that closes.
function parenStep(t: PreToken): number {
  if (t.type !== "punct") return 0;
  return t.value === "(" || t.value === "[" || t.value === "{" ? 1 : t.value === ")" || t.value === "]" || t.value === "}" ? -1 : 0;
}

// From token `at`, the farthest token in direction `dir` that ends an operand
// made of numbers, operators and parentheses alone: `> (40)` after a name.
function numberReach(toks: readonly PreToken[], at: number, dir: 1 | -1): number {
  let best = at;
  let depth = 0;
  for (let k = at + dir; k >= 0 && k < toks.length; k += dir) {
    const t = toks[k]!;
    if (t.type === "number") {
      if (depth === 0) best = k;
      continue;
    }
    if (t.type !== "punct") break;
    const step = parenStep(t) * dir;
    if (step < 0 && depth === 0) break;
    if (depth === 0 && (t.value === "," || t.value === ":")) break;
    depth += step;
    if (step < 0 && depth === 0) best = k;
  }
  return best;
}

/** The template constant a value is, when it depends on no runtime input. */
function constOf(v: Val): Val["konst"] | undefined {
  return isRuntime(v) ? undefined : v.konst;
}

/** The input an element of `v` is read from (`messages[]`), when `v` names one. */
function elemSrc(v: Val): string | undefined {
  return v.src === undefined || v.pairs ? undefined : `${v.src}[]`;
}

// `v` as one element of a list or dict the template builds: its text and
// classes, none of its identity as a constant, namespace or macro.
function element(v: Val): Val {
  return { ...v, konst: undefined, konstList: undefined, ns: undefined, nsInit: undefined, path: undefined, src: undefined };
}

// How deep a nested dict's keys are tracked; deeper ones stay at this depth,
// so every lookup still finds them (review round 3, contracts M1).
const MAX_NEST = 4;

/** `keys` once their dict is an entry of a list or dict: one lookup further down. */
function deeper(keys: Lit[] | undefined): Lit[] | undefined {
  return keys?.map((l) => ({ ...l, nest: Math.min((l.nest ?? 0) + 1, MAX_NEST) }));
}

/** The keys an entry looked up from a list or dict holds: those one lookup down, now its own. */
function entryKeys(keys: Lit[] | undefined): Lit[] | undefined {
  const out = keys?.filter((l) => l.nest).map((l) => ({ ...l, nest: l.nest! >= MAX_NEST ? MAX_NEST : l.nest! - 1 || undefined }));
  return out?.length ? out : undefined;
}

/** The keys held by the entries of a dict, at the same depth: its own keys are gone. */
function heldKeys(keys: Lit[] | undefined): Lit[] | undefined {
  const out = keys?.filter((l) => l.nest);
  return out?.length ? out : undefined;
}

/** A key as a dict's own, whatever dict it came from. */
function own(l: Lit): Lit {
  return l.nest ? { ...l, nest: undefined } : l;
}

function boolVal(cls: TestClass): Val {
  return { lits: [], data: cls, truth: cls };
}

// `s.replace(old, new[, count])` on constants, as Python does it.
function replaceKonst(s: unknown, a: Val[]): string | undefined {
  const [old, by, count] = [a[0]?.konst, a[1]?.konst, a[2]?.konst];
  if (typeof s !== "string" || typeof old !== "string" || old === "" || typeof by !== "string") return undefined;
  if (a.length > 3 || (a.length === 3 && !Number.isInteger(count))) return undefined;
  const parts = s.split(old);
  const n = a.length === 3 ? (count as number) : -1;
  if (n < 0 || n >= parts.length - 1) return parts.join(by);
  return parts.slice(0, n + 1).join(by) + old + parts.slice(n + 1).join(old);
}

// Expressions isFlag evaluates. A test or comparison reaches the flag through
// genPolarity instead, which also keeps the two from calling each other.
const FLAG_NODES = new Set(["Identifier", "MemberExpression", "FilterExpression", "Ternary", "SelectExpression"]);

// `v` printed only in a generation-prompt branch, or only in the arm exclusive with one.
function genArm(v: Val, gen: number | undefined, genElse: number | undefined): Val {
  const tag = (l: Lit): Lit => ({ ...l, gen: l.gen ?? gen, genElse: l.genElse ?? genElse });
  return { ...v, lits: v.lits.map(tag), keys: v.keys?.map(tag) };
}

// The flag itself, or a constant that is never true.
function flagOrFalse(v: Val): boolean {
  return v.genFlag === true || (v.konst === false || v.konst === 0 || v.konst === "" || v.konst === null);
}

// A guard in force (`if x is string`) refines what a membership test on `x` means.
function refine(v: Val, path: string | undefined, c: Ctx): Val {
  if (path === undefined) return v.path === undefined ? v : { ...v, path: undefined };
  const shape = c.facts.get(path);
  if (v.path === path && v.shape === shape) return v;
  return { ...v, path, shape };
}

// `c` with one more test on everything it does and prints.
function gated(c: Ctx, gate: Cond | undefined): Ctx {
  return gate ? { ...c, cond: strongest(c.cond, gate), emitCond: strongest(c.emitCond, gate) } : c;
}

// Methods whose result holds none of the receiver's or the arguments' text: a
// truth value, a position or a count, or None from an in-place change.
const TEXTLESS_METHODS = new Set([
  "startswith", "endswith", "find", "rfind", "index", "rindex", "count", "isalnum", "isalpha", "isascii", "isdecimal",
  "isdigit", "isidentifier", "islower", "isnumeric", "isprintable", "isspace", "istitle", "isupper", "clear", "remove",
  "sort", "reverse",
]);

// Python's string, list and dict methods: a call to one of these names is never
// a call to a macro stored under that key.
const KNOWN_METHODS = new Set([
  "capitalize", "casefold", "center", "count", "encode", "endswith", "expandtabs", "find", "format", "format_map", "index",
  "isalnum", "isalpha", "isascii", "isdecimal", "isdigit", "isidentifier", "islower", "isnumeric", "isprintable", "isspace",
  "istitle", "isupper", "join", "ljust", "lower", "lstrip", "maketrans", "partition", "removeprefix", "removesuffix", "replace",
  "rfind", "rindex", "rjust", "rpartition", "rsplit", "rstrip", "split", "splitlines", "startswith", "strip", "swapcase",
  "title", "translate", "upper", "zfill", "append", "clear", "copy", "extend", "insert", "pop", "remove", "reverse", "sort",
  "get", "items", "keys", "values", "update", "setdefault", "popitem", "fromkeys", "add",
]);

function printKey(l: Lit): string {
  return `${litKey(l)}:${l.via ?? ""}`;
}

/** The names a `for` target binds: `x`, or `k, v`. */
function loopNames(lv: Node): string[] {
  if (lv?.type === "Identifier") return [String(lv.value)];
  if (lv?.type === "TupleLiteral" || lv?.type === "ArrayLiteral") return ((lv.value as Node[]) ?? []).filter((x) => x?.type === "Identifier").map((x) => String(x.value));
  return [];
}

/**
 * `v` as the sequence iterating it yields (ISC-22): a dict's elements are its
 * own keys, so they become text any element prints. The keys of a dict it
 * holds stay keys, its elements' to look up (review round 3, contracts M1).
 * `.items()` pairs keep their keys apart, so a pair's key and value stay
 * separable.
 */
function seqOf(v: Val): Val {
  return v.pairs || !v.keys ? v : { ...v, lits: [...v.lits, ...v.keys.filter((l) => !l.nest)], keys: heldKeys(v.keys) };
}

const pairFields = new WeakMap<Field, Field>();
/**
 * One `.items()` or `|dictsort` pair of the record `f`: its key at 0 and -2,
 * its value at 1 and -1, which keeps the value's class (review round 2, runtime
 * N3). Cached so identity stays stable across passes.
 */
function pairField(f: Field): Field {
  let p = pairFields.get(f);
  if (!p) {
    const v = valueField(f);
    pairFields.set(f, (p = { cls: v.cls, kind: "list", elem: v, fields: { "0": keyField(f), "1": v, "-2": keyField(f), "-1": v } }));
  }
  return p;
}

/** The field at constant position `i` of `f` when it has one there (a pair's key or value), else `orElse`. */
function positionField(f: Field, i: number, orElse: Field): Field {
  return f.fields && Object.hasOwn(f.fields, String(i)) ? f.fields[String(i)]! : orElse;
}

// An element, key or value of `it`. With no schema, an element's emptiness is
// as telling as the whole value's: the parts of a string the template built
// are no more content-revealing than the string. An element holds what every
// element does of the flag (review round 3, contracts M3).
function elemOf(it: Val): Val {
  const s = seqOf({ ...it, pairs: undefined });
  const fields = it.fields ? mapFields(it.fields, it.pairs ? pairField : elementField) : undefined;
  const e: Val = {
    // A pair prints its key as well as its value. An element that is a dict
    // has the keys one lookup down as its own, as the flat dict does; a pair
    // holds them in its value (review round 3, contracts M1).
    lits: s.lits,
    keys: it.pairs ? s.keys : entryKeys(s.keys),
    data: fields ? clsOf(fields) : it.data,
    truth: fields ? presenceOf(fields) : it.truth,
    gate: it.gate,
    fields,
    rest: it.rest,
    src: elemSrc(it),
  };
  return withHeld(e, heldAt(it.genAt, null));
}

// Entry `i` of a tuple or list, or of each of its elements' (`for k, v in`).
function entryOf(it: Val, i: number): Val {
  return withHeld(elemOf(it), heldAt(it.genAt, i));
}

/** The positions Python's `[start:stop:step]` takes from `n` items; undefined for a step of 0. */
function slicePositions(n: number, start: number | undefined, stop: number | undefined, step = 1): number[] | undefined {
  if (step === 0) return undefined;
  const at = (x: number, lo: number, hi: number) => (x < 0 ? Math.max(x + n, lo) : Math.min(x, hi));
  const out: number[] = [];
  if (step > 0) for (let i = at(start ?? 0, 0, n), end = at(stop ?? n, 0, n); i < end; i += step) out.push(i);
  else for (let i = at(start ?? n - 1, -1, n - 1), end = at(stop ?? -n - 1, -1, n - 1); i > end; i += step) out.push(i);
  return out;
}

/** A forward slice that is empty whatever the length: it stops at 0, or starts at or past a stop of the same sign. */
function emptySlice(start: number | undefined, stop: number | undefined, step = 1): boolean {
  if (step <= 0 || stop === undefined) return false;
  const from = start ?? 0;
  return stop === 0 || ((from >= 0) === (stop >= 0) && from >= stop);
}

type KeyRole = "index" | "bound" | "step";

/** The expression under any filters that keep its number. */
function numberKept(n: Node): Node {
  let x = n;
  for (let i = 0; i < 16 && x?.type === "FilterExpression" && NUMBER_KEEPING.has(filterName(x.filter as Node)); i++) x = x.operand as Node;
  return x;
}

/** A count printed as the same number, or summed, is still the count, with what else it may be (review round 3, contracts M2). */
function countKept(o: Val): Pick<Val, "fields" | "rest" | "restNums"> {
  return countsOf(o) ? { fields: o.fields, rest: o.rest, restNums: o.restNums } : {};
}

const number = (k: number | undefined): Val => ({ lits: [], data: "none", truth: "none", konst: k });
// Only the count: what the container and key read besides is judged by selCond and their gates.
const bare = (v: Val): Val => ({ lits: [], data: "presence", truth: "presence", fields: v.fields, rest: v.rest });

/**
 * A subscript, slice bound or step `k` on `o` as a count test (ISC-18, review
 * round 2). On conversation data a constant k asks whether there are more
 * than k elements, judged as `messages|length > k` is, and a count key
 * compares one count with the other: `messages[loop.index0 + 1]` stays near.
 * A step or `batch(k)` divides the count unless it is ±1. On a list or string
 * the template wrote, a count key must reach the last position; on a dict or
 * an unknown template value any key is a threshold. Undefined when neither side
 * is a count, or the container is a pair.
 */
function positionTest(o: Val, k: Val, role: KeyRole): TestClass | undefined {
  // A pair always has two elements.
  if (o.fields && o.fields.length > 0 && o.fields.every((f) => f.kind === "list" && f.fields !== undefined)) return undefined;
  const len = bare(lengthOf(o));
  const key = countsOf(k) ? bare(k) : undefined;
  if (countsOf(len)) {
    if (key) return countTest(key, len);
    if (typeof k.konst !== "number") return undefined;
    return countTest(len, number(role === "step" && Math.abs(k.konst) <= 1 ? 0 : k.konst));
  }
  if (!key) return undefined;
  const n = o.konstList?.length ?? (typeof o.konst === "string" ? o.konst.length : undefined);
  if (n === undefined) return isRuntime(o) ? undefined : countTest(key, number(undefined));
  return stronger(countTest(key, number(0))!, countTest(key, number(Math.max(role === "index" ? n - 1 : n, 0)))!);
}

function keysOf(it: Val): Val {
  const fields = it.fields ? mapFields(it.fields, keyField) : undefined;
  const d: TestClass = fields ? clsOf(fields) : it.data === "none" ? "none" : "presence";
  return { lits: it.keys ?? [], data: d, truth: d, gate: it.gate, fields, rest: it.rest };
}

function valuesOf(it: Val): Val {
  const fields = it.fields ? mapFields(it.fields, valueField) : undefined;
  // A value may be a dict, with keys of its own (review round 3, contracts M1).
  return { lits: it.lits, keys: entryKeys(it.keys), data: fields ? clsOf(fields) : it.data, truth: fields ? presenceOf(fields) : it.truth, gate: it.gate, fields, rest: it.rest };
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
function uniqueLits(ls: Lit[]): Lit[] {
  return ls.length < 2 ? ls : unionLits(ls.slice(0, 1), ls.slice(1));
}

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
      const at = either(cur.at, l.at);
      const nest = Math.max(cur.nest ?? 0, l.nest ?? 0) || undefined;
      if (cond !== cur.cond || at !== cur.at || nest !== cur.nest) out[i] = { ...cur, cond, at, nest };
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
    // Either side may be something besides the other's fields.
    rest: a.fields || b.fields ? eitherRest(restOf(a), restOf(b)) : undefined,
    restNums: a.fields || b.fields ? eitherNums(a, b) : undefined,
    path: a.path === b.path ? a.path : undefined,
    // A default or a constant arm leaves the input it was read from (ISC-22.1).
    src: a.src === b.src ? a.src : !isRuntime(b) ? a.src : !isRuntime(a) ? b.src : undefined,
    shape: a.shape === b.shape ? a.shape : undefined,
    konst: a.konst === b.konst ? a.konst : undefined,
    konstList: a.konstList && b.konstList && a.konstList.join("\u0000") === b.konstList.join("\u0000") ? a.konstList : undefined,
    konstKeys: a.konstKeys && b.konstKeys && a.konstKeys.join("\u0000") === b.konstKeys.join("\u0000") ? a.konstKeys : undefined,
    ns: a.ns === b.ns ? a.ns : undefined,
    macro: a.macro === b.macro ? a.macro : undefined,
    fns: a.fns || b.fns ? [...new Set([...(a.fns ?? []), ...(b.fns ?? [])])].sort() : undefined,
    genFlag: a.genFlag && b.genFlag ? true : undefined,
    genAt: bothAt(a.genAt, b.genAt),
    pairs: a.pairs && b.pairs ? true : undefined,
    nsInit: a.nsInit ?? b.nsInit,
  };
}

// ---- where a container holds the flag ----
// The flag goes into lists, tuples and dicts, and comes back out by a
// subscript, a loop, unpacking, `.get`, `.values()`, `.items()`, `first`,
// `map` and the like, however deep it is (review round 3, contracts M3).

/** What a value holds of the flag: the flag itself, or where it holds it. */
type Held = true | GenAt;

function heldOf(v: Val): Held | undefined {
  return v.genFlag ? true : v.genAt;
}

function withHeld(v: Val, h: Held | undefined): Val {
  return h === true ? { ...v, genFlag: true } : h ? { ...v, genAt: h } : v;
}

function asGen(h: Held | undefined): Pick<Val, "genFlag" | "genAt"> {
  return h === true ? { genFlag: true } : { genAt: h };
}

/** What a container holds at `key`, or at every entry for `null`. */
function heldAt(h: Held | undefined, key: string | number | null): Held | undefined {
  return h === true ? undefined : h?.find(([k]) => k === key)?.[1];
}

/** A read by `key`: an index not known may be any entry of a list. */
function entryHeld(at: GenAt | undefined, key: string | number | undefined): Held | undefined {
  return (key === undefined ? undefined : heldAt(at, key)) ?? (typeof key === "string" ? undefined : heldAt(at, null));
}

/** A dotted attribute path read off an entry (`map(attribute='a.0')`). */
function heldPath(h: Held | undefined, attr: string): Held | undefined {
  for (const part of attr.split(".")) h = heldAt(h, /^\d+$/.test(part) ? Number(part) : part);
  return h;
}

/** A list of entries holding `hs`: at each index from either end, and at every entry when all hold it. */
function gathered(hs: readonly (Held | undefined)[]): GenAt | undefined {
  const at: [number | null, Held][] = [];
  hs.forEach((h, i) => {
    if (h) at.push([i, h], [i - hs.length, h]);
  });
  const each = hs.length ? hs.reduce((x, y) => meet(x, y)) : undefined;
  if (each) at.push([null, each]);
  return at.length ? at : undefined;
}

/** A dict's holdings with `key` set: a later entry for a key replaces an earlier one. */
function keyHeld(at: Map<string, Held>, key: string, h: Held | undefined): void {
  at.delete(key);
  if (h) at.set(key, h);
}

/** The same entries in another order, or fewer of them: only what every entry holds. */
function everyHeld(at: GenAt | undefined): GenAt | undefined {
  const each = heldAt(at, null);
  return each ? [[null, each]] : undefined;
}

/** `.values()` of a dict of constant keys, each once: what each value holds, in order. */
function valuesHeld(d: Val): GenAt | undefined {
  const ks = d.konstKeys;
  if (!d.genAt || !ks || new Set(ks).size !== ks.length) return undefined;
  return gathered(ks.map((k) => heldAt(d.genAt, k)));
}

/** `.items()` of such a dict: each pair holds its value's at 1. `|dictsort` puts them in another order. */
function pairsHeld(d: Val, sorted: boolean): GenAt | undefined {
  const at = valuesHeld(d)?.map(([k, h]): GenAt[number] => [k, [[1, h], [-1, h]]]);
  return sorted ? everyHeld(at) : at;
}

/** What both hold: the flag where both are it, and where both containers hold it. */
function meet(a: Held | undefined, b: Held | undefined): Held | undefined {
  if (a === b) return a;
  if (a === true || b === true) return undefined;
  return bothAt(a, b);
}

// One meet per entry, so the work is linear in the entries at every depth.
// Copies of one literal list the same keys in the same order and need no
// lookup table. It is `a` itself when both hold the same, so a value joined
// again and again with an equal one stays one array (review round 3, runtime
// R3-1).
function bothAt(a: GenAt | undefined, b: GenAt | undefined): GenAt | undefined {
  if (a === b) return a;
  if (!a || !b) return undefined;
  const inB = a.length === b.length && a.every(([k], i) => b[i]![0] === k) ? undefined : new Map(b);
  const at: GenAt[number][] = [];
  let same = true;
  a.forEach(([k, h], i) => {
    const m = meet(h, inB ? inB.get(k) : b[i]![1]);
    if (m) at.push([k, m]);
    if (m !== h) same = false;
  });
  return same ? a : at.length ? at : undefined;
}

// Where the flag is held is tracked up to this many entries, at every depth
// (review round 3, runtime R3-1).
const MAX_GEN_AT = 256;

/** Entries of `at` at every depth, counted no further than one past `cap`. */
function genSize(at: GenAt, cap: number): number {
  let n = 0;
  for (const [, h] of at) {
    if (n++ >= cap) break;
    if (h !== true) n += genSize(h, cap - n);
  }
  return n;
}

// A filter's value: `add_generation_prompt|default(false)` is the flag, and so
// is `[add_generation_prompt]|first`. A list in another order or with fewer
// entries holds what every entry does, and what `select` keeps of entries that
// are only ever the flag is there, so the list is true, only with it set.
function filterGen(o: Val, name: string, args: Node[]): Pick<Val, "genFlag" | "genAt"> {
  const each = heldAt(o.genAt, null);
  if (FLAG_FILTERS.has(name)) return { genFlag: o.genFlag, genAt: name === "default" || name === "d" ? o.genAt : undefined };
  switch (name) {
    case "first":
    case "last":
      return asGen(heldAt(o.genAt, name === "first" ? 0 : -1) ?? each);
    case "min":
    case "max":
      return asGen(each);
    case "list":
      // A dict's list is its keys.
      return { genFlag: o.genFlag, genAt: o.genAt?.some(([k]) => typeof k === "string") ? undefined : o.genAt };
    case "reverse":
    case "sort":
    case "unique":
      return { genFlag: o.genFlag, genAt: everyHeld(o.genAt) };
    case "reject":
    case "rejectattr":
      return { genAt: everyHeld(o.genAt) };
    case "select":
      return { genFlag: args.length === 0 && each === true ? true : undefined, genAt: everyHeld(o.genAt) };
    case "selectattr": {
      const attr = args.length === 1 && args[0]?.type === "StringLiteral" ? String(args[0].value) : undefined;
      return { genFlag: attr !== undefined && heldPath(each, attr) === true ? true : undefined, genAt: everyHeld(o.genAt) };
    }
    case "map": {
      const attr = kwargKonst(args, "attribute");
      const at = attr === undefined ? undefined : o.genAt?.flatMap(([k, h]): GenAt[number][] => {
        const x = typeof k === "string" ? undefined : heldPath(h, attr);
        return x ? [[k, x]] : [];
      });
      return { genAt: at?.length ? at : undefined };
    }
    case "items":
    case "dictsort":
      return { genAt: pairsHeld(o, name === "dictsort") };
  }
  return {};
}

// A method's value: a dict's entry by `.get`, its values and its pairs.
function methodGen(r: Val, m: string, args: Node[]): Pick<Val, "genFlag" | "genAt"> {
  switch (m) {
    case "get":
      return args[0]?.type === "StringLiteral" ? asGen(heldAt(r.genAt, String(args[0].value))) : {};
    case "values":
      return { genAt: valuesHeld(r) };
    case "items":
      return { genAt: pairsHeld(r, false) };
  }
  return {};
}

function sameVal(a: Val, b: Val): boolean {
  if (a.lits.length !== b.lits.length || (a.keys?.length ?? 0) !== (b.keys?.length ?? 0)) return false;
  if (a.data !== b.data || a.truth !== b.truth || a.gate?.test !== b.gate?.test) return false;
  if (!sameFields(a.fields, b.fields) || a.rest !== b.rest || a.konst !== b.konst || a.ns !== b.ns || a.macro !== b.macro || a.pairs !== b.pairs) return false;
  if (String(a.fns) !== String(b.fns) || a.genFlag !== b.genFlag || (a.genAt !== b.genAt && JSON.stringify(a.genAt) !== JSON.stringify(b.genAt))) return false;
  if (String(a.restNums) !== String(b.restNums)) return false;
  if ((a.konstList === undefined) !== (b.konstList === undefined)) return false;
  for (let i = 0; i < a.lits.length; i++) if (a.lits[i]!.cond?.test !== b.lits[i]!.cond?.test) return false;
  // A key's condition can grow on its own (`selectattr` by a value a later
  // pass learns is content), and join keeps the key list's length.
  for (let i = 0; i < (a.keys?.length ?? 0); i++) if (a.keys![i]!.cond?.test !== b.keys![i]!.cond?.test || a.keys![i]!.nest !== b.keys![i]!.nest) return false;
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

// The arguments of a call by parameter, `names` in order, by position or,
// unless `positional`, by keyword. Undefined when one does not fit.
function params(argNodes: Node[], a: Val[], names: string[], positional = false): (Val | undefined)[] | undefined {
  const out: (Val | undefined)[] = [];
  let next = 0;
  for (let i = 0; i < argNodes.length; i++) {
    const n = argNodes[i];
    const kw = n?.type === "KeywordArgumentExpression";
    if (n?.type === "SpreadExpression" || n?.type === "KeywordSpreadExpression" || (kw && positional)) return undefined;
    const at = kw ? names.indexOf(String((n.key as Node).value)) : next++;
    if (at < 0 || at >= names.length || out[at] !== undefined) return undefined;
    out[at] = a[i];
  }
  return out;
}

// A constant str-or-None argument: null when absent or None, undefined when not constant.
function strArg(v: Val | undefined): string | null | undefined {
  if (v === undefined || v.konst === null) return null;
  return typeof v.konst === "string" ? v.konst : undefined;
}

// A constant int argument, `absent` when there is none; undefined when not constant.
function intArg(v: Val | undefined, absent: number): number | undefined {
  if (v === undefined) return absent;
  if (typeof v.konst === "boolean") return Number(v.konst);
  return Number.isInteger(v.konst) ? (v.konst as number) : undefined;
}

// Python's whitespace (str.isspace), which split() and strip() take with no argument.
function isPySpace(c: number): boolean {
  return (c >= 0x09 && c <= 0x0d) || (c >= 0x1c && c <= 0x20) || c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
}

// Python's line boundaries (str.splitlines).
function isPyLineBreak(c: number): boolean {
  return (c >= 0x0a && c <= 0x0d) || (c >= 0x1c && c <= 0x1e) || c === 0x85 || c === 0x2028 || c === 0x2029;
}

// str.strip, lstrip or rstrip: the characters of `chars`, or whitespace when null.
function pyStrip(s: string, chars: string | null, left: boolean, right: boolean): string {
  const cs = Array.from(s);
  const set = chars === null ? undefined : new Set(Array.from(chars));
  const drop = (ch: string): boolean => (set ? set.has(ch) : ch.length === 1 && isPySpace(ch.charCodeAt(0)));
  let i = 0;
  let j = cs.length;
  if (left) while (i < j && drop(cs[i]!)) i++;
  if (right) while (j > i && drop(cs[j - 1]!)) j--;
  return cs.slice(i, j).join("");
}

// str.split or rsplit: at `sep`, or between runs of whitespace when null, at
// most `max` times (every time when negative), from the right for rsplit.
function pySplit(s: string, sep: string | null, max: number, fromRight: boolean): string[] {
  const n = max < 0 ? Infinity : max;
  const out: string[] = [];
  if (sep !== null && !fromRight) {
    let from = 0;
    for (let k = s.indexOf(sep); out.length < n && k >= 0; k = s.indexOf(sep, from)) {
      out.push(s.slice(from, k));
      from = k + sep.length;
    }
    out.push(s.slice(from));
    return out;
  }
  if (sep !== null) {
    let to = s.length;
    const prev = (): number => (to >= sep.length ? s.lastIndexOf(sep, to - sep.length) : -1);
    for (let k = prev(); out.length < n && k >= 0; k = prev()) {
      out.push(s.slice(k + sep.length, to));
      to = k;
    }
    out.push(s.slice(0, to));
    return out.reverse();
  }
  // Whitespace at either end splits off nothing; past `max` words, the rest is
  // one word, whitespace inside it kept.
  const sp = (i: number): boolean => isPySpace(s.charCodeAt(i));
  if (!fromRight) {
    for (let i = 0; ; ) {
      while (i < s.length && sp(i)) i++;
      if (i === s.length) return out;
      if (out.length >= n) return [...out, s.slice(i)];
      const j = i;
      while (i < s.length && !sp(i)) i++;
      out.push(s.slice(j, i));
    }
  }
  for (let j = s.length; ; ) {
    while (j > 0 && sp(j - 1)) j--;
    if (j === 0) return out.reverse();
    if (out.length >= n) return [...out, s.slice(0, j)].reverse();
    const i = j;
    while (j > 0 && !sp(j - 1)) j--;
    out.push(s.slice(j, i));
  }
}

// str.splitlines: at each line boundary, `\r\n` one, kept with `keep`.
function pyLines(s: string, keep: boolean): string[] {
  const out: string[] = [];
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!isPyLineBreak(c)) continue;
    const end = c === 0x0d && s.charCodeAt(i + 1) === 0x0a ? i + 2 : i + 1;
    out.push(s.slice(from, keep ? end : i));
    from = end;
    i = end - 1;
  }
  if (from < s.length) out.push(s.slice(from));
  return out;
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
  /** The piece ending here is one bare word (`user`, `assistant`), with no delimiter of its own. */
  bare?: boolean;
}

// An assistant role in a header: `assistant`, `<|assistant|>`, Gemma's
// `model`, ShareGPT's `gpt`, `bot`.
const ASSISTANT_ROLE = /(?:^|[^\p{L}\p{N}])(?:assistant|model|gpt|bot)(?:$|[^\p{L}\p{N}])/iu;

/** The residue of a literal: the non-scaffolding runs that hold a letter or digit, where the first scaffolding match ends, and where the last one naming the assistant ends (-1 for none). */
export interface Residue {
  frags: [number, number][];
  firstPieceEnd: number;
  assistantEnd: number;
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
 * scaffolding. A bare word is a header only where a header can be: at the start
 * of a line or after a delimiter (`<|im_start|>user`, `### User:`), never after
 * a word or a comma (`obey only the user.`), where it is part of the sentence.
 * Longest match wins. Only strings with a letter or digit are
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
      node.bare = BARE_WORD.test(p);
    }
  }

  residue(text: string): Residue {
    const hit = this.cache.get(text);
    if (hit) return hit;
    const frags: [number, number][] = [];
    let firstPieceEnd = -1;
    let assistantEnd = -1;
    let segStart = 0;
    let i = 0;
    const n = text.length;
    while (i < n) {
      let matchEnd = -1;
      const u = text.charCodeAt(i);
      if (this.complete && (!isWordUnit(u) || i === 0 || !isWordUnit(text.charCodeAt(i - 1)))) {
        // Looked up only when a bare word ends here, so a run of spaces is
        // scanned once, by the word that follows it.
        let inSentence: boolean | undefined;
        let node: TrieNode | undefined = this.root;
        for (let j = i; j < n; ) {
          if (++this.work > MATCH_BUDGET) {
            this.complete = false;
            break;
          }
          node = node.next.get(text.charCodeAt(j));
          if (!node) break;
          j++;
          if (node.end && !(node.bare && (inSentence ??= afterProse(text, i))) && (!isWordUnit(text.charCodeAt(j - 1)) || j === n || !isWordUnit(text.charCodeAt(j)))) matchEnd = j;
        }
      }
      if (matchEnd > i) {
        pushFrag(text, segStart, i, frags);
        if (firstPieceEnd < 0) firstPieceEnd = matchEnd;
        if (ASSISTANT_ROLE.test(text.slice(i, matchEnd))) assistantEnd = matchEnd;
        i = matchEnd;
        segStart = i;
      } else i++;
    }
    pushFrag(text, segStart, n, frags);
    const r = { frags, firstPieceEnd, assistantEnd };
    if (this.cache.size < 100_000) this.cache.set(text, r);
    return r;
  }
}

const BARE_WORD = /^[\p{L}\p{N}_]+$/u;

// True when the text before `i` on its line, past spaces and tabs, ends in a
// word or in a comma or semicolon: a word at `i` continues a sentence.
function afterProse(text: string, i: number): boolean {
  let k = i - 1;
  while (k >= 0 && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k--;
  if (k < 0) return false;
  const u = text.charCodeAt(k);
  return isWordUnit(u) || u === 44 || u === 59;
}

function pushFrag(text: string, s: number, e: number, out: [number, number][]): void {
  while (s < e && /\s/.test(text[s]!)) s++;
  while (e > s && /\s/.test(text[e - 1]!)) e--;
  if (e > s && WORDISH.test(text.slice(s, e))) out.push([s, e]);
}

// ---- items ----

/**
 * The URLs and blobs only the printed text as a whole holds (ISC-19, ISC-20).
 * Literals printed one after another with no runtime text between them are one
 * text: `evil{{ '' }}.com`, `{{ 'evil' }}.com`, `http{{ ':' }}//`. A URL is
 * kept when it crosses a literal boundary, since one inside a literal is the
 * item scan's; a blob also when it lies in a folded literal (`'a' ~ 'b'`),
 * which the template-literal scan never sees. Either must touch injected text,
 * so joined scaffolding raises nothing. One render prints one arm of an `if`
 * or inline `if`, so each text a render may print is scanned on its own
 * (review round 3, runtime R3-3), and each URL and blob is reported once.
 */
export function joinedText(lits: Lit[], matcher: Scaffold): { urls: InjectedText[]; blobs: InjectedText[]; complete: boolean } {
  const urls: InjectedText[] = [];
  const blobs: InjectedText[] = [];
  const seen = new Set<string>();
  let budget = JOIN_BUDGET;
  let complete = true;
  let run: Lit[] = [];
  const push = (out: InjectedText[], t: InjectedText): void => {
    const key = `${out === urls ? "url" : "blob"}:${t.span.start}:${t.span.end}:${t.text}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  };
  // The literals of one render, in order.
  const scanRender = (way: Lit[]): void => {
    if (way.length === 0 || (way.length === 1 && !way[0]!.folded)) return;
    const offs: number[] = [];
    let text = "";
    for (const l of way) {
      offs.push(text.length);
      text += l.text;
    }
    const at = (p: number): number => {
      let lo = 0;
      let hi = offs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (offs[mid]! <= p) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    // The literals a match covers, when it touches residue in one of them.
    const covered = (s: number, e: number): [number, number] | undefined => {
      const i = at(s);
      const j = at(e - 1);
      for (let k = i; k <= j; k++) {
        const o = offs[k]!;
        if (matcher.residue(way[k]!.text).frags.some(([fs, fe]) => fs + o < e && fe + o > s)) return [i, j];
      }
      return undefined;
    };
    const item = (s: number, e: number, [i, j]: [number, number]): InjectedText => {
      let first = way[i]!.span;
      let end = first.end;
      for (let k = i; k <= j; k++) {
        const sp = way[k]!.span;
        if (sp.start < first.start) first = sp;
        end = Math.max(end, sp.end);
      }
      return { text: text.slice(s, e), span: { ...first, end }, afterGenerationPrompt: false };
    };
    scanUrls(text, 0, text.length, (s, e) => {
      const c = covered(s, e);
      if (c && c[0] !== c[1]) push(urls, item(s, e, c));
    });
    scanBlobs(text, 0, text.length, (s, e) => {
      const c = covered(s, e);
      if (c && (c[0] !== c[1] || way[c[0]]!.folded)) push(blobs, item(s, e, c));
    });
  };
  const scan = (): void => {
    if (run.length === 0 || (run.length === 1 && !run[0]!.folded)) return;
    // Past the budget, the run is read once in program order, and the result
    // is incomplete.
    const ways = renders(run, budget);
    if (!ways) complete = false;
    for (const way of ways ?? [run]) {
      for (const l of way) budget -= l.text.length;
      if (budget < 0) {
        complete = false;
        return;
      }
      scanRender(way);
    }
  };
  for (const l of lits) {
    if (l.brk) {
      scan();
      run = [];
    } else {
      run.push(l);
    }
  }
  scan();
  return { urls, blobs, complete };
}

// Option of a fork in a loop's body: both arms, in program order.
const BOTH: Frame = {};
// Renders of one run kept apart at once.
const MAX_RENDERS = 4096;

/**
 * The texts one render may print from a run of literals, each as the literals
 * it prints. A fork with literals on both arms in the run prints one arm; in a
 * loop's body it may also print both, on different passes. A fork with
 * literals on one arm only prints them, as before. Renders that print the same
 * text and choose alike for the literals still to come are one, so arms that
 * print the same text cost nothing. Undefined past `budget` characters or
 * MAX_RENDERS renders.
 */
function renders(run: Lit[], budget: number): Lit[][] | undefined {
  // The fork arms above each literal, outermost first.
  const chains = run.map((l) => {
    const out: Frame[] = [];
    for (let x = l.at; x; x = x.up) if (x.fork !== undefined) out.push(x);
    return out.reverse();
  });
  const armsOf = new Map<object, Set<Frame>>();
  for (const ch of chains) {
    for (const x of ch) {
      const set = armsOf.get(x.fork!) ?? new Set<Frame>();
      armsOf.set(x.fork!, set.add(x));
    }
  }
  // The forks whose arms both hold literals of the run, their options, and the
  // last literal under each.
  const options = new Map<object, Frame[]>();
  for (const [fork, set] of armsOf) {
    if (set.size < 2) continue;
    const [one] = set;
    let looped = false;
    for (let x = one!.up; x && !looped; x = x.up) looped = LOOP_BODIES.has(x);
    options.set(fork, looped ? [...set, BOTH] : [...set]);
  }
  if (options.size === 0) return [run];
  const marks = chains.map((ch) => ch.filter((x) => options.has(x.fork!)));
  const last = new Map<object, number>();
  marks.forEach((m, k) => m.forEach((x) => last.set(x.fork!, k)));
  // Numbers for forks and options, for literal texts, and for each text a
  // render has printed so far, built literal by literal.
  const objs = new Map<object, number>();
  const obj = (x: object): number => objs.get(x) ?? (objs.set(x, objs.size), objs.size - 1);
  const texts = new Map<string, number>();
  const textId = (t: string): number => texts.get(t) ?? (texts.set(t, texts.size), texts.size - 1);
  const litText = run.map((l) => textId(l.text));
  type Printed = { lit: Lit; before?: Printed };
  type Render = { pick: Map<object, Frame>; printed?: Printed; text: number; chars: number };
  let states: Render[] = [{ pick: new Map(), text: textId(""), chars: 0 }];
  for (let k = 0; k < run.length; k++) {
    const l = run[k]!;
    const out: Render[] = [];
    const place = (r: Render, i: number): void => {
      if (i === marks[k]!.length) {
        out.push({ pick: r.pick, printed: { lit: l, before: r.printed }, text: textId(`${r.text}:${litText[k]}`), chars: r.chars + l.text.length });
        return;
      }
      const x = marks[k]![i]!;
      const p = r.pick.get(x.fork!);
      if (p === x || p === BOTH) return place(r, i + 1);
      if (p !== undefined) return void out.push(r);
      for (const o of options.get(x.fork!)!) {
        const t = { ...r, pick: new Map(r.pick).set(x.fork!, o) };
        if (o === x || o === BOTH) place(t, i + 1);
        else out.push(t);
      }
    };
    for (const r of states) place(r, 0);
    // A choice no later literal depends on is dropped, and renders alike from
    // here on are merged.
    const merged = new Map<string, Render>();
    let chars = 0;
    for (const r of out) {
      for (const f of r.pick.keys()) if (last.get(f)! <= k) r.pick.delete(f);
      const key = `${r.text}|${[...r.pick].map(([f, o]) => `${obj(f)}:${obj(o)}`).sort().join(",")}`;
      if (merged.has(key)) continue;
      merged.set(key, r);
      chars += r.chars;
    }
    if (merged.size > MAX_RENDERS || chars > budget) return undefined;
    states = [...merged.values()];
  }
  return states.map((r) => {
    const lits: Lit[] = [];
    for (let p = r.printed; p; p = p.before) lits.push(p.lit);
    return lits.reverse();
  });
}

/**
 * Turn the ordered output literals into injected-text items. Residue after an
 * assistant header the prompt ends in is prefilled assistant text (ISC-17.2):
 * - The generation prompt's header is the first literal emitted in an
 *   `add_generation_prompt` branch. Residue after its first scaffolding match
 *   (a scripted `<think>` inside the header literal), and every literal
 *   emitted after it in program order, is prefill. A header with no
 *   scaffolding is its first line, up to its colon (`### Response:`). The
 *   branch's `else` is exclusive with it and is never after it.
 * - An assistant header left open: the last one in program order, whatever
 *   test gates it, that no token after it ends the turn or starts another.
 *   Every literal after it is prefill, except one in an arm exclusive with it.
 */
export function toItems(lits: Lit[], matcher: Scaffold): InjectedText[] {
  const items = new Map<string, InjectedText>();
  // Items some unrouted path reaches. A routed path only moves text that
  // reaches the output another way, so once a direct path is known the
  // routed ones do not count toward the item's condition.
  const direct = new Set<string>();
  const seen = new Set<number>();
  let after = false;
  const add = (l: Lit, frags: [number, number][], afterGen: boolean): void => {
    if (frags.length === 0) return;
    const text = l.text.slice(frags[0]![0], frags[frags.length - 1]![1]);
    const key = `${l.span.start}:${l.span.end}:${afterGen}:${text}`;
    const prev = items.get(key)?.condition as Cond | undefined;
    const routed = l.routed === true;
    let cond: Cond | undefined;
    if (!items.has(key) || (!routed && !direct.has(key))) cond = l.cond;
    else if (routed && direct.has(key)) cond = prev;
    else cond = strongest(prev, l.cond);
    if (!routed) direct.add(key);
    items.set(key, { text, span: l.span, condition: cond ? { span: cond.span, test: cond.test } : undefined, afterGenerationPrompt: afterGen });
  };
  const res = lits.map((l) => matcher.residue(l.text));
  const open = openHeader(lits, res);
  const openGen = open && lits[open.index]!.gen;
  const head = (open && lits[open.index]!.at) || ROOT;
  for (let i = 0; i < lits.length; i++) {
    const l = lits[i]!;
    const r = res[i]!;
    // The else of a generation-prompt branch never follows its header, but
    // an assistant header it leaves open is still open (review round 2).
    const genElse = l.genElse !== undefined && seen.has(l.genElse);
    // Residue from `cut` on is prefill.
    let cut = after && !genElse ? 0 : Infinity;
    if (!genElse && l.gen !== undefined && !seen.has(l.gen) && WORDISH.test(l.text)) {
      seen.add(l.gen);
      cut = Math.min(cut, headerEnd(l.text, r));
      after = true;
    }
    if (open && i === open.index) cut = Math.min(cut, open.at);
    else if (open && i > open.index && (openGen === undefined || l.genElse !== openGen) && !exclusive(head, l.at ?? ROOT)) cut = 0;
    const frags = splitAt(l.text, r.frags, cut);
    add(l, frags.filter((f) => f[0] < cut), false);
    add(l, frags.filter((f) => f[0] >= cut), true);
  }
  return [...items.values()];
}

// Where the generation prompt's header ends in its literal. The header is the
// first line with a letter or digit: up to its first scaffolding match when
// it has one (`<|im_start|>`), else up to its colon (`### Response:`) or its
// end. Text after the header is prefill, not more header (review round 2,
// contracts R11). A literal that names the assistant later keeps its first match:
// a line before that header (`Note: …`) is not the header.
function headerEnd(text: string, r: Residue): number {
  const start = text.search(WORDISH);
  if (start < 0) return text.length;
  const nl = text.indexOf("\n", start);
  const end = nl < 0 ? text.length : nl;
  if (r.firstPieceEnd >= 0 && (r.firstPieceEnd <= end || r.assistantEnd >= 0)) return r.firstPieceEnd;
  const colon = text.indexOf(":", start);
  return colon >= 0 && colon < end ? colon + 1 : end;
}

// A header with no scaffolding ends inside a residue run: split it there.
function splitAt(text: string, frags: [number, number][], cut: number): [number, number][] {
  if (!frags.some(([s, e]) => s < cut && cut < e)) return frags;
  const out: [number, number][] = [];
  for (const [s, e] of frags) {
    if (s < cut && cut < e) {
      pushFrag(text, s, cut, out);
      pushFrag(text, cut, e, out);
    } else out.push([s, e]);
  }
  return out;
}

// A token-shaped string, and the names that end a turn or start another
// (`<|im_end|>`, `<end_of_turn>`, `<|eot_id|>`, `<turn|>`, `<|im_start|>`,
// `<|start_header_id|>`, `<|user|>`). `<|end_header_id|>` and
// `<|end_of_role|>` close a role name, not a turn.
const TOKEN = /<\/s>|<[^<>\s]{1,48}>/gu;
const TURN_EDGE = /end|eot|eos|eom|return|start|turn|user|system|human|observation/i;

function closesTurn(text: string): boolean {
  for (const m of text.matchAll(TOKEN)) {
    const t = m[0];
    if (t === "</s>") return true;
    if (/header|role/i.test(t) && !/start/i.test(t)) continue;
    if (TURN_EDGE.test(t)) return true;
  }
  return false;
}

// The last assistant header in program order that no token after it closes,
// and where it ends. A closer counts only when every path through the header
// prints it: in the header's block or one holding it, never under a test
// after the header, in a loop that may not run, or in an arm exclusive with
// the header (review round 2, security N4). A header such a closer leaves open
// is not hidden by a later one either.
function openHeader(lits: Lit[], res: Residue[]): { index: number; at: number } | undefined {
  const closed = new Set<Frame>();
  // The first arm of each fork found closed. A closer on both arms closes the
  // block holding them (review round 2, security N4).
  const half = new Map<object, Frame>();
  const close = (f: Frame): void => {
    for (let x: Frame | undefined = f; x && !closed.has(x); x = x.up) {
      closed.add(x);
      if (x.fork === undefined) return;
      if (!half.has(x.fork)) {
        half.set(x.fork, x);
        return;
      }
    }
  };
  for (let i = lits.length - 1; i >= 0; i--) {
    const text = lits[i]!.text;
    const where = lits[i]!.at ?? ROOT;
    const at = res[i]!.assistantEnd;
    if (at >= 0 && !closesTurn(text.slice(at)) && !heldBy(where, closed)) return { index: i, at };
    if (closesTurn(text)) {
      close(where);
      if (closed.has(ROOT)) return undefined;
    }
  }
  return undefined;
}

// ---- blocks ----

const ROOT: Frame = {};

// Each loop's body. A fork in one may take both its arms in one render, on
// different passes.
const LOOP_BODIES = new WeakSet<Frame>();

// The two arms of one `if`, loop or inline `if`, below `up`.
function arms(up: Frame | undefined): [Frame, Frame] {
  const fork = {};
  return [
    { up: up ?? ROOT, fork },
    { up: up ?? ROOT, fork },
  ];
}

// True when `outer` is `f` or a block holding it.
function encloses(outer: Frame, f: Frame): boolean {
  for (let x: Frame | undefined = f; x; x = x.up) if (x === outer) return true;
  return false;
}

function heldBy(f: Frame, outers: ReadonlySet<Frame>): boolean {
  for (let x: Frame | undefined = f; x; x = x.up) if (outers.has(x)) return true;
  return false;
}

// Where a literal made in `made` lands when printed in `here`: the deeper of
// the two when one holds the other. Otherwise both blocks' tests stand
// between it and the output, so it is in a block of its own below `here`.
function placed(made: Frame | undefined, here: Frame): Frame {
  if (!made || encloses(made, here)) return here;
  if (encloses(here, made)) return made;
  return { up: here };
}

// The block of one literal a value holds, made in `a` on some paths and in `b`
// on others: the block both arms of one fork make up, the outer of the two,
// or else a block of its own where they meet. Unset is outside every block.
function either(a: Frame | undefined, b: Frame | undefined): Frame | undefined {
  if (a === b || !a || !b) return a === b ? a : undefined;
  if (encloses(a, b)) return a;
  if (encloses(b, a)) return b;
  if (a.fork !== undefined && a.fork === b.fork) return a.up;
  const up = new Set<Frame>();
  for (let x: Frame | undefined = a; x; x = x.up) up.add(x);
  let meet: Frame | undefined = b;
  while (meet && !up.has(meet)) meet = meet.up;
  return { up: meet ?? ROOT };
}

// `v` as one arm left it: each literal is printed only in `arm`.
function inArm(v: Val, arm: Frame): Val {
  const mark = (l: Lit): Lit => ({ ...l, at: placed(l.at, arm) });
  return { ...v, lits: v.lits.map(mark), keys: v.keys?.map(mark) };
}

// True when no render prints in both blocks: they part at two arms of one fork.
function exclusive(a: Frame, b: Frame): boolean {
  const toward = new Map<Frame, Frame | undefined>();
  let from: Frame | undefined;
  for (let x: Frame | undefined = a; x; from = x, x = x.up) toward.set(x, from);
  from = undefined;
  for (let x: Frame | undefined = b; x; from = x, x = x.up) {
    if (!toward.has(x)) continue;
    const other = toward.get(x);
    return other?.fork !== undefined && other.fork === from?.fork;
  }
  return false;
}

