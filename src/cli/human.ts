// The human report (ISC-26): every template worst first, each finding with where it is and what it
// matched, then each model's context. Lines are built from raw report strings and escaped whole on
// the way out, so no field that carries template or path bytes can reach the terminal raw (ISC-44).

import { WHOLE_TEMPLATE } from "../parse/parse.ts";
import { highestSeverity, STATUS_ORDER } from "../status.ts";
import {
  type Finding,
  type ModelReport,
  type RegistryEntry,
  type RuntimeProfile,
  type ScanReport,
  SEVERITY_RANK,
  type Severity,
  type Span,
  type TemplateReport,
  type TemplateStatus,
} from "../types.ts";
import { escapeText } from "./escape.ts";

const PROFILES: readonly RuntimeProfile[] = ["transformers-tokenizer", "transformers-processor", "mlx-lm", "llama.cpp"];
const PROFILE_WIDTH = Math.max(...PROFILES.map((p) => p.length)) + 2;
// Collapsed unbaselined_text lists this many positions before "and N more".
const POSITIONS_SHOWN = 5;

const short = (revision: string) => revision.slice(0, 12);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const label = (name: string, value: string) => `  ${name.padEnd(10)}${value}`;
const more = (value: string) => `${" ".repeat(12)}${value}`;

// HIGH, MEDIUM, LOW, then no finding; ties by STATUS_ORDER, the order a model takes its worst status in.
type Rank = [number, number];
const rankOf = (severity: Severity | undefined, status: TemplateStatus): Rank => [severity ? 3 - SEVERITY_RANK[severity] : 3, STATUS_ORDER.indexOf(status)];
const byRank = (a: Rank, b: Rank) => a[0] - b[0] || a[1] - b[1];

const isWholeTemplate = (s: Span) => s.start === WHOLE_TEMPLATE.start && s.end === WHOLE_TEMPLATE.end && s.line === WHOLE_TEMPLATE.line && s.col === WHOLE_TEMPLATE.col;

/** line:col, or "whole template" for a finding the pre-lexer could not place on a smaller span (Decisions 22:40). */
function position(span: Span | undefined): string | undefined {
  if (!span) return undefined;
  return isWholeTemplate(span) ? "whole template" : `${span.line}:${span.col}`;
}

function byFinding(a: Finding, b: Finding): number {
  return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || (a.span?.start ?? 0) - (b.span?.start ?? 0) || a.ruleId.localeCompare(b.ruleId);
}

// A finding listed outside any template is about no template, so its whole-template span (the one every
// finding without a place of its own gets) prints no position rather than a false "whole template".
function findingRows(f: Finding, templateName: string | undefined, indent: string, inTemplate = true): string[] {
  const at = inTemplate || !f.span || !isWholeTemplate(f.span) ? position(f.span) : undefined;
  const head = [f.ruleId, f.templateName ?? templateName, at, f.file].filter((part) => part !== undefined).join(" · ");
  const rows = [`${indent}${f.severity.padEnd(7)} ${head}`, `${indent}        ${f.message}`];
  if (f.excerpt) rows.push(`${indent}        excerpt: ${f.excerpt}`);
  return rows;
}

// Hundreds of unbaselined_text findings on one template say one thing: this text is not upstream's.
// One line carries the count and the first few positions (Decisions 19:15); --json keeps every one.
function collapsedRows(group: Finding[], templateName: string, indent: string): string[] {
  const first = group[0]!;
  const spans = group.map((f) => f.span).filter((s): s is Span => s !== undefined);
  const shown = spans.slice(0, POSITIONS_SHOWN).map(position).join(", ");
  const rest = spans.length > POSITIONS_SHOWN ? ` and ${spans.length - POSITIONS_SHOWN} more` : "";
  const where = spans.length > 0 ? ` · ${shown}${rest}` : "";
  const rows = [
    `${indent}${first.severity.padEnd(7)} ${first.ruleId} ×${group.length} · ${first.templateName ?? templateName}${where} · ${first.file}`,
    `${indent}        ${group.length} injected-text literals that the template's registry entry does not have`,
  ];
  if (first.excerpt) rows.push(`${indent}        first excerpt: ${first.excerpt}`);
  return rows;
}

