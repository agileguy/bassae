// Shared contract between the readers, the rules, the renderer and the CLI.
// Every module imports its data shapes from here; nothing else defines them.

export type Severity = "HIGH" | "MEDIUM" | "LOW";

export const SEVERITY_RANK: Record<Severity, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

export type RuleId =
  // extraction and structure
  | "parse_error" //                GGUF or JSON source could not be read (ISC-4.2, 9, 10)
  | "template_list_mismatch" //     tokenizer.chat_templates disagrees with the keys present (ISC-4.1)
  | "intra_model_divergence" //     two sources in one model differ (ISC-7.5)
  | "unanalyzable" //               @huggingface/jinja cannot parse or does not implement a construct (ISC-12)
  // code execution
  | "dunder_access" //              ISC-13
  | "format_traversal" //           ISC-13.1
  | "folded_dunder" //              ISC-14
  | "dynamic_attribute" //          |attr, |format, .format(, non-literal getattr or subscript (ISC-14.1)
  | "gadget_traversal" //           attribute or subscript on cycler, joiner, lipsum, namespace, dict, self (ISC-15)
  | "engine_fingerprint" //         `is defined` on an engine global (ISC-15.1)
  | "exec_surface" //               os, popen, system, subprocess, eval, exec, open, import in a callable position (ISC-16)
  // hidden instructions
  | "unbaselined_text" //           injected text missing from the registry entry (ISC-17.1)
  | "prefill_injection" //          injected text after the generation-prompt marker (ISC-17.2)
  | "content_trigger" //            content test on runtime input that emits injected text (ISC-18)
  | "nondeterministic_trigger" //   random, or strftime_now() inside a test (ISC-18.1)
  | "url_in_text" //                ISC-19
  | "encoded_blob" //               ISC-20
  | "invisible_char" //             ISC-21
  // differential rendering
  | "render_divergence" //          a probe emits injected text the unconditional output does not explain (ISC-22)
  | "env_profile_divergence" //     output differs between environment profiles (ISC-22.2)
  | "content_integrity" //          input content dropped, truncated, reordered or rewritten (ISC-22.3)
  | "tool_integrity" //             tool definitions not rendered JSON-equivalent (ISC-22.4)
  | "render_dos" //                 render exceeded a time, memory or output cap (ISC-43)
  // baseline and provenance
  | "local_comparison" //           GGUF template differs from a sibling HF source (ISC-23)
  | "registry_divergence" //        template differs from its known-good registry entry (ISC-25)
  | "local_tamper" //               HF-cache blob content does not match its git blob hash (ISC-40)
  | "scanner_error"; //             the scanner itself failed on this input

/** A location in a template's decoded text. Offsets are UTF-16 code units into `ExtractedTemplate.text`; line and col are 1-based, col counted in code points. */
export interface Span {
  start: number;
  end: number;
  line: number;
  col: number;
}

export interface Finding {
  ruleId: RuleId;
  severity: Severity;
  message: string;
  /** Absolute path of the file the template or record came from. */
  file: string;
  templateName?: string;
  templateSha256?: string;
  span?: Span;
  /** The matched text, as found. Printing code must escape it (ISC-44). */
  excerpt?: string;
  detail?: Record<string, unknown>;
}

export type SourceKind =
  | "gguf" //                       tokenizer.chat_template or tokenizer.chat_template.<name>
  | "tokenizer_config" //           tokenizer_config.json chat_template, string or list entry
  | "chat_template_jinja" //        chat_template.jinja
  | "chat_template_json" //        legacy chat_template.json
  | "additional_chat_templates" //  additional_chat_templates/<name>.jinja
  | "processor_config" //           processor_config.json chat_template
  | "bare"; //                      --template <file>

export interface TemplateSource {
  kind: SourceKind;
  /** Path as reached during the walk, before symlink resolution. */
  path: string;
  /** realpath of `path`. */
  realPath: string;
  /** "default" for the unnamed template, otherwise the template's name. */
  name: string;
  /** GGUF key or JSON key path the template was read from, e.g. "tokenizer.chat_template.tool_use" or "chat_template[1].template". */
  key?: string;
}

