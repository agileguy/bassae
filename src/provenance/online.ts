// The only network code in bassae (ISC-36, ISC-41): --online --upstream
// <repo>@<revision> fetches the documented template sources of one public repo
// at one pinned commit from huggingface.co. scripts/build-registry.ts builds the
// trust root through the same HubClient, so both get the same guarantees:
//
// - repo and revision are validated before any URL is built;
// - no credentials are ever sent: no Authorization header, no cookies, and
//   neither HF_TOKEN nor the token file is read;
// - redirects are followed by hand, only to https hosts under huggingface.co or hf.co;
// - bodies come as sent (accept-encoding: identity, no decompression), and any
//   other Content-Encoding is refused, so a small compressed body cannot inflate;
// - every response is size-capped while it streams, and every request times out;
// - every file must come with the commit the hub served and its etag: the commit
//   must be the pinned one and the bytes must match the etag;
// - a 404 means "no such file" only when the hub says EntryNotFound on the first
//   hop. Anything else fails, so a fetch never returns a partial set.
//
// The fetched bytes are parsed in memory, exactly as the HF readers parse the same
// files on disk, so nothing is ever written, under a scanned path or anywhere (ISC-35).

import { createHash } from "node:crypto";
import { DEFAULT_READ_LIMITS, isObject, MAX_SOURCE_BYTES, parseJsonLikePython } from "../hf/sources.ts";
import { makeTemplate, makeTemplateFromString } from "../template.ts";
import type { Baseline, ExtractedTemplate, SourceKind } from "../types.ts";
import { normalizeRevision, repoIdProblem } from "./hub.ts";

export interface FetchOptions {
  /** Per request, body included. Default 30 s. */
  timeoutMs?: number;
  /** Per file. Default the readers' per-file cap, 64 MiB. */
  maxBytes?: number;
  /** Across every response of one client. Default the readers' per-model budget, 128 MiB. */
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
  const rev = pinned(repo, revision);
  const templates = await upstreamTemplates(new HubClient(fetcher, options), repo, rev);
  return templates.map((t) => ({ kind: "upstream", repo, revision: rev, path: t.source.path, templateName: t.source.name, text: t.text }));
}

/** The pinned revision, lowercased, once `repo` and `revision` are known safe to put in a URL. */
export function pinned(repo: string, revision: string): string {
  const problem = repoIdProblem(repo);
  if (problem) throw new UpstreamError(`--upstream repo ${JSON.stringify(repo)} is not a hub id: ${problem}`);
  const rev = normalizeRevision(revision);
  if (!rev) throw new UpstreamError(`--upstream revision ${JSON.stringify(revision)} must be a full 40-hex commit hash, not a branch or tag`);
  return rev;
}

/**
 * Every chat template of `repo` at the pinned `revision`, as the HF readers would extract them
 * from the same files on disk. Each template's source path is its path in the repo. Throws
 * UpstreamError on any failure; never returns a partial set.
 */
