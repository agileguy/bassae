// The checked-in known-good registry, runtime precedence table and transform
// allowlist. Their data lives in registry/ at the repo root and is only ever read:
// nothing in this module can write a file (ISC-24.1).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unifiedDiff } from "../diff.ts";
import { cKey, viewKey } from "../gguf/templates.ts";
import { parseHfCachePath } from "../hf/cache.ts";
import { LineMap } from "../parse/support.ts";
import { clip } from "../rules/finalize.ts";
import type {
  ExtractedTemplate,
  Finding,
  KnownGoodTemplate,
  ModelRecord,
  PrecedenceTable,
  Registry,
  RegistryEntry,
  RegistryMatch,
  RuntimeProfile,
  SourceKind,
  TemplateSource,
  TemplateStatus,
} from "../types.ts";

/** registry/ at the repo root. */
export const REGISTRY_DIR = fileURLToPath(new URL("../../registry/", import.meta.url));

/** A documented legitimate content transform, such as stripping past `<think>` blocks (Constraints). Used by DiffRender in Phase 3. */
export interface Transform {
  id: string;
  description: string;
  /** Upstream repo, revision and path that documents it. */
  source: string;
}

export const RUNTIME_PROFILES: readonly RuntimeProfile[] = ["transformers-tokenizer", "transformers-processor", "mlx-lm", "llama.cpp"];

