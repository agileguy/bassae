// The only network code in bassae (ISC-36, ISC-41): --online --upstream
// <repo>@<revision> fetches the documented template sources of one public repo
// at one pinned commit from huggingface.co.
//
// - repo and revision are validated before any URL is built;
// - no credentials are ever sent: no Authorization header, no cookies, and
//   neither HF_TOKEN nor the token file is read;
// - redirects are followed by hand, only to https hosts under huggingface.co or hf.co;
// - every response is size-capped while it streams, and every request times out;
// - each file's bytes are checked against the hub's etag for them, and the
//   commit the hub served against the pinned revision.
//
// The fetched files go to a fresh temp dir and through readHfModel, so each
// upstream baseline is exactly what the local readers would extract from the
// same files.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { readHfModel } from "../hf/index.ts";
import { DEFAULT_READ_LIMITS, MAX_SOURCE_BYTES } from "../hf/sources.ts";
import type { Baseline } from "../types.ts";
import { normalizeRevision, repoIdProblem } from "./hub.ts";

export interface FetchOptions {
  /** Per request, body included. Default 30 s. */
  timeoutMs?: number;
  /** Per response. Default the readers' per-file cap, 64 MiB. */
  maxBytes?: number;
  /** Across every response of one fetch. Default the readers' per-model budget, 128 MiB. */
  maxTotalBytes?: number;
}

/** Any reason an upstream fetch gave no baselines. The message is meant for the user. */
export class UpstreamError extends Error {}

const HUB = "https://huggingface.co";
// The single-file template sources, in the order the readers read them (Constraints).
const SOURCE_FILES = ["tokenizer_config.json", "chat_template.jinja", "chat_template.json", "processor_config.json"];
const ADDITIONAL = "additional_chat_templates";
const MAX_REDIRECTS = 5;
const MAX_LISTING_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

/** Fetches every chat template of `repo` at the pinned `revision`, one `upstream` baseline per template. Throws UpstreamError on any failure; never returns a partial set. */
export async function fetchUpstream(repo: string, revision: string, fetcher: typeof fetch = fetch, options: FetchOptions = {}): Promise<Baseline[]> {
  const problem = repoIdProblem(repo);
  if (problem) throw new UpstreamError(`--upstream repo ${JSON.stringify(repo)} is not a hub id: ${problem}`);
  const rev = normalizeRevision(revision);
  if (!rev) throw new UpstreamError(`--upstream revision ${JSON.stringify(revision)} must be a full 40-hex commit hash, not a branch or tag`);

  const hub = new Hub(repo, rev, fetcher, options);
  const files = new Map<string, Uint8Array>();
  for (const name of SOURCE_FILES) {
    const body = await hub.file(name);
    if (body) files.set(name, body);
  }
  for (const path of await hub.additional()) {
    const body = await hub.file(path);
    if (body) files.set(path, body);
  }
  return extract(repo, rev, files);
}

