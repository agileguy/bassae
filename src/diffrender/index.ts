// Differential rendering (ISC-22 to ISC-22.4, ISC-43): renders each template against a probe matrix in the
// sandboxed renderer and reports what the output shows that static analysis cannot.
//
// Every probe renders under both environment profiles. The first explain probe goes alone, then the other
// explain probes, then the vary probes, and after the first cap breach nothing more is sent, so one hostile
// template costs about one cap plus a batch (Decisions 17:35). What came back is checked four ways:
// - render_divergence: a vary probe prints a word, once its inputs are removed, that no explain probe prints;
// - env_profile_divergence: one probe renders differently under the two profiles;
// - content_integrity and tool_integrity: p3-integrity's checks on every output;
// - render_dos: the first cap breach.
// Each gives at most one HIGH finding per template.

import { WHOLE_TEMPLATE } from "../parse/parse.ts";
import type { Transform } from "../registry/index.ts";
import { clip } from "../rules/finalize.ts";
import type {
  DiffRenderInput,
  DiffRenderResult,
  EnvProfile,
  Finding,
  FindingBase,
  IntegrityIssue,
  Probe,
  RenderFailure,
  RenderRequest,
  RenderResult,
  Renderer,
} from "../types.ts";
import { DEFAULT_RENDER_LIMITS } from "../types.ts";
import { checkContent } from "./integrity.ts";
import { buildProbes, readsTools, REFERENCE_DATE } from "./probes.ts";
import { templateText, unexplained as unexplainedUnits, units, words } from "./residue.ts";
import { checkTools } from "./tools.ts";

const PROFILES: readonly EnvProfile[] = ["hf-default", "jinja2-globals"];

// How much of what went wrong a finding lists.
const MAX_LISTED_PROBES = 20;
const MAX_LISTED_WORDS = 50;
const MAX_LISTED_ISSUES = 5;
const SAMPLE_AROUND = 80;

const CAPS: Partial<Record<RenderFailure, string>> = {
  timeout: `time cap (${DEFAULT_RENDER_LIMITS.timeoutMs} ms)`,
  memory: `memory cap (${DEFAULT_RENDER_LIMITS.maxRssBytes / 1024 / 1024} MiB)`,
  output_limit: `output cap (${DEFAULT_RENDER_LIMITS.maxOutputBytes / 1024 / 1024} MiB)`,
  stack: "stack (unbounded recursion)",
};

/** The integrity checks, injectable so their wiring can be tested before their bodies exist. */
export interface IntegrityChecks {
  checkContent(probe: Probe, output: string, transforms: readonly Transform[], scaffolding: ReadonlySet<string>): IntegrityIssue[];
  checkTools(probe: Probe, output: string, transforms: readonly Transform[]): IntegrityIssue[];
}

/**
 * render_divergence, env_profile_divergence, content_integrity, tool_integrity and render_dos for one template.
 * Never throws: an internal failure is a scanner_error finding and an incomplete result.
 */
export async function diffRender(input: DiffRenderInput, renderer: Renderer, transforms: readonly Transform[]): Promise<DiffRenderResult> {
  return diffRenderWith(input, renderer, transforms, { checkContent, checkTools });
}