const SOURCE_KINDS: ReadonlySet<SourceKind> = new Set([
  "gguf",
  "tokenizer_config",
  "chat_template_jinja",
  "chat_template_json",
  "additional_chat_templates",
  "processor_config",
  "bare",
]);

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function readJson(path: string): unknown {
  return JSON.parse(strictUtf8.decode(readFileSync(path)));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---- known-good registry (ISC-24, ISC-24.1, ISC-24.2) ----

const ENTRY_FIELDS = ["family", "repo", "revision", "path", "templateName", "sha256"] as const;
const REPO = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;
const REVISION = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

// Every entry cites family, repo, a pinned commit, the path in the repo, the template name and the SHA-256 (ISC-24.1).
function parseEntry(raw: unknown, i: number): RegistryEntry {
  const where = `known-good.json entries[${i}]`;
  if (!isObject(raw)) throw new Error(`${where}: not an object`);
  for (const k of Object.keys(raw)) if (!(ENTRY_FIELDS as readonly string[]).includes(k)) throw new Error(`${where}: unknown field ${JSON.stringify(k)}`);
  for (const k of ENTRY_FIELDS) if (typeof raw[k] !== "string" || raw[k] === "") throw new Error(`${where}: ${k} must be a non-empty string`);
  const e = raw as unknown as RegistryEntry;
  if (!REPO.test(e.repo)) throw new Error(`${where}: repo ${JSON.stringify(e.repo)} is not owner/name`);
  if (!REVISION.test(e.revision)) throw new Error(`${where}: revision must be a 40-hex commit, got ${JSON.stringify(e.revision)}`);
  if (!SHA256.test(e.sha256)) throw new Error(`${where}: sha256 must be 64 lowercase hex`);
  if (e.path.startsWith("/") || e.path.split("/").some((s) => s === "" || s === "." || s === "..")) throw new Error(`${where}: path ${JSON.stringify(e.path)} is not a path in a repo`);
  return { family: e.family, repo: e.repo, revision: e.revision, path: e.path, templateName: e.templateName, sha256: e.sha256 };
}

// ISC-24.2: the template's runs of non-whitespace, joined by one space. Two texts get the
// same key exactly when their run sequences are equal, so CRLF against LF, indentation and
// trailing newlines match while `do not` against `donot` does not. Whitespace here is ASCII
// only: an inserted U+FEFF, U+00A0 or U+2028 is a real change, never a variant.
export function whitespaceKey(text: string): string {
  const s = text.replace(/[\t\n\v\f\r ]+/g, " ");
  return s.slice(s.startsWith(" ") ? 1 : 0, s.endsWith(" ") ? -1 : undefined);
}

/** Loads registry/known-good.json and the template text each entry pins. Throws when a pinned text does not hash to its entry's sha256. */
export function loadRegistry(dir: string = REGISTRY_DIR): Registry {
  const file = readJson(join(dir, "known-good.json"));
  if (!isObject(file) || !Array.isArray(file.entries)) throw new Error("known-good.json: expected {entries: [...]}");
  const texts = new Map<string, string>();
  const seen = new Set<string>();
  const known: KnownGoodTemplate[] = file.entries.map((raw, i) => {
    const entry = parseEntry(raw, i);
    const id = `${entry.repo.toLowerCase()}\0${entry.revision}\0${entry.path}\0${entry.templateName}`;
    if (seen.has(id)) throw new Error(`known-good.json entries[${i}]: duplicate of an earlier entry for ${entry.repo}@${entry.revision}:${entry.path} ${entry.templateName}`);
    seen.add(id);
    let text = texts.get(entry.sha256);
    if (text === undefined) {
      const bytes = readFileSync(join(dir, "templates", `${entry.sha256}.jinja`));
      const actual = sha256(bytes);
      if (actual !== entry.sha256) throw new Error(`registry template ${entry.sha256}.jinja hashes to ${actual}, not its entry's sha256`);
      text = strictUtf8.decode(bytes); // a pinned text that is not UTF-8 throws here
      if (whitespaceKey(text) === "") throw new Error(`registry template ${entry.sha256}.jinja is empty or all whitespace`);
      texts.set(entry.sha256, text);
    }
    return Object.freeze({ entry: Object.freeze(entry), text });
  });
  return createRegistry(known);
}

/** A read-only Registry over already-verified entries. */
export function createRegistry(known: readonly KnownGoodTemplate[]): Registry {
  const entries = Object.freeze([...known]);
  const bySha = new Map<string, KnownGoodTemplate[]>();
  const byKey = new Map<string, KnownGoodTemplate[]>();
  const byRepo = new Map<string, KnownGoodTemplate[]>();
  const add = (map: Map<string, KnownGoodTemplate[]>, key: string, k: KnownGoodTemplate) => map.set(key, [...(map.get(key) ?? []), k]);
  for (const k of entries) {
    add(bySha, k.entry.sha256, k);
    add(byKey, whitespaceKey(k.text), k);
    add(byRepo, k.entry.repo.toLowerCase(), k);
  }
  return Object.freeze({
    entries,
    match(template: ExtractedTemplate): RegistryMatch {
      const exact = bySha.get(template.sha256);
      if (exact) return { kind: "exact", known: preferred(exact, template) };
      // Bytes that are not UTF-8 decode lossily, so their text proves nothing about the bytes.
      if (!template.validUtf8) return { kind: "none" };
      const variant = byKey.get(whitespaceKey(template.text));
      if (variant) return { kind: "whitespace", known: preferred(variant, template) };
      return { kind: "none" };
    },
    forRepo(repo: string): readonly KnownGoodTemplate[] {
      return byRepo.get(repo.toLowerCase()) ?? [];
    },
  });
}

// Among entries with the same text, the one pinned to the template's own repo, then
// to its template name, then the first in file order.
function preferred(candidates: KnownGoodTemplate[], template: ExtractedTemplate): KnownGoodTemplate {
  const repo = (parseHfCachePath(template.source.path) ?? parseHfCachePath(template.source.realPath))?.repo.toLowerCase();
  const score = (k: KnownGoodTemplate) => (k.entry.repo.toLowerCase() === repo ? 2 : 0) + (k.entry.templateName === template.source.name ? 1 : 0);
  return candidates.reduce((best, k) => (score(k) > score(best) ? k : best));
}

/** The status a registry match gives on its own: `known-good` for an exact SHA-256 match (ISC-24), `known-good-variant` for a whitespace-only difference (ISC-24.2), undefined when the registry says nothing. */
export function registryStatus(match: RegistryMatch): TemplateStatus | undefined {
  if (match.kind === "exact") return "known-good";
  if (match.kind === "whitespace") return "known-good-variant";
  return undefined;
}

// ---- runtime precedence (ISC-7.4) ----

/** How one runtime reads a source, beyond the order of kinds. Each field cites its upstream code in precedence.json. */
export interface ProfileRules {
  /** Names in a kind that load as the default, highest first. Absent: ["default"]. */
  defaultNames?: Partial<Record<SourceKind, string[]>>;
  /** The runtime raises while loading, and uses no template, when every kind in one of these sets is present. */
  failsWhenPresent?: SourceKind[][];
  /** A kind is not read while any source of the listed kinds exists. */
  ignoredWhenPresent?: Partial<Record<SourceKind, SourceKind[]>>;
  /** The only names read from a kind. Absent: every name. */
  names?: Partial<Record<SourceKind, string[]>>;
  /** When the model sets this hint, the runtime uses a built-in template and loads none of the model's. */
  builtinWhenHint?: keyof ModelRecord["hints"];
  /** GGUF keys and values read as C strings: a key ends at its first NUL, the first key wins, a value ends at its first NUL. */
  cStrings?: boolean;
  /** When the default is absent or its value is one of `whenDefaultIs`, load the template `name` instead. */
  fallback?: { whenDefaultIs: string[]; name: string };
}

/** The precedence table plus the per-runtime rules that refine it. */
export interface PrecedenceRules extends PrecedenceTable {
  rules: Partial<Record<RuntimeProfile, ProfileRules>>;
}

function kindList(v: unknown, where: string): SourceKind[] {
  if (!Array.isArray(v) || v.some((k) => typeof k !== "string" || !SOURCE_KINDS.has(k as SourceKind))) throw new Error(`${where}: expected a list of source kinds`);
  if (new Set(v).size !== v.length) throw new Error(`${where}: repeats a source kind`);
  return v as SourceKind[];
}

function kindMap<T>(v: unknown, where: string, value: (x: unknown, w: string) => T): Partial<Record<SourceKind, T>> {
  if (!isObject(v)) throw new Error(`${where}: expected an object keyed by source kind`);
  const out: Partial<Record<SourceKind, T>> = {};
  for (const [k, x] of Object.entries(v)) {
    if (!SOURCE_KINDS.has(k as SourceKind)) throw new Error(`${where}: unknown source kind ${JSON.stringify(k)}`);
    out[k as SourceKind] = value(x, `${where}.${k}`);
  }
  return out;
}

function stringList(v: unknown, where: string): string[] {
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) throw new Error(`${where}: expected a list of strings`);
  return v as string[];
}

