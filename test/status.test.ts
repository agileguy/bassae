import { describe, expect, test } from "bun:test";
import { exitCodeOf, modelStatus, statusOf } from "../src/status.ts";
import type { Finding, ModelReport, Severity, TemplateReport, TemplateStatus } from "../src/types.ts";

const finding = (severity: Severity, ruleId: Finding["ruleId"] = "url_in_text"): Finding => ({ ruleId, severity, message: "m", file: "/m/t.jinja" });

function template(status: TemplateReport["status"], findings: Finding[] = []): TemplateReport {
  return {
    name: "default",
    sha256: "0".repeat(64),
    status,
    validUtf8: true,
    sites: [],
    registry: { kind: "none" },
    baseline: { kind: "none" },
    findings,
    injected: [],
    triggers: [],
    probes: { total: 0, rendered: 0, refused: 0, failed: 0 },
    gaps: [],
  };
}

function model(status: TemplateStatus, templates: TemplateReport[] = [], findings: Finding[] = []): ModelReport {
  return {
    format: "hf",
    id: "/m",
    paths: ["/m"],
    status,
    hints: {},
    profiles: { "transformers-tokenizer": null, "transformers-processor": null, "mlx-lm": null, "llama.cpp": null },
    upstreamCandidates: [],
    extractionComplete: true,
    findings,
    templates,
  };
}

describe("statusOf (ISC-42, ISC-42.1)", () => {
  test("a HIGH finding wins over a gap", () => {
    expect(statusOf([finding("HIGH")], ["probe skipped"], "exact")).toBe("findings");
  });
  test("a gap wins over MEDIUM findings and over an exact registry match", () => {
    expect(statusOf([finding("MEDIUM")], ["probe skipped"], "none")).toBe("incomplete");
    expect(statusOf([], ["render limit"], "exact")).toBe("incomplete");
  });
  test("MEDIUM and LOW findings give findings, even on a registry match", () => {
    expect(statusOf([finding("LOW")], [], "exact")).toBe("findings");
    expect(statusOf([finding("MEDIUM")], [], "whitespace")).toBe("findings");
  });
  test("clean statuses follow the registry match", () => {
    expect(statusOf([], [], "exact")).toBe("known-good");
    expect(statusOf([], [], "whitespace")).toBe("known-good-variant");
    expect(statusOf([], [], "none")).toBe("clean-unverified");
  });
});

describe("modelStatus", () => {
  test("a model with no template is no_template only when extraction completed", () => {
    expect(modelStatus([], true)).toBe("no_template");
    expect(modelStatus([], false)).toBe("incomplete");
  });
  test("a model takes its worst template's status", () => {
    expect(modelStatus([{ status: "known-good" }, { status: "clean-unverified" }], true)).toBe("clean-unverified");
    expect(modelStatus([{ status: "incomplete" }, { status: "findings" }], true)).toBe("findings");
  });
  test("findings no template took count toward the model's own status", () => {
    expect(modelStatus([{ status: "known-good" }], true, [finding("HIGH", "local_tamper")])).toBe("findings");
    expect(modelStatus([], false, [finding("HIGH", "parse_error")])).toBe("findings");
    expect(modelStatus([{ status: "known-good" }], true, [finding("MEDIUM", "scanner_error")])).toBe("incomplete");
    expect(modelStatus([{ status: "known-good" }], true, [finding("LOW")])).toBe("findings");
    expect(modelStatus([{ status: "known-good" }], false)).toBe("incomplete");
    expect(modelStatus([{ status: "findings" }], true, [finding("MEDIUM", "parse_error")])).toBe("findings");
  });
});

describe("exitCodeOf (ISC-28)", () => {
  test("2 for any HIGH, wherever it sits", () => {
    expect(exitCodeOf({ findings: [finding("HIGH", "scanner_error")], models: [] })).toBe(2);
    expect(exitCodeOf({ findings: [], models: [model("findings", [], [finding("HIGH", "local_tamper")])] })).toBe(2);
    expect(exitCodeOf({ findings: [], models: [model("incomplete", [template("findings", [finding("HIGH")]), template("incomplete")])] })).toBe(2);
  });
  test("3 for a scanner or parse error, or an incomplete status", () => {
    expect(exitCodeOf({ findings: [finding("MEDIUM", "scanner_error")], models: [] })).toBe(3);
    expect(exitCodeOf({ findings: [], models: [model("incomplete", [], [finding("MEDIUM", "parse_error")])] })).toBe(3);
    expect(exitCodeOf({ findings: [], models: [model("incomplete", [template("incomplete", [finding("MEDIUM")])])] })).toBe(3);
    expect(exitCodeOf({ findings: [], models: [model("incomplete")] })).toBe(3);
  });
  test("1 for any MEDIUM, 0 for LOW only or nothing", () => {
    expect(exitCodeOf({ findings: [], models: [model("findings", [template("findings", [finding("MEDIUM")])])] })).toBe(1);
    expect(exitCodeOf({ findings: [], models: [model("findings", [template("findings", [finding("LOW")])])] })).toBe(0);
    expect(exitCodeOf({ findings: [], models: [model("no_template")] })).toBe(0);
  });
});
