// Hidden-instruction rules: injected text, content triggers, nondeterminism,
// URLs, encoded blobs and invisible characters (ISC-17 to ISC-21). Parse-only:
// nothing here renders a template.
//
// analyzeInjection never throws and always returns a RuleResult, like
// analyzeCodeExec: an internal failure is a finding and the result is
// incomplete. Extraction (injected.ts) is bounded in time and memory; over the
// size cap there is no AST, token array or line map, and only the raw-text
// forms of the text rules run.

import type { AnalysisContext, Finding, FindingBase, InjectedText, KnownGoodTemplate, ModelRecord, RuleResult } from "../types.ts";
import { parseTemplate, WHOLE_TEMPLATE } from "../parse/parse.ts";
import { preLex } from "../parse/prelexer.ts";
import { extract, rawItems, Scaffold } from "./injected.ts";
import { findEncodedBlobs, findEncodedBlobsIn, findInvisibleChars, findUrls, findUrlsRaw, scanUrls } from "./textscan.ts";
import { capPerRule, clip, dedupe, pushAll } from "./finalize.ts";
import { forEachLiteral } from "./literals.ts";
import { whitespaceKey } from "../whitespace.ts";

// Role and channel names a template writes between special tokens. A channel
// (gpt-oss `analysis`, Gemma `thought`) is routing, not instruction, so it is
// scaffolding too.
const ROLE_NAMES = [
  "system", "user", "assistant", "tool", "tools", "model", "developer", "function", "functions", "ipython",
  "bot", "human", "gpt", "observation", "analysis", "commentary", "final", "thought", "thinking",
];

// Whitespace and delimiter strings. The matcher ignores any piece with no letter
// or digit, since such a piece never decides whether text is injected; these are
// listed so the set is complete as a description of scaffolding.
const DELIMITERS = ["\n", "\n\n", " ", "\t", "\r\n", ": ", ":", "|", "-", "#"];

// A wrapped special token whose inner name is longer than this reads as prose
// even with no space in it. The longest stock name is about 30 characters
// (`<|reserved_special_token_250|>`).
const MAX_TOKEN_NAME = 48;

// A one-word name longer than this reads as prose (`ignorepreviousinstructions`).
// The longest stock one is 11 characters (`startoftext`, `endofprompt`).
const MAX_NAME_WORD = 20;

// The words stock special-token names are made of, from the declared tokens of
// the local models (Qwen, Gemma, gpt-oss, LFM2, SmolLM) and the well-known
// families (Llama, Mistral, DeepSeek, GLM, Phi, Cohere, Granite, Kimi, MiniMax,
// Seed-OSS, Hunyuan, Ernie, StarCoder). A name of two or more words reads as
// prose when any word is outside this set: `<|reserved_special_token_250|>` is
// structure, `<|ignore_previous_instructions|>` is a sentence. Role names count
// as well. test/rules/fixtures/stock-special-tokens.json pins the tokens.
const NAME_WORDS = new Set([
  "action", "after", "arg", "argument", "audio", "available", "before", "begin", "bos", "box", "break", "budget",
  "call", "calls", "chatbot", "closed", "code", "col", "comment", "commit", "content", "cot", "crop", "declaration",
  "empty", "end", "eod", "eom", "eos", "eot", "extra", "file", "fim", "finetune", "g", "gh", "header", "hole",
  "holder", "hy", "id", "im", "image", "img", "issue", "jupyter", "key", "list", "mask", "mid", "middle", "minimax",
  "mixed", "msg", "name", "no", "object", "of", "output", "outputs", "pad", "place", "placeholder", "post", "pre",
  "prefix", "prompt", "python", "quad", "receiver", "ref", "reflect", "repo", "reserved", "response", "result",
  "results", "review", "right", "role", "row", "scratch", "script", "section", "seed", "sentence", "sep", "separator",
  "single", "soft", "solution", "special", "stars", "start", "step", "suf", "suffix", "tag", "text", "think", "tile",
  "token", "train", "tts", "turn", "unused", "value", "video", "vision", "x", "y",
  ...ROLE_NAMES,
]);

const ROLE_SET = new Set(ROLE_NAMES);

/**
 * True when a special token reads as prose and so is not scaffolding (ISC-17.3).
 * Scaffolding tokens are whitespace or punctuation (`▁▁`, `<|"|>`), role names,
 * or a name marked by delimiter characters, at one end or both, that is one
 * word or is made of the words stock token names use (`<|im_start|>`, `[INST]`,
 * `<｜begin▁of▁sentence｜>`, GLM's `/nothink`). Anything else, a bare word, a
 * marked phrase, a name of other words however they are joined (`▁`, `Ġ`, `_`,
 * `-`, camelCase), or a name holding a domain, is something a template could
 * hide an instruction in by declaring it a control token. A sentence split into
 * one-word tokens (`<|Ignore|><|previous|>`) is a known limit.
 */
