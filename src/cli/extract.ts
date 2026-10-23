// --extract <model> --out <dir>: each template's exact bytes, one file each (ISC-29).
//
// This is the only place bassae writes a file, so it is careful in three ways:
// - it refuses an --out under any scanned path before writing anything (ISC-29.1, ISC-35), comparing
//   directories by device and inode, so links, `..` and letter case cannot hide the overlap;
// - it builds each file name from the SHA-256 and a sanitized template name, so a name cannot leave --out (ISC-29.2);
// - it creates each file with O_CREAT|O_EXCL|O_NOFOLLOW, so nothing is overwritten and a planted symlink leads nowhere.

import { constants } from "node:fs";
import { mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadModels } from "../scan/index.ts";
import type { ExtractedTemplate, Finding, ModelRecord } from "../types.ts";
import { escapeText } from "./escape.ts";

// Sanitized names are cut to this many characters; the SHA-256 prefix already keeps files apart.
const MAX_NAME = 64;

const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
// Reading what is already there: never through a link, and never blocking on a planted FIFO.
const READ_EXISTING = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

// The findings that mean a template may not have been read at all.
const EXTRACTION_PROBLEMS: ReadonlySet<Finding["ruleId"]> = new Set(["scanner_error", "parse_error"]);

const errorCode = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Only [A-Za-z0-9._-], one underscore per other character, no leading dot, at most MAX_NAME long, never empty. */
export function sanitizeName(name: string): string {
  const safe = name
    .replace(/[^A-Za-z0-9._-]/gu, "_")
    .replace(/^\.+/, (dots) => "_".repeat(dots.length))
    .slice(0, MAX_NAME);
  return safe || "default";
}

/** `<sha256 first 12>_<sanitized name>.jinja` */
export function extractFileName(t: ExtractedTemplate): string {
  return `${t.sha256.slice(0, 12)}_${sanitizeName(t.source.name)}.jinja`;
}

async function identity(path: string): Promise<string | undefined> {
  try {
    const s = await stat(path, { bigint: true });
    return `${s.dev}:${s.ino}`;
  } catch {
    return undefined;
  }
}

// mkdir -p creates everything below the deepest part of the path that exists; that part decides where the files land.
async function nearestExisting(path: string): Promise<string> {
  let p = path;
  while ((await identity(p)) === undefined && dirname(p) !== p) p = dirname(p);
  return realpath(p);
}

/** Why `out` may not be written, or undefined. It may not when it, or the deepest part of it that exists, is at or under any scanned path. */
export async function outRefusal(out: string, scanned: readonly string[]): Promise<string | undefined> {
  const within = new Set<string>();
  for (let p = await nearestExisting(resolve(out)); ; p = dirname(p)) {
    const id = await identity(p);
    if (id) within.add(id);
    if (dirname(p) === p) break;
  }
  for (const root of scanned) {
    const id = await identity(root);
    if (id && within.has(id)) return `refusing to write: --out ${out} is under the scanned path ${root}`;
  }
  return undefined;
}

async function writeNew(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, CREATE, 0o644);
  let complete = false;
  try {
    await handle.writeFile(bytes);
    complete = true;
  } finally {
    await handle.close();
    // The file is ours, made a moment ago by O_EXCL; a partial copy is worse than none.
    if (!complete) await unlink(path).catch(() => undefined);
  }
}

async function sameBytes(path: string, bytes: Uint8Array): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, READ_EXISTING);
  } catch {
    return false;
  }
  try {
    const s = await handle.stat();
    return s.isFile() && s.size === bytes.length && Buffer.compare(await handle.readFile(), bytes) === 0;
  } finally {
    await handle.close();
  }
}

export interface WriteResult {
  written: string[];
  /** Already there with the same bytes, e.g. from an earlier --extract into the same directory. */
  existing: string[];
  /** One line each: anything not written. */
  problems: string[];
}

