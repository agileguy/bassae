// Shared fixtures for the scan pipeline tests: stock-shaped templates, a Hugging Face cache layout,
// registry entries, and stand-ins for differential rendering and the renderer.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRegistry } from "../../../src/registry/index.ts";
import type { DiffRenderInput, DiffRenderResult, KnownGoodTemplate, Registry, Renderer, ScanOptions } from "../../../src/types.ts";
import { link, type Tree } from "../../helpers/tree.ts";

export const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

/** The git blob SHA-1 huggingface_hub names a regular file's blob by. */
export function gitBlob(content: string | Uint8Array): string {
  const b = typeof content === "string" ? Buffer.from(content) : content;
  return createHash("sha1").update(`blob ${b.byteLength}\0`).update(b).digest("hex");
}

/** A ChatML template every rule passes once its two special tokens are declared. */
export const CHATML =
  "{% for message in messages %}<|im_start|>{{ message.role }}\n{{ message.content }}<|im_end|>\n{% endfor %}{% if add_generation_prompt %}<|im_start|>assistant\n{% endif %}";

/** CHATML with an always-on instruction: MEDIUM unbaselined_text (ISC-17.1). */
export const CHATML_MEDIUM = CHATML.replace("{% endfor %}", "{% endfor %}Always answer politely.\n");

/** CHATML with a dunder: HIGH dunder_access (ISC-13). */
export const CHATML_HIGH = CHATML.replace("{% endfor %}", "{% endfor %}{{ message.__class__ }}");

/** CHATML with a jinja2 filter the JS engine lacks: MEDIUM unanalyzable, and code-exec analysis incomplete (ISC-12.1). */
export const CHATML_UNANALYZABLE = `${CHATML}{{ messages | map('upper') | list }}`;

/**
 * CHATML with CRLF line ends, a widened gap inside a tag and a trailing newline: a whitespace-only variant
 * (ISC-24.2). Whitespace goes only where some already was, since splitting a run of text is a real change.
 */
export const CHATML_VARIANT = `${CHATML.replaceAll("\n", "\r\n").replace("{% for", "{%   for")}\r\n`;

/** tokenizer_config.json declaring the ChatML special tokens, with extra fields merged in. */
export function tokenizerConfig(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ added_tokens_decoder: { "1": { content: "<|im_start|>" }, "2": { content: "<|im_end|>" } }, ...extra });
}

/** An HF/MLX model directory holding `template` as chat_template.jinja. */
export function hfModel(template: string, extra: Tree = {}): Tree {
  return { "tokenizer_config.json": tokenizerConfig(), "chat_template.jinja": template, ...extra };
}

/** A Hugging Face cache repo folder: every revision's files link into blobs/, each blob named by its git blob hash as huggingface_hub writes it. */
export function hfCacheRepo(revisions: Record<string, Record<string, string | Uint8Array>>): Tree {
  const blobs: Tree = {};
  const snapshots: Tree = {};
  for (const [rev, files] of Object.entries(revisions)) {
    const snap: Tree = {};
    for (const [name, content] of Object.entries(files)) {
      const etag = gitBlob(content);
      blobs[etag] = content;
      snap[name] = link(`../../blobs/${etag}`);
    }
    snapshots[rev] = snap;
  }
  return { blobs, snapshots, refs: { main: Object.keys(revisions)[0]! } };
}

export const REV_A = "0123456789abcdef0123456789abcdef01234567";
export const REV_B = "89abcdef0123456789abcdef0123456789abcdef";

/** A registry entry pinning `text`. */
export function known(text: string, entry: Partial<KnownGoodTemplate["entry"]> = {}): KnownGoodTemplate {
  return {
    entry: { family: "chatml", repo: "acme/chat", revision: "a".repeat(40), path: "chat_template.jinja", templateName: "default", sha256: sha256(text), ...entry },
    text,
  };
}

/** A registry whose one entry is CHATML. */
export const chatmlRegistry = (): Registry => createRegistry([known(CHATML)]);

const PROBES = 4;

/** Differential rendering that rendered every probe and found nothing. */
export async function completeRender(): Promise<DiffRenderResult> {
  return { findings: [], complete: true, probes: { total: PROBES, rendered: PROBES, refused: 0, failed: 0 } };
}

/** Differential rendering whose probes mostly failed to render (ISC-42.1). */
export async function failedRender(): Promise<DiffRenderResult> {
  return { findings: [], complete: false, probes: { total: PROBES, rendered: 1, refused: 0, failed: PROBES - 1 } };
}

/** A diffRender hook that counts its calls and keeps each input, answering completeRender. */
export function countingRender(answer: (input: DiffRenderInput) => Promise<DiffRenderResult> = completeRender) {
  const inputs: DiffRenderInput[] = [];
  const hook: NonNullable<ScanOptions["diffRender"]> = async (input) => {
    inputs.push(input);
    return answer(input);
  };
  return { hook, inputs };
}

/** A renderer that renders nothing: every request is a sandbox failure. Registry divergence then fails closed. */
export const deadRenderer: Renderer = {
  async renderBatch(_template, requests) {
    return requests.map((r) => ({ id: r.id, ok: false, failure: "sandbox", message: "test renderer renders nothing" }));
  },
};

/** Scan options for a fixture: no registry entries, a supplied renderer and complete differential rendering, unless overridden. */
export function options(roots: string[], extra: Partial<ScanOptions> = {}): ScanOptions {
  return { roots, templates: [], online: false, registry: createRegistry([]), renderer: deadRenderer, diffRender: completeRender, ...extra };
}

/** SHA-256 and mtime of every real file under `root` and the names in every directory, links followed (ISC-35). */
export function snapshotTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Set<string>();
  const walk = (path: string) => {
    const st = statSync(path);
    const key = `${st.dev}:${st.ino}`;
    if (st.isDirectory()) {
      if (seen.has(key)) return;
      seen.add(key);
      const names = readdirSync(path).sort();
      out.set(path, `dir ${st.mtimeMs} ${names.join("\0")}`);
      for (const n of names) walk(join(path, n));
    } else if (st.isFile()) {
      out.set(path, `file ${st.mtimeMs} ${st.size} ${sha256(readFileSync(path))}`);
    }
  };
  walk(root);
  return out;
}
