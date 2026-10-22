// Raw-text fallback for ISC-13 to ISC-16. When @huggingface/jinja cannot parse
// a template (ISC-12) — or it is too large to parse safely — the AST rules
// cannot run, so we scan the raw tag interiors with patterns instead. These are
// deliberately coarse: a parse failure already made the template HIGH, and
// these add the specific offending spans.

import type { Finding, RuleId, Span } from "../types.ts";
import { ENGINE_GLOBALS, EXEC_SURFACES, GADGETS, LineMap } from "../parse/support.ts";
import type { TextRun } from "../parse/prelexer.ts";

interface RawPattern {
  ruleId: RuleId;
  re: RegExp;
  message: (m: RegExpExecArray) => string;
}

const PATTERNS: RawPattern[] = [
  { ruleId: "dunder_access", re: /__[A-Za-z0-9]+__/g, message: (m) => `dunder attribute '${m[0]}'` },
  { ruleId: "dynamic_attribute", re: /\|\s*(attr|format)\b/g, message: (m) => `'|${m[1]}' reaches attributes by name` },
  { ruleId: "dynamic_attribute", re: /\.\s*format\s*\(/g, message: () => ".format() reaches attributes by name" },
  {
    ruleId: "gadget_traversal",
    re: new RegExp(`\\b(${[...GADGETS].join("|")})\\s*[.\\[]`, "g"),
    message: (m) => `traversal on engine gadget '${m[1]}'`,
  },
  {
    ruleId: "exec_surface",
    re: new RegExp(`\\b(${[...EXEC_SURFACES].join("|")})\\s*\\(`, "g"),
    message: (m) => `OS/exec surface '${m[1]}' in a callable position`,
  },
  {
    ruleId: "engine_fingerprint",
    re: new RegExp(`\\b(${[...ENGINE_GLOBALS].join("|")})\\s+is\\s+(not\\s+)?(un)?defined\\b`, "g"),
    message: (m) => `tests engine global '${m[1]}' with 'is defined'`,
  },
];

export function runRawText(
  regions: TextRun[],
  lines: LineMap,
  text: string,
  base: { file: string; templateName: string; sha256: string },
): Finding[] {
  const findings: Finding[] = [];
  for (const region of regions) {
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = p.re.exec(region.value)) !== null) {
        const start = region.start + m.index;
        const end = start + m[0].length;
        const span: Span = lines.span(start, end);
        findings.push({
          ruleId: p.ruleId,
          severity: "HIGH",
          message: p.message(m),
          file: base.file,
          templateName: base.templateName,
          templateSha256: base.sha256,
          span,
          excerpt: text.slice(start, end),
        });
      }
    }
  }
  return findings;
}
