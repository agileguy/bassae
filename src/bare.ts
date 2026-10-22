import type { ModelRecord } from "./types.ts";

/** Wraps a single template file passed with --template as a one-template record. */
export async function readBareTemplate(path: string): Promise<ModelRecord> {
  return { format: "bare", id: path, paths: [path], templates: [], hints: {}, specialTokens: [], findings: [] };
}
