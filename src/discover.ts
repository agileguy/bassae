import type { DiscoveredModel } from "./types.ts";

/** Walks every root and returns each GGUF file and HF/MLX model directory once. */
export async function discover(roots: string[]): Promise<DiscoveredModel[]> {
  void roots;
  return [];
}
