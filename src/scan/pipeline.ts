// The scan itself, once the renderer is settled: models loaded, model-level checks, every template
// analyzed, model findings attached, one status per template (ISC-42) and the exit code (ISC-28).
// scan() in index.ts picks the renderer; tests call scanWith directly to stand in a missing one.

import { readFileSync } from "node:fs";
import { relative, isAbsolute, join } from "node:path";
import { diffRender } from "../diffrender/index.ts";
import { parseHfCachePath } from "../hf/cache.ts";
import { checkLocalTamper, compareLocal, fetchUpstream, pairLocal, upstreamCandidateHints } from "../provenance/index.ts";
import { checkIntraModel, loadPrecedence, loadRegistry, loadTransforms, resolveProfiles, RUNTIME_PROFILES } from "../registry/index.ts";
import { exitCodeOf, highestSeverity, modelStatus, statusOf } from "../status.ts";
import type {
  Baseline,
  ExtractedTemplate,
  Finding,
  ModelRecord,
  ModelReport,
  Renderer,
  ScanOptions,
  ScanReport,
  Severity,
  TemplateReport,
  TemplateSite,
  TemplateStatus,
} from "../types.ts";
import { type Analysis, createAnalyzer } from "./analyze.ts";
import { type Attachable, attachModelFindings, finalizeFindings } from "./attach.ts";
import { loadModels } from "./load.ts";

/** A command the scan refuses before reading anything. The CLI exits 3 on it (ISC-28). */
export class ScanUsageError extends Error {}

/** The renderer a scan uses, and what the report says about it. */
export type RendererSetup =
  | { status: Extract<ScanReport["renderer"], { available: true }>; renderer: Renderer }
  | { status: Extract<ScanReport["renderer"], { available: false }> };

// Renders run in a few sandboxed children at once: one per template, with its whole probe batch.
const POOL_SIZE = 8;

const EXTRACTION_GAP = "model extraction incomplete: a template may exist that was not extracted";

const VERSION = readVersion();

/** Throws ScanUsageError for options the CLI must refuse. Nothing has been read or fetched yet. */
export function checkUsage(options: ScanOptions): void {
  // The one network call needs the one switch that allows it (ISC-36).
  if (options.upstream && !options.online) throw new ScanUsageError("--upstream requires --online");
}

export async function scanWith(options: ScanOptions, setup: RendererSetup): Promise<ScanReport> {
  checkUsage(options);
  const registry = options.registry ?? loadRegistry();
  const precedence = loadPrecedence();
  const transforms = loadTransforms();
  const findings: Finding[] = [];

  const renderer = "renderer" in setup ? setup.renderer : undefined;
  const unavailable = setup.status.available ? undefined : setup.status.reason;
  if (unavailable !== undefined) {
    findings.push({ ruleId: "scanner_error", severity: "MEDIUM", message: `renderer unavailable, so no template was rendered: ${unavailable}`, file: "<renderer>" });
  }

  const upstream = options.online && options.upstream ? await fetchBaselines(options, findings) : [];

  const loaded = await loadModels(options.roots, options.templates);
  findings.push(...loaded.findings);
  const records = loaded.models;

  // Shadowing is set here and read by the local comparison, so every model is checked first (ISC-7.5).
  const intra = new Map(records.map((m) => [m, checkIntraModel(m, precedence)]));
  const local = new Map<ModelRecord, Finding[]>();
  for (const { gguf, hf } of pairLocal(records)) local.set(gguf, [...(local.get(gguf) ?? []), ...compareLocal(gguf, hf)]);

  const analyze = createAnalyzer({
    registry,
    upstream,
    ...(renderer ? { renderer } : {}),
    ...(unavailable !== undefined ? { unavailable } : {}),
    transforms,
    diffRender: options.diffRender ?? diffRender,
  });

  const pending: { record: ModelRecord; modelFindings: Finding[]; drafts: Draft[] }[] = [];
  const jobs: (() => Promise<void>)[] = [];
  for (const record of records) {
    const tamper = await checkLocalTamper(record);
    const modelFindings = finalizeFindings([...record.findings, ...intra.get(record)!, ...tamper, ...(local.get(record) ?? [])], record.id);
    const drafts: Draft[] = [];
    for (const [i, group] of groupTemplates(record).entries()) {
      jobs.push(async () => {
        drafts[i] = draft(group, record, await analyze(representative(group), record));
      });
    }
    pending.push({ record, modelFindings, drafts });
  }
  await pool(jobs, POOL_SIZE);

  const models = pending.map(({ record, modelFindings, drafts }) => modelReport(record, modelFindings, drafts, precedence));
  const report: ScanReport = {
    tool: { name: "bassae", version: VERSION },
    schemaVersion: 1,
    roots: options.roots,
    online: options.online,
    ...(options.online && options.upstream ? { upstream: { repo: options.upstream.repo, revision: options.upstream.revision } } : {}),
    renderer: setup.status,
    models,
    findings,
    summary: summarize(models, findings),
    exitCode: 0,
  };
  report.exitCode = exitCodeOf(report);
  return report;
}

// --online --upstream: fetched once for the whole scan (ISC-41). A failure is reported and the scan goes on offline.
async function fetchBaselines(options: ScanOptions, findings: Finding[]): Promise<Baseline[]> {
  const { repo, revision } = options.upstream!;
  try {
    return await fetchUpstream(repo, revision, options.fetcher);
  } catch (e) {
    findings.push({
      ruleId: "scanner_error",
      severity: "MEDIUM",
      message: `upstream ${repo}@${revision} was not fetched, so nothing was compared with it: ${e instanceof Error ? e.message : String(e)}`,
      file: `https://huggingface.co/${repo}/tree/${revision}`,
    });
    return [];
  }
}

