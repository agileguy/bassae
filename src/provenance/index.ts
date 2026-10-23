// Where a template came from and what it is compared with: local tamper checks,
// sibling comparisons, registry divergence and the one network call, --online.
// Each piece lives in its own file; this module is the seam the CLI imports.

export { checkLocalTamper, type TamperOptions } from "./tamper.ts";

/** local_comparison findings for a GGUF beside or linked to an HF source with its own template: labeled as a local comparison, never upstream, with a unified diff (ISC-23). pairLocal finds the pairs. */
export { compareLocal, type LocalPair, pairLocal } from "./local.ts";

/** Untrusted upstream candidates inferred from GGUF `general.*` metadata. Listed for the user; never used as a baseline (ISC-41.1). */
export { type CandidateHint, upstreamCandidateHints, upstreamCandidates } from "./baseline.ts";

// fetchUpstream(repo, revision, fetcher?, options?) fetches every chat template of `repo` at the pinned `revision`
// (--online --upstream), the only network call bassae makes (ISC-41). It lives in online.ts so the network code
// stays in one file.
export { type FetchOptions, fetchUpstream, UpstreamError } from "./online.ts";

/** The trusted baseline for a template: the registry entry it matches (the caller's own RegistryMatch, the one that set knownGood) or that is pinned to its repo, else a fetched upstream, else `none` (ISC-41.2). Never a sibling file, never a `general.*` guess. */
export { selectBaseline } from "./baseline.ts";

/** registry_divergence findings against a trusted baseline (ISC-25). Severity is the highest rule that fires on added or changed spans; changed literal text with no rule is MEDIUM; a control-flow-only rewrite whose probe output is identical is LOW. `analyze` runs every static rule on a template; `renderer` compares probe output. */
export { probeRequests, registryDivergence, sameIgnoringWhitespace } from "./divergence.ts";
