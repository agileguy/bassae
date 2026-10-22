// ISC-12, ISC-12.1, ISC-12.2 — coverage failures.
//
// A template @huggingface/jinja cannot parse is HIGH unanalyzable (ISC-12),
// unless it is known-good. Statements it rejects outright surface as a parse
// error whose message names the construct (ISC-12.1 for `{% with %}`, and
// ISC-12.2 for anything Python jinja2 accepts but the library does not). Filters
// and tests it parses but does not implement are reported from the ParseOutcome.

import type { Finding, Severity } from "../types.ts";
import { type ParseOutcome, WHOLE_TEMPLATE } from "../parse/parse.ts";

type Base = Pick<Finding, "file" | "templateName" | "templateSha256">;

// Pull the offending keyword out of the library's parse-error text, e.g.
// "Unknown statement type: with" -> "with".
function namedConstruct(message: string): string | undefined {
  const m = /Unknown statement type: (\w+)|Unknown statement, got (\w+)|Unexpected (?:token|character): (\S+)/.exec(message);
  return m?.[1] ?? m?.[2] ?? m?.[3];
}

export function runUnanalyzable(outcome: ParseOutcome, knownGood: boolean, base: Base, text: string): Finding[] {
  const findings: Finding[] = [];

  const mk = (severity: Severity, message: string, span?: Finding["span"]): Finding => ({
    ruleId: "unanalyzable",
    severity,
    message,
    ...base,
    span,
  });

  if (outcome.parseError || outcome.tooLarge) {
    if (!knownGood) {
      const named = outcome.parseError ? namedConstruct(outcome.parseError) : undefined;
      // Point at the named construct in the raw text when we can find it, and
      // at where a size or shape cap tripped (M5, ISC-26.1). The library's own
      // parse errors carry no position ("Unexpected token: CloseExpression",
      // "Unexpected end of input"), so one with no locatable construct is the
      // whole-template case.
      const tok = named && outcome.pre ? outcome.pre.tokens.find((t) => t.type === "identifier" && t.value === named) : undefined;
      const span = tok && outcome.lines ? outcome.lines.span(tok.start, tok.end) : (outcome.capAt ?? { ...WHOLE_TEMPLATE });
      // Carry the real reason for a size/shape cap, not a generic blurb (item D):
      // parseError holds e.g. "whitespace run of 5000 exceeds the parse limit".
      const detail = outcome.tooLarge
        ? (outcome.parseError ?? "template too large to parse in-process")
        : named
          ? `@huggingface/jinja cannot parse this template (construct: ${named})`
          : `@huggingface/jinja cannot parse this template: ${outcome.parseError}`;
      const f = mk("HIGH", detail, span);
      if (span && span.end > span.start && span === outcome.capAt) f.excerpt = text.slice(span.start, span.end);
      findings.push(f);
    }
    return findings;
  }

  // Parsed, but uses constructs the library does not implement (ISC-12.1).
  for (const u of outcome.unsupported) {
    const what = u.form ? `'${u.name}' (${u.form})` : `'${u.name}'`;
    const f = mk(u.severity, `unsupported ${u.kind} ${what} ${u.reason ?? "is not implemented by @huggingface/jinja"}`, u.span);
    if (u.span) f.excerpt = text.slice(u.span.start, u.span.end);
    findings.push(f);
  }
  return findings;
}