export function readsAsProse(token: string): boolean {
  if (!/[\p{L}\p{N}]/u.test(token)) return false;
  if (ROLE_SET.has(token.toLowerCase())) return false;
  const m = /^([^\p{L}\p{N}\s]*)([\s\S]*?)([^\p{L}\p{N}\s]*)$/u.exec(token)!;
  if (!m[1] && !m[3]) return true; // a bare word or phrase; `Ġ` is a letter, so `ĠIgnoreĠall` is one
  const inner = m[2]!;
  if (/[\p{L}\p{N}][\s]+[\p{L}\p{N}]/u.test(inner)) return true;
  if (inner.length > MAX_TOKEN_NAME) return true;
  if (/^0x[0-9a-f]+$/i.test(inner)) return false; // a byte token, `<0x0A>`
  let host = false;
  scanUrls(inner, 0, inner.length, () => (host = true));
  if (host) return true;
  const words = nameWords(inner);
  if (words.length <= 1) return (words[0]?.length ?? 0) > MAX_NAME_WORD;
  return words.some((w) => !NAME_WORDS.has(w.toLowerCase()));
}

// The words of a token name: split at the separators tokenizers and templates
// use, at camelCase and at letters next to digits, without the numbers.
function nameWords(inner: string): string[] {
  const s = inner
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/(\p{L})(\p{N})|(\p{N})(\p{L})/gu, (_, a, b, c, d) => (a ? `${a} ${b}` : `${c} ${d}`));
  return s.split(/[^\p{L}\p{N}]+|[ĠĊĉ]/u).filter((w) => w && !/^\p{N}+$/u.test(w));
}

/** Every literal of a template: string literals and text between tags, as written and trimmed. */
export function templateLiterals(text: string): Set<string> {
  const out = new Set<string>();
  const pre = preLex(text);
  for (const s of pre.stringLiterals) if (s.value) out.add(s.value);
  for (const s of pre.textSegments) {
    if (s.value) out.add(s.value);
    const t = s.value.trim();
    if (t) out.add(t);
  }
  return out;
}

/** Scaffolding for one template: the model's special tokens that do not read as prose (ISC-17.3), role names, whitespace and delimiters, and the text `known` emits. */
export function buildScaffolding(model: ModelRecord, known?: KnownGoodTemplate): Set<string> {
  const out = new Set<string>();
  for (const t of model.specialTokens) if (!readsAsProse(t)) out.add(t);
  for (const r of ROLE_NAMES) {
    out.add(r);
    out.add(r[0]!.toUpperCase() + r.slice(1));
    out.add(r.toUpperCase());
  }
  for (const d of DELIMITERS) out.add(d);
  if (known) for (const l of baseline(known).pieces) out.add(l);
  return out;
}

// The text a template emits: its literals, and what its constant expressions
// fold to. gpt-oss writes `"namespace " + namespace_name + " {"` with a constant
// name, and no single literal holds `namespace functions {`; read word by word,
// `functions` after `namespace` is a bare word inside a sentence and would be
// residue.
function emitted(text: string): Set<string> {
  const out = templateLiterals(text);
  const outcome = parseTemplate(text);
  if (outcome.program) for (const it of extract(outcome, text, new Set()).items) out.add(it.text);
  return out;
}

interface Baseline {
  pieces: ReadonlySet<string>;
  keys: ReadonlySet<string>;
}
const BASELINES = new WeakMap<KnownGoodTemplate, Baseline>();

/** What a registry entry emits, and its whitespace keys. Read once per entry. */
function baseline(known: KnownGoodTemplate): Baseline {
  let b = BASELINES.get(known);
  if (!b) {
    const pieces = emitted(known.text);
    BASELINES.set(known, (b = { pieces, keys: new Set([...pieces].map(whitespaceKey)) }));
  }
  return b;
}

// The scaffolding the extraction matches against: the context's set, plus what
// the registry entry emits when there is one (ISC-17.1), so a caller that built
// scaffolding without `known` still gets baselined text removed. A literal of
// this template equal to one of those up to ASCII whitespace is baselined too
// (ISC-24.2): a CRLF or re-indented copy of an entry emits `<end_of_turn>\r\n`
// where the entry has `<end_of_turn>\n`. `knownGood` is still the exact hash.
function effectiveScaffolding(ctx: AnalysisContext): ReadonlySet<string> {
  if (!ctx.known) return ctx.scaffolding;
  const b = baseline(ctx.known);
  const s = new Set(ctx.scaffolding);
  for (const l of b.pieces) s.add(l);
  if (ctx.template.text !== ctx.known.text) {
    for (const l of emitted(ctx.template.text)) if (b.keys.has(whitespaceKey(l))) s.add(l);
  }
  return s;
}

/** Every literal the template can emit that is not in `ctx.scaffolding`, with its span and the test it depends on (ISC-17). */
export function extractInjectedText(ctx: AnalysisContext): InjectedText[] {
  const outcome = parseTemplate(ctx.template.text);
  const scaffolding = effectiveScaffolding(ctx);
  if (!outcome.program) return rawItems(outcome, new Scaffold(scaffolding));
  return extract(outcome, ctx.template.text, scaffolding).items;
}

