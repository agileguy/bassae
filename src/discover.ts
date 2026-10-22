import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { isGguf } from "./gguf/magic.ts";
import { firstHfCacheLocation } from "./hf/cache.ts";
import { HF_SOURCE_NAMES, problem } from "./hf/sources.ts";
import type { DiscoveredModel, Finding, Severity } from "./types.ts";

export interface Discovery {
  models: DiscoveredModel[];
  /** scanner_error findings: paths that could not be read, links not followed, budgets run out. The CLI decides what they do to coverage. */
  findings: Finding[];
}

/** What one walk may do. Running out is a HIGH finding, never a silent stop. */
export interface WalkLimits {
  /** Directory entries examined, roots included. The walk stops when they run out. */
  maxEntries: number;
  /** Symlinks followed. Past this, links are reported and skipped; real directories are still walked. */
  maxSymlinks: number;
}

export const DEFAULT_WALK_LIMITS: WalkLimits = { maxEntries: 1_000_000, maxSymlinks: 100_000 };

// The hub's negative-cache sentinels: zero-byte files named like real sources.
const SKIP_NAMES = new Set([".no_exist"]);

// Kernel filesystems: huge or endless, full of files that block or change when read, and no place for a model.
const PSEUDO_FS = ["/proc", "/sys", "/dev"];

// Bounds the path list a pathological symlink graph could otherwise grow without end.
const MAX_PATHS_PER_MODEL = 256;

/** Walks every root and returns each GGUF file and HF/MLX model directory once, with everything it could not walk. */
export async function discover(roots: string[], limits: Partial<WalkLimits> = {}): Promise<Discovery> {
  const walker = new Walker({ ...DEFAULT_WALK_LIMITS, ...limits });
  for (const root of roots) await walker.root(resolve(root));
  return walker.result();
}

class Walker {
  // Each directory walked, by (dev, inode), and the path it was walked at. A directory is walked once.
  private readonly dirs = new Map<string, string>();
  // A walked directory reached again elsewhere: whatever was found under the key is reachable under each value too.
  private readonly aliases = new Map<string, string[]>();
  private readonly models = new Map<string, DiscoveredModel>();
  // GGUF verdict per realpath, so a blob linked from many snapshots is opened once.
  private readonly magic = new Map<string, boolean>();
  private readonly findings: Finding[] = [];
  private entries = 0;
  private links = 0;
  private stopped = false;
  private linksSkipped?: Finding;

  constructor(private readonly limits: WalkLimits) {}

  // A root is walked as given, even inside a kernel filesystem: the user asked for it.
  async root(path: string): Promise<void> {
    if (!this.spend(path)) return;
    const real = await this.try(path, () => realpath(path));
    const st = real && (await this.try(path, () => stat(path)));
    if (real && st) await this.visit(path, real, st);
  }

  result(): Discovery {
    const models = [...this.models.values()].map((m) => {
      const paths = this.expand(m.paths);
      const hfCache = firstHfCacheLocation([...paths, m.id]);
      return hfCache ? { ...m, paths, hfCache } : { ...m, paths };
    });
    return { models, findings: this.findings };
  }

  // `real` is the realpath of `path`, carried down so plain entries need no realpath call of their own.
  private async visit(path: string, real: string, st: Stats): Promise<void> {
    if (st.isDirectory()) await this.dir(path, real, st);
    else if (st.isFile()) await this.file(path, real);
  }

