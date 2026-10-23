// The scan pipeline: discovery, the readers, every rule, provenance and differential rendering, folded into
// one report with one status per template (ISC-42) and the exit code (ISC-28).
//
// Phase 3 seam: the signatures are fixed; p3-scan owns the bodies.

import type { Finding, ModelRecord, ScanOptions, ScanReport } from "../types.ts";

/** Scans every root and bare template. Never throws for anything a scanned file contains; read-only under every root (ISC-35). */
export async function scan(options: ScanOptions): Promise<ScanReport> {
  void options;
  throw new Error("scan: not implemented");
}

/** Walks the roots and reads every model, plus each bare template, exactly as `scan` does. `--extract` reads models through here. */
export async function loadModels(roots: string[], templates: string[]): Promise<{ models: ModelRecord[]; findings: Finding[] }> {
  void roots;
  void templates;
  throw new Error("loadModels: not implemented");
}
