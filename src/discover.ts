import type { Dirent, Stats } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { isGguf } from "./gguf/magic.ts";
import { firstHfCacheLocation } from "./hf/cache.ts";
import { HF_SOURCE_NAMES } from "./hf/sources.ts";
import type { DiscoveredModel } from "./types.ts";

/** A path the walk could not read. The CLI decides what that does to coverage. */
export interface WalkError {
  path: string;
  message: string;
}

export interface WalkResult {
  models: DiscoveredModel[];
  errors: WalkError[];
}

// The hub's negative-cache sentinels: zero-byte files named like real sources.
const SKIP_NAMES = new Set([".no_exist"]);

// Bounds the path list a pathological symlink graph could otherwise grow without end.
const MAX_PATHS_PER_MODEL = 256;

/** Walks every root and returns each GGUF file and HF/MLX model directory once. */
export async function discover(roots: string[]): Promise<DiscoveredModel[]> {
  return (await walk(roots)).models;
}

/** discover, plus every path that could not be read. */
export async function walk(roots: string[]): Promise<WalkResult> {
  const walker = new Walker();
  for (const root of roots) await walker.root(resolve(root));
  return walker.result();
}

class Walker {
  // Each directory walked, by (dev, inode), and the path it was walked at. A directory is walked once.
  private readonly dirs = new Map<string, string>();
  // A walked directory reached again at `to`: whatever was found under `from` is reachable there too.
  private readonly aliases: { from: string; to: string }[] = [];
  private readonly models = new Map<string, DiscoveredModel>();
  // GGUF verdict per realpath, so a blob linked from many snapshots is opened once.
  private readonly magic = new Map<string, boolean>();
  private readonly errors: WalkError[] = [];

  async root(path: string): Promise<void> {
    const st = await this.stat(path);
    if (st) await this.visit(path, st);
  }

  result(): WalkResult {
    const models = [...this.models.values()].map((m) => {
      const paths = this.expand(m.paths);
      const hfCache = firstHfCacheLocation([...paths, m.id]);
      return hfCache ? { ...m, paths, hfCache } : { ...m, paths };
    });
    return { models, errors: this.errors };
  }

  private async visit(path: string, st: Stats): Promise<void> {
    if (st.isDirectory()) await this.dir(path, st);
    else if (st.isFile()) await this.file(path);
  }

  private async dir(path: string, st: Stats): Promise<void> {
    const key = `${st.dev}:${st.ino}`;
    const first = this.dirs.get(key);
    if (first !== undefined) {
      // A path inside the directory it leads back to is a loop and adds nothing.
      if (path !== first && !path.startsWith(first + sep)) this.aliases.push({ from: first, to: path });
      return;
    }
    this.dirs.set(key, path);

    let entries: Dirent[];
    try {
      entries = (await readdir(path, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch (e) {
      this.fail(path, e);
      return;
    }
    if (entries.some((e) => HF_SOURCE_NAMES.has(e.name))) {
      const id = await this.realpath(path);
      if (id) this.add("hf", id, path);
    }
    for (const entry of entries) {
      if (SKIP_NAMES.has(entry.name)) continue;
      const child = join(path, entry.name);
      if (entry.isFile()) await this.file(child);
      else if (entry.isDirectory() || entry.isSymbolicLink()) {
        const st = await this.stat(child);
        if (st) await this.visit(child, st);
      }
    }
  }

  // GGUF by magic bytes only, whatever the name (ISC-1).
  private async file(path: string): Promise<void> {
    const real = await this.realpath(path);
    if (!real) return;
    let gguf = this.magic.get(real);
    if (gguf === undefined) {
      gguf = await isGguf(real);
      this.magic.set(real, gguf);
    }
    if (gguf) this.add("gguf", real, path);
  }

  private add(format: DiscoveredModel["format"], id: string, path: string): void {
    const m = this.models.get(id);
    if (!m) this.models.set(id, { format, id, paths: [path] });
    else if (!m.paths.includes(path)) m.paths.push(path);
  }

  private expand(paths: string[]): string[] {
    const out = [...paths];
    const seen = new Set(out);
    for (let i = 0; i < out.length; i++) {
      const p = out[i]!;
      for (const { from, to } of this.aliases) {
        if (out.length >= MAX_PATHS_PER_MODEL) return out;
        if (p !== from && !p.startsWith(from + sep)) continue;
        const q = to + p.slice(from.length);
        if (!seen.has(q)) {
          seen.add(q);
          out.push(q);
        }
      }
    }
    return out;
  }

  private async stat(path: string): Promise<Stats | undefined> {
    try {
      return await stat(path);
    } catch (e) {
      this.fail(path, e);
      return undefined;
    }
  }

  private async realpath(path: string): Promise<string | undefined> {
    try {
      return await realpath(path);
    } catch (e) {
      this.fail(path, e);
      return undefined;
    }
  }

  private fail(path: string, e: unknown): void {
    this.errors.push({ path, message: e instanceof Error ? e.message : String(e) });
  }
}
