// Builds fixtures/clean-manifest.json, the verified clean manifest of ISC-34: one entry per template the
// real readers find under ~/.cache/huggingface/hub and ~/.omlx, for each model, file and template name.
// Read-only: model files are opened only to be read, and nothing is written but the manifest.
//
//   bun scripts/build-clean-manifest.ts
//
// Each entry is shown clean (ISC-34.1) by an exact SHA-256 match with a registry entry fetched at a pinned
// upstream commit, plus, when the file has a download record, that record's hash recomputed here: the git
// blob SHA-1 or LFS SHA-256 an HF cache snapshot link names, or the etag a local_dir download wrote to
// .cache/huggingface/download/<path>.metadata. This recomputes ISC-40 independently of the scanner, and hashes
// GGUFs whole (about 16 GB here), which the scanner skips by default. A file in an HF cache snapshot must
// pass that check. An entry missing either proof is written `review: needed`, with the reason.
//
// The output is deterministic: entries sorted by path then name, every path written from ~, and no timestamp
// but each entry's freeze date, kept from the previous manifest while the entry's SHA-256 is unchanged. The
// `justified` list (ISC-34.2) is curated by hand and carried over as it is.

import { existsSync } from "node:fs";
import { lstat, readlink, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { discover } from "../src/discover.ts";
import { readGgufModel } from "../src/gguf/index.ts";
import { parseHfCachePath } from "../src/hf/cache.ts";
import { readHfModel } from "../src/hf/index.ts";
import { loadRegistry } from "../src/registry/index.ts";
import type { DiscoveredModel, ModelRecord, RegistryEntry, RuleId, SourceKind } from "../src/types.ts";

/** The registry entry an entry's SHA-256 matches exactly (ISC-24.1). */
export type RegistryProof = Pick<RegistryEntry, "repo" | "revision" | "path" | "templateName">;

/** The download record a file's content was hashed against, or `none` for a file outside the HF cache that has none. */
export type Integrity =
  | { record: "hf-cache-blob" | "download-metadata"; algorithm: Algorithm; etag: string; commit?: string }
  | { record: "none" };

export type Proof = { registry: RegistryProof; integrity: Integrity } | { review: "needed"; why: string };

export interface ManifestEntry {
  /** The template's file, as reached under `model`, written from ~. */
  path: string;
  kind: SourceKind;
  name: string;
  sha256: string;
  /** YYYY-MM-DD. */
  frozen: string;
  /** The path the model is read at, written from ~: its HF cache snapshot when it has one. */
  model: string;
  /** Other paths the walk reaches the same file by, when there are any. */
  alsoAt?: string[];
  proof: Proof;
}

/** A MEDIUM or LOW finding accepted on the clean manifest (ISC-34.2). */
export interface Justification {
  ruleId: RuleId;
  /** The finding's file, written from ~. */
  path: string;
  reason: string;
}

export interface CleanManifest {
  roots: string[];
  entries: ManifestEntry[];
  justified: Justification[];
}

type Algorithm = "git-blob-sha1" | "sha256";

const OUT = join(import.meta.dir, "..", "fixtures", "clean-manifest.json");
const HOME = homedir();
const ROOTS = ["~/.cache/huggingface/hub", "~/.omlx"];

const SHA1_HEX = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// A real metadata record is about 120 bytes.
const MAX_METADATA_BYTES = 4096;
// Files this big get a progress line while they hash.
const LOUD_BYTES = 256 * 1024 * 1024;

function tilde(p: string): string {
  if (!p.startsWith(`${HOME}/`)) throw new Error(`refusing to write a path outside the home directory: ${p}`);
  return `~${p.slice(HOME.length)}`;
}

// Code-unit order: locale order differs between machines.
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

const previous: CleanManifest | undefined = existsSync(OUT) ? await Bun.file(OUT).json() : undefined;
const frozenAt = new Map(previous?.entries.map((e) => [`${e.path}\0${e.name}`, e]));
const registry = loadRegistry().entries.map((k) => k.entry);

// The path a model is read at: one in an HF cache snapshot names its repo and commit, so it wins; then code-unit order.
function primaryPath(m: DiscoveredModel): string {
  const inSnapshot = (p: string) => {
    const loc = parseHfCachePath(p);
    return loc !== undefined && SHA1_HEX.test(loc.revision);
  };
  return [...m.paths].sort((a, b) => Number(inSnapshot(b)) - Number(inSnapshot(a)) || byCodeUnit(a, b))[0]!;
}

function algorithmOf(etag: string): Algorithm | undefined {
  if (SHA1_HEX.test(etag)) return "git-blob-sha1";
  if (SHA256_HEX.test(etag)) return "sha256";
  return undefined;
}

// Streamed, so a GGUF never sits in memory. A git blob hash covers "blob <size>\0" and then the bytes.
async function hashOf(path: string, algorithm: Algorithm): Promise<string> {
  const size = (await stat(path)).size;
  if (size >= LOUD_BYTES) console.error(`hashing ${tilde(path)} (${(size / 1e9).toFixed(1)} GB)`);
  const hasher = new Bun.CryptoHasher(algorithm === "sha256" ? "sha256" : "sha1");
  if (algorithm === "git-blob-sha1") hasher.update(`blob ${size}\0`);
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

// <local_dir>/.cache/huggingface/download/<path>.metadata for the nearest ancestor that has the folder:
// commit, etag and timestamp lines, as huggingface_hub writes them.
async function downloadRecord(realFile: string): Promise<{ record: string; commit: string; etag: string; pathInRepo: string } | undefined> {
  for (let dir = dirname(realFile); ; dir = dirname(dir)) {
    const download = join(dir, ".cache", "huggingface", "download");
    if (existsSync(download)) {
      const pathInRepo = relative(dir, realFile);
      const record = `${join(download, pathInRepo)}.metadata`;
      if (!existsSync(record) || (await stat(record)).size > MAX_METADATA_BYTES) return undefined;
      const [commit = "", etag = ""] = (await Bun.file(record).text()).split("\n").map((l) => l.trim());
      return { record, commit, etag, pathInRepo };
    }
    if (dirname(dir) === dir) return undefined;
  }
}

type Checked = { integrity: Integrity; origin: { repo?: string; revision?: string; pathInRepo?: string } } | { failed: string };

/** Hashes a file against its HF cache blob link or its download record. A file in a snapshot must have one that matches. */
async function checkIntegrity(path: string): Promise<Checked> {
  const loc = parseHfCachePath(path);
  const inSnapshot = loc !== undefined && SHA1_HEX.test(loc.revision) && loc.pathInRepo !== "";
  if (inSnapshot && (await lstat(path)).isSymbolicLink()) {
    const target = resolve(dirname(path), await readlink(path));
    const etag = basename(target);
    const algorithm = algorithmOf(etag);
    if (!algorithm || basename(dirname(target)) !== "blobs") return { failed: `its snapshot link points at ${tilde(target)}, not a blob` };
    const actual = await hashOf(path, algorithm);
    if (actual !== etag) return { failed: `its ${algorithm} is ${actual}, but its snapshot link names blob ${etag}` };
    return { integrity: { record: "hf-cache-blob", algorithm, etag }, origin: loc };
  }
  const real = await realpath(path);
  const found = await downloadRecord(real);
  if (found) {
    const algorithm = algorithmOf(found.etag);
    if (!algorithm) return { failed: `its download record ${tilde(found.record)} holds no content hash` };
    const actual = await hashOf(path, algorithm);
    if (actual !== found.etag) return { failed: `its ${algorithm} is ${actual}, but its download record says ${found.etag}` };
    return {
      integrity: { record: "download-metadata", algorithm, etag: found.etag, commit: found.commit },
      origin: { revision: found.commit, pathInRepo: found.pathInRepo },
    };
  }
  if (inSnapshot) return { failed: "it sits in an HF cache snapshot as neither a blob link nor a file with a download record" };
  return { integrity: { record: "none" }, origin: {} };
}

// The registry entry to cite among those with the same bytes: the one pinned to this very file's commit and path,
// then one from its repo, then one with its template name, then the first in file order.
function citation(sha256: string, name: string, origin: { repo?: string; revision?: string; pathInRepo?: string }): RegistryProof | undefined {
  const same = registry.filter((e) => e.sha256 === sha256);
  const best =
    same.find((e) => e.revision === origin.revision && e.path === origin.pathInRepo && (origin.repo === undefined || e.repo === origin.repo)) ??
    same.find((e) => e.repo === origin.repo) ??
    same.find((e) => e.templateName === name) ??
    same[0];
  return best && { repo: best.repo, revision: best.revision, path: best.path, templateName: best.templateName };
}

const discovery = await discover(ROOTS.map((r) => join(HOME, r.slice("~/".length))));
for (const f of discovery.findings) console.error(`walk: ${f.severity} ${f.ruleId} ${f.message}`);

// A template shown clean (registry + integrity) is a manifest entry; one we cannot prove clean is held back
// for triage, never counted toward ISC-34. An unregistered or failed-integrity template is not "verified
// clean" by ISC-34.1, so it stays out of the verified-clean set until a registry pin or a recorded review
// resolves it.
const entries: ManifestEntry[] = [];
const excluded: { path: string; name: string; why: string }[] = [];
for (const m of discovery.models) {
  const at = primaryPath(m);
  let model: ModelRecord;
  try {
    model = m.format === "gguf" ? await readGgufModel(at) : await readHfModel(at);
  } catch (e) {
    console.error(`unreadable, no entries: ${tilde(at)}: ${e instanceof Error ? e.message : String(e)}`);
    continue;
  }
  if (!model.extractionComplete) console.error(`extraction incomplete, entries may be missing: ${tilde(at)}`);
  for (const t of model.templates) {
    const rel = relative(at, t.source.path);
    const others = m.paths.filter((p) => p !== at).map((p) => tilde(rel ? join(p, rel) : p)).sort(byCodeUnit);
    const path = tilde(t.source.path);
    const kept = frozenAt.get(`${path}\0${t.source.name}`);
    const checked = await checkIntegrity(t.source.path);
    const cited = "failed" in checked ? undefined : citation(t.sha256, t.source.name, checked.origin);
    if ("failed" in checked) {
      excluded.push({ path, name: t.source.name, why: `integrity: ${checked.failed}` });
      continue;
    }
    if (!cited) {
      excluded.push({ path, name: t.source.name, why: "no registry entry has this SHA-256" });
      continue;
    }
    entries.push({
      path,
      kind: t.source.kind,
      name: t.source.name,
      sha256: t.sha256,
      frozen: kept?.sha256 === t.sha256 ? kept.frozen : today,
      model: tilde(at),
      ...(others.length > 0 ? { alsoAt: others } : {}),
      proof: { registry: cited, integrity: checked.integrity },
    });
  }
}

entries.sort((a, b) => byCodeUnit(a.path, b.path) || byCodeUnit(a.name, b.name));
for (let i = 1; i < entries.length; i++) {
  if (entries[i - 1]!.path === entries[i]!.path && entries[i - 1]!.name === entries[i]!.name) throw new Error(`two templates named ${entries[i]!.name} in ${entries[i]!.path}`);
}
const justified = [...(previous?.justified ?? [])].sort((a, b) => byCodeUnit(a.ruleId, b.ruleId) || byCodeUnit(a.path, b.path));

const manifest: CleanManifest = { roots: ROOTS, entries, justified };
await Bun.write(OUT, `${JSON.stringify(manifest, null, 2)}\n`);

const records = new Map<string, number>();
for (const e of entries) if ("registry" in e.proof) records.set(e.proof.integrity.record, (records.get(e.proof.integrity.record) ?? 0) + 1);
console.log(`${entries.length} entries from ${discovery.models.length} models, ${new Set(entries.map((e) => e.sha256)).size} distinct templates`);
console.log(`registry proof: ${entries.length} (${[...records].map(([r, n]) => `${r} ${n}`).join(", ")})`);
console.log(`excluded (not yet shown clean, triage): ${excluded.length}`);
for (const e of excluded.sort((a, b) => byCodeUnit(a.path, b.path) || byCodeUnit(a.name, b.name))) console.log(`  ${e.path} [${e.name}]: ${e.why}`);
console.log(`justified: ${justified.length}`);
console.log(`wrote ${relative(process.cwd(), OUT) || OUT}`);
