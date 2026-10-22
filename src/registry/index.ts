// The checked-in known-good registry, runtime precedence table and transform
// allowlist. Their data lives in registry/ at the repo root and is only ever read.
// Phase 2 seam: signatures are fixed; bodies belong to the Registry engineer.

import type { Finding, ModelRecord, PrecedenceTable, Registry, RuntimeProfile, TemplateSource } from "../types.ts";

/** A documented legitimate content transform, such as stripping past `<think>` blocks (Constraints). Used by DiffRender in Phase 3. */
export interface Transform {
  id: string;
  description: string;
  /** Upstream repo, revision and path that documents it. */
  source: string;
}

/** Loads registry/known-good.json and the template text each entry pins. Throws when a pinned text does not hash to its entry's sha256. */
export function loadRegistry(dir?: string): Registry {
  throw new Error("not implemented");
}

/** Loads registry/precedence.json. */
export function loadPrecedence(dir?: string): PrecedenceTable {
  throw new Error("not implemented");
}

/** Loads registry/transforms.json. */
export function loadTransforms(dir?: string): Transform[] {
  throw new Error("not implemented");
}

/** For each runtime profile, the source in `model` that runtime would load as its default template, or undefined when it loads none (ISC-7.4). */
export function resolveProfiles(model: ModelRecord, table: PrecedenceTable): Record<RuntimeProfile, TemplateSource | undefined> {
  throw new Error("not implemented");
}

/** MEDIUM intra_model_divergence findings, each with a unified diff in `detail`, for sources in one model that differ; sets `shadowed` on every template no profile loads (ISC-7.5). */
export function checkIntraModel(model: ModelRecord, table: PrecedenceTable): Finding[] {
  throw new Error("not implemented");
}
