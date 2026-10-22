// Where a template came from and what it is compared with: local tamper checks,
// sibling comparisons, registry divergence and the one network call, --online.
// Phase 2 seam: signatures are fixed; bodies belong to the Provenance engineer.

import type { Baseline, ExtractedTemplate, Finding, ModelRecord, Registry, Renderer, RuleResult } from "../types.ts";

/** HIGH local_tamper for each HF-cache blob, or file with a .cache/huggingface/download/*.metadata record, whose content no longer matches its git blob hash (ISC-40). */
export async function checkLocalTamper(model: ModelRecord): Promise<Finding[]> {
  throw new Error("not implemented");
}

/** local_comparison findings for a GGUF beside or linked to an HF source with its own template: labeled as a local comparison, never upstream, with a unified diff (ISC-23). */
export function compareLocal(gguf: ModelRecord, hf: ModelRecord): Finding[] {
  throw new Error("not implemented");
}

/** Untrusted upstream candidates inferred from GGUF `general.*` metadata. Listed for the user; never used as a baseline (ISC-41.1). */
export function upstreamCandidates(model: ModelRecord): string[] {
  throw new Error("not implemented");
}

/** Fetches every chat template of `repo` at the pinned `revision` (--online --upstream). The only network call bassae makes (ISC-41). */
export async function fetchUpstream(repo: string, revision: string, fetcher?: typeof fetch): Promise<Baseline[]> {
  throw new Error("not implemented");
}

/** The trusted baseline for a template: the registry entry it matches or that is pinned to its repo, else a fetched upstream, else `none` (ISC-41.2). Never a sibling file, never a `general.*` guess. */
export function selectBaseline(template: ExtractedTemplate, model: ModelRecord, registry: Registry, upstream?: readonly Baseline[]): Baseline {
  throw new Error("not implemented");
}

/** registry_divergence findings against a trusted baseline (ISC-25). Severity is the highest rule that fires on added or changed spans; changed literal text with no rule is MEDIUM; a control-flow-only rewrite whose probe output is identical is LOW. `analyze` runs every static rule on a template; `renderer` compares probe output. */
export async function registryDivergence(
  template: ExtractedTemplate,
  baseline: Baseline,
  analyze: (t: ExtractedTemplate) => RuleResult,
  renderer?: Renderer,
): Promise<Finding[]> {
  throw new Error("not implemented");
}