function parseRules(v: unknown, where: string): ProfileRules {
  if (!isObject(v)) throw new Error(`${where}: expected an object`);
  const r: ProfileRules = {};
  for (const [k, x] of Object.entries(v)) {
    const w = `${where}.${k}`;
    if (k === "defaultNames") r.defaultNames = kindMap(x, w, stringList);
    else if (k === "ignoredWhenPresent") r.ignoredWhenPresent = kindMap(x, w, kindList);
    else if (k === "failsWhenPresent") {
      if (!Array.isArray(x)) throw new Error(`${w}: expected a list of source-kind lists`);
      r.failsWhenPresent = x.map((set, i) => kindList(set, `${w}[${i}]`));
    }
    else if (k === "names") r.names = kindMap(x, w, stringList);
    else if (k === "builtinWhenHint") {
      if (x !== "chatTemplateType" && x !== "toolParserType") throw new Error(`${w}: unknown hint`);
      r.builtinWhenHint = x;
    } else if (k === "cStrings") {
      if (typeof x !== "boolean") throw new Error(`${w}: expected a boolean`);
      r.cStrings = x;
    } else if (k === "fallback") {
      if (!isObject(x) || typeof x.name !== "string") throw new Error(`${w}: expected {whenDefaultIs, name}`);
      r.fallback = { whenDefaultIs: stringList(x.whenDefaultIs, `${w}.whenDefaultIs`), name: x.name };
    } else throw new Error(`${w}: unknown rule`);
  }
  return r;
}

