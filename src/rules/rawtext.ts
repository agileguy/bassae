// Raw-text fallback for ISC-13 to ISC-16. When @huggingface/jinja cannot parse
// a template (ISC-12) — or it is too large to parse safely — the AST rules
// cannot run, so we scan the raw tag interiors with patterns instead. These are
// deliberately coarse: a parse failure already made the template HIGH, and
// these add the specific offending spans.

import type { Finding, RuleId } from "../types.ts";
import { ENGINE_GLOBALS, ENGINE_PROBE_TESTS, EXEC_SURFACES, GADGETS, type LineMap } from "../parse/support.ts";
import type { TextRun } from "../parse/prelexer.ts";

type Base = Pick<Finding, "file" | "templateName" | "templateSha256">;

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
  {
    ruleId: "engine_fingerprint",
    re: new RegExp(`\\bis\\s+(?:not\\s+)?(${[...ENGINE_PROBE_TESTS].join("|")})\\b`, "g"),
    message: (m) => `'is ${m[1]}' asks the engine whether a ${m[1]} exists`,
  },
  {
    ruleId: "engine_fingerprint",
    re: new RegExp(`\\b(?:select|reject|selectattr|rejectattr)\\s*\\([^)]*?['"](${[...ENGINE_PROBE_TESTS].join("|")})['"]`, "g"),
    message: (m) => `'${m[1]}' named in select/reject asks the engine whether it exists`,
  },
];

// Stop building findings for a pattern after this many; a parse failure already
// made the whole template HIGH, so the raw-text spans are illustrative. Without
// a cap a 16 MiB string of dunders would allocate millions of findings.
const RAW_CAP = 100;

export function runRawText(regions: TextRun[], lines: LineMap, text: string, base: Base): Finding[] {
  const findings: Finding[] = [];
  for (const p of PATTERNS) {
    let hits = 0;
    for (const region of regions) {
      if (hits >= RAW_CAP) break;
      p.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = p.re.exec(region.value)) !== null) {
        const start = region.start + m.index;
        const end = start + m[0].length;
        findings.push({
          ruleId: p.ruleId,
          severity: "HIGH",
          message: p.message(m),
          ...base,
          span: lines.span(start, end),
          excerpt: text.slice(start, end),
        });
        if (++hits >= RAW_CAP) break;
      }
    }
  }
  return findings;
}

// Maps a monotonically-increasing UTF-16 offset to 1-based line and code-point
// column in O(total text), O(1) extra memory — no line-start array. Line breaks
// and column counting match LineMap exactly (round-2 memory review: used when the input is
// over the size cap, so no full LineMap is built).
class IncrementalPos {
  private i = 0;
  private line = 1;
  private lineStart = 0;
  private surrogatesOnLine = 0;
  constructor(private readonly text: string) {}
  at(offset: number): { line: number; col: number } {
    const t = this.text;
    while (this.i < offset) {
      const c = t.charCodeAt(this.i);
      if (c === 10 || (c === 13 && t.charCodeAt(this.i + 1) !== 10)) {
        this.line++;
        this.lineStart = this.i + 1;
        this.surrogatesOnLine = 0;
      } else if (c >= 0xd800 && c <= 0xdbff) {
        this.surrogatesOnLine++;
      }
      this.i++;
    }
    return { line: this.line, col: offset - this.lineStart - this.surrogatesOnLine + 1 };
  }
}

// The interior [start, end) of the next {{ }} or {% %} tag at or after `from`,
// plus the index just past its close. Lightweight: no object-literal depth, no
// token array. Returns null when no further tag opens.
function nextTag(text: string, from: number): { start: number; end: number; next: number } | null {
  const n = text.length;
  for (let i = from; i < n - 1; i++) {
    const c = text.charCodeAt(i);
    if (c !== 0x7b) continue; // '{'
    const d = text.charCodeAt(i + 1);
    const expr = d === 0x7b; // '{{'
    if (!expr && d !== 0x25) continue; // '{%'
    let s = i + 2;
    const mod = text.charCodeAt(s);
    if (mod === 0x2d || mod === 0x2b) s++; // '-' / '+'
    const closeExpr = "}}";
    const closeStmt = "%}";
    let j = s;
    let end = n;
    let next = n;
    while (j < n - 1) {
      const two = text.substr(j, 2);
      if (two === (expr ? closeExpr : closeStmt)) {
        end = j;
        next = j + 2;
        break;
      }
      if (text.charCodeAt(j) === 0x2d || text.charCodeAt(j) === 0x2b) {
        const t2 = text.substr(j + 1, 2);
        if (t2 === (expr ? closeExpr : closeStmt)) {
          end = j;
          next = j + 3;
          break;
        }
      }
      j++;
    }
    return { start: s, end, next };
  }
  return null;
}

/**
 * Streaming raw-text scan for an over-cap template (round-2 memory review). Each pattern is
 * run ONCE over the whole text, and every match is attributed to a tag interior
 * through a tag cursor that only moves forward. This keeps the work O(text) per
 * pattern in BOTH time and memory however the tags are shaped: no token array,
 * no line map, and — unlike slicing each interior — no per-tag allocation, so a
 * benign template of millions of tiny tags does not churn the heap. The
 * per-pattern RAW_CAP still holds, and spans are mapped incrementally at the end.
 */
export function runRawTextStreaming(text: string, base: Base): Finding[] {
  const allHits: { off: number; end: number; ruleId: RuleId; message: string }[] = [];
  for (const p of PATTERNS) {
    let hits = 0;
    p.re.lastIndex = 0;
    // The current tag interior [cs, ce); the cursor advances monotonically as the
    // match offset grows, so the whole tag stream is walked at most once per
    // pattern. A match outside every interior (in literal text) is ignored.
    let tagFrom = 0;
    let cs = -1;
    let ce = -1;
    let noMoreTags = false;
    let m: RegExpExecArray | null;
    while (hits < RAW_CAP && (m = p.re.exec(text)) !== null) {
      const mi = m.index;
      if (p.re.lastIndex <= mi) p.re.lastIndex = mi + 1; // guarantee forward progress
      while (!noMoreTags && ce <= mi) {
        const tag = nextTag(text, tagFrom);
        if (!tag) {
          noMoreTags = true;
          break;
        }
        cs = tag.start;
        ce = tag.end;
        tagFrom = tag.next;
      }
      if (mi >= cs && mi < ce) {
        allHits.push({ off: mi, end: mi + m[0].length, ruleId: p.ruleId, message: p.message(m) });
        hits++;
      }
    }
  }
  if (allHits.length === 0) return [];
  // At most PATTERNS.length * RAW_CAP hits, so this sort and the incremental
  // position walk are cheap and bounded regardless of template size.
  allHits.sort((a, b) => a.off - b.off || a.end - b.end);
  const pos = new IncrementalPos(text);
  const findings: Finding[] = [];
  for (const h of allHits) {
    const { line, col } = pos.at(h.off);
    findings.push({
      ruleId: h.ruleId,
      severity: "HIGH",
      message: h.message,
      ...base,
      span: { start: h.off, end: h.end, line, col },
      excerpt: text.slice(h.off, h.end),
    });
  }
  return findings;
}