function templateFindingRows(findings: readonly Finding[], templateName: string, indent: string): string[] {
  const sorted = [...findings].sort(byFinding);
  const keyOf = (f: Finding) => JSON.stringify([f.severity, f.file, f.templateName ?? templateName]);
  const groups = new Map<string, Finding[]>();
  for (const f of sorted) {
    if (f.ruleId === "unbaselined_text") groups.set(keyOf(f), [...(groups.get(keyOf(f)) ?? []), f]);
  }
  const rows: string[] = [];
  const done = new Set<Finding[]>();
  for (const f of sorted) {
    const group = f.ruleId === "unbaselined_text" ? groups.get(keyOf(f)) : undefined;
    if (!group || group.length < 2) rows.push(...findingRows(f, templateName, indent));
    else if (!done.has(group)) {
      done.add(group);
      rows.push(...collapsedRows(group, templateName, indent));
    }
  }
  return rows;
}

const entryRef = (e: RegistryEntry) => `${e.repo}@${short(e.revision)} ${e.path} (${e.templateName})`;

function registryText(t: TemplateReport): string {
  if (t.registry.kind === "exact") return `known-good: ${entryRef(t.registry.entry)}`;
  if (t.registry.kind === "whitespace") return `whitespace-only variant of ${entryRef(t.registry.entry)}`;
  return "none";
}

function baselineText(t: TemplateReport): string {
  const b = t.baseline;
  if (b.kind === "registry") return `registry ${entryRef(b.entry)}`;
  if (b.kind === "upstream") return `upstream ${b.repo}@${short(b.revision)} ${b.path} (${b.templateName})`;
  return "none";
}

function analysisText(t: TemplateReport): string {
  const content = t.triggers.filter((c) => c.test === "content").length;
  const clock = t.triggers.filter((c) => c.test === "nondeterministic").length;
  const kinds = [content ? `${content} content` : "", clock ? `${clock} nondeterministic` : ""].filter(Boolean).join(", ");
  const p = t.probes;
  return [
    plural(t.injected.length, "injected-text item"),
    `${plural(t.triggers.length, "trigger candidate")}${kinds ? ` (${kinds})` : ""}`,
    `probes ${p.rendered} rendered, ${p.refused} refused, ${p.failed} failed of ${p.total}`,
  ].join(" · ");
}

function templateBlock(t: TemplateReport, m: ModelReport): string[] {
  const severity = t.severity ?? highestSeverity(t.findings);
  const sha = t.sha256.slice(0, 12);
  const rows = [severity ? `${severity}  ${t.name}  ${sha}  ${t.status}` : `${t.status}  ${t.name}  ${sha}`];
  rows.push(label("model", `${m.id} (${m.format})`));
  // Every place this content was found (ISC-11), and the file behind each link.
  for (const s of t.sites) {
    const hf = s.hfCache ? ` · hf ${s.hfCache.repo}@${short(s.hfCache.revision)} ${s.hfCache.pathInRepo}` : "";
    rows.push(label("site", `${s.kind} ${s.path}${s.key !== undefined ? ` key ${s.key}` : ""}${s.shadowed ? " · shadowed" : ""}${hf}`));
    if (s.realPath !== s.path) rows.push(more(`→ ${s.realPath}`));
  }
  rows.push(label("registry", registryText(t)), label("baseline", baselineText(t)), label("analysis", analysisText(t)));
  if (!t.validUtf8) rows.push(label("bytes", "not valid UTF-8; analyzed as decoded, with each invalid byte read as U+FFFD"));
  if (t.findings.length > 0) rows.push("  findings", ...templateFindingRows(t.findings, t.name, "    "));
  if (t.gaps.length > 0) rows.push("  gaps", ...t.gaps.map((g) => `    - ${g}`));
  return rows;
}

