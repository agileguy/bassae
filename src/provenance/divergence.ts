// Divergence from a trusted baseline (ISC-25). One registry_divergence finding
// per diverging template, carrying the diff, the baseline's citation and the
// rules that fired. Severity, in order:
//
// 1. the highest finding of `analyze(template)` that touches an added or changed
//    span: through its own span, or through a span in its detail, such as the
//    injected text a content_trigger gates (`detail.textSpan`) while its own span
//    is the unchanged condition. A finding with no place in the text
//    (unanalyzable, scanner_error) touches every change (Decisions 19:15);
// 2. else MEDIUM when any literal (text between tags, a string literal or a
//    number inside one) was added, changed or removed. A changed number is a
//    changed threshold, which no fixed probe set can show harmless (Decisions 19:15);
// 3. else the rewrite changes control flow only. It is LOW only when it adds no
//    test on content or on the clock or chance (Decisions 20:55), as the trigger
//    rules' own interpreter classes each test: a fixed probe set never sends the
//    one message such a test waits for. Then the
//    sandboxed renderer must give identical output for both texts on every probe
//    that renders, and every conversation shape must render at least once. A probe
//    both texts refuse with the same render_error message counts as identical but
//    not as rendered. With no renderer, an incomplete analysis, tests that cannot
//    be classified or any other failed render it cannot be shown harmless, so it
//    stays MEDIUM (fail closed).
//
// A whitespace-only difference is the ISC-24.2 variant and gives no finding, and
// so does a `none` baseline.

import { diffLines, type LineDiff, unifiedDiff } from "../diff.ts";
import { parseTemplate, WHOLE_TEMPLATE } from "../parse/parse.ts";
import { preLex } from "../parse/prelexer.ts";
import { LineMap } from "../parse/support.ts";
import { clip } from "../rules/finalize.ts";
import { type ClassedTest, classedTests } from "../rules/injected.ts";
import { stronger, type TestClass } from "../rules/triggers.ts";
import { isTemplateSpace, sameIgnoringWhitespace, whitespaceKey } from "../whitespace.ts";
import type { Baseline, ExtractedTemplate, Finding, RenderRequest, Renderer, RuleResult, Severity, Span } from "../types.ts";
import { SEVERITY_RANK } from "../types.ts";

// Past the diff's own whole-text limit the pre-lexer is not run either; the literal check then fails closed.
const MAX_LITERAL_UNITS = 4 * 1024 * 1024;
// Rule hits kept in a finding's detail.
const MAX_RULES_LISTED = 50;
// Characters of an added test kept as its excerpt.
const MAX_EXCERPT = 200;

type Trusted = Exclude<Baseline, { kind: "none" }>;