/** diffRender with the integrity checks passed in. */
export async function diffRenderWith(input: DiffRenderInput, renderer: Renderer, transforms: readonly Transform[], checks: IntegrityChecks): Promise<DiffRenderResult> {
  const t = input.template;
  const base: FindingBase = { file: t.source.path, templateName: t.source.name, templateSha256: t.sha256 };
  try {
    return await run(input, renderer, transforms, checks, base);
  } catch (e) {
    // We cannot vouch for output we did not finish checking.
    return {
      findings: [{ ruleId: "scanner_error", severity: "HIGH", message: `internal error in differential rendering: ${errorText(e)}`, ...base, span: { ...WHOLE_TEMPLATE } }],
      complete: false,
      probes: { total: 0, rendered: 0, refused: 0, failed: 0 },
    };
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---- rendering ----

/** A probe's results under each profile; absent where nothing was sent. */
type Outcome = Partial<Record<EnvProfile, RenderResult>>;

const isSkipped = (r: RenderResult) =>
  // Until the renderer reports `skipped`, a render its fail-fast rule skipped comes back as a timeout that says so.
  !r.ok && (r.failure === "skipped" || (r.failure === "timeout" && r.message.startsWith("not attempted")));
const isCapBreach = (r: RenderResult) => !r.ok && r.failure in CAPS && !isSkipped(r);

interface Breach {
  probe: number;
  profile: EnvProfile;
  result: RenderResult & { ok: false };
}

/** Sends each batch in turn and stops after the first cap breach, or when the template or the sandbox cannot run at all. */
async function renderAll(template: string, probes: readonly Probe[], renderer: Renderer): Promise<{ outcomes: Outcome[]; breach?: Breach }> {
  const outcomes: Outcome[] = probes.map(() => ({}));
  const sent = new Map<string, { probe: number; profile: EnvProfile }>();
  const request = (i: number, profile: EnvProfile): RenderRequest => {
    const id = `${i}/${profile}/${probes[i]!.label}`;
    sent.set(id, { probe: i, profile });
    return { ...probes[i]!.request, id, profile };
  };
  const explain = probes.flatMap((p, i) => (p.role === "explain" ? [i] : []));
  const vary = probes.flatMap((p, i) => (p.role === "vary" ? [i] : []));
  const both = (ids: number[]) => ids.flatMap((i) => PROFILES.map((profile) => request(i, profile)));
  const queue = [...both(explain), ...both(vary)];
  const split = Math.max(1, explain.length * PROFILES.length);
  const batches = [queue.slice(0, 1), queue.slice(1, split), queue.slice(split)];

  for (const batch of batches) {
    if (batch.length === 0) continue;
    let results: RenderResult[];
    try {
      results = await renderer.renderBatch(template, batch);
    } catch (e) {
      results = batch.map(({ id }) => ({ id, ok: false, failure: "sandbox", message: `renderer failed: ${errorText(e)}` }));
    }
    const byId = new Map(results.map((r) => [r.id, r]));
    let breach: Breach | undefined;
    let fatal = false;
    for (const req of batch) {
      const result: RenderResult = byId.get(req.id) ?? { id: req.id, ok: false, failure: "sandbox", message: "the renderer returned no result for this probe" };
      const { probe, profile } = sent.get(req.id)!;
      outcomes[probe]![profile] = result;
      if (!result.ok && !breach && isCapBreach(result)) breach = { probe, profile, result };
      if (!result.ok && (result.failure === "parse" || result.failure === "sandbox")) fatal = true;
    }
    if (breach) return { outcomes, breach };
    // A template that does not parse, or a sandbox that does not start, fails every later probe the same way.
    if (fatal && batch.length === 1) break;
  }
  return { outcomes };
}

// ---- counting ----

/** A render_error the template raised itself: the message it raised is text the template holds (raise_exception). An engine error, a filter it does not implement, is a gap, not an answer. */
function isRefusal(r: RenderResult, templateText: string): boolean {
  if (r.ok || r.failure !== "render_error" || !r.message.startsWith("Error: ")) return false;
  const raised = r.message.slice("Error: ".length).replace(/… \[truncated\]$/, "");
  return raised.length > 0 && templateText.includes(raised);
}

// ---- the run ----

async function run(input: DiffRenderInput, renderer: Renderer, transforms: readonly Transform[], checks: IntegrityChecks, base: FindingBase): Promise<DiffRenderResult> {
  const text = input.template.text;
  const scaffolding = input.scaffolding ?? new Set<string>();
  // A template that never reads `tools` gets no probe passing any: it cannot render them (ISC-22.4).
  const { probes, cut } = buildProbes(input.triggers, { tools: readsTools(text), text, ...(input.reads ? { reads: input.reads } : {}) });
  const { outcomes, breach } = await renderAll(text, probes, renderer);

  let rendered = 0;
  let refused = 0;
  let explainRefused = 0;
  for (const [i, outcome] of outcomes.entries()) {
    const results = PROFILES.map((p) => outcome[p]);
    if (results.some((r) => r?.ok)) rendered++;
    else if (results.every((r) => r && isRefusal(r, text))) {
      refused++;
      if (probes[i]!.role === "explain") explainRefused++;
    }
  }
  const total = probes.length + cut;
  const failed = total - rendered - refused;
  const explainCount = probes.filter((p) => p.role === "explain").length;

  const findings: Finding[] = [];
  const whole = { ...base, span: { ...WHOLE_TEMPLATE } };
  let internal: string | undefined;

  if (breach) {
    const { probe, profile, result } = breach;
    findings.push({
      ruleId: "render_dos",
      severity: "HIGH",
      message: `rendering the ${probes[probe]!.label} probe (${profile}) hit the ${CAPS[result.failure]}; no further probes were rendered`,
      ...whole,
      detail: { probe: probes[probe]!.label, profile, cap: result.failure, limits: { ...DEFAULT_RENDER_LIMITS }, error: result.message },
    });
  }

  const profileFinding = profileDivergence(probes, outcomes, base);
  if (profileFinding) findings.push(profileFinding);

  const divergence = renderDivergence(input, probes, outcomes, base);
  if (divergence) findings.push(divergence);

  // ISC-22.3 and ISC-22.4 on every output under both profiles; an output identical to the other profile's is checked once.
  const issues = { content_integrity: [] as Listed[], tool_integrity: [] as Listed[] };
  for (const [i, outcome] of outcomes.entries()) {
    const seen = new Set<string>();
    for (const profile of PROFILES) {
      const r = outcome[profile];
      if (!r?.ok || seen.has(r.output)) continue;
      seen.add(r.output);
      for (const check of [checks.checkContent, checks.checkTools]) {
        let found: IntegrityIssue[];
        try {
          found = check(probes[i]!, r.output, transforms, scaffolding);
        } catch (e) {
          internal ??= errorText(e);
          continue;
        }
        for (const rule of ["content_integrity", "tool_integrity"] as const) {
          const mine = found.filter((x) => x.ruleId === rule);
          if (mine.length > 0) issues[rule].push({ probe: probes[i]!.label, profile, issues: mine });
        }
      }
    }
  }
  for (const rule of ["content_integrity", "tool_integrity"] as const) {
    const listed = issues[rule];
    if (listed.length === 0) continue;
    const first = listed[0]!;
    findings.push({
      ruleId: rule,
      severity: "HIGH",
      message: `${first.issues[0]!.message} (the ${first.probe} probe${listed.length > 1 ? ` and ${listed.length - 1} more` : ""})`,
      ...whole,
      detail: {
        probeCount: listed.length,
        probes: listed.slice(0, MAX_LISTED_PROBES).map((l) => ({
          probe: l.probe,
          profile: l.profile,
          issues: l.issues.slice(0, MAX_LISTED_ISSUES).map((x) => ({ index: x.index, message: x.message })),
        })),
      },
    });
  }

  if (internal !== undefined) {
    findings.push({ ruleId: "scanner_error", severity: "HIGH", message: `internal error in an integrity check: ${internal}`, ...whole });
  }

  const complete = failed === 0 && !(explainCount > 0 && explainRefused === explainCount) && internal === undefined;
  return { findings, complete, probes: { total, rendered, refused, failed } };
}

interface Listed {
  probe: string;
  profile: EnvProfile;
  issues: IntegrityIssue[];
}

// ---- env_profile_divergence (ISC-22.2) ----

function profileDivergence(probes: readonly Probe[], outcomes: readonly Outcome[], base: FindingBase): Finding | undefined {
  const differing: number[] = [];
  for (const [i, o] of outcomes.entries()) {
    const a = o["hf-default"];
    const b = o["jinja2-globals"];
    if (a?.ok && b?.ok && a.output !== b.output) differing.push(i);
  }
  const i = differing[0];
  if (i === undefined) return undefined;
  const a = (outcomes[i]!["hf-default"] as { output: string }).output;
  const b = (outcomes[i]!["jinja2-globals"] as { output: string }).output;
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at++;
  const from = Math.max(0, at - 20);
  return {
    ruleId: "env_profile_divergence",
    severity: "HIGH",
    message: `the ${probes[i]!.label} probe renders differently when jinja2's default globals exist, so the template can tell this engine from a victim's`,
    ...base,
    span: { ...WHOLE_TEMPLATE },
    detail: {
      probe: probes[i]!.label,
      probeCount: differing.length,
      probes: differing.slice(0, MAX_LISTED_PROBES).map((d) => probes[d]!.label),
      firstDifference: { offset: at, "hf-default": clip(a.slice(from, at + 100)), "jinja2-globals": clip(b.slice(from, at + 100)) },
    },
  };
}

// ---- render_divergence (ISC-22) ----

function renderDivergence(input: DiffRenderInput, probes: readonly Probe[], outcomes: readonly Outcome[], base: FindingBase): Finding | undefined {
  // The template's ordinary output: every word and word pair any explain probe prints under either profile, also
  // with month and weekday names masked, which is how a date probe's units are compared.
  const explained = new Set<string>();
  for (const [i, o] of outcomes.entries()) {
    if (probes[i]!.role !== "explain") continue;
    for (const profile of PROFILES) {
      const r = o[profile];
      if (!r?.ok) continue;
      const text = templateText(r.output, probes[i]!.inputs);
      for (const dateProbe of [false, true]) for (const u of units(text, dateProbe)) explained.add(u);
    }
  }

  const hits: { probe: string; profile: EnvProfile; words: string[]; text: string }[] = [];
  for (const [i, o] of outcomes.entries()) {
    const probe = probes[i]!;
    if (probe.role !== "vary") continue;
    const seen = new Set<string>();
    for (const profile of PROFILES) {
      const r = o[profile];
      if (!r?.ok || seen.has(r.output)) continue;
      seen.add(r.output);
      const text = templateText(r.output, probe.inputs);
      const unexplained = unexplainedUnits(text, explained, probe.request.now !== REFERENCE_DATE);
      if (unexplained.length > 0) hits.push({ probe: probe.label, profile, words: unexplained, text });
    }
  }
  if (hits.length === 0) return undefined;

  // Each unexplained unit: a word, or two known words in an order no explain probe prints.
  const all = [...new Set(hits.flatMap((h) => h.words))];
  // The span is the injected literal that holds an unexplained unit's word, when one does (ISC-26.1).
  const owner = new Map<string, (typeof input.injected)[number]>();
  for (const item of input.injected) for (const w of words(item.text)) if (!owner.has(w)) owner.set(w, item);
  const item = all.flatMap((u) => u.split(" ")).map((w) => owner.get(w)).find((x) => x !== undefined);

  const first = hits[0]!;
  // A pair's words may sit apart, across punctuation or markup; a masked date name matches any word.
  const pattern = first.words[0]!.split(" ").map((w) => (w.startsWith("#") ? "\\p{L}+" : escapeRegExp(w))).join("\\P{L}+");
  const at = Math.max(0, first.text.search(new RegExp(`(?<!\\p{L})${pattern}(?!\\p{L})`, "u")));
  const sample = clip(first.text.slice(Math.max(0, at - SAMPLE_AROUND), at + SAMPLE_AROUND * 2).replaceAll("\u0000", " … "));
  const shown = all.slice(0, 8).join(", ");
  return {
    ruleId: "render_divergence",
    severity: "HIGH",
    message: `${hits.length === 1 ? `the ${first.probe} probe prints` : `${new Set(hits.map((h) => h.probe)).size} probes print`} text no ordinary-use probe prints: ${shown}${all.length > 8 ? " …" : ""}`,
    ...base,
    span: item ? item.span : { ...WHOLE_TEMPLATE },
    ...(item ? { excerpt: clip(item.text) } : {}),
    detail: {
      words: all.slice(0, MAX_LISTED_WORDS),
      wordCount: all.length,
      probeCount: hits.length,
      probes: hits.slice(0, MAX_LISTED_PROBES).map((h) => ({ probe: h.probe, profile: h.profile, words: h.words.slice(0, MAX_LISTED_WORDS) })),
      sample,
    },
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
