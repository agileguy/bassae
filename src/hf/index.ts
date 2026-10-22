import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModelRecord } from "../types.ts";
import { firstHfCacheLocation } from "./cache.ts";
import { problem, type ReadLimits, readTemplateSources, SourceReader } from "./sources.ts";
import { specialTokensFrom } from "./tokens.ts";

/** Reads every template source in an HF/MLX model directory, within `limits`. Never throws on bad input. */
export async function readHfModel(dir: string, limits: Partial<ReadLimits> = {}): Promise<ModelRecord> {
  const path = resolve(dir);
  const reader = new SourceReader(limits);
  const record: ModelRecord = {
    format: "hf",
    id: path,
    paths: [path],
    templates: [],
    hints: {},
    specialTokens: [],
    extractionComplete: false,
    findings: reader.findings,
  };
  try {
    if (!(await stat(path)).isDirectory()) {
      reader.findings.push(problem("scanner_error", "MEDIUM", path, "not a directory"));
      return record;
    }
    record.id = await realpath(path);
    const hfCache = firstHfCacheLocation([path, record.id]);
    if (hfCache) record.hfCache = hfCache;

    const sources = await readTemplateSources(path, reader);
    record.templates = sources.templates;
    record.hints = sources.hints;
    const tokenizer = await reader.json(join(path, "tokenizer.json"), "tokens");
    record.specialTokens = specialTokensFrom(tokenizer?.value, sources.tokenizerConfig);
    record.extractionComplete = reader.complete;
  } catch (e) {
    reader.findings.push(problem("scanner_error", "MEDIUM", path, "cannot read model directory", e));
  }
  return record;
}
