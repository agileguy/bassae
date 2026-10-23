// Differential rendering (ISC-22 to ISC-22.4, ISC-43): renders each template against a probe matrix in the
// sandboxed renderer and reports what the output shows that static analysis cannot.
//
// Phase 3 seam: the signature is fixed; p3-probes owns the body.

import type { Transform } from "../registry/index.ts";
import type { DiffRenderInput, DiffRenderResult, Renderer } from "../types.ts";

/**
 * render_divergence, env_profile_divergence, content_integrity, tool_integrity and render_dos for one template.
 * Never throws: an internal failure is a scanner_error finding and an incomplete result.
 */
export async function diffRender(input: DiffRenderInput, renderer: Renderer, transforms: readonly Transform[]): Promise<DiffRenderResult> {
  void input;
  void renderer;
  void transforms;
  return { findings: [], complete: false, probes: { total: 0, rendered: 0, refused: 0, failed: 0 } };
}