export interface ExtractedTemplate {
  source: TemplateSource;
  /** Exact bytes as stored. For JSON sources, the UTF-8 encoding of the decoded JSON string. */
  bytes: Uint8Array;
  /** UTF-8 decode of `bytes`, invalid sequences replaced with U+FFFD. Analysis runs on this. */
  text: string;
  /** Lowercase hex SHA-256 of `bytes`. */
  sha256: string;
  validUtf8: boolean;
  /** True when another source in the same model wins for every runtime profile; still scanned (ISC-7.5). */
  shadowed?: boolean;
}

/** Where a model sits inside a Hugging Face cache, when it does. */
export interface HfCacheLocation {
  /** e.g. "Qwen/Qwen3-8B" */
  repo: string;
  /** snapshot commit hash */
  revision: string;
  /** path of the file inside the snapshot, e.g. "tokenizer_config.json" */
  pathInRepo: string;
}

export interface ModelRecord {
  format: "gguf" | "hf" | "bare";
  /** Canonical identity: realpath of the GGUF file or of the model directory. */
  id: string;
  /** Every path the walk reached this model through. */
  paths: string[];
  templates: ExtractedTemplate[];
  /** mlx-lm hints from tokenizer_config.json, reported but not analyzed (ISC-7.3). */
  hints: { chatTemplateType?: string; toolParserType?: string };
  /** GGUF `general.*` scalar metadata, for provenance hints (ISC-41.1). 64-bit integers outside the safe range are decimal strings, so the record always survives JSON.stringify (ISC-27). */
  ggufGeneral?: Record<string, string | number | boolean>;
  /** Special-token strings: tokenizer.json added tokens, or GGUF control and user-defined tokens. */
  specialTokens: string[];
  hfCache?: HfCacheLocation;
  /** False when a template might exist that was not extracted: a parse stopped before the end of the GGUF KV section, or a template-bearing source failed to load or parse. A model with this false is never `no_template` and never clean (ISC-42). */
  extractionComplete: boolean;
  /** Findings about the model or file as a whole, not one template. */
  findings: Finding[];
}

export type TemplateStatus =
  | "known-good"
  | "known-good-variant"
  | "clean-unverified"
  | "findings"
  | "incomplete"
  | "no_template";

/** One entry of the checked-in known-good registry (ISC-24.1). */
export interface RegistryEntry {
  family: string;
  repo: string;
  revision: string;
  path: string;
  templateName: string;
  sha256: string;
}

/** A registry entry with the template text pinned for it, as loaded from the checked-in registry. */
export interface KnownGoodTemplate {
  entry: RegistryEntry;
  text: string;
}

/** How a template relates to the registry: an exact SHA-256 match (ISC-24), a whitespace-only variant (ISC-24.2), or neither. */
export type RegistryMatch =
  | { kind: "exact"; known: KnownGoodTemplate }
  | { kind: "whitespace"; known: KnownGoodTemplate }
  | { kind: "none" };

/** The checked-in known-good registry. Read-only: nothing a scan sees is ever written to it (ISC-24.1). */
export interface Registry {
  readonly entries: readonly KnownGoodTemplate[];
  match(template: ExtractedTemplate): RegistryMatch;
  /** Entries pinned to this repo, any revision: the candidate baselines for a template that diverges (ISC-25). */
  forRepo(repo: string): readonly KnownGoodTemplate[];
}

/** Everything a rule may look at for one template. */
export interface AnalysisContext {
  template: ExtractedTemplate;
  /** Literals that count as scaffolding (special tokens, role names, delimiters, registry literals). */
  scaffolding: ReadonlySet<string>;
  /** True when the template's SHA-256 matches a known-good registry entry. */
  knownGood: boolean;
  /** The registry entry the template matched, or the trusted baseline it is compared with; its literals are not injected text (ISC-17.1). */
  known?: KnownGoodTemplate;
}

