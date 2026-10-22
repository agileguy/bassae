// Local tamper check (ISC-40): recompute the hash a file's own download record
// promises and report a mismatch. Two records exist, both written by
// huggingface_hub (v2.2.0, acfdf30d):
//
// - The hub cache names each blob by its etag: snapshots/<rev>/<path> links to
//   ../../blobs/<etag> (file_download.py: blob_path = storage/blobs/<etag>). The
//   etag is the git blob SHA-1 for a regular file and the SHA-256 for an LFS
//   file (X-Linked-Etag). With the shared blob store, blobs/<etag> is itself a
//   link into <cache>/blobs/<xx>/<xet hash>, so the name is read from the
//   snapshot link's first hop, never from the realpath.
// - A local_dir download records <local_dir>/.cache/huggingface/download/<path>.metadata
//   as three lines: commit hash, etag, timestamp (_local_folder.py,
//   write_download_metadata).
//
// By default only the template- and token-bearing files the readers open are
// hashed: HF_SOURCE_NAMES plus tokenizer.json. Hashing every blob, weights and
// GGUFs included, is opt-in (hashAll), because ISC-8 bounds a 40 GB GGUF scan at
// under a second and hashing one takes minutes. Files are opened read-only and
// streamed; nothing is written, locked or touched. An intact file never yields a
// finding. A tamperer who rewrites the record as well goes unseen here; that is
// what the registry and upstream comparisons are for.

import { createHash, type Hash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, readdir, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { HF_SOURCE_NAMES } from "../hf/sources.ts";
import type { Finding, ModelRecord } from "../types.ts";

export interface TamperOptions {
  /** Hash every file of the model, weights and GGUFs included. Off by default: see the header. */
  hashAll?: boolean;
  /** With hashAll, the most files hashed per model; past it a finding says the rest were not checked. */
  maxFiles?: number;
}

const DEFAULT_MAX_FILES = 100_000;

// The token-bearing file the HF reader opens besides the template sources.
const TOKEN_FILES = ["tokenizer.json"];
const ADDITIONAL = "additional_chat_templates";

// Same flags as the readers: a FIFO under a covered name opens at once and a tty never becomes ours.
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY;
const CHUNK = 1024 * 1024;
// A real metadata record is about 120 bytes.
const MAX_METADATA_BYTES = 4096;

const SHA1_HEX = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const REPO_FOLDER = /^(models|datasets|spaces)--/;

type Algorithm = "git-blob-sha1" | "sha256";

interface Expectation {
  record: "hf-cache-blob" | "download-metadata";
  /** The blob link target or the metadata file. */
  recordPath: string;
  algorithm: Algorithm;
  expected: string;
  detail?: Record<string, unknown>;
}

function algorithmOf(etag: string): Algorithm | undefined {
  if (SHA1_HEX.test(etag)) return "git-blob-sha1";
  if (SHA256_HEX.test(etag)) return "sha256";
  return undefined;
}

/** HIGH local_tamper for each covered file whose content no longer matches its HF cache blob name or download metadata record (ISC-40). Never throws. */
export async function checkLocalTamper(model: ModelRecord, options: TamperOptions = {}): Promise<Finding[]> {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const metadataRoots = new Map<string, boolean>();
  for (const file of await coveredFiles(model, options, findings)) {
    try {
      const realDir = await realpath(dirname(file));
      const key = join(realDir, basename(file));
      if (seen.has(key)) continue;
      seen.add(key);
      const expectations = [...(await blobExpectation(file, realDir)), ...(await metadataExpectation(key, metadataRoots, findings))];
      if (expectations.length > 0) findings.push(...(await verify(file, expectations)));
    } catch (e) {
      if (!isAbsent(e)) findings.push(scannerError(file, "could not check against its download record", e));
    }
  }
  return findings;
}

// The files to hash, as reached through the model's own paths.
async function coveredFiles(model: ModelRecord, options: TamperOptions, findings: Finding[]): Promise<string[]> {
  if (model.format === "bare") return [];
  if (model.format === "gguf") return options.hashAll ? [...model.paths, model.id] : [];
  const dirs = [...new Set([...model.paths, model.id])];
  const out: string[] = [];
  for (const dir of dirs) {
    if (options.hashAll) {
      out.push(...(await everyFile(dir, options.maxFiles ?? DEFAULT_MAX_FILES, findings)));
      continue;
    }
    for (const name of HF_SOURCE_NAMES) if (name !== ADDITIONAL) out.push(join(dir, name));
    for (const name of TOKEN_FILES) out.push(join(dir, name));
    const extra = join(dir, ADDITIONAL);
    const names = await readdir(extra).catch(() => [] as string[]);
    for (const name of names.sort()) if (name.endsWith(".jinja")) out.push(join(extra, name));
  }
  return out;
}

// Every regular file under `dir`, skipping .cache (local_dir bookkeeping, not model files) and directory links.
async function everyFile(dir: string, max: number, findings: Finding[]): Promise<string[]> {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const at = stack.pop()!;
    const entries = await readdir(at, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        if (!(at === dir && entry.name === ".cache")) stack.push(path);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (out.length >= max) {
          findings.push(scannerError(dir, `more than ${max} files; the rest were not checked against their download records`));
          return out;
        }
        out.push(path);
      }
    }
  }
  return out;
}

