// Discovery plus the readers: every model the walk finds, read once, and every --template file (ISC-39).
// A reader that fails costs only its own model (ISC-9).

import { readBareTemplate } from "../bare.ts";
import { discover } from "../discover.ts";
import { readGgufModel } from "../gguf/index.ts";
import { readHfModel } from "../hf/index.ts";
import type { DiscoveredModel, Finding, ModelRecord } from "../types.ts";

/** Walks the roots and reads every model, plus each bare template. The walk's own findings come back beside the models. */
export async function loadModels(roots: string[], templates: string[]): Promise<{ models: ModelRecord[]; findings: Finding[] }> {
  const discovery = await discover(roots);
  const models: ModelRecord[] = [];
  for (const found of discovery.models) models.push(await readModel(found));
  for (const path of templates) {
    try {
      models.push(await readBareTemplate(path));
    } catch (e) {
      models.push(failed("bare", path, path, e));
    }
  }
  return { models, findings: discovery.findings };
}

async function readModel(found: DiscoveredModel): Promise<ModelRecord> {
  const at = found.paths[0] ?? found.id;
  let record: ModelRecord;
  try {
    record = found.format === "gguf" ? await readGgufModel(at) : await readHfModel(at);
  } catch (e) {
    // The readers never throw by contract. One that does still leaves the model listed, incomplete.
    record = failed(found.format, found.id, at, e);
  }
  // Every path the walk reached the model through, the one it was read at first (ISC-11.1).
  record.paths = [...new Set([...record.paths, ...found.paths])];
  if (!record.hfCache && found.hfCache) record.hfCache = found.hfCache;
  return record;
}

function failed(format: ModelRecord["format"], id: string, path: string, e: unknown): ModelRecord {
  const message = `could not read ${path}: ${e instanceof Error ? e.message : String(e)}`;
  return {
    format,
    id,
    paths: [path],
    templates: [],
    hints: {},
    specialTokens: [],
    extractionComplete: false,
    findings: [{ ruleId: "scanner_error", severity: "MEDIUM", message, file: path }],
  };
}