export async function registryDivergence(
  template: ExtractedTemplate,
  baseline: Baseline,
  analyze: (t: ExtractedTemplate) => RuleResult,
  renderer?: Renderer,
): Promise<Finding[]> {
  if (baseline.kind === "none") return [];
  const base = baselineText(baseline);
  if (sameIgnoringWhitespace(base, template.text)) return [];

  const diff = diffLines(base, template.text);
  const changed = diff.blocks.filter((b) => b.bRange.end > b.bRange.start).map((b) => b.bRange);

  let result: RuleResult | undefined;
  let analyzeError: string | undefined;
  try {
    result = analyze(template);
  } catch (e) {
    analyzeError = e instanceof Error ? e.message : String(e);
  }
  const hits = (result?.findings ?? []).filter((f) => touches(f, changed));

  let severity: Severity;
  let reason: string;
  let probes: Record<string, unknown> | undefined;
  let added: AddedTest[] | undefined;
  if (hits.length > 0) {
    severity = hits.reduce<Severity>((s, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[s] ? f.severity : s), "LOW");
    const ids = [...new Set(hits.map((f) => f.ruleId))];
    reason = `${ids.join(", ")} ${ids.length === 1 ? "fires" : "fire"} on added or changed lines`;
  } else if (literalsChanged(base, template.text)) {
    severity = "MEDIUM";
    reason = "literal text or a number was added, changed or removed";
  } else {
    added = result?.complete ? addedTests(base, template.text, diff) : undefined;
    const first = added?.[0];
    if (result?.complete && !added) {
      severity = "MEDIUM";
      reason = "control flow only, but the tests it changed could not be classified";
    } else if (first) {
      severity = "MEDIUM";
      reason = `control flow only, but the rewrite adds a ${first.cls} test: \`${first.excerpt}\` (line ${first.span.line})`;
    } else {
      const proof: Proof = !result?.complete ? { identical: false, why: analyzeError ? `analysis failed: ${analyzeError}` : "analysis incomplete" } : await sameOutput(base, template.text, renderer);
      probes = proof;
      severity = proof.identical ? "LOW" : "MEDIUM";
      reason = proof.identical
        ? `control flow only, with identical output on ${proof.rendered} of ${proof.total} probes${proof.skipped ? ` (${proof.skipped} refused identically by both)` : ""}`
        : `control flow only, but identical output could not be shown: ${proof.why}`;
    }
  }

  const span = firstChange(template.text, diff);
  return [
    {
      ruleId: "registry_divergence",
      severity,
      message: `differs from ${cite(baseline)}: ${reason}`,
      file: template.source.path,
      templateName: template.source.name,
      templateSha256: template.sha256,
      span,
      excerpt: clip(template.text.slice(span.start, span.end)),
      detail: {
        baseline: citation(baseline),
        diff: unifiedDiff(base, template.text, `${baseline.kind}: ${label(baseline)}`, `${template.source.path} [${template.source.name}]`),
        coarse: diff.coarse,
        rules: hits.slice(0, MAX_RULES_LISTED).map((f) => ({ ruleId: f.ruleId, severity: f.severity, message: f.message, span: f.span })),
        ...(added?.length ? { tests: added.slice(0, MAX_RULES_LISTED).map((t) => ({ class: t.cls, span: t.span, excerpt: t.excerpt })) } : {}),
        ...(probes ? { probes } : {}),
        ...(analyzeError ? { analyzeError } : {}),
      },
    },
  ];
}

export function baselineText(baseline: Trusted): string {
  return baseline.kind === "registry" ? baseline.known.text : baseline.text;
}

function label(b: Trusted): string {
  const { repo, revision, path, templateName } = b.kind === "registry" ? b.known.entry : b;
  return `${repo}@${revision}/${path} [${templateName}]`;
}

function cite(b: Trusted): string {
  const { repo, revision, path, templateName } = b.kind === "registry" ? b.known.entry : b;
  return `${b.kind === "registry" ? "known-good" : "upstream"} ${repo}@${revision.slice(0, 7)} ${path} [${templateName}]`;
}

function citation(b: Trusted): Record<string, string> {
  if (b.kind === "registry") return { kind: "registry", ...b.known.entry };
  return { kind: "upstream", repo: b.repo, revision: b.revision, path: b.path, templateName: b.templateName };
}

// ISC-24.2's whitespace, the same ASCII-only definition the registry uses.
export { sameIgnoringWhitespace };

/** Where `text` first differs from the baseline: the first added or changed lines, else the point of the first removal. */
export function firstChange(text: string, diff: LineDiff): Span {
  const block = diff.blocks.find((b) => b.bRange.end > b.bRange.start) ?? diff.blocks[0];
  if (!block) return { ...WHOLE_TEMPLATE };
  // A trailing line break belongs to the line but makes a poor excerpt.
  let end = block.bRange.end;
  if (end > block.bRange.start && text[end - 1] === "\n") end--;
  return new LineMap(text).span(block.bRange.start, end);
}

