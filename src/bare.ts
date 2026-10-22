import { resolve } from "node:path";
import { loadFile, problem } from "./hf/sources.ts";
import { makeTemplate } from "./template.ts";
import type { Finding, ModelRecord } from "./types.ts";

/** Wraps a single template file passed with --template as a one-template record (ISC-39). Never throws. */
export async function readBareTemplate(path: string): Promise<ModelRecord> {
  const abs = resolve(path);
  const findings: Finding[] = [];
  const record: ModelRecord = { format: "bare", id: abs, paths: [abs], templates: [], hints: {}, specialTokens: [], findings };
  const file = await loadFile(abs, findings, "HIGH");
  if (file) {
    record.id = file.realPath;
    record.templates.push(makeTemplate({ kind: "bare", path: abs, realPath: file.realPath, name: "default" }, file.bytes));
  } else if (findings.length === 0) {
    // loadFile treats a missing source as normal; a missing --template is not.
    findings.push(problem("scanner_error", "MEDIUM", abs, "no such file"));
  }
  return record;
}
