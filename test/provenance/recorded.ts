// Recorded huggingface.co responses for fetchUpstream's tests, so no test ever
// touches the network. `bun test/provenance/recorded.ts <repo> <revision>` records
// a set once, live, through fetchUpstream itself; recordedFetcher replays it.
//
// Recorded sandbox renders too, so divergence's outcome 3 runs where no sandbox
// can: `bun test/provenance/recorded.ts renders` renders RENDER_TEMPLATES over the
// probe set once; recordedRenderer replays it. Outputs are kept as their SHA-256,
// which is all an identical-output comparison needs.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probeRequests } from "../../src/provenance/divergence.ts";
import type { Renderer, RenderRequest, RenderResult } from "../../src/types.ts";

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

const CHATML =
  "{% for message in messages %}<|im_start|>{{ message.role }}\n{{ message.content }}<|im_end|>\n{% endfor %}\n{% if add_generation_prompt %}<|im_start|>assistant\n{% endif %}";
const STRICT = `{% if messages[0].role == 'system' %}{{ raise_exception('System role not supported') }}{% endif %}${CHATML}`;
const rename = (t: string) => t.replaceAll("message.", "m.").replace("for message in", "for m in");

/** The texts the divergence tests render: two trusted baselines and three control-flow-only rewrites of them. */
export const RENDER_TEMPLATES = {
  CHATML,
  /** The loop variable renamed: same literals, same output. */
  RENAMED: rename(CHATML),
  /** Assistant turns with tool calls dropped: same literals, different output on the tool shape only. */
  TOOL_GATED: CHATML.replace("{% for message in messages %}", "{% for message in messages %}{% if message.tool_calls is not defined %}").replace("{% endfor %}", "{% endif %}{% endfor %}"),
  /** A trusted template that refuses a system turn, as Gemma's does. */
  STRICT,
  STRICT_RENAMED: rename(STRICT),
};

export const RENDER_FIXTURE = join(import.meta.dir, "fixtures", "renders.json");

interface RenderRecording {
  /** The probe ids, in order, the recording was made with. */
  ids: string[];
  /** Per template SHA-256, per probe: the output's SHA-256, or the failure. */
  templates: Record<string, (string | { failure: string; message: string })[]>;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** A Renderer that answers from the recording and throws on any template or probe set it was not recorded with. */
export function recordedRenderer(file = RENDER_FIXTURE): Renderer {
  const rec: RenderRecording = JSON.parse(readFileSync(file, "utf8"));
  return {
    async renderBatch(template: string, requests: RenderRequest[]): Promise<RenderResult[]> {
      const results = rec.templates[sha256(template)];
      if (!results) throw new Error(`no recorded renders for template ${sha256(template).slice(0, 12)}; run bun test/provenance/recorded.ts renders`);
      if (requests.length !== rec.ids.length || requests.some((r, i) => r.id !== rec.ids[i])) throw new Error("the probe set changed since the renders were recorded; run bun test/provenance/recorded.ts renders");
      return requests.map((r, i) => {
        const got = results[i]!;
        return typeof got === "string" ? { id: r.id, ok: true, output: got } : { id: r.id, ok: false, failure: got.failure as never, message: got.message };
      });
    },
  };
}

/** Renders every RENDER_TEMPLATES text over the probe set with `renderer`, in recordedRenderer's form. */
export async function recordRenders(renderer: Renderer): Promise<RenderRecording> {
  const requests = probeRequests();
  const templates: RenderRecording["templates"] = {};
  for (const text of Object.values(RENDER_TEMPLATES)) {
    const results = await renderer.renderBatch(text, requests);
    templates[sha256(text)] = results.map((r) => (r.ok ? sha256(r.output) : { failure: r.failure, message: r.message }));
  }
  return { ids: requests.map((r) => r.id), templates };
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

if (import.meta.main && process.argv[2] === "renders") {
  const { createRenderer } = await import("../../src/sandbox/index.ts");
  writeFileSync(RENDER_FIXTURE, `${JSON.stringify(await recordRenders(createRenderer()))}\n`);
  console.log(`renders recorded in ${RENDER_FIXTURE}`);
} else if (import.meta.main) {
  const [repo, revision] = process.argv.slice(2);
  if (!repo || !revision) throw new Error("usage: bun test/provenance/recorded.ts <org/name> <40-hex revision>");
  await record(repo, revision);
}
