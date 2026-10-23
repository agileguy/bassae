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

// The library's token types, as a reader would know them.
const TOKEN_WORDS: Record<string, string> = {
  Text: "text", NumericLiteral: "a number", StringLiteral: "a string", Identifier: "a name", Equals: "'='",
  OpenParen: "'('", CloseParen: "')'", OpenStatement: "'{%'", CloseStatement: "'%}'", OpenExpression: "'{{'",
  CloseExpression: "'}}'", OpenSquareBracket: "'['", CloseSquareBracket: "']'", OpenCurlyBracket: "'{'",
  CloseCurlyBracket: "'}'", Comma: "','", Dot: "'.'", Colon: "':'", Pipe: "'|'", CallOperator: "a call",
  AdditiveBinaryOperator: "'+' or '-'", MultiplicativeBinaryOperator: "'*', '/', '//' or '%'",
  ExponentiationBinaryOperator: "'**'", ComparisonBinaryOperator: "a comparison", UnaryOperator: "'not'", Comment: "a comment",
};
const word = (type: string) => TOKEN_WORDS[type] ?? "something unexpected";
// Names and raw text come from the template, so neither may grow a message without bound.
const clipped = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

/**
 * A library parse error in plain words, and the statement it names when it names one. The library's text names
 * its own token types, and a block left open makes its parser read past its last token and crash with a TypeError;
 * neither means anything to a reader, so the finding keeps that text in detail.raw instead.
 */
function describe(raw: string): { problem: string; construct?: string } {
  const [, name, text = raw] = /^(\w*Error): ([\s\S]*)$/.exec(raw) ?? [];
  let m: RegExpExecArray | null;
  if ((m = /^Unknown statement type: (\w+)/.exec(text))) {
    const construct = m[1]!;
    const tag = `{% ${clipped(construct, 64)} %}`;
    return { construct, problem: /^(?:end\w+|else|elif)$/.test(construct) ? `${tag} has no open block to close or continue` : `${tag} is a statement it does not support` };
  }
  if ((m = /^Unknown statement, got (\w+)$/.exec(text))) return { problem: `a '{%' tag must start with a statement name, not ${word(m[1]!)}` };
  if ((m = /^Unexpected token(?: type)?: (\w+)$/.exec(text))) return { problem: `an expression is missing or incomplete before ${word(m[1]!)}` };
  if ((m = /^Parser Error: [\s\S]*\. (\w+) !== (\w+)\.$/.exec(text))) return { problem: `expected ${word(m[2]!)} but found ${word(m[1]!)}` };
  if ((m = /^Unexpected (escaped )?character: ([\s\S])$/u.exec(text))) return { problem: `unexpected ${m[1] ? "escape" : "character"} '${m[2]}'` };
  if (text.startsWith("Expected identifier/tuple for the loop variable")) return { problem: "a {% for %} loop variable must be a name or a tuple of names" };
  if (text === "Unexpected end of input") return { problem: "it ends inside an unclosed string, '{{' or '{%'" };
  if (text === "Missing end of comment tag") return { problem: "a '{#' comment is never closed" };
  if (name === "TypeError" && /undefined/.test(text)) {
    return { problem: "it ends inside a block that is never closed: an {% if %}, {% for %}, {% macro %} or other block has no end tag" };
  }
  // The library's other SyntaxErrors are already in words, e.g. "Duplicate parameter name: x".
  if (name === "SyntaxError") return { problem: clipped(text.charAt(0).toLowerCase() + text.slice(1), 160) };
  return { problem: "its parser failed on it" };
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
      const said = outcome.parseError && !outcome.tooLarge ? describe(outcome.parseError) : undefined;
      const named = said?.construct;
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
        : `@huggingface/jinja cannot parse this template: ${said!.problem}`;
      const f = mk("HIGH", detail, span);
      if (said) f.detail = { raw: clipped(outcome.parseError!, 512) };
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