function touches(f: Finding, changed: readonly { start: number; end: number }[]): boolean {
  // A finding with no span, or the whole-template one, may stem from any change, a pure deletion included.
  if (!f.span || isWholeTemplate(f.span)) return true;
  const spans = [f.span, ...Object.values(f.detail ?? {}).filter(isSpan)];
  return spans.some((s) => changed.some((r) => overlaps(s, r)));
}

function isWholeTemplate(s: Span): boolean {
  return s.start === WHOLE_TEMPLATE.start && s.end === WHOLE_TEMPLATE.end;
}

function isSpan(v: unknown): v is Span {
  const s = v as Span | null;
  return typeof s === "object" && s !== null && Number.isInteger(s.start) && Number.isInteger(s.end) && Number.isInteger(s.line) && Number.isInteger(s.col);
}

function overlaps(span: Span, r: { start: number; end: number }): boolean {
  if (span.end <= span.start) return r.start <= span.start && span.start < r.end;
  return span.start < r.end && r.start < span.end;
}

// Each text run and string literal reduced to its ASCII-whitespace-separated runs, so moving text between a raw
// run and a string literal, or re-indenting it, is not a literal change; whether such an edit changes output
// is the renderer's to show. A run or string of whitespace alone (the newline a `-%}` trims) has no runs and is
// left out: whitespaceKey hashes even an empty text, so its key alone cannot say so (review round 2, contracts N3).
// Numbers are kept as written.
function literals(text: string): string[] | undefined {
  if (text.length > MAX_LITERAL_UNITS) return undefined;
  const out: string[] = [];
  for (const t of preLex(text).tokens) {
    if (t.type === "number") out.push(`#${t.value}`);
    else if ((t.type === "text" || t.type === "string") && !allSpace(t.value)) out.push(whitespaceKey(t.value));
  }
  return out;
}

function allSpace(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (!isTemplateSpace(s.charCodeAt(i))) return false;
  return true;
}

function literalsChanged(a: string, b: string): boolean {
  const la = literals(a);
  const lb = literals(b);
  if (!la || !lb) return true;
  return la.length !== lb.length || la.some((s, i) => s !== lb[i]);
}

/** A test on content, or on the clock or chance, that a rewrite added or made. */
interface AddedTest {
  cls: "content" | "nondeterministic";
  span: Span;
  excerpt: string;
}

/**
 * The content and nondeterministic tests in `text` that `base` does not have at the same place: every such test in
 * the lines `diff` marks changed, and every other one whose class is stronger than the same test's in `base`.
 * Undefined when either text cannot be parsed or its walk is incomplete.
 */
function addedTests(base: string, text: string, diff: LineDiff): AddedTest[] | undefined {
  const before = testsOf(base);
  const after = testsOf(text);
  if (!before || !after) return undefined;
  const was = new Map<string, TestClass>();
  for (const t of before.tests) {
    const key = keyOf(t.span.start, t.span.end, t.node.type);
    was.set(key, stronger(was.get(key) ?? "none", t.cls));
  }
  const changed = diff.blocks.filter((b) => b.bRange.end > b.bRange.start).map((b) => b.bRange);
  const found: (ClassedTest & { cls: AddedTest["cls"] })[] = [];
  for (const t of after.tests) {
    if (t.cls !== "content" && t.cls !== "nondeterministic") continue;
    const { start, end } = t.span;
    if (!changed.some((r) => start < r.end && r.start < end)) {
      // An unchanged line: the same test, at the same place in the base, already read this much.
      const at = toBase(start, diff);
      const prior = at === undefined ? undefined : was.get(keyOf(at, at + (end - start), t.node.type));
      if (prior !== undefined && stronger(prior, t.cls) === prior) continue;
    }
    found.push({ ...t, cls: t.cls });
  }
  // A test that holds a smaller one at least as strong says no more than it
  // does: a loop over `messages|selectattr(k, u)` is named by its filter.
  const inner = (o: ClassedTest, i: ClassedTest) => i !== o && o.span.start <= i.span.start && i.span.end <= o.span.end && (i.span.end - i.span.start) < (o.span.end - o.span.start) && stronger(o.cls, i.cls) === i.cls;
  return found.filter((o) => !found.some((i) => inner(o, i))).map((t) => ({ cls: t.cls, span: t.span, excerpt: excerpt(text, t.span.start, t.span.end) }));
}

