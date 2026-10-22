import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Finding, ModelRecord } from "../types.ts";
import { openFileSource, parseGguf, type ByteSource } from "./reader.ts";
import { CHAT_TEMPLATE_KEY, checkTemplateList, extractTemplates, templateName } from "./templates.ts";

export { bytesSource, openFileSource, parseGguf, type ByteSource } from "./reader.ts";

function emptyRecord(path: string, realPath: string): ModelRecord {
  return { format: "gguf", id: realPath, paths: [path], templates: [], hints: {}, specialTokens: [], findings: [] };
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
    // A FIFO or device would block or lie about its size.
    if (!statSync(realPath).isFile()) throw new Error("not a regular file");
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
  record.templates = extractTemplates(parse.templates, path, realPath);
  record.specialTokens = parse.specialTokens;
  record.ggufGeneral = parse.general;
  for (const p of parse.problems) {
    const f: Finding = { ruleId: p.ruleId, severity: p.severity, message: p.message, file: path };
    if (p.key !== undefined) {
      f.detail = { key: p.key };
      if (CHAT_TEMPLATE_KEY.test(p.key)) f.templateName = templateName(p.key);
    }
    record.findings.push(f);
  }
  // A list check on a partial parse would blame keys that were never reached.
  if (parse.kvEnd !== undefined) record.findings.push(...checkTemplateList(record.templates, parse.templateList, path));
  return record;
}
