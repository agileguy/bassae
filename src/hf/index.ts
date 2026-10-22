import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Finding, ModelRecord } from "../types.ts";
import { firstHfCacheLocation } from "./cache.ts";
import { loadJson, problem, readTemplateSources } from "./sources.ts";
import { specialTokensFrom } from "./tokens.ts";

/** Reads every template source in an HF/MLX model directory. Never throws on bad input. */
export async function readHfModel(dir: string): Promise<ModelRecord> {
  const path = resolve(dir);
  const findings: Finding[] = [];
  const record: ModelRecord = { format: "hf", id: path, paths: [path], templates: [], hints: {}, specialTokens: [], findings };
  try {
    if (!(await stat(path)).isDirectory()) {
      findings.push(problem("scanner_error", "MEDIUM", path, "not a directory"));
      return record;
    }
    record.id = await realpath(path);
    const hfCache = firstHfCacheLocation([path, record.id]);
    if (hfCache) record.hfCache = hfCache;

    const sources = await readTemplateSources(path, findings);
    record.templates = sources.templates;
    record.hints = sources.hints;
    // tokenizer.json is not a template, so an oversized one only costs scaffolding: MEDIUM.
    const tokenizer = await loadJson(join(path, "tokenizer.json"), findings, "MEDIUM");
    record.specialTokens = specialTokensFrom(tokenizer?.value, sources.tokenizerConfig);
  } catch (e) {
    findings.push(problem("scanner_error", "MEDIUM", path, "cannot read model directory", e));
  }
  return record;
}
