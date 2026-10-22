// AST code-execution rules: ISC-13, ISC-13.1, ISC-14.1, ISC-15, ISC-15.1,
// ISC-16. One source-order walk over the parsed program, with an explicit stack
// so a deep AST cannot overflow (ISC-31). Spans come from the pre-lexer
// correlation in the ParseOutcome; a composite node falls back to its first leaf
// so no HIGH finding is ever span-less (ISC-26.1).

import type { Finding, Span } from "../types.ts";
import type { ParseOutcome } from "../parse/parse.ts";
import {
  type BindingEnv,
  ENGINE_GLOBALS,
  ENGINE_PROBE_TESTS,
  EXEC_SURFACES,
  firstLeafSpan,
  gadgetAliases,
  hasDunder,
  isDataObject,
  isExecName,
  foldLiteral,
  resolveKey,
  type Node,
} from "../parse/support.ts";

export interface RuleCtx {
  outcome: ParseOutcome;
  text: string;
  /** What every local name (and `ns.attr` slot) is bound to, for the ISC-14.1 carve-out. */
  env: BindingEnv;
  /** Literals that count as scaffolding (special tokens, role names, delimiters); never a finding (ISC-14). */
  scaffolding: ReadonlySet<string>;
  file: string;
  templateName: string;
  sha256: string;
}

// Filters whose `attribute=` keyword names an attribute path to traverse (ISC-14.1).
const ATTR_KEYWORD_FILTERS = new Set(["map", "sort", "unique", "groupby", "sum", "min", "max", "dictsort"]);

// Filters that take the attribute path as a POSITIONAL argument, and the index
// of that argument among the positional (non-keyword) arguments. jinja2 3.1
// signatures: sort(value, reverse, case_sensitive, attribute) -> 2 (the piped
// value is the operand, not an argument); unique/min/max(value, case_sensitive,
// attribute) -> 1; groupby(value, attribute, ...) and sum(iterable, attribute,
// ...) -> 0; selectattr/rejectattr(value, attr, ...) -> 0. The library renders a
// positional attribute, so `messages|sort(false, false, ns.k)` must be caught
// exactly as the `attribute=` form is (M3).
const ATTR_POSITIONAL_INDEX: Record<string, number> = {
  selectattr: 0,
  rejectattr: 0,
  groupby: 0,
  sum: 0,
  unique: 1,
  min: 1,
  max: 1,
  sort: 2,
};

// Engine gadgets that the library DOES provide, so a bare reference parses: using
// one as a value (not calling it) hands out a handle whose `__globals__` reaches
// `os` (ISC-15, M2). cycler/joiner/lipsum/self are caught earlier, at parse.
const GADGET_VALUE_HANDLES = new Set(["namespace", "dict"]);