  private async dir(path: string, real: string, st: Stats): Promise<void> {
    const key = `${st.dev}:${st.ino}`;
    const first = this.dirs.get(key);
    if (first !== undefined) {
      // A path inside the directory it leads back to is a loop and adds nothing.
      if (path !== first && !path.startsWith(first + sep)) this.aliases.set(first, [...(this.aliases.get(first) ?? []), path]);
      return;
    }
    this.dirs.set(key, path);

    const entries = await this.try(path, async () =>
      (await readdir(path, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    );
    if (!entries) return;
    if (entries.some((e) => HF_SOURCE_NAMES.has(e.name))) this.add("hf", real, path);
    for (const entry of entries) {
      if (SKIP_NAMES.has(entry.name)) continue;
      const child = join(path, entry.name);
      if (!this.spend(child)) return;
      await this.entry(child, join(real, entry.name), entry);
    }
  }

  // FIFOs, sockets and devices are never models, so only files, directories and links are looked at.
  private async entry(path: string, real: string, entry: Dirent): Promise<void> {
    let kind = entry.isSymbolicLink() ? "link" : entry.isFile() ? "file" : entry.isDirectory() ? "dir" : undefined;
    if (kind === undefined) {
      // The filesystem did not report a type, or reported a special file: ask.
      const st = await this.try(path, () => lstat(path));
      kind = st?.isSymbolicLink() ? "link" : st?.isFile() ? "file" : st?.isDirectory() ? "dir" : undefined;
    }
    if (kind === "file") await this.file(path, real);
    else if (kind === "dir") {
      if (this.pseudo(path, real)) return;
      const st = await this.try(path, () => stat(path));
      if (st) await this.dir(path, real, st);
    } else if (kind === "link") await this.follow(path);
  }

  private async follow(path: string): Promise<void> {
    if (this.links >= this.limits.maxSymlinks) {
      if (this.linksSkipped) (this.linksSkipped.detail as { skipped: number }).skipped++;
      else {
        this.linksSkipped = this.finding(
          "HIGH",
          path,
          `symlink budget of ${this.limits.maxSymlinks} used up; this link and later ones were not followed`,
          undefined,
          { skipped: 1 },
        );
      }
      return;
    }
    this.links++;
    const real = await this.try(path, () => realpath(path));
    if (!real || this.pseudo(path, real)) return;
    const st = await this.try(path, () => stat(path));
    if (st) await this.visit(path, real, st);
  }

  private pseudo(path: string, real: string): boolean {
    const fs = PSEUDO_FS.find((p) => real === p || real.startsWith(p + sep));
    if (fs) this.finding("MEDIUM", path, `resolves into ${fs} (${real}); kernel filesystems are not walked`);
    return fs !== undefined;
  }

  // GGUF by magic bytes only, whatever the name (ISC-1).
  private async file(path: string, real: string): Promise<void> {
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

  // Counts one entry against the budget. False once it is used up, which stops the whole walk.
  private spend(path: string): boolean {
    if (this.stopped) return false;
    if (++this.entries <= this.limits.maxEntries) return true;
    this.stopped = true;
    this.finding("HIGH", path, `entry budget of ${this.limits.maxEntries} used up; the walk stopped here`);
    return false;
  }

  private expand(paths: string[]): string[] {
    const out = [...paths];
    const seen = new Set(out);
    for (let i = 0; i < out.length; i++) {
      const p = out[i]!;
      // p and each of its ancestors, looked up rather than tested against every alias.
      for (let end = p.length; end > 0; end = p.lastIndexOf(sep, end - 1)) {
        for (const to of this.aliases.get(p.slice(0, end)) ?? []) {
          if (out.length >= MAX_PATHS_PER_MODEL) return out;
          const q = to + p.slice(end);
          if (!seen.has(q)) {
            seen.add(q);
            out.push(q);
          }
        }
      }
    }
    return out;
  }

  private async try<T>(path: string, op: () => Promise<T>): Promise<T | undefined> {
    try {
      return await op();
    } catch (e) {
      this.finding("MEDIUM", path, "cannot read", e);
      return undefined;
    }
  }

  private finding(severity: Severity, path: string, message: string, error?: unknown, detail?: Record<string, unknown>): Finding {
    const f = problem("scanner_error", severity, path, message, error, detail);
    this.findings.push(f);
    return f;
  }
}