// Where an offset in the new text was in the base, through the unchanged lines; undefined inside a changed block.
function toBase(p: number, diff: LineDiff): number | undefined {
  let delta = 0;
  for (const b of diff.blocks) {
    if (p < b.bRange.start) break;
    if (p < b.bRange.end) return undefined;
    delta = b.aRange.end - b.bRange.end;
  }
  return p + delta;
}

const keyOf = (start: number, end: number, type: string) => `${start}:${end}:${type}`;

// The test's own text, widened to the parentheses its first and last names
// sit in and to the empty argument list of a call it ends with.
function excerpt(text: string, start: number, end: number): string {
  let depth = 0;
  let low = 0;
  for (let i = start; i < end; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") low = Math.min(low, --depth);
  }
  let s = start;
  for (let need = -low; need > 0 && s > 0; s--) {
    const c = text[s - 1]!;
    if (c === "(") need--;
    else if (c.trim() !== "") break;
  }
  let e = end;
  for (let open = depth - low; open > 0 && e < text.length; e++) {
    const c = text[e]!;
    if (c === ")") open--;
    else if (c.trim() !== "") break;
  }
  while (text.startsWith("()", e)) e += 2;
  const t = text.slice(s, e);
  return t.length > MAX_EXCERPT ? `${t.slice(0, MAX_EXCERPT)}…` : t;
}

// Every test the trigger rules' interpreter judged in `text`, with its class
// (ISC-18): the same walk the findings come from, so a construct it models is
// classed as the rules class it, and an incomplete walk classes nothing.
function testsOf(text: string): { tests: ClassedTest[] } | undefined {
  const outcome = parseTemplate(text);
  if (!outcome.program || !outcome.lines || outcome.tooLarge) return undefined;
  const tests = classedTests(outcome);
  return tests && { tests };
}

/** What the renderer showed. `rendered` probes gave identical output; `skipped` ones were refused identically by both texts. */
type Proof =
  | { identical: true; total: number; rendered: number; skipped: number }
  | { identical: false; why: string; probe?: string; total?: number; rendered?: number; skipped?: number; unrendered?: string[] };

async function sameOutput(a: string, b: string, renderer: Renderer | undefined): Promise<Proof> {
  if (!renderer) return { identical: false, why: "no renderer" };
  const requests = probeRequests();
  const total = requests.length;
  let ra;
  let rb;
  try {
    [ra, rb] = await Promise.all([renderer.renderBatch(a, requests), renderer.renderBatch(b, requests)]);
  } catch (e) {
    return { identical: false, why: `render failed: ${e instanceof Error ? e.message : String(e)}`, total };
  }
  if (ra.length !== total || rb.length !== total) return { identical: false, why: "the renderer answered a different number of probes", total };
  let rendered = 0;
  let skipped = 0;
  const shapes = new Set<string>();
  for (let i = 0; i < total; i++) {
    const x = ra[i]!;
    const y = rb[i]!;
    const id = requests[i]!.id;
    const counts = { total, rendered, skipped, probe: id };
    if (x.id !== id || y.id !== id) return { identical: false, why: "the renderer answered probes out of order", ...counts };
    // A trusted template may refuse a conversation on purpose (Gemma's raise_exception on a system turn). The
    // same refusal, word for word, is the same behavior; every other failure fails closed.
    if (!x.ok && !y.ok && x.failure === "render_error" && y.failure === "render_error" && x.message === y.message) {
      skipped++;
      continue;
    }
    if (!x.ok) return { identical: false, why: `the baseline failed to render (${x.failure})`, ...counts };
    if (!y.ok) return { identical: false, why: `the template failed to render (${y.failure})`, ...counts };
    if (x.output !== y.output) return { identical: false, why: "output differs", ...counts };
    rendered++;
    shapes.add(shapeOf(id));
  }
  // One rendered probe shows nothing about the shapes refused everywhere, so every shape must render somewhere.
  const unrendered = SHAPE_NAMES.filter((name) => !shapes.has(name));
  if (unrendered.length > 0) return { identical: false, why: `no probe of shape ${unrendered.join(", ")} rendered`, total, rendered, skipped, unrendered };
  return { identical: true, total, rendered, skipped };
}

