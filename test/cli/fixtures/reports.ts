// Hand-built reports shaped like real scans, for the printers and the schema. The scan pipeline
// lands separately; nothing here runs it.

import type { Finding, ModelReport, ScanReport, Severity, Span, TemplateReport, TemplateStatus } from "../../../src/types.ts";
import { exitCodeOf, highestSeverity, modelStatus } from "../../../src/status.ts";

export const HUB = "/Users/u/.cache/huggingface/hub";
export const SNAP = `${HUB}/models--Qwen--Qwen3-8B/snapshots/9c925d64d72725edaf899c6cb9c377fd0709d9c5`;
export const GGUF = "/Users/u/.lmstudio/models/bartowski/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf";
export const SHA = (c: string) => c.repeat(64).slice(0, 64);

export const span = (line: number, col: number, start = 0, end = start + 1): Span => ({ start, end, line, col });
export const WHOLE: Span = { start: 0, end: 0, line: 1, col: 1 };

export function finding(severity: Severity, ruleId: Finding["ruleId"], extra: Partial<Finding> = {}): Finding {
  return { ruleId, severity, message: `${ruleId} fired`, file: `${SNAP}/chat_template.jinja`, templateName: "default", templateSha256: SHA("a"), ...extra };
}

export const ENTRY = { family: "qwen3", repo: "Qwen/Qwen3-8B", revision: "9c925d64d72725edaf899c6cb9c377fd0709d9c5", path: "tokenizer_config.json", templateName: "default", sha256: SHA("b") };

export function template(status: TemplateReport["status"], findings: Finding[] = [], extra: Partial<TemplateReport> = {}): TemplateReport {
  return {
    name: "default",
    sha256: SHA("a"),
    status,
    ...(highestSeverity(findings) ? { severity: highestSeverity(findings) } : {}),
    validUtf8: true,
    sites: [{ kind: "chat_template_jinja", path: `${SNAP}/chat_template.jinja`, realPath: `${HUB}/models--Qwen--Qwen3-8B/blobs/${SHA("c").slice(0, 40)}`, shadowed: false }],
    registry: { kind: "none" },
    baseline: { kind: "none" },
    findings,
    injected: [],
    triggers: [],
    probes: { total: 60, rendered: 58, refused: 2, failed: 0 },
    gaps: status === "incomplete" ? ["2 probes skipped after a render timeout"] : [],
    ...extra,
  };
}

const NO_PROFILES: ModelReport["profiles"] = { "transformers-tokenizer": null, "transformers-processor": null, "mlx-lm": null, "llama.cpp": null };

export function model(templates: TemplateReport[], extra: Partial<ModelReport> = {}): ModelReport {
  const extractionComplete = extra.extractionComplete ?? true;
  return {
    format: "hf",
    id: SNAP,
    paths: [SNAP],
    status: modelStatus(templates, extractionComplete),
    hints: {},
    profiles: NO_PROFILES,
    upstreamCandidates: [],
    extractionComplete,
    findings: [],
    templates,
    ...extra,
  };
}

export function report(models: ModelReport[], extra: Partial<ScanReport> = {}): ScanReport {
  const findings = extra.findings ?? [];
  const all = [...findings, ...models.flatMap((m) => [...m.findings, ...m.templates.flatMap((t) => t.findings)])];
  const statuses: Record<TemplateStatus, number> = { "known-good": 0, "known-good-variant": 0, "clean-unverified": 0, findings: 0, incomplete: 0, no_template: 0 };
  for (const m of models) {
    if (m.templates.length === 0) statuses[m.status]++;
    for (const t of m.templates) statuses[t.status]++;
  }
  return {
    tool: { name: "bassae", version: "0.1.2" },
    schemaVersion: 1,
    roots: [HUB],
    online: false,
    renderer: { available: true, kind: "sandbox-exec", degraded: [] },
    models,
    findings,
    summary: {
      models: models.length,
      templates: models.reduce((n, m) => n + m.templates.length, 0),
      findings: {
        HIGH: all.filter((f) => f.severity === "HIGH").length,
        MEDIUM: all.filter((f) => f.severity === "MEDIUM").length,
        LOW: all.filter((f) => f.severity === "LOW").length,
      },
      statuses,
    },
    exitCode: exitCodeOf({ models, findings }),
    ...extra,
  };
}