// Writes the files to a fresh private temp dir and reads them back with the HF reader.
async function extract(repo: string, revision: string, files: Map<string, Uint8Array>): Promise<Baseline[]> {
  if (files.size === 0) return [];
  const dir = await mkdtemp(join(tmpdir(), "bassae-upstream-"));
  try {
    for (const [path, bytes] of files) {
      const out = join(dir, ...path.split("/"));
      await mkdir(dirname(out), { recursive: true, mode: 0o700 });
      await writeFile(out, bytes, { flag: "wx", mode: 0o600 });
    }
    const model = await readHfModel(dir);
    if (!model.extractionComplete || model.findings.length > 0) {
      const why = model.findings.map((f) => `${relative(dir, f.file).split(sep).join("/")}: ${f.message}`).join("; ");
      throw new UpstreamError(`${repo}@${revision}: the upstream template sources could not be read completely${why ? ` (${why})` : ""}`);
    }
    return model.templates.map((t) => ({
      kind: "upstream",
      repo,
      revision,
      path: relative(dir, t.source.path).split(sep).join("/"),
      templateName: t.source.name,
      text: t.text,
    }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface Got {
  body: Uint8Array;
  /** The first hop's headers, where the hub states the commit and the etag. */
  first: Headers;
  last: Headers;
}

class Hub {
  private total = 0;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxTotal: number;

  constructor(
    private readonly repo: string,
    private readonly revision: string,
    private readonly fetcher: typeof fetch,
    options: FetchOptions,
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? MAX_SOURCE_BYTES;
    this.maxTotal = options.maxTotalBytes ?? DEFAULT_READ_LIMITS.maxBytes;
  }

  /** One file at the pinned revision, or undefined when the repo has no such file. */
  async file(path: string): Promise<Uint8Array | undefined> {
    const url = `${HUB}/${this.repo}/resolve/${this.revision}/${path.split("/").map(encodeURIComponent).join("/")}`;
    const got = await this.get(url, this.maxBytes);
    if (!got) return undefined;
    const commit = got.first.get("x-repo-commit");
    if (commit && commit.toLowerCase() !== this.revision) throw new UpstreamError(`${url}: the hub served commit ${commit}, not the pinned ${this.revision}`);
    verifyEtag(url, got.body, got.first.get("x-linked-etag") ?? got.first.get("etag"));
    return got.body;
  }

  /** The .jinja files listed in additional_chat_templates/ at the pinned revision. */
  async additional(): Promise<string[]> {
    const url = `${HUB}/api/models/${this.repo}/tree/${this.revision}/${ADDITIONAL}`;
    const got = await this.get(url, MAX_LISTING_BYTES);
    if (!got) return [];
    if (/\brel="?next"?/.test(got.last.get("link") ?? "")) throw new UpstreamError(`${url}: the listing has more than one page; refusing a partial set`);
    let entries: unknown;
    try {
      entries = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(got.body));
    } catch (e) {
      throw new UpstreamError(`${url}: the listing is not JSON (${e instanceof Error ? e.message : e})`);
    }
    if (!Array.isArray(entries)) throw new UpstreamError(`${url}: the listing is not a JSON array`);
    const paths: string[] = [];
    for (const entry of entries) {
      const { type, path } = (entry ?? {}) as { type?: unknown; path?: unknown };
      if (type === "directory") continue; // the readers ignore subdirectories too
      if (type !== "file" || typeof path !== "string") throw new UpstreamError(`${url}: unexpected listing entry ${JSON.stringify(entry)}`);
      const name = path.startsWith(`${ADDITIONAL}/`) ? path.slice(ADDITIONAL.length + 1) : undefined;
      // One safe path component, so writing it can never leave the temp dir.
      if (name === undefined || name === "" || name === "." || name === ".." || /[/\\\0]/.test(name)) {
        throw new UpstreamError(`${url}: unexpected path ${JSON.stringify(path)} in the listing`);
      }
      if (name.endsWith(".jinja")) paths.push(path);
    }
    if (paths.length > DEFAULT_READ_LIMITS.maxAdditional) throw new UpstreamError(`${url}: ${paths.length} templates, over the limit of ${DEFAULT_READ_LIMITS.maxAdditional}`);
    return paths.sort();
  }

  // GET with no credentials, following redirects by hand. Undefined for a 404 on an entry that does not exist.
  private async get(url: string, cap: number): Promise<Got | undefined> {
    try {
      return await this.attempt(url, cap);
    } catch (e) {
      if (e instanceof UpstreamError) throw e;
      throw new UpstreamError(`${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async attempt(url: string, cap: number): Promise<Got | undefined> {
    const deadline = new Deadline(this.timeoutMs, url);
    try {
      let current = url;
      let first: Headers | undefined;
      for (let hop = 0; ; hop++) {
        const res = await deadline.race(
          this.fetcher(current, {
            method: "GET",
            headers: { accept: "*/*", "user-agent": "bassae" },
            redirect: "manual",
            credentials: "omit",
            signal: deadline.signal,
          }),
        );
        first ??= res.headers;
        if (res.status >= 300 && res.status < 400) {
          await res.body?.cancel().catch(() => {});
          if (hop >= MAX_REDIRECTS) throw new UpstreamError(`${url}: more than ${MAX_REDIRECTS} redirects`);
          current = redirectTarget(current, res.headers.get("location"));
          continue;
        }
        const code = res.headers.get("x-error-code");
        if (res.status === 401 || res.status === 403) {
          await res.body?.cancel().catch(() => {});
          throw new UpstreamError(
            `${this.repo} is gated, private or missing (HTTP ${res.status}${code ? ` ${code}` : ""}). bassae never sends credentials, so --upstream works only with public, ungated repos.`,
          );
        }
        if (res.status === 404 && code !== "RepoNotFound" && code !== "RevisionNotFound") {
          await res.body?.cancel().catch(() => {});
          return undefined;
        }
        if (res.status !== 200) {
          await res.body?.cancel().catch(() => {});
          throw new UpstreamError(`${current}: HTTP ${res.status}${code ? ` ${code}` : ""}`);
        }
        const body = await this.read(res, cap, current, deadline);
        return { body, first, last: res.headers };
      }
    } finally {
      deadline.clear();
    }
  }

  // Streams the body, stopping at the cap rather than after it.
  private async read(res: Response, cap: number, url: string, deadline: Deadline): Promise<Uint8Array> {
    const limit = Math.min(cap, this.maxTotal - this.total);
    const declared = Number(res.headers.get("content-length") ?? Number.NaN);
    if (declared > limit) {
      await res.body?.cancel().catch(() => {});
      throw new UpstreamError(`${url}: ${declared} bytes, over the ${limit}-byte limit`);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = res.body?.getReader();
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await deadline.race(reader.read());
          if (done) break;
          size += value.byteLength;
          if (size > limit) throw new UpstreamError(`${url}: over the ${limit}-byte limit`);
          chunks.push(value);
        }
      } catch (e) {
        await reader.cancel().catch(() => {});
        throw e;
      }
    }
    this.total += size;
    const body = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      body.set(c, at);
      at += c.byteLength;
    }
    return body;
  }
}

// Only https, and only the hub's own hosts: the resolve endpoint redirects to itself and, for LFS files, to its CDN.
function redirectTarget(from: string, location: string | null): string {
  if (!location) throw new UpstreamError(`${from}: redirect without a Location`);
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    throw new UpstreamError(`${from}: redirect to an invalid URL`);
  }
  const host = next.hostname.toLowerCase();
  const hub = host === "huggingface.co" || host.endsWith(".huggingface.co") || host === "hf.co" || host.endsWith(".hf.co");
  if (next.protocol !== "https:" || !hub || next.username || next.password) throw new UpstreamError(`${from}: refusing a redirect to ${next.origin}`);
  return next.href;
}

// The hub's etag for a file is its git blob SHA-1, or its SHA-256 when it is an LFS file.
function verifyEtag(url: string, body: Uint8Array, etag: string | null): void {
  const value = etag?.replace(/^W\//, "").replace(/"/g, "").toLowerCase();
  if (!value) return;
  let actual: string;
  if (/^[0-9a-f]{40}$/.test(value)) actual = createHash("sha1").update(`blob ${body.byteLength}\0`).update(body).digest("hex");
  else if (/^[0-9a-f]{64}$/.test(value)) actual = createHash("sha256").update(body).digest("hex");
  else return;
  if (actual !== value) throw new UpstreamError(`${url}: content does not match the hub's etag ${value}`);
}

// One timer per request, covering the response and every body read, even with a fetcher that ignores the signal.
class Deadline {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly expired: Promise<never>;

  constructor(ms: number, url: string) {
    let fire!: (e: Error) => void;
    this.expired = new Promise<never>((_, reject) => (fire = reject));
    this.expired.catch(() => {});
    this.timer = setTimeout(() => {
      const e = new UpstreamError(`${url}: no complete response within ${ms} ms`);
      this.controller.abort(e);
      fire(e);
    }, ms);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  race<T>(p: Promise<T>): Promise<T> {
    return Promise.race([p, this.expired]);
  }

  clear(): void {
    clearTimeout(this.timer);
  }
}