// snapshots/<rev>/<path> -> <repo folder>/blobs/<etag>, read one hop and resolved against the real directory.
async function blobExpectation(file: string, realDir: string): Promise<Expectation[]> {
  const st = await lstat(file);
  if (!st.isSymbolicLink()) return [];
  const target = resolve(realDir, await readlink(file));
  const name = basename(target);
  const blobs = dirname(target);
  const algorithm = algorithmOf(name);
  if (!algorithm || basename(blobs) !== "blobs" || !REPO_FOLDER.test(basename(dirname(blobs)))) return [];
  return [{ record: "hf-cache-blob", recordPath: target, algorithm, expected: name }];
}

// <local_dir>/.cache/huggingface/download/<path>.metadata for the nearest ancestor that has the folder.
async function metadataExpectation(realFile: string, roots: Map<string, boolean>, findings: Finding[]): Promise<Expectation[]> {
  for (let dir = dirname(realFile); ; dir = dirname(dir)) {
    const download = join(dir, ".cache", "huggingface", "download");
    let present = roots.get(download);
    if (present === undefined) {
      present = await stat(download).then((s) => s.isDirectory(), () => false);
      roots.set(download, present);
    }
    if (present) {
      const record = `${join(download, relative(dir, realFile))}.metadata`;
      const parsed = await readMetadata(record);
      if (parsed === undefined) return [];
      if ("problem" in parsed) {
        findings.push(scannerError(realFile, `download metadata ${record} ${parsed.problem}; not verified`));
        return [];
      }
      const algorithm = algorithmOf(parsed.etag);
      if (!algorithm) return []; // an etag that is not a content hash cannot be checked
      const mtime = (await stat(realFile)).mtimeMs / 1000;
      return [
        {
          record: "download-metadata",
          recordPath: record,
          algorithm,
          expected: parsed.etag,
          // huggingface_hub ignores a record older than the file's mtime and re-hashes; the content still has to match.
          detail: { commit: parsed.commit, ...(mtime - 1 > parsed.timestamp ? { metadataStale: true } : {}) },
        },
      ];
    }
    if (dirname(dir) === dir) return [];
  }
}

type Metadata = { commit: string; etag: string; timestamp: number } | { problem: string };

// read_download_metadata: three lines, each stripped; the timestamp parses as a float.
async function readMetadata(path: string): Promise<Metadata | undefined> {
  let fh: FileHandle;
  try {
    fh = await open(path, OPEN_FLAGS);
  } catch (e) {
    if (isAbsent(e)) return undefined;
    return { problem: `cannot be opened (${errorText(e)})` };
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { problem: "is not a regular file" };
    if (st.size > MAX_METADATA_BYTES) return { problem: `is ${st.size} bytes, over ${MAX_METADATA_BYTES}` };
    const buf = new Uint8Array(st.size);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const lines = new TextDecoder().decode(buf.subarray(0, bytesRead)).split("\n");
    const commit = lines[0]?.trim() ?? "";
    const etag = lines[1]?.trim() ?? "";
    const timestamp = Number.parseFloat(lines[2]?.trim() ?? "");
    if (!etag || Number.isNaN(timestamp)) return { problem: "is not commit, etag and timestamp lines" };
    return { commit, etag, timestamp };
  } finally {
    await fh.close();
  }
}

async function verify(file: string, expectations: Expectation[]): Promise<Finding[]> {
  const algorithms = new Set(expectations.map((e) => e.algorithm));
  const hashed = await hashFile(file, algorithms);
  if (!hashed) return [];
  if ("changed" in hashed) return [scannerError(file, `changed size while being hashed (${hashed.changed}); not verified`)];
  const findings: Finding[] = [];
  for (const e of expectations) {
    const actual = hashed[e.algorithm]!;
    if (actual === e.expected) continue;
    const what = e.record === "hf-cache-blob" ? "the HF cache blob name it links to" : "its huggingface download metadata record";
    findings.push({
      ruleId: "local_tamper",
      severity: "HIGH",
      message: `${basename(file)} does not match ${what}: ${e.algorithm} is ${actual}, expected ${e.expected}`,
      file,
      detail: { record: e.record, recordPath: e.recordPath, algorithm: e.algorithm, expected: e.expected, actual, ...e.detail },
    });
  }
  return findings;
}

type Hashes = Partial<Record<Algorithm, string>> | { changed: string };

// Streams the file once into every hash asked for. Undefined when it is not a regular file; the readers report those.
async function hashFile(file: string, algorithms: Set<Algorithm>): Promise<Hashes | undefined> {
  const fh = await open(file, OPEN_FLAGS);
  try {
    const st = await fh.stat();
    if (!st.isFile()) return undefined;
    const hashes = new Map<Algorithm, Hash>();
    if (algorithms.has("git-blob-sha1")) hashes.set("git-blob-sha1", createHash("sha1").update(`blob ${st.size}\0`));
    if (algorithms.has("sha256")) hashes.set("sha256", createHash("sha256"));
    const buf = new Uint8Array(Math.min(CHUNK, Math.max(1, st.size)));
    let total = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      for (const h of hashes.values()) h.update(buf.subarray(0, bytesRead));
    }
    if (total !== st.size) return { changed: `${st.size} bytes at open, ${total} read` };
    const out: Partial<Record<Algorithm, string>> = {};
    for (const [a, h] of hashes) out[a] = h.digest("hex");
    return out;
  } finally {
    await fh.close();
  }
}

function scannerError(file: string, message: string, error?: unknown): Finding {
  return { ruleId: "scanner_error", severity: "MEDIUM", message: `${basename(file)}: ${message}`, file, ...(error === undefined ? {} : { detail: { error: errorText(error) } }) };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isAbsent(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