export function runCodeExec(ctx: RuleCtx): Finding[] {
  const { outcome, env } = ctx;
  if (!outcome.program) return [];
  const program = outcome.program as Node;
  const findings: Finding[] = [];
  const aliases = gadgetAliases(program);
  const spanOf = (n: Node | undefined): Span | undefined => (n ? outcome.spans.get(n) : undefined);

  const add = (ruleId: Finding["ruleId"], message: string, node: Node | undefined, span?: Span): void => {
    const s = span ?? spanOf(node) ?? (node ? firstLeafSpan(node, outcome.spans) : undefined);
    findings.push({
      ruleId,
      severity: "HIGH",
      message,
      file: ctx.file,
      templateName: ctx.templateName,
      templateSha256: ctx.sha256,
      span: s,
      excerpt: s ? ctx.text.slice(s.start, s.end) : undefined,
    });
  };

  // Gadget-handle identifiers that are NOT value uses: a call callee
  // (`namespace(x=1)`), a member object (handled by the gadget-traversal branch),
  // a member property name, or a keyword-argument key. Everything else that
  // references `namespace`/`dict` is a value use (M2 fix 2).
  const excusedGadget = new Set<Node>();
  {
    const s: unknown[] = [program];
    while (s.length) {
      const node = s.pop();
      if (!node || typeof node !== "object") continue;
      if (Array.isArray(node)) {
        for (const c of node) s.push(c);
        continue;
      }
      const nn = node as Node;
      const mark = (x: Node | undefined): void => {
        if (x?.type === "Identifier" && GADGET_VALUE_HANDLES.has(String(x.value))) excusedGadget.add(x);
      };
      if (nn.type === "CallExpression") mark(nn.callee as Node);
      if (nn.type === "MemberExpression") {
        mark(nn.object as Node);
        if (!nn.computed) mark(nn.property as Node);
      }
      if (nn.type === "KeywordArgumentExpression") mark(nn.key as Node);
      for (const v of Object.values(nn)) s.push(v);
    }
  }

  // An OS/exec surface or str.format() in a callable position (ISC-16 / ISC-13.1).
  const checkExecCall = (callee: Node): void => {
    if (callee.type === "Identifier" && EXEC_SURFACES.has(String(callee.value))) {
      add("exec_surface", `call to OS/exec surface '${String(callee.value)}'`, callee);
      return;
    }
    if (callee.type !== "MemberExpression") return;
    const base = baseIdentifier(callee);
    if (base && EXEC_SURFACES.has(String(base.value))) {
      add("exec_surface", `call rooted at OS/exec surface '${String(base.value)}'`, base);
    }
    const prop = callee.property as Node;
    // Dotted (.popen) or literal/assembled subscript (['popen']) callee property.
    const name = prop.type === "Identifier" ? String(prop.value) : resolveKey(prop, env).value;
    if (name !== undefined && isExecName(name)) {
      add("exec_surface", `call to OS/exec surface '${name}'`, prop);
    }
    if (name === "format") {
      const obj = callee.object as Node;
      if (obj.type === "StringLiteral") add("format_traversal", "str.format() enables format-spec attribute traversal", prop);
      else add("dynamic_attribute", ".format() reaches attributes by name", prop);
    }
  };

  // A map()/sort()/selectattr()/... call's attribute argument, keyword or
  // positional (ISC-14.1, M3).
  const classifyAttr = (name: string, attr: Node): void => {
    const rk = resolveKey(attr, env);
    if (rk.value !== undefined) {
      // Folds to a path: any segment that names a dunder or an exec surface is
      // the specific finding; an assembled but otherwise benign path is dynamic.
      let flagged = false;
      for (const seg of rk.value.split(".")) {
        if (hasDunder(seg)) {
          add("dunder_access", `attribute path names dunder '${seg}'`, attr);
          flagged = true;
        }
        if (isExecName(seg)) {
          add("exec_surface", `attribute path names OS/exec surface '${seg}'`, attr);
          flagged = true;
        }
      }
      if (!flagged && rk.built) add("dynamic_attribute", `attribute argument to '${name}' is built by a string operation`, attr);
      return;
    }
    // Anything not a plain string literal reaches an attribute by a name we
    // cannot pin down.
    if (attr.type !== "StringLiteral") add("dynamic_attribute", `non-literal attribute argument to '${name}' reaches attributes by name`, attr);
  };

  const checkAttrArg = (filter: Node): void => {
    if (filter.type !== "CallExpression") return;
    const name = String((filter.callee as Node).value);
    const args = filter.args as Node[];
    const kw = args.find((a) => a.type === "KeywordArgumentExpression" && String((a.key as Node).value) === "attribute");
    if (kw && ATTR_KEYWORD_FILTERS.has(name)) {
      classifyAttr(name, kw.value as Node);
      return;
    }
    if (name in ATTR_POSITIONAL_INDEX) {
      const positionals = args.filter((a) => a.type !== "KeywordArgumentExpression");
      const attr = positionals[ATTR_POSITIONAL_INDEX[name]!];
      if (attr) classifyAttr(name, attr);
    }
  };

  const stack: unknown[] = [program];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
      continue;
    }
    const n = node as Node;

    // ISC-15, M2 fix 2 — a bare gadget handle used as a value.
    if (n.type === "Identifier" && GADGET_VALUE_HANDLES.has(String(n.value)) && !excusedGadget.has(n)) {
      add("gadget_traversal", `engine gadget '${String(n.value)}' used as a value`, n);
    }

    if (n.type === "MemberExpression") {
      const prop = n.property as Node;
      const obj = n.object as Node;
      let dunderHit = false;

      // ISC-13 — dunder attribute access, dot or subscript. A plain string-
      // literal key (x['__class__']) is left to the string-literal catch-all in
      // index.ts; here we fold ASSEMBLED keys ('_'*2 ~ 'class' ~ '_'*2, keys
      // carried across `set` statements, string-method results).
      if (prop.type === "Identifier" && hasDunder(String(prop.value))) {
        add("dunder_access", `dunder attribute '${String(prop.value)}'`, prop);
        dunderHit = true;
      } else if (n.computed && prop.type !== "StringLiteral") {
        const key = resolveKey(prop, env);
        if (key.value !== undefined && hasDunder(key.value)) {
          add("dunder_access", `dunder attribute via subscript '${key.value}'`, prop);
          dunderHit = true;
        }
      }

      // ISC-15 — attribute or subscript directly on an engine gadget or an alias.
      if (obj.type === "Identifier" && aliases.has(String(obj.value))) {
        add("gadget_traversal", `traversal on engine gadget '${String(obj.value)}'`, obj);
      }

      // ISC-14.1 — a computed key that reaches an attribute by name. The key is
      // exempt only when it is provably runtime data: not assembled, and either a
      // literal index or a reference whose object root is runtime data.
      if (!dunderHit && n.computed) {
        const key = resolveKey(prop, env);
        if (key.built) {
          add("dynamic_attribute", "subscript key built by a string operation", prop);
        } else if (!isDataObject(n, env)) {
          const literalIndex = key.value !== undefined || typeof foldLiteral(prop, 0, env) === "number";
          if (!literalIndex) add("dynamic_attribute", "subscript with a non-literal key on a non-runtime object", prop);
        }
      }
    }

    // ISC-16 / ISC-13.1 — OS/exec surface or str.format() in a callable position.
    if (n.type === "CallExpression") checkExecCall(n.callee as Node);

    if (n.type === "FilterExpression" || n.type === "FilterStatement") {
      const filter = n.filter as Node;
      const id = filter.type === "CallExpression" ? (filter.callee as Node) : filter;
      const name = String(id.value);
      // ISC-14.1 — |attr and |format reach attributes dynamically.
      if (name === "attr" || name === "format") add("dynamic_attribute", `'|${name}' reaches attributes by name`, id);
      checkAttrArg(filter);
      // ISC-15.1 — select('filter') and friends run the engine-probe test by name.
      if (filter.type === "CallExpression") {
        const positional = (filter.args as Node[]).filter((a) => a.type !== "KeywordArgumentExpression");
        const arg = name === "select" || name === "reject" ? positional[0] : name === "selectattr" || name === "rejectattr" ? positional[1] : undefined;
        if (arg?.type === "StringLiteral" && ENGINE_PROBE_TESTS.has(String(arg.value))) {
          add("engine_fingerprint", `${name}('${String(arg.value)}') asks the engine whether a ${String(arg.value)} exists`, arg);
        }
      }
    }

    // ISC-15.1 — `is defined` / `is undefined` on an engine global, and `is filter` / `is test`.
    if (n.type === "TestExpression") {
      const test = String((n.test as Node).value);
      const operand = n.operand as Node;
      if (ENGINE_PROBE_TESTS.has(test)) {
        add("engine_fingerprint", `'is ${test}' asks the engine whether a ${test} exists`, n.test as Node);
      }
      if ((test === "defined" || test === "undefined") && operand.type === "Identifier" && ENGINE_GLOBALS.has(String(operand.value))) {
        add("engine_fingerprint", `tests engine global '${String(operand.value)}' with 'is ${test}'`, operand);
      }
    }

    for (const v of Object.values(n)) stack.push(v);
  }
  return findings;
}

// The Identifier a member chain hangs off, as a node (for its span).
function baseIdentifier(node: Node): Node | undefined {
  let cur: Node | undefined = node;
  while (cur && cur.type === "MemberExpression") cur = cur.object as Node;
  return cur && cur.type === "Identifier" ? cur : undefined;
}
