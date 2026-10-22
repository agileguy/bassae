// AST code-execution rules: ISC-13, ISC-13.1, ISC-14.1, ISC-15, ISC-15.1,
// ISC-16. One source-order walk over the parsed program, with an explicit stack
// so a deep AST cannot overflow (ISC-31). Spans come from the pre-lexer
// correlation in the ParseOutcome.

import type { Finding, Span } from "../types.ts";
import type { ParseOutcome } from "../parse/parse.ts";
import {
  ENGINE_GLOBALS,
  ENGINE_PROBE_TESTS,
  EXEC_SURFACES,
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
  bound: Set<string>;
  /** Literals that count as scaffolding (special tokens, role names, delimiters); never a finding (ISC-14). */
  scaffolding: ReadonlySet<string>;
  file: string;
  templateName: string;
  sha256: string;
}

// Filters whose `attribute=` keyword (or, for selectattr/rejectattr, whose first
// positional argument) names an attribute path to traverse by name (ISC-14.1).
const ATTR_KEYWORD_FILTERS = new Set(["map", "sort", "unique", "groupby", "sum", "min", "max", "dictsort"]);
const ATTR_POSITIONAL_FILTERS = new Set(["selectattr", "rejectattr"]);

function excerpt(ctx: RuleCtx, span: Span | undefined): string | undefined {
  return span ? ctx.text.slice(span.start, span.end) : undefined;
}

// The Identifier a member chain hangs off, as a node (for its span).
function baseIdentifier(node: Node): Node | undefined {
  let cur: Node | undefined = node;
  while (cur && cur.type === "MemberExpression") cur = cur.object as Node;
  return cur && cur.type === "Identifier" ? cur : undefined;
}

export function runCodeExec(ctx: RuleCtx): Finding[] {
  const { outcome } = ctx;
  if (!outcome.program) return [];
  const findings: Finding[] = [];
  const aliases = gadgetAliases(outcome.program as Node);
  const spanOf = (n: Node | undefined): Span | undefined => (n ? outcome.spans.get(n) : undefined);

  const add = (ruleId: Finding["ruleId"], message: string, node: Node | undefined, span?: Span): void => {
    const s = span ?? spanOf(node);
    findings.push({
      ruleId,
      severity: "HIGH",
      message,
      file: ctx.file,
      templateName: ctx.templateName,
      templateSha256: ctx.sha256,
      span: s,
      excerpt: excerpt(ctx, s),
    });
  };

  // The attribute name a member chain's call reaches, as a node + resolved name.
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
    // Dotted (.popen) or literal-subscript (['popen']) callee property alike.
    const name = prop.type === "Identifier" ? String(prop.value) : resolveKey(prop).value;
    if (name !== undefined && isExecName(name)) {
      add("exec_surface", `call to OS/exec surface '${name}'`, prop);
    }
    if (name === "format") {
      const obj = callee.object as Node;
      if (obj.type === "StringLiteral") add("format_traversal", "str.format() enables format-spec attribute traversal", prop);
      else add("dynamic_attribute", ".format() reaches attributes by name", prop);
    }
  };

  // A map()/selectattr()/... call's attribute argument (ISC-14.1).
  const checkAttrArg = (filter: Node): void => {
    if (filter.type !== "CallExpression") return;
    const name = String((filter.callee as Node).value);
    const args = filter.args as Node[];
    let attr: Node | undefined;
    if (ATTR_POSITIONAL_FILTERS.has(name)) {
      attr = args.filter((a) => a.type !== "KeywordArgumentExpression")[0];
    } else if (ATTR_KEYWORD_FILTERS.has(name)) {
      const kw = args.find((a) => a.type === "KeywordArgumentExpression" && String((a.key as Node).value) === "attribute");
      attr = kw ? (kw.value as Node) : undefined;
    }
    if (!attr) return;
    if (attr.type !== "StringLiteral") {
      add("dynamic_attribute", `non-literal attribute= argument to '${name}' reaches attributes by name`, attr);
      return;
    }
    // A literal dotted path: any segment naming an exec surface is ISC-16.
    for (const seg of String(attr.value).split(".")) {
      if (isExecName(seg)) add("exec_surface", `attribute= path names OS/exec surface '${seg}'`, attr);
    }
  };

  const stack: unknown[] = [outcome.program];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
      continue;
    }
    const n = node as Node;

    if (n.type === "MemberExpression") {
      const prop = n.property as Node;
      const obj = n.object as Node;
      let dunderHit = false;

      // ISC-13 — dunder attribute access, dot or subscript. A plain string-
      // literal key (x['__class__']) is left to the string-literal catch-all in
      // index.ts; here we fold ASSEMBLED keys ('_'*2 ~ 'class' ~ '_'*2).
      if (prop.type === "Identifier" && hasDunder(String(prop.value))) {
        add("dunder_access", `dunder attribute '${String(prop.value)}'`, prop);
        dunderHit = true;
      } else if (n.computed && prop.type !== "StringLiteral") {
        const key = resolveKey(prop);
        if (key.value !== undefined && hasDunder(key.value)) {
          add("dunder_access", `dunder attribute via subscript '${key.value}'`, prop);
          dunderHit = true;
        }
      }

      // ISC-15 — attribute or subscript directly on an engine gadget or an alias of one.
      if (obj.type === "Identifier" && aliases.has(String(obj.value))) {
        add("gadget_traversal", `traversal on engine gadget '${String(obj.value)}'`, obj);
      }

      // ISC-14.1 — a computed key that reaches an attribute by name.
      if (!dunderHit && n.computed) {
        const key = resolveKey(prop);
        if (key.built) {
          // Assembled by a string operation: the carve-out never applies.
          add("dynamic_attribute", "subscript key built by a string operation", prop, spanOf(prop) ?? spanOf(obj));
        } else if (!isDataObject(n, ctx.bound)) {
          // Not runtime data: a non-literal (non-index) key is ISC-14.1.
          const literalIndex = key.value !== undefined || typeof foldLiteral(prop) === "number";
          if (!literalIndex) {
            add("dynamic_attribute", "subscript with a non-literal key on a non-runtime object", prop, spanOf(obj) ?? spanOf(prop));
          }
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