/** A template report before model findings are attached and its status is known. */
type Draft = Omit<TemplateReport, "status" | "severity"> & Attachable & { matchKind: Analysis["match"]["kind"] };

// One report per (sha256, name) in a model: copies of one template in several sources are one template
// found in several places (ISC-11). Reader order is kept.
function groupTemplates(record: ModelRecord): ExtractedTemplate[][] {
  const groups = new Map<string, ExtractedTemplate[]>();
  for (const t of record.templates) {
    const key = `${t.sha256}\0${t.source.name}`;
    const group = groups.get(key);
    if (group) group.push(t);
    else groups.set(key, [t]);
  }
  return [...groups.values()];
}

// Findings name the representative's file, so it is the copy a runtime loads when one does.
function representative(group: ExtractedTemplate[]): ExtractedTemplate {
  return group.find((t) => !t.shadowed) ?? group[0]!;
}

function draft(group: ExtractedTemplate[], record: ModelRecord, a: Analysis): Draft {
  const t = representative(group);
  const gaps = record.extractionComplete ? a.gaps : [...a.gaps, EXTRACTION_GAP];
  return {
    name: t.source.name,
    sha256: t.sha256,
    validUtf8: t.validUtf8,
    sites: sitesOf(group, record),
    registry: a.match.kind === "none" ? { kind: "none" } : { kind: a.match.kind, entry: a.match.known.entry },
    baseline:
      a.baseline.kind === "none"
        ? { kind: "none" }
        : a.baseline.kind === "registry"
          ? { kind: "registry", entry: a.baseline.known.entry }
          : { kind: "upstream", repo: a.baseline.repo, revision: a.baseline.revision, path: a.baseline.path, templateName: a.baseline.templateName },
    findings: a.findings,
    injected: a.injected,
    triggers: a.triggers,
    probes: a.probes,
    gaps,
    matchKind: a.match.kind,
  };
}

// Every place the template was found: each source holding it, at every path the walk reached the model
// through. A model reached through a directory link lists its files under the link as well (ISC-11.1).
// The copy a runtime loads comes first, then shadowed copies in reader order.
function sitesOf(group: ExtractedTemplate[], record: ModelRecord): TemplateSite[] {
  const readAt = record.paths[0];
  const first = representative(group);
  const out: TemplateSite[] = [];
  const seen = new Set<string>();
  for (const t of [first, ...group.filter((t) => t !== first)]) {
    const rel = readAt === undefined ? undefined : relative(readAt, t.source.path);
    const inside = rel !== undefined && !rel.startsWith("..") && !isAbsolute(rel);
    const paths = inside ? record.paths.map((p) => (rel === "" ? p : join(p, rel))) : [t.source.path];
    for (const path of [t.source.path, ...paths]) {
      const id = JSON.stringify([t.source.kind, path, t.source.key]);
      if (seen.has(id)) continue;
      seen.add(id);
      const hfCache = parseHfCachePath(path);
      out.push({
        kind: t.source.kind,
        path,
        realPath: t.source.realPath,
        ...(t.source.key !== undefined ? { key: t.source.key } : {}),
        ...(hfCache ? { hfCache } : {}),
        shadowed: t.shadowed === true,
      });
    }
  }
  return out;
}

function modelReport(record: ModelRecord, modelFindings: Finding[], drafts: Draft[], precedence: ReturnType<typeof loadPrecedence>): ModelReport {
  const rest = attachModelFindings(modelFindings, drafts);
  const templates: TemplateReport[] = drafts.map(({ matchKind, ...d }) => {
    const severity = highestSeverity(d.findings);
    return { ...d, status: statusOf(d.findings, d.gaps, matchKind), ...(severity ? { severity } : {}) };
  });
  const resolved = resolveProfiles(record, precedence);
  const profiles = {} as ModelReport["profiles"];
  for (const p of RUNTIME_PROFILES) {
    const s = resolved[p];
    profiles[p] = s ? { kind: s.kind, path: s.path, name: s.name } : null;
  }
  return {
    format: record.format,
    id: record.id,
    paths: record.paths,
    ...(record.hfCache ? { hfCache: record.hfCache } : {}),
    status: modelStatus(templates, record.extractionComplete, rest),
    hints: { ...record.hints },
    profiles,
    upstreamCandidates: upstreamCandidateHints(record).map(({ repo, key }) => ({ repo, key })),
    extractionComplete: record.extractionComplete,
    findings: rest,
    templates,
  };
}

// Findings are counted where the report lists them, so the counts match what --json shows. Statuses are
// counted per template, plus each model with no template, so `no_template` is counted too.
function summarize(models: ModelReport[], findings: Finding[]): ScanReport["summary"] {
  const bySeverity: Record<Severity, number> = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  const statuses: Record<TemplateStatus, number> = { "known-good": 0, "known-good-variant": 0, "clean-unverified": 0, findings: 0, incomplete: 0, no_template: 0 };
  let templates = 0;
  const count = (list: readonly Finding[]) => {
    for (const f of list) bySeverity[f.severity]++;
  };
  count(findings);
  for (const m of models) {
    count(m.findings);
    if (m.templates.length === 0) statuses[m.status]++;
    for (const t of m.templates) {
      templates++;
      statuses[t.status]++;
      count(t.findings);
    }
  }
  return { models: models.length, templates, findings: bySeverity, statuses };
}

async function pool(jobs: readonly (() => Promise<void>)[], size: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) await jobs[next++]!();
  };
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, worker));
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}