/** Writes each distinct template into `dir`, which must already be checked. Never overwrites, never follows a link. */
export async function writeTemplates(dir: string, templates: readonly ExtractedTemplate[]): Promise<WriteResult> {
  const result: WriteResult = { written: [], existing: [], problems: [] };
  const planned = new Map<string, ExtractedTemplate>();
  for (const t of templates) {
    const name = extractFileName(t);
    const prior = planned.get(name);
    if (!prior) planned.set(name, t);
    else if (prior.sha256 !== t.sha256) result.problems.push(`${join(dir, name)}: two different templates share this file name; wrote the first only`);
  }
  for (const [name, t] of planned) {
    const path = join(dir, name);
    try {
      await writeNew(path, t.bytes);
      result.written.push(path);
    } catch (e) {
      if (errorCode(e) !== "EEXIST") result.problems.push(`${path}: ${errorMessage(e)}`);
      else if (await sameBytes(path, t.bytes)) result.existing.push(path);
      else result.problems.push(`${path}: already exists with other content, or is not a regular file; not overwritten`);
    }
  }
  return result;
}

export type Loader = (roots: string[], templates: string[]) => Promise<{ models: ModelRecord[]; findings: Finding[] }>;

export interface ExtractResult {
  exitCode: 0 | 3;
  /** Escaped lines (ISC-44). */
  stdout: string[];
  /** Escaped lines, each prefixed "bassae: ". */
  stderr: string[];
}

/** The whole --extract. Exit 3 on a refusal, a missing model, or anything not extracted or not written; else 0. */
export async function extract(model: string, out: string, load: Loader = loadModels): Promise<ExtractResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const done = (exitCode: 0 | 3): ExtractResult => ({ exitCode, stdout: stdout.map(escapeText), stderr: stderr.map((l) => escapeText(`bassae: ${l}`)) });
  const modelPath = resolve(model);
  try {
    if ((await identity(modelPath)) === undefined) {
      stderr.push(`no such file or directory: ${model}`);
      return done(3);
    }
    // Before the model is read at all.
    let refusal = await outRefusal(out, [modelPath]);
    if (refusal) {
      stderr.push(refusal);
      return done(3);
    }

    const { models, findings } = await load([modelPath], []);
    // The walk may have followed links out of the model path; everywhere it read counts as scanned.
    const scanned = [modelPath, ...models.flatMap((m) => [m.id, ...m.paths, ...m.templates.map((t) => t.source.realPath)])];
    refusal = await outRefusal(out, scanned);
    if (refusal) {
      stderr.push(refusal);
      return done(3);
    }

    let failed = false;
    for (const f of [...findings, ...models.flatMap((m) => m.findings)]) {
      if (!EXTRACTION_PROBLEMS.has(f.ruleId)) continue;
      stderr.push(`${f.file}: ${f.message}`);
      failed = true;
    }
    for (const m of models) {
      if (m.extractionComplete) continue;
      stderr.push(`${m.id}: extraction did not complete; a template may exist that was not written`);
      failed = true;
    }
    if (models.length === 0) {
      stderr.push(`no model found at ${model}`);
      return done(3);
    }
    const templates = models.flatMap((m) => m.templates);
    if (templates.length === 0) {
      stderr.push(`no chat template in ${model}`);
      return done(failed ? 3 : 0);
    }

    await mkdir(resolve(out), { recursive: true });
    // Once more on what now exists: a link swapped in since the first check is caught here, before any file.
    const dir = await realpath(resolve(out));
    refusal = await outRefusal(dir, scanned);
    if (refusal) {
      stderr.push(refusal);
      return done(3);
    }
    const result = await writeTemplates(dir, templates);
    stdout.push(...result.written.map((p) => `wrote ${p}`), ...result.existing.map((p) => `present ${p} (same bytes)`));
    stderr.push(...result.problems);
    return done(failed || result.problems.length > 0 ? 3 : 0);
  } catch (e) {
    stderr.push(errorMessage(e));
    return done(3);
  }
}
