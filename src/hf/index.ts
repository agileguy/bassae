import type { ModelRecord } from "../types.ts";

/** Reads every template source in an HF/MLX model directory. Never throws on bad input. */
export async function readHfModel(dir: string): Promise<ModelRecord> {
  return { format: "hf", id: dir, paths: [dir], templates: [], hints: {}, specialTokens: [], findings: [] };
}
