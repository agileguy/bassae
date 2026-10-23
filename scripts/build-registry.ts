// Builds the known-good registry from registry/sources.json, a list of repo@commit
// pins. Every template comes from https://huggingface.co/<repo>/resolve/<commit>/<file>,
// never from a local model: the local corpus only says which repos are worth pinning
// (ISC-24.1). No token is ever sent, so a gated or private repo fails instead of loading.
//
//   bun scripts/build-registry.ts
//
// Each repo's template-bearing files are downloaded into a fresh temp dir outside the
// repo and read with the bassae readers, so every entry's SHA-256 is exactly what a scan
// computes. GGUF files listed under "gguf" are read with HTTP range requests up to the end
// of their KV section. The temp dir is removed afterwards. Rewrites registry/known-good.json
// and registry/templates/, then loads the result to check it.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { bytesSource, readGgufSource } from "../src/gguf/index.ts";
import { readHfModel } from "../src/hf/index.ts";
import { loadRegistry, REGISTRY_DIR } from "../src/registry/index.ts";
import type { ExtractedTemplate, RegistryEntry } from "../src/types.ts";

interface Source {
  family: string;
  repo: string;
  revision: string;
  /** GGUF files in the repo whose embedded templates are pinned too. */
  gguf?: string[];
}

const HUB = "https://huggingface.co";
const HF_FILES = new Set(["tokenizer_config.json", "chat_template.jinja", "chat_template.json", "processor_config.json"]);
const MAX_FILE_BYTES = 64 * 1024 * 1024;
// GGUF prefixes tried in turn; the KV section of a large-vocabulary model runs to tens of MB.
const GGUF_PREFIXES = [8, 32, 128, 512].map((mb) => mb * 1024 * 1024);

// No Authorization header, ever: a gated repo must fail here, not be fetched with someone's token.
async function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "bassae-build-registry", ...headers } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res;
}

const resolveUrl = (s: Source, file: string) => `${HUB}/${s.repo}/resolve/${s.revision}/${file.split("/").map(encodeURIComponent).join("/")}`;

async function templateFiles(s: Source): Promise<string[]> {
  const info = (await (await get(`${HUB}/api/models/${s.repo}/revision/${s.revision}`)).json()) as {
    sha?: string;
    gated?: unknown;
    private?: boolean;
    siblings?: { rfilename: string }[];
  };
  if (info.sha !== s.revision) throw new Error(`${s.repo}: revision ${s.revision} resolved to ${info.sha}`);
  if (info.gated !== false || info.private !== false) throw new Error(`${s.repo} is gated or private; pin only public, ungated repos`);
  return (info.siblings ?? [])
    .map((x) => x.rfilename)
    .filter((f) => HF_FILES.has(f) || /^additional_chat_templates\/[^/]+\.jinja$/.test(f));
}

async function download(url: string): Promise<Uint8Array> {
  const bytes = new Uint8Array(await (await get(url)).arrayBuffer());
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`${url}: ${bytes.length} bytes, over ${MAX_FILE_BYTES}`);
  return bytes;
}

async function hfTemplates(s: Source, files: string[]): Promise<ExtractedTemplate[]> {
  if (files.length === 0) return [];
  const dir = mkdtempSync(join(tmpdir(), "bassae-registry-"));
  try {
    for (const f of files) {
      const path = join(dir, f);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, await download(resolveUrl(s, f)));
    }
    const record = await readHfModel(dir);
    const high = record.findings.filter((f) => f.severity === "HIGH");
    if (!record.extractionComplete || high.length > 0) throw new Error(`${s.repo}: extraction incomplete: ${high.map((f) => f.message).join("; ")}`);
    // Paths in the entry are paths in the repo, not in the temp dir.
    return record.templates.map((t) => ({ ...t, source: { ...t.source, path: relative(dir, t.source.path) } }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function ggufTemplates(s: Source, file: string): Promise<ExtractedTemplate[]> {
  for (const n of GGUF_PREFIXES) {
    const res = await get(resolveUrl(s, file), { range: `bytes=0-${n - 1}` });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const total = Number(/\/(\d+)$/.exec(res.headers.get("content-range") ?? "")?.[1] ?? bytes.length);
    const record = readGgufSource(bytesSource(bytes), file);
    if (record.extractionComplete) {
      const bad = record.findings.filter((f) => f.severity === "HIGH");
      if (bad.length > 0) throw new Error(`${s.repo}/${file}: ${bad.map((f) => f.message).join("; ")}`);
      return record.templates;
    }
    if (bytes.length >= total) break;
  }
  throw new Error(`${s.repo}/${file}: KV section not complete within ${GGUF_PREFIXES.at(-1)} bytes`);
}

function readSources(): Source[] {
  const file = JSON.parse(readFileSync(join(REGISTRY_DIR, "sources.json"), "utf8")) as { sources?: Source[] };
  const sources = file.sources ?? [];
  for (const s of sources) {
    if (!s.family || !/^[\w.-]+\/[\w.-]+$/.test(s.repo) || !/^[0-9a-f]{40}$/.test(s.revision)) throw new Error(`bad source ${JSON.stringify(s)}`);
  }
  return sources;
}

const entries: RegistryEntry[] = [];
const texts = new Map<string, Uint8Array>();
for (const s of readSources()) {
  const templates = [...(await hfTemplates(s, await templateFiles(s)))];
  for (const f of s.gguf ?? []) templates.push(...(await ggufTemplates(s, f)));
  if (templates.length === 0) throw new Error(`${s.repo}@${s.revision}: no chat template`);
  for (const t of templates) {
    entries.push({ family: s.family, repo: s.repo, revision: s.revision, path: t.source.path, templateName: t.source.name, sha256: t.sha256 });
    texts.set(t.sha256, t.bytes);
  }
  console.log(`${s.repo}@${s.revision.slice(0, 12)}: ${templates.map((t) => `${t.source.path} ${t.source.name} ${t.sha256.slice(0, 12)}`).join(", ")}`);
}

entries.sort((a, b) => [a.family, a.repo, a.revision, a.path, a.templateName].join("\0").localeCompare([b.family, b.repo, b.revision, b.path, b.templateName].join("\0")));
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
