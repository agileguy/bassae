// One template's analysis: the static rules, its trusted baseline and the divergence from it, and
// differential rendering. Identical inputs are analyzed once across the whole scan, however many places
// hold the template (ISC-11).
//
// The input is the template's bytes, the scaffolding its model gives it, how it matches the registry and
// the baseline it is compared with. Two copies agreeing on all four get the same answer, so the second
// takes the first's result, re-stamped with its own file. The cache keeps the promise, so a copy that
// arrives while the first is still rendering waits for it rather than rendering again.

import { createHash } from "node:crypto";
import { registryDivergence, selectBaseline } from "../provenance/index.ts";
import type { Transform } from "../registry/index.ts";
import { pushAll } from "../rules/finalize.ts";
import { analyzeCodeExec } from "../rules/index.ts";
import { analyzeInjection, buildScaffolding } from "../rules/injection.ts";
import type {
  AnalysisContext,
  Baseline,
  DiffRenderResult,
  ExtractedTemplate,
  Finding,
  InjectedText,
  KnownGoodTemplate,
  ModelRecord,
  Registry,
  RegistryMatch,
  Renderer,
  RuleResult,
  ScanOptions,
  TriggerCandidate,
} from "../types.ts";

export interface AnalyzeEnv {
  registry: Registry;
  /** Baselines fetched with --online --upstream, else empty. */
  upstream: readonly Baseline[];
  /** The sandboxed renderer, absent when `unavailable` says why there is none. */
  renderer?: Renderer;
  unavailable?: string;
  transforms: readonly Transform[];
  diffRender: NonNullable<ScanOptions["diffRender"]>;
}

/** What one template's analysis gives its report. */
export interface Analysis {
  match: RegistryMatch;
  baseline: Baseline;
  findings: Finding[];
  injected: InjectedText[];
  triggers: TriggerCandidate[];
  probes: DiffRenderResult["probes"];
  /** One line per analysis that did not finish (ISC-42.1). */
  gaps: string[];
}

type Result = Omit<Analysis, "match" | "baseline"> & { template: ExtractedTemplate };

const NO_PROBES: DiffRenderResult["probes"] = { total: 0, rendered: 0, refused: 0, failed: 0 };

/** An analyzer for one scan. Call it once per template; identical inputs share one analysis. */
export function createAnalyzer(env: AnalyzeEnv): (template: ExtractedTemplate, model: ModelRecord) => Promise<Analysis> {
  const cache = new Map<string, Promise<Result>>();
  const scaffoldings = new WeakMap<ModelRecord, Map<KnownGoodTemplate | undefined, Scaffolding>>();
  const upstreamKnown = new WeakMap<Baseline, KnownGoodTemplate>();

  // Scaffolding depends only on the model and the baseline, so a GGUF repeating one template under
  // thousands of names builds it once, not once per name.
  const scaffoldingOf = (model: ModelRecord, known: KnownGoodTemplate | undefined): Scaffolding => {
    let byKnown = scaffoldings.get(model);
    if (!byKnown) scaffoldings.set(model, (byKnown = new Map()));
    let s = byKnown.get(known);
    if (!s) byKnown.set(known, (s = scaffolding(buildScaffolding(model, known))));
    return s;
  };

  // The baseline's text is what the rules read as the template's own (ISC-17.1): an exact or whitespace
  // match, else the pinned registry entry or fetched upstream it diverges from. Literals the baseline
  // already emits are then not injected text, and only what the copy adds is.
  const knownOf = (match: RegistryMatch, baseline: Baseline): KnownGoodTemplate | undefined => {
    if (match.kind !== "none") return match.known;
    if (baseline.kind === "registry") return baseline.known;
    if (baseline.kind === "none") return undefined;
    let k = upstreamKnown.get(baseline);
    if (!k) {
      const { repo, revision, path, templateName, text } = baseline;
      const sha256 = createHash("sha256").update(text).digest("hex");
      upstreamKnown.set(baseline, (k = { entry: { family: "upstream", repo, revision, path, templateName, sha256 }, text }));
    }
    return k;
  };

  return async (template, model) => {
    const match = env.registry.match(template);
    const baseline = selectBaseline(template, model, match, env.registry, env.upstream);
    const known = knownOf(match, baseline);
    const s = scaffoldingOf(model, known);
    const ctx: AnalysisContext = { template, scaffolding: s.set, knownGood: match.kind === "exact", ...(known ? { known } : {}) };
    const key = [template.sha256, match.kind, baselineId(baseline), s.hash].join("\0");
    let result = cache.get(key);
    if (!result) cache.set(key, (result = analyze(ctx, baseline, env)));
    return { match, baseline, ...restamp(await result, template) };
  };
}

