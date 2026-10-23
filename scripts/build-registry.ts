// Builds the known-good registry from registry/sources.json, a list of repo@commit
// pins. Every template comes from huggingface.co at the pinned commit, never from a
// local model: the local corpus only says which repos are worth pinning (ISC-24.1).
//
//   bun scripts/build-registry.ts
//
// Every request goes through HubClient in src/provenance/online.ts, the client
// --online uses, so the trust root is built with the same guarantees: no token, ever
// (a gated or private repo fails instead of loading); redirects only to the hub's own
// https hosts; a timeout and a streaming size cap on every request; identity encoding
// only; and every file checked against the commit and etag the hub states for it.
// HF template sources are extracted in memory the way a scan extracts them, so every
// entry's SHA-256 is exactly what a scan computes. GGUF files listed under "gguf" are
// read with Range requests, each answered 206 with a matching Content-Range, up to the
// end of their KV section. Rewrites registry/known-good.json and registry/templates/,
// then loads the result to check it.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bytesSource, readGgufSource } from "../src/gguf/index.ts";
import { isObject } from "../src/hf/sources.ts";
import { HubClient, pinned, upstreamTemplates } from "../src/provenance/online.ts";
import { loadRegistry, REGISTRY_DIR } from "../src/registry/index.ts";
import type { ExtractedTemplate, RegistryEntry } from "../src/types.ts";

export interface Source {
  family: string;
  repo: string;
  revision: string;
  /** GGUF files in the repo whose embedded templates are pinned too. */
  gguf?: string[];
}

// GGUF prefixes tried in turn; the KV section of a large-vocabulary model runs to tens of MB.
const GGUF_PREFIXES = [8, 32, 128, 512].map((mb) => mb * 1024 * 1024);
// One client per source: room for every prefix of its GGUF files, and time for the largest one.
const CLIENT_OPTIONS = { timeoutMs: 10 * 60_000, maxTotalBytes: 2 * 1024 * 1024 * 1024 };

// The hub's own word that the pin is a public, ungated commit, before anything is read from it.
async function checkPublic(hub: HubClient, s: Source): Promise<void> {
  const info = await hub.json(`/api/models/${s.repo}/revision/${s.revision}`);
  if (!info || !isObject(info.value)) throw new Error(`${s.repo}@${s.revision}: no revision info`);
  const { sha, gated, private: priv } = info.value;
  if (sha !== s.revision) throw new Error(`${s.repo}: revision ${s.revision} resolved to ${String(sha)}`);
  if (gated !== false || priv !== false) throw new Error(`${s.repo} is gated or private; pin only public, ungated repos`);
}

async function ggufTemplates(hub: HubClient, s: Source, file: string): Promise<ExtractedTemplate[]> {
  for (const n of GGUF_PREFIXES) {
    const { bytes, size } = await hub.range(s.repo, s.revision, file, n);
    const record = readGgufSource(bytesSource(bytes), file);
    if (record.extractionComplete) {
      const bad = record.findings.filter((f) => f.severity === "HIGH");
      if (bad.length > 0) throw new Error(`${s.repo}/${file}: ${bad.map((f) => f.message).join("; ")}`);
      return record.templates;
    }
    if (bytes.length >= size) break;
  }
  throw new Error(`${s.repo}/${file}: KV section not complete within ${GGUF_PREFIXES.at(-1)} bytes`);
}

export function readSources(): Source[] {
  const file = JSON.parse(readFileSync(join(REGISTRY_DIR, "sources.json"), "utf8")) as { sources?: Source[] };
  const sources = file.sources ?? [];
  for (const s of sources) {
    if (!s.family) throw new Error(`bad source ${JSON.stringify(s)}`);
    // The same repo and revision checks as --upstream; a pin must already be lowercase so entries compare exactly.
    if (pinned(s.repo, s.revision) !== s.revision) throw new Error(`bad source ${JSON.stringify(s)}: revision must be lowercase`);
  }
  return sources;
}

/** Every entry and template text for `sources`, read from the hub. `fetcher` is for tests; the default is HubClient's. */
export async function collect(sources: Source[], fetcher?: typeof fetch, log: (line: string) => void = console.log): Promise<{ entries: RegistryEntry[]; texts: Map<string, Uint8Array> }> {
  const entries: RegistryEntry[] = [];
  const texts = new Map<string, Uint8Array>();
  for (const s of sources) {
    const hub = new HubClient(fetcher, CLIENT_OPTIONS);
    await checkPublic(hub, s);
    const templates = await upstreamTemplates(hub, s.repo, s.revision);
    for (const f of s.gguf ?? []) templates.push(...(await ggufTemplates(hub, s, f)));
    if (templates.length === 0) throw new Error(`${s.repo}@${s.revision}: no chat template`);
    for (const t of templates) {
      entries.push({ family: s.family, repo: s.repo, revision: s.revision, path: t.source.path, templateName: t.source.name, sha256: t.sha256 });
      texts.set(t.sha256, t.bytes);
    }
    log(`${s.repo}@${s.revision.slice(0, 12)}: ${templates.map((t) => `${t.source.path} ${t.source.name} ${t.sha256.slice(0, 12)}`).join(", ")}`);
  }
  entries.sort((a, b) => [a.family, a.repo, a.revision, a.path, a.templateName].join("\0").localeCompare([b.family, b.repo, b.revision, b.path, b.templateName].join("\0")));
  return { entries, texts };
}

if (import.meta.main) {
  const { entries, texts } = await collect(readSources());
  const templatesDir = join(REGISTRY_DIR, "templates");
  mkdirSync(templatesDir, { recursive: true });
  for (const name of readdirSync(templatesDir)) if (!texts.has(name.replace(/\.jinja$/, ""))) rmSync(join(templatesDir, name));
  for (const [sha, bytes] of texts) {
    const path = join(templatesDir, `${sha}.jinja`);
    if (!existsSync(path)) writeFileSync(path, bytes);
  }
  writeFileSync(join(REGISTRY_DIR, "known-good.json"), `${JSON.stringify({ entries }, null, 2)}\n`);

  const registry = loadRegistry();
  console.log(`\n${registry.entries.length} entries, ${texts.size} distinct templates`);
}
