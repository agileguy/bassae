// Which text a template is judged against (ISC-41.1, ISC-41.2). Only two things
// are trusted: a registry entry pinned to repo@revision, and an upstream text
// fetched at a pinned revision. A sibling file and a GGUF's `general.*` metadata
// both travel with the file under suspicion, so either can be forged with it.
//
// general.* keys are from llama.cpp gguf-py/gguf/constants.py at tag v0.7.0
// (620d2225cc436ab0b001e3200e590e3b286ef9ab): general.url, general.repo_url,
// general.source.url, general.source.repo_url and general.base_model.{id}.url /
// .repo_url. Older converters wrote general.source.huggingface.repository (a bare
// repo id; present at b2000 and b3400, gone by v0.7.0). base_model.{id}.name and
// .organization are display titles, not repo ids, so they are never read.

import { relative, sep } from "node:path";
import { hfCacheLocations, parseHfCachePath } from "../hf/cache.ts";
import type { Baseline, ExtractedTemplate, HfCacheLocation, KnownGoodTemplate, ModelRecord, Registry, RegistryMatch } from "../types.ts";
import { isRepoId, repoFromHubUrl } from "./hub.ts";

export interface CandidateHint {
  /** The hub id the value names, `org/name`. */
  repo: string;
  /** The general.* key it was read from. */
  key: string;
}

// The upstream a converter recorded comes first, then the models it derives from, then the file's own page.
const SOURCE_KEYS = ["general.source.huggingface.repository", "general.source.repo_url", "general.source.url"];
const OWN_KEYS = ["general.repo_url", "general.url"];
const BASE_MODEL_KEY = /^general\.base_model\.(\d+)\.(repo_url|url)$/;

/** Every hub repo a GGUF's general.* metadata names, with the key that named it, in the order above. */
export function upstreamCandidateHints(model: ModelRecord): CandidateHint[] {
  const general = model.ggufGeneral;
  if (!general) return [];
  const base = Object.keys(general)
    .map((key) => ({ key, m: BASE_MODEL_KEY.exec(key) }))
    .filter((x): x is { key: string; m: RegExpExecArray } => x.m !== null)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]) || (a.m[2] === "repo_url" ? -1 : 1))
    .map((x) => x.key);
  const out: CandidateHint[] = [];
  const seen = new Set<string>();
  for (const key of [...SOURCE_KEYS, ...base, ...OWN_KEYS]) {
    const value = general[key];
    if (typeof value !== "string") continue;
    const repo = key === SOURCE_KEYS[0] && isRepoId(value.trim()) ? value.trim() : repoFromHubUrl(value);
    if (!repo || seen.has(repo)) continue;
    seen.add(repo);
    out.push({ repo, key });
  }
  return out;
}

/** The repos alone: untrusted, listed for the user, never a baseline (ISC-41.1). */
export function upstreamCandidates(model: ModelRecord): string[] {
  return upstreamCandidateHints(model).map((h) => h.repo);
}

/**
 * In order: the registry entry the template matches; else a registry entry pinned to the repo the model sits
 * in inside a Hugging Face cache, with the same template name; else a supplied upstream baseline with the
 * same template name; else `none`. The repo comes only from the cache path, never from general.* hints.
 *
 * `match` is the caller's own registry.match(template), the one that decided knownGood for the rules, so
 * the rules and the baseline can never be told two different things about the same template.
 */
export function selectBaseline(template: ExtractedTemplate, model: ModelRecord, match: RegistryMatch, registry: Registry, upstream: readonly Baseline[] = []): Baseline {
  if (match.kind !== "none") return { kind: "registry", known: match.known };

  const path = pathInRepo(template, model);
  const pinned = pinnedEntry(template, hfCacheLocations([template.source.path, ...model.paths, model.id]), path, registry);
  if (pinned) return { kind: "registry", known: pinned };

  const fetched = upstream.filter((b): b is Extract<Baseline, { kind: "upstream" }> => b.kind === "upstream" && b.templateName === template.source.name);
  const best = fetched.find((b) => b.text === template.text) ?? fetched.find((b) => b.path === path) ?? fetched[0];
  return best ?? { kind: "none" };
}

// The template's file as a repo path: from its cache location, else relative to the HF model directory. A GGUF has none.
function pathInRepo(template: ExtractedTemplate, model: ModelRecord): string | undefined {
  const cached = parseHfCachePath(template.source.path)?.pathInRepo;
  if (cached) return cached;
  if (model.format !== "hf" || !model.paths[0]) return undefined;
  const rel = relative(model.paths[0], template.source.path);
  return rel && !rel.startsWith("..") ? rel.split(sep).join("/") : undefined;
}

// Ranked: same revision and file, same revision, same file, then registry order.
function pinnedEntry(template: ExtractedTemplate, where: HfCacheLocation[], path: string | undefined, registry: Registry): KnownGoodTemplate | undefined {
  let best: KnownGoodTemplate | undefined;
  let bestScore = -1;
  for (const loc of where) {
    for (const known of registry.forRepo(loc.repo)) {
      if (known.entry.templateName !== template.source.name) continue;
      const score = (known.entry.revision === loc.revision ? 2 : 0) + (known.entry.path === path ? 1 : 0);
      if (score > bestScore) {
        best = known;
        bestScore = score;
      }
    }
  }
  return best;
}
