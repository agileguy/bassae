// Divergence from a trusted baseline (ISC-25). One registry_divergence finding
// per diverging template, carrying the diff, the baseline's citation and the
// rules that fired. Severity, in order:
//
// 1. the highest finding of `analyze(template)` whose span overlaps an added or
//    changed span;
// 2. else MEDIUM when any literal text (text between tags, or a string literal
//    inside one) was added, changed or removed;
// 3. else the rewrite changes control flow only. It is LOW only when the
//    sandboxed renderer gives identical output for both texts on every probe;
//    with no renderer, an incomplete analysis or any failed render it cannot be
//    shown harmless, so it stays MEDIUM (fail closed).
//
// A whitespace-only difference is the ISC-24.2 variant and gives no finding, and
// so does a `none` baseline.

import { diffLines, type LineDiff, unifiedDiff } from "../diff.ts";
import { WHOLE_TEMPLATE } from "../parse/parse.ts";
import { preLex } from "../parse/prelexer.ts";
import { LineMap } from "../parse/support.ts";
import { clip } from "../rules/finalize.ts";
import { sameIgnoringWhitespace } from "../whitespace.ts";
import type { Baseline, ExtractedTemplate, Finding, RenderRequest, Renderer, RuleResult, Severity, Span } from "../types.ts";
import { SEVERITY_RANK } from "../types.ts";

// Past the diff's own whole-text limit the pre-lexer is not run either; the literal check then fails closed.
const MAX_LITERAL_UNITS = 4 * 1024 * 1024;
// Rule hits kept in a finding's detail.
const MAX_RULES_LISTED = 50;

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
  const hits = (result?.findings ?? []).filter((f) => changed.some((r) => overlaps(f.span, r)));

  let severity: Severity;
  let reason: string;
  let probes: Record<string, unknown> | undefined;
  if (hits.length > 0) {
    severity = hits.reduce<Severity>((s, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[s] ? f.severity : s), "LOW");
    const ids = [...new Set(hits.map((f) => f.ruleId))];
    reason = `${ids.join(", ")} ${ids.length === 1 ? "fires" : "fire"} on added or changed lines`;
  } else if (literalsChanged(base, template.text)) {
    severity = "MEDIUM";
    reason = "literal text was added, changed or removed";
  } else {
    const proof: Proof = !result?.complete ? { identical: false, why: analyzeError ? `analysis failed: ${analyzeError}` : "analysis incomplete" } : await sameOutput(base, template.text, renderer);
    probes = proof;
    severity = proof.identical ? "LOW" : "MEDIUM";
    reason = proof.identical ? `control flow only, with identical output on ${proof.count} probes` : `control flow only, but identical output could not be shown: ${proof.why}`;
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

// A finding the pre-lexer could not place spans the whole template, so it may stem from any change.
function overlaps(span: Span | undefined, r: { start: number; end: number }): boolean {
  if (!span || (span.start === 0 && span.end === 0)) return true;
  if (span.end <= span.start) return r.start <= span.start && span.start < r.end;
  return span.start < r.end && r.start < span.end;
}

// Each literal reduced to its non-whitespace runs, so moving text between a raw run and a string literal, or
// re-indenting it, is not a literal change; whether such an edit changes output is the renderer's to show.
function literals(text: string): string[] | undefined {
  if (text.length > MAX_LITERAL_UNITS) return undefined;
  const out: string[] = [];
  for (const t of preLex(text).tokens) {
    if (t.type !== "text" && t.type !== "string") continue;
    const runs = t.value.split(/\s+/).filter(Boolean).join(" ");
    if (runs) out.push(runs);
  }
  return out;
}

function literalsChanged(a: string, b: string): boolean {
  const la = literals(a);
  const lb = literals(b);
  if (!la || !lb) return true;
  return la.length !== lb.length || la.some((s, i) => s !== lb[i]);
}

type Proof = { identical: true; count: number } | { identical: false; why: string; probe?: string };

async function sameOutput(a: string, b: string, renderer: Renderer | undefined): Promise<Proof> {
  if (!renderer) return { identical: false, why: "no renderer" };
  const requests = probeRequests();
  let ra;
  let rb;
  try {
    [ra, rb] = await Promise.all([renderer.renderBatch(a, requests), renderer.renderBatch(b, requests)]);
  } catch (e) {
    return { identical: false, why: `render failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (ra.length !== requests.length || rb.length !== requests.length) return { identical: false, why: "the renderer answered a different number of probes" };
  let rendered = 0;
  for (let i = 0; i < requests.length; i++) {
    const x = ra[i]!;
    const y = rb[i]!;
    const id = requests[i]!.id;
    if (x.id !== id || y.id !== id) return { identical: false, why: "the renderer answered probes out of order", probe: id };
    // A trusted template may refuse a conversation on purpose (Gemma's raise_exception on a system turn). The
    // same refusal, word for word, is the same behavior; every other failure fails closed.
    if (!x.ok && !y.ok && x.failure === "render_error" && y.failure === "render_error" && x.message === y.message) continue;
    if (!x.ok) return { identical: false, why: `the baseline failed to render (${x.failure})`, probe: id };
    if (!y.ok) return { identical: false, why: `the template failed to render (${y.failure})`, probe: id };
    if (x.output !== y.output) return { identical: false, why: "output differs", probe: id };
    rendered++;
  }
  if (rendered === 0) return { identical: false, why: "no probe rendered" };
  return { identical: true, count: rendered };
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

// One message, a short chat, a tool round trip, and fifty messages, so a gate on role, tool use or length is exercised.
const CONVERSATIONS: Record<string, object[]> = {
  one: [USER],
  chat: [SYSTEM, USER, ASSISTANT, FOLLOW_UP],
  tool: [SYSTEM, USER, TOOL_CALL, TOOL_RESULT, ASSISTANT],
  long: [SYSTEM, ...Array.from({ length: 49 }, (_, i) => (i % 2 === 0 ? { role: "user", content: `Question ${i / 2 + 1}?` } : { role: "assistant", content: `Answer ${(i + 1) / 2}.` }))],
};
// Ten years either side of now, so a date gate shows up as differing output.
const DATES = ["2016-03-01T09:30:00Z", "2026-07-15T12:00:00Z", "2036-11-30T23:15:00Z"];

/** Every conversation with tools present and absent and add_generation_prompt both ways, at three dates, under both environment profiles. */
export function probeRequests(): RenderRequest[] {
  const out: RenderRequest[] = [];
  for (const [name, messages] of Object.entries(CONVERSATIONS)) {
    for (const tools of [false, true]) {
      for (const add_generation_prompt of [false, true]) {
        for (const now of DATES) {
          for (const profile of ["hf-default", "jinja2-globals"] as const) {
            out.push({
              id: `${name}/${tools ? "tools" : "no-tools"}/${add_generation_prompt ? "gen" : "no-gen"}/${now.slice(0, 4)}/${profile}`,
              context: { messages, add_generation_prompt, bos_token: "<s>", eos_token: "</s>", ...(tools ? { tools: TOOLS } : {}) },
              profile,
              now,
            });
          }
        }
      }
    }
  }
  return out;
}