export async function upstreamTemplates(hub: HubClient, repo: string, revision: string): Promise<ExtractedTemplate[]> {
  const rev = pinned(repo, revision);
  try {
    const files = new Map<string, Uint8Array>();
    for (const name of SOURCE_FILES) {
      const body = await hub.file(repo, rev, name);
      if (body) files.set(name, body);
    }
    for (const path of await hub.additional(repo, rev)) {
      const body = await hub.file(repo, rev, path);
      if (!body) throw new UpstreamError(`${repo}@${rev}: ${path} is listed but not found`);
      files.set(path, body);
    }
    return extract(`${repo}@${rev}`, files);
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    throw new UpstreamError(`${repo}@${rev}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// readTemplateSources (src/hf/sources.ts) over fetched bytes: the same sources in the same order and
// the same JSON rules, with every problem the readers would record an error instead. The tests hold
// the two to the same output on the same files.
function extract(where: string, files: Map<string, Uint8Array>): ExtractedTemplate[] {
  const out: ExtractedTemplate[] = [];
  const source = (kind: SourceKind, path: string, name: string, key?: string) => ({ kind, path, realPath: path, name, ...(key === undefined ? {} : { key }) });
  const fail = (path: string, message: string) => new UpstreamError(`${where}: ${path}: ${message}; the upstream template sources could not be read completely`);

  // `chat_template` may be a string or a list of {name, template}; each list entry stands alone.
  const fromJson = (path: string, kind: SourceKind) => {
    const bytes = files.get(path);
    if (!bytes) return;
    const parsed = parseJsonLikePython(bytes);
    if (!("value" in parsed)) throw fail(path, parsed.message);
    if (!isObject(parsed.value)) throw fail(path, "expected a JSON object");
    const ct = parsed.value.chat_template;
    if (ct === undefined || ct === null) return;
    if (typeof ct === "string") {
      out.push(makeTemplateFromString(source(kind, path, "default", "chat_template"), ct));
      return;
    }
    if (!Array.isArray(ct)) throw fail(path, "chat_template is neither a string nor a list");
    ct.forEach((entry: unknown, i) => {
      if (!isObject(entry) || typeof entry.name !== "string" || typeof entry.template !== "string") throw fail(path, `chat_template[${i}] is not {name, template} strings`);
      out.push(makeTemplateFromString(source(kind, path, entry.name, `chat_template[${i}].template`), entry.template));
    });
  };

  fromJson("tokenizer_config.json", "tokenizer_config");
  const jinja = files.get("chat_template.jinja");
  if (jinja) out.push(makeTemplate(source("chat_template_jinja", "chat_template.jinja", "default"), jinja));
  fromJson("chat_template.json", "chat_template_json");
  // In listing order, which is the readers' sorted name order.
  for (const [path, bytes] of files) {
    if (path.startsWith(`${ADDITIONAL}/`)) out.push(makeTemplate(source("additional_chat_templates", path, path.slice(ADDITIONAL.length + 1, -".jinja".length)), bytes));
  }
  fromJson("processor_config.json", "processor_config");
  return out;
}

interface Got {
  body: Uint8Array;
  /** The first hop's headers, where the hub states the commit and the etag. */
  first: Headers;
  last: Response;
}

interface GetOptions {
  /** Ask for the first `range` bytes and require a 206. */
  range?: number;
  /** A 404 EntryNotFound on the first hop is undefined rather than an error. */
  mayBeAbsent?: boolean;
  /** Runs on the final response before its body is read. */
  check?: (first: Headers, last: Response) => void;
}

/** The hub, read without credentials, within one budget of time and bytes. Every method throws UpstreamError on any failure. */
export class HubClient {
  private total = 0;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxTotal: number;

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    options: FetchOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? MAX_SOURCE_BYTES;
    this.maxTotal = options.maxTotalBytes ?? DEFAULT_READ_LIMITS.maxBytes;
  }

  /** One file at the pinned commit, checked against the commit and etag the hub states for it. Undefined when the hub says the file does not exist. */
  async file(repo: string, revision: string, path: string): Promise<Uint8Array | undefined> {
    const rev = pinned(repo, revision);
    const url = resolveUrl(repo, rev, path);
    let etag = "";
    const got = await this.get(url, this.maxBytes, {
      mayBeAbsent: true,
      check: (first, last) => {
        checkCommit(url, rev, first, last);
        etag = expectedEtag(url, first);
      },
    });
    if (!got) return undefined;
    verifyEtag(url, got.body, etag);
    return got.body;
  }

  /**
   * The first `length` bytes of a file at the pinned commit, and the file's full size, by one
   * Range request. The hub must answer 206 from the pinned commit, with a Content-Range for
   * exactly those bytes and a size that agrees with the one it linked.
   *
   * Unlike file(), the bytes are not checked against the etag: for a GGUF that is the SHA-256 of
   * the whole file, and a prefix cannot be hashed to it. That they are the pinned commit's bytes
   * rests on TLS to the hub's hosts and the x-repo-commit header alone.
   */
  async range(repo: string, revision: string, path: string, length: number): Promise<{ bytes: Uint8Array; size: number }> {
    const rev = pinned(repo, revision);
    const url = resolveUrl(repo, rev, path);
    let want = 0;
    let size = 0;
    const got = await this.get(url, length, {
      range: length,
      check: (first, last) => {
        checkCommit(url, rev, first, last);
        const m = /^bytes 0-(\d+)\/(\d+)$/.exec(last.headers.get("content-range")?.trim() ?? "");
        if (!m) throw new UpstreamError(`${url}: Content-Range ${JSON.stringify(last.headers.get("content-range"))} is not bytes 0-<end>/<size>`);
        size = Number(m[2]);
        want = Math.min(length, size);
        if (Number(m[1]) !== want - 1) throw new UpstreamError(`${url}: Content-Range ${m[0]} is not the ${want} bytes asked for`);
        const linked = first.get("x-linked-size");
        if (linked !== null && Number(linked) !== size) throw new UpstreamError(`${url}: Content-Range size ${size} is not the hub's linked size ${linked}`);
      },
    });
    if (!got) throw new UpstreamError(`${url}: not found`);
    if (got.body.byteLength !== want) throw new UpstreamError(`${url}: ${got.body.byteLength} bytes, not the ${want} the Content-Range states`);
    return { bytes: got.body, size };
  }

  /** A JSON document from the hub's API at `path` (/api/...), or undefined when the hub says it does not exist. */
  async json(path: string): Promise<{ value: unknown; headers: Headers } | undefined> {
    if (!path.startsWith("/api/")) throw new UpstreamError(`${path}: not a hub API path`);
    const url = `${HUB}${path}`;
    const got = await this.get(url, MAX_LISTING_BYTES, { mayBeAbsent: true });
    if (!got) return undefined;
    try {
      return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(got.body)), headers: got.last.headers };
    } catch (e) {
      throw new UpstreamError(`${url}: not JSON (${e instanceof Error ? e.message : e})`);
    }
  }

  /** The .jinja files listed in additional_chat_templates/ at the pinned commit, sorted. */
  async additional(repo: string, revision: string): Promise<string[]> {
    const path = `/api/models/${repo}/tree/${pinned(repo, revision)}/${ADDITIONAL}`;
    const url = `${HUB}${path}`;
    const got = await this.json(path);
    if (!got) return [];
    if (/\brel="?next"?/.test(got.headers.get("link") ?? "")) throw new UpstreamError(`${url}: the listing has more than one page; refusing a partial set`);
    if (!Array.isArray(got.value)) throw new UpstreamError(`${url}: the listing is not a JSON array`);
    const paths: string[] = [];
    for (const entry of got.value) {
      const { type, path } = (entry ?? {}) as { type?: unknown; path?: unknown };
      if (type === "directory") continue; // the readers ignore subdirectories too
      if (type !== "file" || typeof path !== "string") throw new UpstreamError(`${url}: unexpected listing entry ${JSON.stringify(entry)}`);
      const name = path.startsWith(`${ADDITIONAL}/`) ? path.slice(ADDITIONAL.length + 1) : undefined;
      // One path component, so the resolve URL names a file directly in the directory.
      if (name === undefined || name === "" || name === "." || name === ".." || /[/\\\0]/.test(name)) {
        throw new UpstreamError(`${url}: unexpected path ${JSON.stringify(path)} in the listing`);
      }
      if (name.endsWith(".jinja")) paths.push(path);
    }
    if (paths.length > DEFAULT_READ_LIMITS.maxAdditional) throw new UpstreamError(`${url}: ${paths.length} templates, over the limit of ${DEFAULT_READ_LIMITS.maxAdditional}`);
    return paths.sort();
  }

  // GET with no credentials, following redirects by hand.
  private async get(url: string, cap: number, options: GetOptions): Promise<Got | undefined> {
    try {
      return await this.attempt(url, cap, options);
    } catch (e) {
      if (e instanceof UpstreamError) throw e;
      throw new UpstreamError(`${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async attempt(url: string, cap: number, options: GetOptions): Promise<Got | undefined> {
    const deadline = new Deadline(this.timeoutMs, url);
    const headers: Record<string, string> = { accept: "*/*", "accept-encoding": "identity", "user-agent": "bassae" };
    if (options.range !== undefined) headers.range = `bytes=0-${options.range - 1}`;
    try {
      let current = url;
      let first: Headers | undefined;
      for (let hop = 0; ; hop++) {
        const res = await deadline.race(
          this.fetcher(current, { method: "GET", headers, redirect: "manual", credentials: "omit", decompress: false, signal: deadline.signal }),
        );
        first ??= res.headers;
        const refuse = async (why: string) => {
          await res.body?.cancel().catch(() => {});
          return new UpstreamError(why);
        };
        if (res.status >= 300 && res.status < 400) {
          if (hop >= MAX_REDIRECTS) throw await refuse(`${url}: more than ${MAX_REDIRECTS} redirects`);
          await res.body?.cancel().catch(() => {});
          current = redirectTarget(current, res.headers.get("location"));
          continue;
        }
        const code = res.headers.get("x-error-code");
        if (res.status === 401 || res.status === 403) {
          throw await refuse(`${url}: gated, private or missing (HTTP ${res.status}${code ? ` ${code}` : ""}). bassae never sends credentials, so --upstream works only with public, ungated repos.`);
        }
        // Only the hub itself, answering the request as made, can say a file is not there. A 404 from its CDN
        // after a redirect, or one without the hub's error code (a proxy, say), may hide a file that exists.
        if (res.status === 404 && hop === 0 && code === "EntryNotFound" && options.mayBeAbsent) {
          await res.body?.cancel().catch(() => {});
          return undefined;
        }
        const ok = options.range === undefined ? 200 : 206;
        if (res.status !== ok) throw await refuse(`${current}: HTTP ${res.status}${code ? ` ${code}` : ""}${options.range === undefined ? "" : " to a range request, not 206"}`);
        const encoding = res.headers.get("content-encoding")?.trim().toLowerCase();
        if (encoding && encoding !== "identity") throw await refuse(`${current}: refusing Content-Encoding ${JSON.stringify(encoding)}; only identity was asked for`);
        try {
          options.check?.(first, res);
        } catch (e) {
          await res.body?.cancel().catch(() => {});
          throw e;
        }
        const body = await this.read(res, cap, current, deadline);
        return { body, first, last: res };
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

const resolveUrl = (repo: string, revision: string, path: string) => `${HUB}/${repo}/resolve/${revision}/${path.split("/").map(encodeURIComponent).join("/")}`;

// The hub states the commit it served on the first hop; a later hop that states one must agree.
function checkCommit(url: string, revision: string, first: Headers, last: Response): void {
  const stated = first.get("x-repo-commit");
  if (!stated) throw new UpstreamError(`${url}: the hub did not state the commit it served (no x-repo-commit)`);
  for (const commit of [stated, last.headers.get("x-repo-commit") ?? stated]) {
    if (commit.trim().toLowerCase() !== revision) throw new UpstreamError(`${url}: the hub served commit ${commit}, not the pinned ${revision}`);
  }
}

// The hub's etag for a file is its git blob SHA-1, or its SHA-256 when it is an LFS file. The first hop
// carries it (as x-linked-etag on a redirect); a later hop's etag is the CDN's own and says nothing.
function expectedEtag(url: string, first: Headers): string {
  const raw = first.get("x-linked-etag") ?? first.get("etag");
  if (!raw) throw new UpstreamError(`${url}: the hub did not state the file's etag, so its content cannot be checked`);
  const value = raw.trim().replace(/^W\//, "").replace(/"/g, "").toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) throw new UpstreamError(`${url}: etag ${raw} is neither a git blob SHA-1 nor a SHA-256, so the content cannot be checked`);
  return value;
}

function verifyEtag(url: string, body: Uint8Array, etag: string): void {
  const actual =
    etag.length === 40 ? createHash("sha1").update(`blob ${body.byteLength}\0`).update(body).digest("hex") : createHash("sha256").update(body).digest("hex");
  if (actual !== etag) throw new UpstreamError(`${url}: content does not match the hub's etag ${etag}`);
}

// Only https, and only the hub's own hosts: the resolve endpoint redirects to itself and, for LFS files, to its CDN.
// Any host under huggingface.co or hf.co is trusted, not the CDN hosts alone; a subdomain the hub
// does not control is an accepted limit (Decisions 20:55).
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
