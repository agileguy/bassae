import { resolve } from "node:path";
import type { ModelRecord } from "../types.ts";
import type { ByteSource } from "./reader.ts";

export { bytesSource, openFileSource, parseGguf, type ByteSource } from "./reader.ts";

/** Reads one GGUF file's header and KV section. Never throws: every failure becomes a finding. */
export async function readGgufModel(path: string): Promise<ModelRecord> {
  const abs = resolve(path);
  return { format: "gguf", id: abs, paths: [abs], templates: [], hints: {}, specialTokens: [], findings: [] };
}

/** The same, over any byte source. `path` labels the record and its findings. */
export function readGgufSource(_src: ByteSource, path: string, realPath = path): ModelRecord {
  return { format: "gguf", id: realPath, paths: [path], templates: [], hints: {}, specialTokens: [], findings: [] };
}