/** Loads registry/precedence.json. */
export function loadPrecedence(dir: string = REGISTRY_DIR): PrecedenceRules {
  const file = readJson(join(dir, "precedence.json"));
  if (!isObject(file) || !isObject(file.order) || !isObject(file.provenance)) throw new Error("precedence.json: expected {order, provenance}");
  const order = {} as Record<RuntimeProfile, SourceKind[]>;
  const provenance = {} as Record<RuntimeProfile, string>;
  const rules: PrecedenceRules["rules"] = {};
  for (const p of RUNTIME_PROFILES) {
    order[p] = kindList(file.order[p], `precedence.json order.${p}`);
    const cite = file.provenance[p];
    if (typeof cite !== "string" || !/^[\w.-]+\/[\w.-]+@\S+/.test(cite)) throw new Error(`precedence.json provenance.${p}: expected "owner/repo@tag..."`);
    provenance[p] = cite;
    if (isObject(file.rules) && file.rules[p] !== undefined) rules[p] = parseRules(file.rules[p], `precedence.json rules.${p}`);
  }
  for (const key of [file.order, file.provenance, isObject(file.rules) ? file.rules : {}]) {
    for (const p of Object.keys(key)) if (!(RUNTIME_PROFILES as readonly string[]).includes(p)) throw new Error(`precedence.json: unknown runtime profile ${JSON.stringify(p)}`);
  }
  return { order, provenance, rules };
}

const GGUF_BARE_KEY = "tokenizer.chat_template";
const ggufKeyFor = (name: string) => (name === "default" ? GGUF_BARE_KEY : `${GGUF_BARE_KEY}.${name}`);

/** The template a profile loads under a name, with every template indexed once, so a hostile record costs linear time. */
interface Resolver {
  load(name: string): ExtractedTemplate | undefined;
}

// Indexes shared by every profile. A GGUF value holding a NUL has a second template, the
// bytes before it, which is what llama.cpp renders (src/gguf/templates.ts); `viewOf` maps
// the stored value to it.
interface ModelIndex {
  present: Set<SourceKind>;
  byKindName: Map<string, ExtractedTemplate>;
  ggufByKey: Map<string, ExtractedTemplate>;
  ggufByCKey: Map<string, ExtractedTemplate>;
  viewOf: Map<ExtractedTemplate, ExtractedTemplate>;
}

function indexModel(model: ModelRecord): ModelIndex {
  const gguf = model.templates.filter((t) => t.source.kind === "gguf" && t.source.key !== undefined);
  const byKey = new Map<string, ExtractedTemplate[]>();
  for (const t of gguf) byKey.set(t.source.key!, [...(byKey.get(t.source.key!) ?? []), t]);
  const viewOf = new Map<ExtractedTemplate, ExtractedTemplate>();
  const views = new Set<ExtractedTemplate>();
  for (const t of gguf) {
    const n = t.bytes.indexOf(0);
    if (n < 0) continue;
    // Views follow the stored values in a record, so the last candidate is the view even when a stored key is spelled like one.
    const view = (byKey.get(viewKey(t.source.key!, n)) ?? []).findLast((v) => v !== t && v.bytes.length === n);
    if (view) {
      viewOf.set(t, view);
      views.add(view);
    }
  }
  const index: ModelIndex = { present: new Set(), byKindName: new Map(), ggufByKey: new Map(), ggufByCKey: new Map(), viewOf };
  const first = <K>(map: Map<K, ExtractedTemplate>, key: K, t: ExtractedTemplate) => map.has(key) || map.set(key, t);
  for (const t of model.templates) {
    index.present.add(t.source.kind);
    if (t.source.kind !== "gguf") first(index.byKindName, `${t.source.kind}\0${t.source.name}`, t);
    else if (t.source.key !== undefined && !views.has(t)) {
      first(index.ggufByKey, t.source.key, t);
      first(index.ggufByCKey, cKey(t.source.key), t);
    }
  }
  return index;
}