function modelBlock(m: ModelReport): string[] {
  const rows = [`model ${m.id} (${m.format}) · ${m.status}`];
  for (const p of m.paths) if (p !== m.id) rows.push(label("path", p));
  if (m.hfCache) rows.push(label("hf cache", `${m.hfCache.repo}@${short(m.hfCache.revision)} ${m.hfCache.pathInRepo}`));
  // mlx-lm hints, reported and never analyzed (ISC-7.3).
  const hints = [m.hints.chatTemplateType !== undefined ? `chat_template_type ${m.hints.chatTemplateType}` : "", m.hints.toolParserType !== undefined ? `tool_parser_type ${m.hints.toolParserType}` : ""];
  if (hints.some(Boolean)) rows.push(label("hints", hints.filter(Boolean).join(" · ")));
  // The template each runtime would load by default (ISC-7.4); one line when none of them loads any.
  if (PROFILES.every((profile) => m.profiles[profile] === null)) rows.push(label("loads", "none of the runtime profiles loads a template from here"));
  else {
    PROFILES.forEach((profile, i) => {
      const source = m.profiles[profile];
      const value = `${profile.padEnd(PROFILE_WIDTH)}${source ? `${source.kind} ${source.path} (${source.name})` : "none"}`;
      rows.push(i === 0 ? label("loads", value) : more(value));
    });
  }
  // Named by the file itself, so never trusted as a baseline (ISC-41.1).
  for (const c of m.upstreamCandidates) rows.push(label("upstream", `${c.repo} from ${c.key} (untrusted, never a baseline)`));
  if (m.templates.length === 0) rows.push(label("templates", "no chat template"));
  for (const t of m.templates) rows.push(label("templates", `${t.name} ${t.sha256.slice(0, 12)} ${t.status}`));
  if (!m.extractionComplete) rows.push("  extraction did not complete: a template may exist that was not read");
  return rows;
}

function header(report: ScanReport): string[] {
  const r = report.renderer;
  const renderer = r.available ? `renderer ${r.kind}${r.degraded.length > 0 ? ` (degraded: ${r.degraded.join("; ")})` : ""}` : `renderer unavailable: ${r.reason}`;
  const upstream = report.upstream ? ` · upstream ${report.upstream.repo}@${short(report.upstream.revision)}` : "";
  return [`bassae ${report.tool.version} · ${report.online ? "online" : "offline"}${upstream} · ${renderer}`, `roots: ${report.roots.length > 0 ? report.roots.join(", ") : "(none)"}`];
}

function summary(report: ScanReport): string {
  const s = report.summary;
  const statuses = STATUS_ORDER.map((status) => `${status} ${s.statuses[status]}`).join(", ");
  return `Summary: ${plural(s.models, "model")}, ${plural(s.templates, "template")} · HIGH ${s.findings.HIGH}, MEDIUM ${s.findings.MEDIUM}, LOW ${s.findings.LOW} · ${statuses} · exit ${report.exitCode}`;
}

/** The ranked text report, ending in a summary line and a newline. */
export function renderHuman(report: ScanReport): string {
  const out = [...header(report), ""];

  const outside = [...report.findings, ...report.models.flatMap((m) => m.findings)].sort(byFinding);
  if (outside.length > 0) out.push("Findings outside templates", ...outside.flatMap((f) => findingRows(f, undefined, "  ", false)), "");

  const templates = report.models
    .flatMap((m) => m.templates.map((t) => ({ t, m, rank: rankOf(t.severity ?? highestSeverity(t.findings), t.status) })))
    .sort((a, b) => byRank(a.rank, b.rank));
  if (templates.length > 0) {
    out.push("Templates, worst first", "");
    for (const { t, m } of templates) out.push(...templateBlock(t, m), "");
  }

  const models = report.models
    .map((m) => ({ m, rank: rankOf(highestSeverity([...m.findings, ...m.templates.flatMap((t) => t.findings)]), m.status) }))
    .sort((a, b) => byRank(a.rank, b.rank));
  if (models.length > 0) {
    out.push("Models", "");
    for (const { m } of models) out.push(...modelBlock(m), "");
  } else out.push("No models found.", "");

  out.push(summary(report));
  return `${out.map(escapeText).join("\n")}\n`;
}
