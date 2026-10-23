// Content integrity (ISC-22.3): every system, user and tool content a probe passes reaches the output verbatim,
// in order, under its own role, unless a transform on the allowlist explains the difference.
//
// Phase 3 seam: the signature is fixed; p3-integrity owns the body.

import type { Transform } from "../registry/index.ts";
import type { IntegrityIssue, Probe } from "../types.ts";

/** The content_integrity issues in one rendered probe's output. Empty when every content arrived intact. */
export function checkContent(probe: Probe, output: string, transforms: readonly Transform[]): IntegrityIssue[] {
  void probe;
  void output;
  void transforms;
  return [];
}
