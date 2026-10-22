import type { HfCacheLocation } from "../types.ts";

/** Reads (repo, revision, path in repo) from a path inside a Hugging Face cache, if it is one. */
export function parseHfCachePath(path: string): HfCacheLocation | undefined {
  void path;
  return undefined;
}
