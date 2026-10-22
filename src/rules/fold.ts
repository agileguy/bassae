// ISC-14 — constant folding. A dunder (or exec surface) assembled at parse time
// from literals, via `~`, `|join`, `|replace`, slicing or escapes, is as
// dangerous as writing it out. We fold literal-only composite expressions and
// flag any that resolve to one.

import type { Finding, Span } from "../types.ts";
import { foldLiteral, hasDunder, hasExecSurface, type Node } from "../parse/support.ts";
import type { RuleCtx } from "./codeexec.ts";

// Node kinds worth folding: a bare StringLiteral is not obfuscation, so we only
// look at expressions that actually combine or transform pieces.
const COMPOSITE = new Set(["BinaryExpression", "FilterExpression", "MemberExpression", "ArrayLiteral", "TupleLiteral"]);

export function runFold(ctx: RuleCtx): Finding[] {
  const { outcome } = ctx;
  if (!outcome.program) return [];
  const findings: Finding[] = [];

  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const c of node) visit(c);
      return;
    }
    const n = node as Node;
    if (COMPOSITE.has(n.type)) {
      const folded = foldLiteral(n);
      if (typeof folded === "string" && (hasDunder(folded) || hasExecSurface(folded))) {
        const span: Span | undefined = outcome.spans.get(n) ?? firstLeafSpan(n, outcome.spans);
        findings.push({
          ruleId: "folded_dunder",
          severity: "HIGH",
          message: `literal expression folds to '${folded}'`,
          file: ctx.file,
          templateName: ctx.templateName,
          templateSha256: ctx.sha256,
          span,
          excerpt: span ? ctx.text.slice(span.start, span.end) : undefined,
          detail: { folded },
        });
        return; // don't also flag the nested pieces
      }
    }
    for (const v of Object.values(n)) visit(v);
  };

  visit(outcome.program);
  return findings;
}

// A composite node has no span of its own; point at its first leaf.
function firstLeafSpan(node: Node, spans: Map<Node, Span>): Span | undefined {
  let found: Span | undefined;
  const visit = (x: unknown): void => {
    if (found || !x || typeof x !== "object") return;
    if (Array.isArray(x)) {
      for (const c of x) visit(c);
      return;
    }
    const n = x as Node;
    const s = spans.get(n);
    if (s) {
      found = s;
      return;
    }
    for (const v of Object.values(n)) visit(v);
  };
  visit(node);
  return found;
}
