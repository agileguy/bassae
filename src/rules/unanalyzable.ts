// ISC-12, ISC-12.1, ISC-12.2 — coverage failures.
//
// A template @huggingface/jinja cannot parse is HIGH unanalyzable (ISC-12),
// unless it is known-good. Statements it rejects outright surface as a parse
// error whose message names the construct (ISC-12.1 for `{% with %}`, and
// ISC-12.2 for anything Python jinja2 accepts but the library does not). Filters
// and tests it parses but does not implement are reported from the ParseOutcome.

import type { Finding, Severity } from "../types.ts";
import type { ParseOutcome } from "../parse/parse.ts";

interface Base {
  file: string;
  templateName: string;
  sha256: string;
}

// Pull the offending keyword out of the library's parse-error text, e.g.
// "Unknown statement type: with" -> "with".
function namedConstruct(message: string): string | undefined {
  const m = /Unknown statement type: (\w+)|Unknown statement, got (\w+)|Unexpected (?:token|character): (\S+)/.exec(message);
  return m?.[1] ?? m?.[2] ?? m?.[3];
}

export function runUnanalyzable(outcome: ParseOutcome, knownGood: boolean, base: Base): Finding[] {
  const findings: Finding[] = [];

  const mk = (severity: Severity, message: string, span?: Finding["span"]): Finding => ({
    ruleId: "unanalyzable",
    severity,
    message,
    file: base.file,
    templateName: base.templateName,
    templateSha256: base.sha256,
    span,
  });

  if (outcome.parseError || outcome.tooLarge) {
    if (!knownGood) {
      const named = outcome.parseError ? namedConstruct(outcome.parseError) : undefined;
      // Point at the named construct in the raw text when we can find it.
      const tok = named ? outcome.pre.tokens.find((t) => t.type === "identifier" && t.value === named) : undefined;
      const span = tok ? outcome.lines.span(tok.start, tok.end) : undefined;
      const detail = outcome.tooLarge
        ? "template too large to parse in-process"
        : named
          ? `@huggingface/jinja cannot parse this template (construct: ${named})`
          : `@huggingface/jinja cannot parse this template: ${outcome.parseError}`;
      findings.push(mk("HIGH", detail, span));
    }
    return findings;
  }

  // Parsed, but uses constructs the library does not implement (ISC-12.1).
  for (const u of outcome.unsupported) {
    findings.push(mk(u.severity, `unsupported ${u.kind} '${u.name}' is not implemented by @huggingface/jinja`, u.span));
  }
  return findings;
}
