// The scan pipeline: discovery, the readers, every rule, provenance and differential rendering, folded into
// one report with one status per template (ISC-42) and the exit code (ISC-28).
//
// The pieces: load.ts reads the models, analyze.ts analyzes each distinct template once, attach.ts places
// model findings, and pipeline.ts runs them in order.

import { createRenderer, sandboxAvailable } from "../sandbox/index.ts";
import type { ScanOptions, ScanReport } from "../types.ts";
import { type Loaded, loadModels as load } from "./load.ts";
import { checkUsage, scanWith } from "./pipeline.ts";

export type { Loaded } from "./load.ts";
export { ScanUsageError } from "./pipeline.ts";

/**
 * Scans every root and bare template. Never throws for anything a scanned file contains; read-only under
 * every root (ISC-35). Throws ScanUsageError for `upstream` without `online`, before anything is read.
 */
export async function scan(options: ScanOptions): Promise<ScanReport> {
  checkUsage(options);
  if (options.renderer) return scanWith(options, { status: { available: true, kind: "supplied", degraded: [] }, renderer: options.renderer });
  const status = await sandboxAvailable();
  return scanWith(options, status.available ? { status, renderer: createRenderer() } : { status });
}

/** Walks the roots and reads every model, plus each bare template, exactly as `scan` does. `--extract` reads models through here. */
export async function loadModels(roots: string[], templates: string[]): Promise<Loaded> {
  return load(roots, templates);
}
