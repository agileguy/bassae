import { resolve } from "node:path";
import { problem, SourceReader } from "./hf/sources.ts";
import { makeTemplate } from "./template.ts";
import type { ModelRecord } from "./types.ts";

/** Wraps a single template file passed with --template as a one-template record (ISC-39). Never throws. */
export async function readBareTemplate(path: string): Promise<ModelRecord> {
  const abs = resolve(path);
  const reader = new SourceReader();
  const record: ModelRecord = {
    format: "bare",
    id: abs,
    paths: [abs],
    templates: [],
    hints: {},
    specialTokens: [],
    extractionComplete: false,
    findings: reader.findings,
  };
  const file = await reader.file(abs, "template");
  if (file) {
    record.id = file.realPath;
    record.templates.push(makeTemplate({ kind: "bare", path: abs, realPath: file.realPath, name: "default" }, file.bytes));
    record.extractionComplete = true;
  } else if (reader.findings.length === 0) {
    // The reader treats a missing source as normal; a missing --template is the caller's mistake.
    reader.findings.push(problem("scanner_error", "MEDIUM", abs, "no such file"));
  }
  return record;
}