function resolver(model: ModelRecord, index: ModelIndex, table: PrecedenceTable, profile: RuntimeProfile): Resolver {
  const order = table.order[profile] ?? [];
  const rules: ProfileRules = (table as Partial<PrecedenceRules>).rules?.[profile] ?? {};
  const ignored = (kind: SourceKind) => (rules.ignoredWhenPresent?.[kind] ?? []).some((k) => index.present.has(k));
  const fails = (rules.failsWhenPresent ?? []).some((set) => set.every((k) => index.present.has(k)));

  const find = (kind: SourceKind, name: string): ExtractedTemplate | undefined => {
    const readable = rules.names?.[kind];
    if (readable && !readable.includes(name)) return undefined;
    if (kind !== "gguf") return index.byKindName.get(`${kind}\0${name}`);
    if (!rules.cStrings) return index.ggufByKey.get(ggufKeyFor(name));
    const stored = index.ggufByCKey.get(ggufKeyFor(name));
    return stored && (index.viewOf.get(stored) ?? stored);
  };

  const lookup = (name: string): ExtractedTemplate | undefined => {
    for (const kind of order) {
      if (!index.present.has(kind) || ignored(kind)) continue;
      const aliases = rules.defaultNames?.[kind];
      // An alias of the default (additional_chat_templates/file.jinja) is not loadable under its own name.
      if (name !== "default" && aliases?.includes(name)) continue;
      for (const n of name === "default" ? (aliases ?? ["default"]) : [name]) {
        const t = find(kind, n);
        if (t) return t;
      }
    }
    return undefined;
  };

  return {
    load(name) {
      if (fails || (rules.builtinWhenHint && model.hints[rules.builtinWhenHint] !== undefined)) return undefined;
      const t = lookup(name);
      const fb = rules.fallback;
      if (name !== "default" || !fb) return t;
      if (t && !fb.whenDefaultIs.includes(t.text)) return t;
      return lookup(fb.name);
    },
  };
}

/** For each runtime profile, the source in `model` that runtime would load as its default template, or undefined when it loads none (ISC-7.4). */
export function resolveProfiles(model: ModelRecord, table: PrecedenceTable): Record<RuntimeProfile, TemplateSource | undefined> {
  const index = indexModel(model);
  const out = {} as Record<RuntimeProfile, TemplateSource | undefined>;
  for (const p of RUNTIME_PROFILES) out[p] = resolver(model, index, table, p).load("default")?.source;
  return out;
}

// ---- intra-model divergence (ISC-7.5) ----

// A hostile GGUF can repeat one key thousands of times; past this many pairs one summary finding stands for the rest.
export const MAX_DIVERGENCE_PAIRS = 32;

const label = (s: TemplateSource) => (s.key === undefined ? s.path : `${s.path}:${s.key}`);

/** Which profiles load each template, under its own name or as the default. */
function loadedBy(model: ModelRecord, table: PrecedenceTable): Map<ExtractedTemplate, RuntimeProfile[]> {
  const index = indexModel(model);
  const out = new Map<ExtractedTemplate, RuntimeProfile[]>(model.templates.map((t) => [t, []]));
  const names = new Set(["default", ...model.templates.map((t) => t.source.name)]);
  for (const p of RUNTIME_PROFILES) {
    const r = resolver(model, index, table, p);
    const loaded = new Set<ExtractedTemplate>();
    for (const name of names) {
      const t = r.load(name);
      if (t) loaded.add(t);
    }
    for (const t of loaded) out.get(t)?.push(p);
  }
  return out;
}

