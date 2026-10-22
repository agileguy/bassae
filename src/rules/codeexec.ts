// AST code-execution rules: ISC-13, ISC-13.1, ISC-14.1, ISC-15, ISC-15.1,
// ISC-16. One source-order walk over the parsed program. Spans come from the
// pre-lexer correlation in the ParseOutcome.

import type { Finding, Span } from "../types.ts";
import type { ParseOutcome } from "../parse/parse.ts";
import {
  ENGINE_GLOBALS,
  EXEC_SURFACES,
  GADGETS,
  hasDunder,
  isDataObject,
  foldLiteral,
  type Node,
} from "../parse/support.ts";

export interface RuleCtx {
  outcome: ParseOutcome;
  text: string;
  bound: Set<string>;
  file: string;
  templateName: string;
  sha256: string;
}

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

  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const c of node) visit(c);
      return;
    }
    const n = node as Node;

    // ISC-13 — dunder attribute access, dot or subscript.
    if (n.type === "MemberExpression") {
      const prop = n.property as Node;
      let dunderHit = false;
      if (prop.type === "Identifier" && hasDunder(String(prop.value))) {
        add("dunder_access", `dunder attribute '${String(prop.value)}'`, prop);
        dunderHit = true;
      } else if (n.computed) {
        const folded = foldLiteral(prop);
        if (typeof folded === "string" && hasDunder(folded)) {
          add("dunder_access", `dunder attribute via subscript '${folded}'`, prop);
          dunderHit = true;
        }
      }

      // ISC-15 — attribute or subscript directly on an engine gadget.
      const obj = n.object as Node;
      if (obj.type === "Identifier" && GADGETS.has(String(obj.value))) {
        add("gadget_traversal", `traversal on engine gadget '${String(obj.value)}'`, obj);
      }

      // ISC-14.1 — computed key that is neither a literal nor on a runtime-data object.
      if (!dunderHit && n.computed) {
        const folded = foldLiteral(n.property);
        const literalKey = folded !== undefined && !Array.isArray(folded);
        if (!literalKey && !isDataObject(n, ctx.bound)) {
          add("dynamic_attribute", "subscript with a non-literal key on a non-runtime object", n.property as Node, spanOf(n.object as Node) ?? spanOf(n.property as Node));
        }
      }
    }

    // ISC-16 — OS/exec surface in a callable position. The surface may be the
    // callee itself (system(...)), the chain root (subprocess.run(...)) or the
    // called member (x.popen(...)).
    if (n.type === "CallExpression") {
      const callee = n.callee as Node;
      if (callee.type === "Identifier" && EXEC_SURFACES.has(String(callee.value))) {
        add("exec_surface", `call to OS/exec surface '${String(callee.value)}'`, callee);
      } else if (callee.type === "MemberExpression") {
        const base = baseIdentifier(callee);
        if (base && EXEC_SURFACES.has(String(base.value))) {
          add("exec_surface", `call rooted at OS/exec surface '${String(base.value)}'`, base);
        }
        const prop = callee.property as Node;
        if (prop.type === "Identifier" && EXEC_SURFACES.has(String(prop.value))) {
          add("exec_surface", `call to OS/exec surface '.${String(prop.value)}'`, prop);
        }
        // ISC-13.1 — str.format() format-spec traversal / ISC-14.1 — .format( on any object.
        if (prop.type === "Identifier" && String(prop.value) === "format") {
          const obj = callee.object as Node;
          if (obj.type === "StringLiteral") add("format_traversal", "str.format() enables format-spec attribute traversal", prop);
          else add("dynamic_attribute", ".format() reaches attributes by name", prop);
        }
      }
    }

    // ISC-14.1 — |attr and |format reach attributes dynamically.
    if (n.type === "FilterExpression" || n.type === "FilterStatement") {
      const filter = n.filter as Node;
      const id = filter.type === "CallExpression" ? (filter.callee as Node) : filter;
      const name = String(id.value);
      if (name === "attr" || name === "format") {
        add("dynamic_attribute", `'|${name}' reaches attributes by name`, id);
      }
    }

    // ISC-15.1 — `is defined` / `is undefined` on an engine global.
    if (n.type === "TestExpression") {
      const test = String((n.test as Node).value);
      const operand = n.operand as Node;
      if ((test === "defined" || test === "undefined") && operand.type === "Identifier" && ENGINE_GLOBALS.has(String(operand.value))) {
        findings.push({
          ruleId: "engine_fingerprint",
          severity: "HIGH",
          message: `tests engine global '${String(operand.value)}' with 'is ${test}'`,
          file: ctx.file,
          templateName: ctx.templateName,
          templateSha256: ctx.sha256,
          span: spanOf(operand),
          excerpt: excerpt(ctx, spanOf(operand)),
        });
      }
    }

    for (const v of Object.values(n)) visit(v);
  };

  visit(outcome.program);
  return findings;
}
