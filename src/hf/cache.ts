import type { HfCacheLocation } from "../types.ts";

// Hub cache layout: <cache>/models--<org>--<name>/snapshots/<revision>/<path in repo>.
// The hub forbids "--" inside repo ids, so splitting the folder name on it is unambiguous.

/** Reads (repo, revision, path in repo) from a path inside a Hugging Face cache, if it is one. */
export function parseHfCachePath(path: string): HfCacheLocation | undefined {
  const parts = path.split("/");
  // Innermost layout wins: a repo can vendor a cache tree of its own.
  for (let i = parts.length - 3; i >= 0; i--) {
    const folder = parts[i]!;
    if (!folder.startsWith("models--") || parts[i + 1] !== "snapshots") continue;
    const revision = parts[i + 2];
    if (!revision) continue;
    return {
      repo: folder.slice("models--".length).split("--").join("/"),
      revision,
      pathInRepo: parts.slice(i + 3).filter(Boolean).join("/"),
    };
  }
  return undefined;
}

/** Every distinct cache location among the given paths, in order. */
export function hfCacheLocations(paths: Iterable<string>): HfCacheLocation[] {
  const seen = new Set<string>();
  const out: HfCacheLocation[] = [];
  for (const p of paths) {
    const loc = parseHfCachePath(p);
    if (!loc) continue;
    const key = `${loc.repo}\0${loc.revision}\0${loc.pathInRepo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(loc);
  }
  return out;
}

/** The first cache location among the given paths. */
export function firstHfCacheLocation(paths: Iterable<string>): HfCacheLocation | undefined {
  for (const p of paths) {
    const loc = parseHfCachePath(p);
    if (loc) return loc;
  }
  return undefined;
}