/** MEDIUM intra_model_divergence findings, each with a unified diff in `detail`, for sources in one model that differ; sets `shadowed` on every template no profile loads (ISC-7.5). */
export function checkIntraModel(model: ModelRecord, table: PrecedenceTable): Finding[] {
  const loaded = loadedBy(model, table);
  const readKinds = new Set(RUNTIME_PROFILES.flatMap((p) => table.order[p] ?? []));

  // Shadowed: no runtime loads it, though some runtime reads its kind. It is still returned
  // and scanned. A bare --template file is read by no runtime, so it is never shadowed.
  for (const t of model.templates) {
    if (loaded.get(t)!.length === 0 && readKinds.has(t.source.kind)) t.shadowed = true;
    else delete t.shadowed;
  }

  const byName = new Map<string, ExtractedTemplate[]>();
  for (const t of model.templates) byName.set(t.source.name, [...(byName.get(t.source.name) ?? []), t]);

  const findings: Finding[] = [];
  let skipped = 0;
  for (const [name, group] of byName) {
    // Pairs whose bytes differ, counted without visiting them: (n^2 - sum of squared same-hash counts) / 2.
    const counts = new Map<string, number>();
    for (const t of group) counts.set(t.sha256, (counts.get(t.sha256) ?? 0) + 1);
    let differing = (group.length ** 2 - [...counts.values()].reduce((s, c) => s + c * c, 0)) / 2;
    for (let i = 0; i < group.length && findings.length < MAX_DIVERGENCE_PAIRS; i++) {
      for (let j = i + 1; j < group.length && findings.length < MAX_DIVERGENCE_PAIRS; j++) {
        let [a, b] = [group[i]!, group[j]!];
        if (a.sha256 === b.sha256) continue;
        // The diff's baseline is the template more runtimes load; ties keep reader order.
        if (loaded.get(b)!.length > loaded.get(a)!.length) [a, b] = [b, a];
        findings.push(divergence(model, name, a, b, loaded));
        differing--;
      }
    }
    skipped += differing;
  }
  if (skipped > 0) {
    findings.push({
      ruleId: "intra_model_divergence",
      severity: "MEDIUM",
      message: `${skipped} more pairs of differing same-name templates not compared`,
      file: model.id,
      span: { start: 0, end: 0, line: 1, col: 1 },
      detail: { suppressed: skipped },
    });
  }
  return findings;
}

function divergence(model: ModelRecord, name: string, a: ExtractedTemplate, b: ExtractedTemplate, loaded: Map<ExtractedTemplate, RuntimeProfile[]>): Finding {
  const same = label(a.source) === label(b.source);
  const aLabel = same ? `${label(a.source)} (first)` : label(a.source);
  const bLabel = same ? `${label(b.source)} (second)` : label(b.source);
  const diff = unifiedDiff(a.text, b.text, aLabel, bLabel);
  const side = (t: ExtractedTemplate) => ({ kind: t.source.kind, path: t.source.path, key: t.source.key, sha256: t.sha256, loadedBy: loaded.get(t), shadowed: t.shadowed === true });
  // The span is the first line of b that differs from a.
  let at = 0;
  while (at < a.text.length && at < b.text.length && a.text[at] === b.text[at]) at++;
  const lineStart = at === 0 ? 0 : b.text.lastIndexOf("\n", at - 1) + 1;
  const nl = b.text.indexOf("\n", at);
  const lineEnd = nl < 0 ? b.text.length : nl;
  return {
    ruleId: "intra_model_divergence",
    severity: "MEDIUM",
    message: `${aLabel} and ${bLabel} both define template ${JSON.stringify(name)} and differ`,
    file: b.source.path,
    templateName: name,
    templateSha256: b.sha256,
    span: new LineMap(b.text).span(lineStart, lineEnd),
    excerpt: clip(b.text.slice(lineStart, lineEnd)),
    // Bytes can differ where both texts decode to U+FFFD, and then the text diff is empty.
    detail: { diff: diff || `--- ${aLabel}\n+++ ${bLabel}\n@@ bytes differ where both texts decode to U+FFFD @@\n`, model: model.id, a: side(a), b: side(b) },
  };
}

// ---- transform allowlist ----

/** Loads registry/transforms.json. */
export function loadTransforms(dir: string = REGISTRY_DIR): Transform[] {
  const file = readJson(join(dir, "transforms.json"));
  if (!isObject(file) || !Array.isArray(file.transforms)) throw new Error("transforms.json: expected {transforms: [...]}");
  const ids = new Set<string>();
  return file.transforms.map((t, i) => {
    const where = `transforms.json transforms[${i}]`;
    if (!isObject(t) || typeof t.id !== "string" || typeof t.description !== "string" || typeof t.source !== "string" || !t.id || !t.description) {
      throw new Error(`${where}: expected {id, description, source} strings`);
    }
    if (!/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}:\S/.test(t.source)) throw new Error(`${where}: source must cite owner/repo@<40-hex commit>:<path>`);
    if (ids.has(t.id)) throw new Error(`${where}: duplicate id ${JSON.stringify(t.id)}`);
    ids.add(t.id);
    return { id: t.id, description: t.description, source: t.source };
  });
}