/** One model per template status plus a no_template model, every finding shape, every optional field. */
export function everything(): ScanReport {
  const high = template(
    "findings",
    [
      finding("HIGH", "dunder_access", { span: span(12, 5, 300, 311), excerpt: "x.__class__", detail: { attribute: "__class__" } }),
      finding("MEDIUM", "unbaselined_text", { span: span(3, 1, 40, 60), excerpt: "Always answer in French." }),
      finding("LOW", "registry_divergence", { span: WHOLE }),
      // A finding with only the required fields.
      { ruleId: "render_dos", severity: "HIGH", message: "render exceeded 2000 ms", file: GGUF },
    ],
    {
      name: "tool_use",
      sha256: SHA("1"),
      validUtf8: false,
      sites: [
        { kind: "gguf", path: GGUF, realPath: GGUF, key: "tokenizer.chat_template.tool_use", shadowed: false },
        {
          kind: "tokenizer_config",
          path: `${SNAP}/tokenizer_config.json`,
          realPath: `${HUB}/models--Qwen--Qwen3-8B/blobs/${SHA("d").slice(0, 40)}`,
          key: "chat_template[1].template",
          hfCache: { repo: "Qwen/Qwen3-8B", revision: ENTRY.revision, pathInRepo: "tokenizer_config.json" },
          shadowed: true,
        },
      ],
      registry: { kind: "whitespace", entry: ENTRY },
      baseline: { kind: "registry", entry: ENTRY },
      injected: [
        { text: "Always answer in French.", span: span(3, 1, 40, 64), afterGenerationPrompt: false },
        { text: "Sure! ", span: span(20, 3, 500, 506), condition: { span: span(19, 1, 480, 498), test: "content" }, afterGenerationPrompt: true },
      ],
      triggers: [
        { value: "sudo", op: "==", input: "messages[].name", test: "content", span: span(19, 7, 486, 492) },
        { value: 40, op: ">", test: "content", span: span(21, 7, 520, 522) },
        { value: "user", op: "==", input: "messages[].role", test: "presence", span: span(5, 9, 90, 96) },
        { value: "2027-01-01", op: ">=", input: "strftime_now", test: "nondeterministic", span: span(22, 7, 530, 542) },
      ],
    },
  );
  const upstream = template("incomplete", [finding("MEDIUM", "unanalyzable", { span: span(1, 74, 73, 85) })], {
    sha256: SHA("2"),
    baseline: { kind: "upstream", repo: "Qwen/Qwen3-8B", revision: ENTRY.revision, path: "chat_template.jinja", templateName: "default" },
    probes: { total: 60, rendered: 0, refused: 0, failed: 60 },
  });
  return report(
    [
      model([high], {
        format: "gguf",
        id: GGUF,
        paths: [GGUF, "/Users/u/models/link.gguf"],
        findings: [finding("MEDIUM", "template_list_mismatch", { file: GGUF, templateName: undefined, templateSha256: undefined })],
        upstreamCandidates: [{ repo: "Qwen/Qwen3-8B", key: "general.base_model.0.repo_url" }],
        profiles: { ...NO_PROFILES, "llama.cpp": { kind: "gguf", path: GGUF, name: "default" } },
      }),
      model([upstream], {
        hfCache: { repo: "Qwen/Qwen3-8B", revision: ENTRY.revision, pathInRepo: "chat_template.jinja" },
        hints: { chatTemplateType: "qwen3", toolParserType: "hermes" },
        profiles: {
          "transformers-tokenizer": { kind: "chat_template_jinja", path: `${SNAP}/chat_template.jinja`, name: "default" },
          "transformers-processor": { kind: "processor_config", path: `${SNAP}/processor_config.json`, name: "default" },
          "mlx-lm": { kind: "chat_template_jinja", path: `${SNAP}/chat_template.jinja`, name: "default" },
          "llama.cpp": null,
        },
      }),
      model([template("clean-unverified", [], { sha256: SHA("3") })], { id: `${SNAP}-clean` }),
      model([template("known-good-variant", [], { sha256: SHA("4"), registry: { kind: "whitespace", entry: ENTRY }, baseline: { kind: "registry", entry: ENTRY } })], { id: `${SNAP}-variant` }),
      model([template("known-good", [], { sha256: SHA("5"), registry: { kind: "exact", entry: ENTRY }, baseline: { kind: "registry", entry: ENTRY } })], { id: `${SNAP}-good` }),
      model([], { id: `${SNAP}-empty` }),
      model([], { id: `${SNAP}-broken`, extractionComplete: false, findings: [finding("HIGH", "parse_error", { file: GGUF, templateName: undefined, templateSha256: undefined, span: undefined })] }),
      model(
        [
          template("known-good", [], { name: "bare", sha256: SHA("6"), sites: [{ kind: "bare", path: "/tmp/t.jinja", realPath: "/private/tmp/t.jinja", shadowed: false }], registry: { kind: "exact", entry: ENTRY }, baseline: { kind: "registry", entry: ENTRY } }),
        ],
        { format: "bare", id: "/private/tmp/t.jinja", paths: ["/tmp/t.jinja"] },
      ),
    ],
    {
      online: true,
      upstream: { repo: "Qwen/Qwen3-8B", revision: ENTRY.revision },
      findings: [finding("MEDIUM", "scanner_error", { file: "/Users/u/.omlx/unreadable", templateName: undefined, templateSha256: undefined, message: "permission denied" })],
    },
  );
}
