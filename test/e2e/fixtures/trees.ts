// The models the end-to-end tests scan: one per status, built from a registry template pinned in
// registry/sources.json and from the scan tests' ChatML template, so every expected status follows from
// a real rule or a real gap and the sandboxed renderer decides the rest.
//
// No template here needs `reject` or a positional `map`, which the JS engine gains only with its polyfills,
// so each status holds before and after they land.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelReport, ScanReport } from "../../../src/types.ts";
import type { Tree } from "../../helpers/tree.ts";
import { CHATML, CHATML_HIGH, CHATML_MEDIUM, hfCacheRepo, hfModel, tokenizerConfig } from "../../scan/fixtures/pipeline.ts";
import { ROOT } from "./cli.ts";

export const sha256 = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");

interface Pinned {
  repo: string;
  revision: string;
  path: string;
  sha256: string;
  text: string;
}

/** A registry template byte for byte: the revision sources.json pins, the entry known-good.json gives it, the file in registry/templates. */
function pinned(repo: string, path: string): Pinned {
  const read = (name: string) => JSON.parse(readFileSync(join(ROOT, "registry", name), "utf8"));
  const source = (read("sources.json").sources as { repo: string; revision: string }[]).find((s) => s.repo === repo);
  const entry = (read("known-good.json").entries as { repo: string; revision: string; path: string; sha256: string }[]).find(
    (e) => e.repo === repo && e.revision === source?.revision && e.path === path,
  );
  if (!source || !entry) throw new Error(`${repo} ${path} is not pinned in the registry`);
  const bytes = readFileSync(join(ROOT, "registry", "templates", `${entry.sha256}.jinja`));
  if (sha256(bytes) !== entry.sha256) throw new Error(`registry/templates/${entry.sha256}.jinja does not hash to its name`);
  return { repo, revision: source.revision, path, sha256: entry.sha256, text: bytes.toString("utf8") };
}

/** LFM2-1.2B-Tool's chat_template.jinja: small, stock, and it renders every probe. */
export const LFM2 = pinned("LiquidAI/LFM2-1.2B-Tool", "chat_template.jinja");

function changed(text: string, from: string | RegExp, to: string): string {
  const out = text.replace(from, to);
  if (out === text) throw new Error(`fixture edit found nothing to change: ${String(from)}`);
  return out;
}

/** Wider gaps inside a tag and a trailing newline: whitespace only (ISC-24.2). */
export const LFM2_VARIANT = `${changed(LFM2.text, "{%- set system_prompt", "{%-   set system_prompt")}\n`;

/** The last tag stops trimming whitespace that is never there: control flow only, identical output, so LOW (ISC-25). */
export const LFM2_LOW = changed(LFM2.text, /\{%- endif -%\}$/, "{%- endif %}");

/** LFM2's special tokens, so its scaffolding is not read as injected text. */
export function lfm2Config(): string {
  const tokens = ["<|startoftext|>", "<|im_start|>", "<|im_end|>", "<|tool_list_start|>", "<|tool_list_end|>", "<|tool_response_start|>", "<|tool_response_end|>"];
  return JSON.stringify({ bos_token: "<|startoftext|>", added_tokens_decoder: Object.fromEntries(tokens.map((content, i) => [String(i + 1), { content }])) });
}

const lfm2Model = (template: string): Tree => ({ "tokenizer_config.json": lfm2Config(), "chat_template.jinja": template });

/**
 * A guard on conversation length past the most messages any probe builds: the scanner cannot render
 * what the template does beyond it, so that probe is cut and the template is incomplete (ISC-42.1).
 */
export const CHATML_LENGTH_GATE = changed(CHATML, "{% for message in messages %}", "{% if messages|length > 10000 %}{{ raise_exception('Conversation too long.') }}{% endif %}{% for message in messages %}");

/** A template that refuses every conversation: no ordinary probe renders, so nothing could be checked (ISC-42.1). */
export const REFUSES_ALL = "{{ raise_exception('This model does not support chat.') }}";

/** Each fixture's directory name, its template status and its model status. */
export const EXPECTED = {
  "known-good": "known-good",
  "known-good-variant": "known-good-variant",
  "clean-unverified": "clean-unverified",
  "findings-high": "findings",
  "findings-medium": "findings",
  "findings-low": "findings",
  incomplete: "incomplete",
  "incomplete-refuses": "incomplete",
  "no-template": "no_template",
} as const;

export type Fixture = keyof typeof EXPECTED;

/** One model directory per status. findings-low is a Hugging Face cache repo, so its registry entry is its baseline. */
export function statusTree(): Record<Fixture, Tree> {
  return {
    "known-good": lfm2Model(LFM2.text),
    "known-good-variant": lfm2Model(LFM2_VARIANT),
    "clean-unverified": hfModel(CHATML),
    "findings-high": hfModel(CHATML_HIGH),
    "findings-medium": hfModel(CHATML_MEDIUM),
    "findings-low": { "models--LiquidAI--LFM2-1.2B-Tool": hfCacheRepo({ [LFM2.revision]: lfm2Model(LFM2_LOW) as Record<string, string> }) },
    incomplete: hfModel(CHATML_LENGTH_GATE),
    "incomplete-refuses": hfModel(REFUSES_ALL),
    "no-template": { "tokenizer_config.json": tokenizerConfig(), "tokenizer.json": JSON.stringify({ added_tokens: [] }) },
  };
}

/** The one model found at or under `dir`. */
export function modelAt(report: ScanReport, dir: string): ModelReport {
  const found = report.models.filter((m) => m.id === dir || m.id.startsWith(`${dir}/`));
  if (found.length !== 1) throw new Error(`expected one model under ${dir}, found ${found.length}`);
  return found[0]!;
}

/** 1-based line and column of the first `needle` in `text`, as the report counts them. */
export function positionOf(text: string, needle: string): string {
  const at = text.indexOf(needle);
  if (at < 0) throw new Error(`${needle} not in the fixture`);
  const before = text.slice(0, at).split("\n");
  return `${before.length}:${before.at(-1)!.length + 1}`;
}

export { CHATML, CHATML_HIGH, CHATML_MEDIUM };
