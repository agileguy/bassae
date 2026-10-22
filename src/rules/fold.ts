// ISC-14 — constant folding of obfuscated dunder names. A dunder assembled at
// parse time from literals — via `~`, `*`, `|join`, `|replace`, `|reverse`,
// slicing or escapes — is as dangerous as writing `__class__` out, and has no
// benign use, so we flag any composite expression that folds to one wherever it
// appears. Exec-surface names are deliberately NOT flagged here (a folded
// `'system'` or `'open a ticket'` is only dangerous in a callable/attribute
// position; that is handled position-aware in codeexec.ts — ISC-16, item 9).

import type { Finding, Span } from "../types.ts";
import { children, firstLeafSpan, foldLiteral, hasDunder, type Node } from "../parse/support.ts";
import type { RuleCtx } from "./codeexec.ts";

// Node kinds worth folding: a bare StringLiteral is not obfuscation, so we only
// look at expressions that actually combine or transform pieces.
const COMPOSITE = new Set(["BinaryExpression", "FilterExpression", "MemberExpression", "ArrayLiteral", "TupleLiteral"]);

export function runFold(ctx: RuleCtx): Finding[] {
  const { outcome } = ctx;
  if (!outcome.program) return [];
  const findings: Finding[] = [];

  const stack: unknown[] = [outcome.program];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const c of node) stack.push(c);
      continue;
    }
    const n = node as Node;
    if (COMPOSITE.has(n.type)) {
      const folded = foldLiteral(n);
      if (typeof folded === "string" && hasDunder(folded) && !ctx.scaffolding.has(folded)) {
        const span: Span | undefined = outcome.spans.get(n) ?? firstLeafSpan(n, outcome.spans);
        findings.push({
          ruleId: "folded_dunder",
          severity: "HIGH",
          message: `literal expression folds to a dunder '${folded}'`,
          file: ctx.file,
          templateName: ctx.templateName,
          templateSha256: ctx.templateSha256,
          span,
          excerpt: span ? ctx.text.slice(span.start, span.end) : undefined,
          detail: { folded },
        });
        continue; // don't also flag the nested pieces
      }
    }
    for (const c of children(n)) stack.push(c);
  }
  return findings;
}
