// Recorded huggingface.co responses for fetchUpstream's tests, so no test ever
// touches the network. `bun test/provenance/recorded.ts <repo> <revision>` records
// a set once, live, through fetchUpstream itself; recordedFetcher replays it.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RECORDED = join(import.meta.dir, "recorded");

export interface RecordedResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  /** File under the set's directory holding the exact body bytes. */
  body: string;
}

// Only what fetchUpstream reads, plus what explains a response to a reader of the fixture.
const KEPT_HEADERS = ["content-type", "content-length", "location", "link", "etag", "x-repo-commit", "x-linked-etag", "x-linked-size", "x-error-code", "x-error-message"];

export const setDir = (repo: string, revision: string) => join(RECORDED, `${repo.replace("/", "--")}@${revision}`);

/** A fetch that answers only recorded URLs and keeps every request it was given. */
export function recordedFetcher(dir: string): { fetcher: typeof fetch; requests: { url: string; init?: RequestInit }[] } {
  const index: RecordedResponse[] = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
  const byUrl = new Map(index.map((r) => [r.url, r]));
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, init });
    const r = byUrl.get(url);
    if (!r) throw new Error(`no recorded response for ${url}`);
    return new Response(readFileSync(join(dir, r.body)), { status: r.status, headers: r.headers });
  }) as typeof fetch;
  return { fetcher, requests };
}

async function record(repo: string, revision: string): Promise<void> {
  const { fetchUpstream } = await import("../../src/provenance/online.ts");
  const dir = setDir(repo, revision);
  mkdirSync(dir, { recursive: true });
  const index: RecordedResponse[] = [];
  const recording = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const res = await fetch(url, init);
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    const body = `${String(index.length).padStart(2, "0")}.body`;
    writeFileSync(join(dir, body), bytes);
    const headers: Record<string, string> = {};
    for (const name of KEPT_HEADERS) {
      const v = res.headers.get(name);
      if (v !== null) headers[name] = v;
    }
    index.push({ url, status: res.status, headers, body });
    return res;
  }) as typeof fetch;
  const baselines = await fetchUpstream(repo, revision, recording);
  writeFileSync(join(dir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  console.log(`${index.length} responses recorded in ${dir}`);
  for (const b of baselines) if (b.kind === "upstream") console.log(`  ${b.path} [${b.templateName}] ${b.text.length} chars`);
}

if (import.meta.main) {
  const [repo, revision] = process.argv.slice(2);
  if (!repo || !revision) throw new Error("usage: bun test/provenance/recorded.ts <org/name> <40-hex revision>");
  await record(repo, revision);
}