/** unbaselined_text, prefill_injection, content_trigger, nondeterministic_trigger, url_in_text, encoded_blob and invisible_char. The raw-text forms of ISC-19 to ISC-21 still run when the template does not parse (ISC-12). */
export function analyzeInjection(ctx: AnalysisContext): RuleResult {
  const t = ctx.template;
  const base: FindingBase = { file: t.source.path, templateName: t.source.name, templateSha256: t.sha256 };
  try {
    return analyze(ctx, base);
  } catch (e) {
    // An internal failure is reported, never thrown, and the template is
    // incomplete: we cannot vouch for text we did not finish reading.
    const message = e instanceof Error ? e.message : String(e);
    return {
      findings: [{ ruleId: "scanner_error", severity: "HIGH", message: `internal error in the injection rules: ${message}`, ...base, span: { ...WHOLE_TEMPLATE } }],
      complete: false,
    };
  }
}

function analyze(ctx: AnalysisContext, base: FindingBase): RuleResult {
  const t = ctx.template;
  const outcome = parseTemplate(t.text);
  const findings: Finding[] = [];
  const scaffolding = effectiveScaffolding(ctx);

  if (outcome.program) {
    const ex = extract(outcome, t.text, scaffolding);
    pushAll(findings, itemFindings(ex.items, ctx, base, t.text));
    for (const n of ex.nondeterministic) {
      pushAll(findings, [{ ruleId: "nondeterministic_trigger", severity: "HIGH", message: n.message, ...base, span: n.span, excerpt: clip(t.text.slice(n.span.start, n.span.end)) }]);
    }
    pushAll(findings, whole(findUrls(ex.items, base), findUrls(ex.joined.urls, base))); //                                ISC-19
    pushAll(findings, whole(findEncodedBlobs(outcome, t.text, base), findEncodedBlobsIn(ex.joined.blobs, base))); //  ISC-20
    pushAll(findings, findInvisibleChars(t.text, base, outcome)); //   ISC-21
    return { findings: capPerRule(dedupe(findings), base), complete: ex.complete };
  }

  // No AST: a parse error, a shape cap, or over the size cap (no token array or
  // line map). The raw-text forms of ISC-19 to ISC-21 still run (ISC-12), and the
  // text between tags is still unbaselined text when it can be located.
  pushAll(findings, findUrlsRaw(outcome, t.text, base, baselinedLiteral(ctx)));
  pushAll(findings, findEncodedBlobs(outcome, t.text, base));
  pushAll(findings, findInvisibleChars(t.text, base, outcome));
  if (!outcome.oversized) pushAll(findings, itemFindings(rawItems(outcome, new Scaffold(scaffolding)), ctx, base, t.text));
  return { findings: capPerRule(dedupe(findings), base), complete: false };
}

// ISC-17.1 on the raw path: a literal equal to one of the registry entry's, up
// to ASCII whitespace, is the baseline's, so a URL in it is not reported. The
// AST path gets this from the scaffolding; with no AST there is none to match.
function baselinedLiteral(ctx: AnalysisContext): ((from: number, to: number) => boolean) | undefined {
  const known = ctx.known;
  if (!known) return undefined;
  const keys = new Set<string>();
  forEachLiteral(known.text, (_kind, start, end) => keys.add(whitespaceKey(known.text.slice(start, end))));
  const text = ctx.template.text;
  return (from, to) => keys.has(whitespaceKey(text.slice(from, to)));
}

// A URL or blob found across literals is reported once, whole: a finding on
// part of it in one literal (`evil.com` of `evil.com{{ '/x' }}`) is dropped.
function whole(parts: Finding[], joined: Finding[]): Finding[] {
  if (joined.length === 0) return parts;
  const within = (p: Finding, j: Finding): boolean =>
    !!p.span && !!j.span && j.span.start <= p.span.start && p.span.end <= j.span.end && (j.excerpt ?? "").includes(p.excerpt ?? "\u0000");
  return [...parts.filter((p) => !joined.some((j) => within(p, j))), ...joined];
}

// ISC-17.1, ISC-17.2, ISC-18 — the findings one extracted item raises.
function itemFindings(items: readonly InjectedText[], ctx: AnalysisContext, base: FindingBase, text: string): Finding[] {
  const out: Finding[] = [];
  for (const it of items) {
    // A template whose SHA-256 is a registry entry is the baseline itself.
    if (!ctx.knownGood) {
      out.push({ ruleId: "unbaselined_text", severity: "MEDIUM", message: `emits text not in any baseline: '${clip(oneLine(it.text))}'`, ...base, span: it.span, excerpt: clip(it.text) });
    }
    if (it.afterGenerationPrompt) {
      out.push({ ruleId: "prefill_injection", severity: "HIGH", message: `prefills the assistant turn after the generation prompt: '${clip(oneLine(it.text))}'`, ...base, span: it.span, excerpt: clip(it.text) });
    }
    if (it.condition?.test === "content") {
      const s = it.condition.span;
      out.push({
        ruleId: "content_trigger",
        severity: "HIGH",
        message: `a test on conversation content gates injected text: '${clip(oneLine(it.text))}'`,
        ...base,
        span: s,
        excerpt: clip(text.slice(s.start, s.end)),
        detail: { text: clip(it.text), textSpan: it.span },
      });
    }
  }
  return out;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

