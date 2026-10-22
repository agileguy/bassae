import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { firstHfCacheLocation } from "../hf/cache.ts";
import type { Finding, ModelRecord } from "../types.ts";
import { openFileSource, parseGguf, type ByteSource } from "./reader.ts";
import { checkDefaultPair, checkTemplateList, extractTemplates, isTemplateKey, templateName } from "./templates.ts";

export { bytesSource, openFileSource, parseGguf, type ByteSource } from "./reader.ts";

function emptyRecord(path: string, realPath: string): ModelRecord {
  const record: ModelRecord = { format: "gguf", id: realPath, paths: [path], templates: [], hints: {}, specialTokens: [], extractionComplete: false, findings: [] };
  // The same lookup the HF reader makes. A snapshot path holds the location; its blob path does not.
  const hfCache = firstHfCacheLocation([path, realPath]);
  if (hfCache) record.hfCache = hfCache;
  return record;
}

function scannerError(path: string, e: unknown): Finding {
  return { ruleId: "scanner_error", severity: "MEDIUM", message: `could not read ${path}: ${(e as Error)?.message ?? e}`, file: path };
}

/** Reads one GGUF file's header and KV section. Never throws: every failure becomes a finding. */
export async function readGgufModel(path: string): Promise<ModelRecord> {
  const abs = resolve(path);
  let realPath = abs;
  try {
    realPath = realpathSync(abs);
    const src = openFileSource(realPath);
    try {
      return readGgufSource(src, abs, realPath);
    } finally {
      src.close();
    }
  } catch (e) {
    const record = emptyRecord(abs, realPath);
    record.findings.push(scannerError(abs, e));
    return record;
  }
}

/** The same, over any byte source. `path` labels the record and its findings. */
export function readGgufSource(src: ByteSource, path: string, realPath = path): ModelRecord {
  const record = emptyRecord(path, realPath);
  let parse;
  try {
    parse = parseGguf(src);
  } catch (e) {
    record.findings.push(scannerError(path, e));
    return record;
  }
  const { templates, views, findings } = extractTemplates(parse.templates, path, realPath);
  record.templates = [...templates, ...views];
  record.specialTokens = parse.specialTokens;
  record.ggufGeneral = parse.general;
  record.extractionComplete = parse.complete;
  for (const p of parse.problems) {
    const f: Finding = { ruleId: p.ruleId, severity: p.severity, message: p.message, file: path };
    if (p.key !== undefined) {
      f.detail = { key: p.key };
      if (isTemplateKey(p.key)) f.templateName = templateName(p.key);
    }
    record.findings.push(f);
  }
  record.findings.push(...findings, ...checkDefaultPair(templates, path));
  // A list check on a partial parse would blame keys that were never reached. Views are not keys, so they stay out of it.
  if (parse.kvEnd !== undefined) record.findings.push(...checkTemplateList(templates, parse.templateList, path));
  return record;
}