interface Scaffolding {
  set: ReadonlySet<string>;
  /** Over the sorted UTF-16 code units, so two sets differing only in a lone surrogate never collide. */
  hash: string;
}

function scaffolding(set: ReadonlySet<string>): Scaffolding {
  const h = createHash("sha256");
  for (const s of [...set].sort()) h.update(`${s.length}:`).update(Buffer.from(s, "utf16le"));
  return { set, hash: h.digest("hex") };
}

function baselineId(b: Baseline): string {
  if (b.kind === "none") return "none";
  const { repo, revision, path, templateName } = b.kind === "registry" ? b.known.entry : b;
  return JSON.stringify([b.kind, repo, revision, path, templateName]);
}

async function analyze(ctx: AnalysisContext, baseline: Baseline, env: AnalyzeEnv): Promise<Result> {
  const t = ctx.template;
  const base = { file: t.source.path, templateName: t.source.name, templateSha256: t.sha256 };
  const codeExec = analyzeCodeExec(ctx);
  const injection = analyzeInjection(ctx);
  const findings = [...codeExec.findings, ...injection.findings];
  const gaps: string[] = [];
  if (!codeExec.complete) gaps.push("code-execution analysis incomplete");
  if (!injection.complete) gaps.push("injection analysis incomplete");

  // Divergence weighs every static finding on the changed lines, code execution included (Decisions 20:55).
  // They are already computed, so the callback hands them back rather than running the rules again.
  const rules: RuleResult = { findings: [...findings], complete: codeExec.complete && injection.complete };
  try {
    pushAll(findings, await registryDivergence(t, baseline, () => rules, env.renderer));
  } catch (e) {
    pushAll(findings, [{ ruleId: "scanner_error", severity: "MEDIUM", message: `baseline comparison failed: ${errorText(e)}`, ...base }]);
    gaps.push("baseline comparison incomplete");
  }

  let probes = NO_PROBES;
  if (env.unavailable !== undefined || !env.renderer) {
    gaps.push(`renderer unavailable: ${env.unavailable ?? "none supplied"}`);
  } else {
    try {
      const r = await env.diffRender({ template: t, injected: injection.injected, triggers: injection.triggers, reads: injection.reads, scaffolding: ctx.scaffolding }, env.renderer, env.transforms);
      pushAll(findings, r.findings);
      probes = r.probes;
      if (!r.complete) {
        const p = r.probes;
        gaps.push(`differential rendering incomplete: ${p.rendered} of ${p.total} probes rendered, ${p.refused} refused, ${p.failed} failed`);
      }
      for (const g of r.gaps ?? []) gaps.push(`differential rendering incomplete: ${g}`);
    } catch (e) {
      // diffRender never throws by contract; a hook that does costs this template its coverage, not the scan.
      pushAll(findings, [{ ruleId: "scanner_error", severity: "MEDIUM", message: `differential rendering failed: ${errorText(e)}`, ...base }]);
      gaps.push("differential rendering incomplete: it failed before rendering");
    }
  }
  return { template: t, findings, injected: injection.injected, triggers: injection.triggers, probes, gaps };
}

// A shared result names the file it was computed for; each other copy gets its own file and name.
function restamp(r: Result, t: ExtractedTemplate): Omit<Analysis, "match" | "baseline"> {
  const own = r.template;
  const findings =
    own === t
      ? [...r.findings]
      : r.findings.map((f) => ({
          ...f,
          ...(f.file === own.source.path ? { file: t.source.path } : {}),
          ...(f.templateName === own.source.name ? { templateName: t.source.name } : {}),
        }));
  return { findings, injected: [...r.injected], triggers: [...r.triggers], probes: { ...r.probes }, gaps: [...r.gaps] };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