/** A literal a template can emit that is not scaffolding (Constraints: "injected text", ISC-17). */
export interface InjectedText {
  text: string;
  span: Span;
  /** The innermost test the emission depends on, when it is conditional. `presence` tests are exempt from ISC-18. */
  condition?: { span: Span; test: "presence" | "content" | "nondeterministic" };
  /** Emitted after the generation-prompt marker, as prefilled assistant text (ISC-17.2). */
  afterGenerationPrompt: boolean;
}

// ---- runtime precedence and baselines ----

/** The runtimes whose template choice the checked-in precedence table pins (Constraints). */
export type RuntimeProfile =
  | "transformers-tokenizer" // transformers 5.x tokenizer apply_chat_template
  | "transformers-processor" // transformers 5.x processor apply_chat_template
  | "mlx-lm" //                 mlx-lm 0.31
  | "llama.cpp"; //             llama.cpp with its native Jinja engine

/** For each runtime, the sources it loads the default template from, highest priority first (ISC-7.4). */
export interface PrecedenceTable {
  order: Record<RuntimeProfile, SourceKind[]>;
  /** Where each order was read from: upstream repo, pinned version and file. */
  provenance: Record<RuntimeProfile, string>;
}

/** What a template is compared with. Only a pinned registry entry or a pinned upstream fetch is trusted (Principles); a sibling file is a local comparison, never a baseline (ISC-23). */
export type Baseline =
  | { kind: "registry"; known: KnownGoodTemplate }
  | { kind: "upstream"; repo: string; revision: string; path: string; templateName: string; text: string }
  | { kind: "none" };

export interface RuleResult {
  findings: Finding[];
  /** False when the rule could not run to completion; the template's status becomes `incomplete` (ISC-42.1). */
  complete: boolean;
}

export type Rule = (ctx: AnalysisContext) => RuleResult;

// ---- renderer ----

export type EnvProfile =
  | "hf-default" //      @huggingface/jinja defaults
  | "jinja2-globals"; // dict, cycler, joiner, lipsum, namespace stubbed in (ISC-22.2)

export interface RenderRequest {
  /** Caller-chosen id, echoed back in the result. */
  id: string;
  /** Variables passed to the template: messages, tools, add_generation_prompt, bos_token, ... */
  context: Record<string, unknown>;
  profile: EnvProfile;
  /** ISO-8601 instant that strftime_now() reports. Defaults to the real clock when absent. */
  now?: string;
}

/** `stack` is a stack overflow inside the render, e.g. a recursive macro; like timeout, memory and output_limit it becomes `render_dos` (ISC-43). */
export type RenderFailure = "timeout" | "memory" | "output_limit" | "stack" | "parse" | "render_error" | "sandbox";

export type RenderResult =
  | { id: string; ok: true; output: string }
  | { id: string; ok: false; failure: RenderFailure; message: string };

export interface RenderLimits {
  /** Per render. Default 2000. */
  timeoutMs: number;
  /** Child process resident memory cap. Default 256 MiB. */
  maxRssBytes: number;
  /** Per render output cap. Default 1 MiB. */
  maxOutputBytes: number;
}

export const DEFAULT_RENDER_LIMITS: RenderLimits = {
  timeoutMs: 2000,
  maxRssBytes: 256 * 1024 * 1024,
  maxOutputBytes: 1024 * 1024,
};

/** Renders one template against many requests inside a sandboxed child process (ISC-43). */
export interface Renderer {
  renderBatch(template: string, requests: RenderRequest[], limits?: Partial<RenderLimits>): Promise<RenderResult[]>;
}

// ---- discovery ----

/** One model found by the walk, before any reader has opened it. */
export interface DiscoveredModel {
  format: "gguf" | "hf";
  /** realpath of the GGUF file or the model directory; the dedup key. */
  id: string;
  /** Every path the walk reached it through, in walk order. */
  paths: string[];
  hfCache?: HfCacheLocation;
}