// ---- the probe set ----

const SYSTEM = { role: "system", content: "You are a helpful assistant." };
const USER = { role: "user", content: "What is the weather in Paris?" };
const ASSISTANT = { role: "assistant", content: "It is sunny in Paris." };
const FOLLOW_UP = { role: "user", content: "And tomorrow?" };
const TOOL_CALL = {
  role: "assistant",
  content: "",
  tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: { location: "Paris" } } }],
};
const TOOL_RESULT = { role: "tool", name: "get_weather", tool_call_id: "call_1", content: '{"temperature": 18, "sky": "clear"}' };
const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather for a city.",
      parameters: { type: "object", properties: { location: { type: "string", description: "City name" } }, required: ["location"] },
    },
  },
];

// Long enough to cross any content-length gate a stock template plausibly carries.
const LONG_TEXT = "The quarterly report covers revenue, costs, hiring and the outlook for every region. ".repeat(150).trim();

// The conversation shapes: one message, a short chat, a tool round trip, fifty messages and two very long
// messages, so a gate on role, tool use, turn count or content length is exercised. Each also runs with a
// system message first, since some templates refuse or reshape a system turn.
const SHAPES: Record<string, object[]> = {
  one: [USER],
  chat: [USER, ASSISTANT, FOLLOW_UP],
  tool: [USER, TOOL_CALL, TOOL_RESULT, ASSISTANT],
  long: Array.from({ length: 49 }, (_, i) => (i % 2 === 0 ? { role: "user", content: `Question ${i / 2 + 1}?` } : { role: "assistant", content: `Answer ${(i + 1) / 2}.` })),
  "long-content": [
    { role: "user", content: `Summarise this report. ${LONG_TEXT}` },
    { role: "assistant", content: `Summary: ${LONG_TEXT}` },
    FOLLOW_UP,
  ],
};
const SHAPE_NAMES = Object.keys(SHAPES);
const shapeOf = (id: string) => id.slice(0, id.indexOf("/"));
// Ten years either side of now, so a date gate shows up as differing output.
const DATES = ["2016-03-01T09:30:00Z", "2026-07-15T12:00:00Z", "2036-11-30T23:15:00Z"];

/** Every shape with and without a system message, tools present and absent, add_generation_prompt both ways, at three dates, under both environment profiles. Ids start with the shape name. */
export function probeRequests(): RenderRequest[] {
  const out: RenderRequest[] = [];
  for (const [name, shape] of Object.entries(SHAPES)) {
    for (const system of [false, true]) {
      const messages = system ? [SYSTEM, ...shape] : shape;
      for (const tools of [false, true]) {
        for (const add_generation_prompt of [false, true]) {
          for (const now of DATES) {
            for (const profile of ["hf-default", "jinja2-globals"] as const) {
              out.push({
                id: `${name}/${system ? "system" : "no-system"}/${tools ? "tools" : "no-tools"}/${add_generation_prompt ? "gen" : "no-gen"}/${now.slice(0, 4)}/${profile}`,
                context: { messages, add_generation_prompt, bos_token: "<s>", eos_token: "</s>", ...(tools ? { tools: TOOLS } : {}) },
                profile,
                now,
              });
            }
          }
        }
      }
    }
  }
  return out;
}
