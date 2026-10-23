// Tool integrity (ISC-22.4): every tool definition a probe passes renders JSON-equivalent to its input, unless a
// transform on the allowlist documents the template's own rendering of it.
//
// Phase 3 seam: the signature is fixed; p3-integrity owns the body.

import type { Transform } from "../registry/index.ts";
import type { IntegrityIssue, Probe } from "../types.ts";

/** The tool_integrity issues in one rendered probe's output. Empty when the probe passes no tools or every tool arrived intact. */
export function checkTools(probe: Probe, output: string, transforms: readonly Transform[]): IntegrityIssue[] {
  void probe;
  void output;
  void transforms;
  return [];
}
