import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import schema from "../../schema/report.schema.json";
import { renderJson } from "../../src/cli/json.ts";
import type {
  Finding,
  HfCacheLocation,
  InjectedText,
  ModelReport,
  RegistryEntry,
  RuleId,
  RuntimeProfile,
  ScanReport,
  Severity,
  SourceKind,
  Span,
  TemplateReport,
  TemplateSite,
  TemplateStatus,
  TriggerCandidate,
  TriggerOp,
} from "../../src/types.ts";
import { HOSTILE, RAW } from "./fixtures/hostile.ts";
import { everything, finding, model, report, SHA, span, template, WHOLE } from "./fixtures/reports.ts";

const ajv = new Ajv2020({ strict: true, allErrors: true });
const validate = ajv.compile(schema);

/** Validates what --json prints, parsed back, so the test sees exactly the bytes a consumer would. */
function check(r: ScanReport): string[] {
  const parsed: unknown = JSON.parse(renderJson(r));
  return validate(parsed) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}

describe("report.schema.json validates real-shaped reports (ISC-27)", () => {
  test("a report with every status, every finding shape and every optional field present", () => {
    const r = everything();
    const statuses = new Set([...r.models.map((m) => m.status), ...r.models.flatMap((m) => m.templates.map((t) => t.status))]);
    expect([...statuses].sort()).toEqual(["clean-unverified", "findings", "incomplete", "known-good", "known-good-variant", "no_template"]);
    expect(check(r)).toEqual([]);
  });

  test("a report with every optional field absent", () => {
    const bare: Finding = { ruleId: "url_in_text", severity: "HIGH", message: "m", file: "/f" };
    const r = report([model([template("findings", [bare], { sites: [] })], { hfCache: undefined })], { renderer: { available: false, reason: "bwrap is not installed" } });
    expect(r.upstream).toBeUndefined();
    expect(check(r)).toEqual([]);
  });

  test("an empty scan", () => {
    expect(check(report([]))).toEqual([]);
  });

  test("every rule id, every severity", () => {
    const ids = (schema.$defs.ruleId.enum as RuleId[]).flatMap((id) => (["HIGH", "MEDIUM", "LOW"] as Severity[]).map((s) => finding(s, id, { span: WHOLE })));
    expect(check(report([model([template("findings", ids)])]))).toEqual([]);
  });

  test("names carrying invalid-UTF-8 surrogates and terminal escapes survive the round trip", () => {
    const name = `tool${HOSTILE.join("")}`;
    const r = report([model([template("clean-unverified", [], { name })])]);
    const text = renderJson(r);
    // Pretty-printing puts raw newlines between tokens; inside strings there are none.
    expect(RAW.test(text.replaceAll("\n", ""))).toBe(false);
    expect((JSON.parse(text) as ScanReport).models[0]!.templates[0]!.name).toBe(name);
    expect(check(r)).toEqual([]);
  });

  test("a bigint that slips into detail prints as a decimal string instead of throwing", () => {
    const r = report([model([template("findings", [finding("MEDIUM", "parse_error", { detail: { offset: 2n ** 64n } })])])]);
    expect(check(r)).toEqual([]);
    expect((JSON.parse(renderJson(r)) as ScanReport).models[0]!.templates[0]!.findings[0]!.detail).toEqual({ offset: "18446744073709551616" });
  });
});

describe("report.schema.json rejects what the type does not allow", () => {
  const base = () => JSON.parse(renderJson(everything())) as Record<string, any>;
  const rejects = (mutate: (r: Record<string, any>) => void) => {
    const r = base();
    mutate(r);
    return !validate(r);
  };

  test("schemaVersion is pinned to 1", () => {
    expect(rejects((r) => (r.schemaVersion = 2))).toBe(true);
  });

  test("closed objects take no extra field", () => {
    expect(rejects((r) => (r.extra = 1))).toBe(true);
    expect(rejects((r) => (r.models[0].extra = 1))).toBe(true);
    expect(rejects((r) => (r.models[0].templates[0].extra = 1))).toBe(true);
    expect(rejects((r) => (r.models[0].templates[0].findings[0].extra = 1))).toBe(true);
    expect(rejects((r) => (r.models[0].templates[0].findings[0].span.extra = 1))).toBe(true);
    expect(rejects((r) => (r.models[0].templates[0].sites[0].extra = 1))).toBe(true);
    expect(rejects((r) => (r.models[0].templates[0].registry.entry.extra = 1))).toBe(true);
    expect(rejects((r) => (r.models[0].templates[0].baseline.extra = 1))).toBe(true);
    expect(rejects((r) => (r.models[0].templates[0].injected[0].extra = 1))).toBe(true);
    expect(rejects((r) => (r.models[0].templates[0].triggers[0].extra = 1))).toBe(true);
    expect(rejects((r) => (r.models[0].profiles.ollama = null))).toBe(true);
    expect(rejects((r) => (r.models[0].hints.other = "x"))).toBe(true);
    expect(rejects((r) => (r.summary.statuses.clean = 0))).toBe(true);
  });

  test("Finding.detail stays open", () => {
    expect(rejects((r) => (r.models[0].templates[0].findings[0].detail = { anything: [1, { x: null }] }))).toBe(false);
  });

  test("required fields, enums and union branches are enforced", () => {
    expect(rejects((r) => delete r.exitCode)).toBe(true);
    expect(rejects((r) => (r.exitCode = 4))).toBe(true);
    expect(rejects((r) => delete r.models[0].templates[0].gaps)).toBe(true);
    expect(rejects((r) => (r.models[0].templates[0].status = "no_template"))).toBe(true);
    expect(rejects((r) => (r.models[0].templates[0].findings[0].ruleId = "made_up"))).toBe(true);
    expect(rejects((r) => (r.models[0].templates[0].sha256 = "ABC"))).toBe(true);
    expect(rejects((r) => (r.models[0].templates[0].registry = { kind: "none", entry: r.models[0].templates[0].registry.entry }))).toBe(true);
    expect(rejects((r) => (r.models[0].templates[0].baseline = { kind: "upstream", repo: "a/b" }))).toBe(true);
    expect(rejects((r) => (r.renderer = { available: true, reason: "x" }))).toBe(true);
    expect(rejects((r) => (r.models[0].templates[0].findings[0].span.line = 0))).toBe(true);
  });
});

// ---- the schema and src/types.ts cannot drift apart ----
//
// Each list below must name every key (or member) of its type, or this file does not typecheck;
// the tests then hold the schema to the same lists. Adding a field to the report without the
// schema, or the other way round, fails here.

type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];
type Complete<All, Listed> = [Exclude<All, Listed>] extends [never] ? unknown : { missing: Exclude<All, Listed> };

function members<T>() {
  return <const L extends readonly T[]>(list: L & Complete<T, L[number]>): string[] => [...(list as readonly T[])].map(String);
}

function keys<T>() {
  return <const A extends readonly (keyof T & string)[], const R extends readonly (RequiredKeys<T> & string)[]>(
    all: A & Complete<keyof T, A[number]>,
    required: R & Complete<RequiredKeys<T>, R[number]>,
  ) => ({ all: [...(all as readonly string[])], required: [...(required as readonly string[])] });
}

type Branch<U, K> = Extract<U, { kind: K }>;
type ProfileSource = NonNullable<ModelReport["profiles"][RuntimeProfile]>;
type Renderer<A extends boolean> = Extract<ScanReport["renderer"], { available: A }>;

const S = schema as unknown as { properties: Record<string, any>; required: string[]; $defs: Record<string, any> };
const defs = S.$defs;
const props = (node: any) => ({ all: Object.keys(node.properties), required: node.required ?? [] });

const OBJECTS: [string, any, { all: string[]; required: string[] }][] = [
  ["ScanReport", S, keys<ScanReport>()(["tool", "schemaVersion", "roots", "online", "upstream", "renderer", "models", "findings", "summary", "exitCode"], ["tool", "schemaVersion", "roots", "online", "renderer", "models", "findings", "summary", "exitCode"])],
  ["ScanReport.tool", S.properties.tool, keys<ScanReport["tool"]>()(["name", "version"], ["name", "version"])],
  ["ScanReport.upstream", S.properties.upstream, keys<NonNullable<ScanReport["upstream"]>>()(["repo", "revision"], ["repo", "revision"])],
  ["renderer available", S.properties.renderer.oneOf[0], keys<Renderer<true>>()(["available", "kind", "degraded"], ["available", "kind", "degraded"])],
  ["renderer unavailable", S.properties.renderer.oneOf[1], keys<Renderer<false>>()(["available", "reason"], ["available", "reason"])],
  ["summary", S.properties.summary, keys<ScanReport["summary"]>()(["models", "templates", "findings", "statuses"], ["models", "templates", "findings", "statuses"])],
  ["summary.findings", S.properties.summary.properties.findings, keys<ScanReport["summary"]["findings"]>()(["HIGH", "MEDIUM", "LOW"], ["HIGH", "MEDIUM", "LOW"])],
  [
    "summary.statuses",
    S.properties.summary.properties.statuses,
    keys<ScanReport["summary"]["statuses"]>()(
      ["known-good", "known-good-variant", "clean-unverified", "findings", "incomplete", "no_template"],
      ["known-good", "known-good-variant", "clean-unverified", "findings", "incomplete", "no_template"],
    ),
  ],
  ["Span", defs.span, keys<Span>()(["start", "end", "line", "col"], ["start", "end", "line", "col"])],
  ["Finding", defs.finding, keys<Finding>()(["ruleId", "severity", "message", "file", "templateName", "templateSha256", "span", "excerpt", "detail"], ["ruleId", "severity", "message", "file"])],
  ["HfCacheLocation", defs.hfCacheLocation, keys<HfCacheLocation>()(["repo", "revision", "pathInRepo"], ["repo", "revision", "pathInRepo"])],
  ["TemplateSite", defs.templateSite, keys<TemplateSite>()(["kind", "path", "realPath", "key", "hfCache", "shadowed"], ["kind", "path", "realPath", "shadowed"])],
  ["RegistryEntry", defs.registryEntry, keys<RegistryEntry>()(["family", "repo", "revision", "path", "templateName", "sha256"], ["family", "repo", "revision", "path", "templateName", "sha256"])],
  ["InjectedText", defs.injectedText, keys<InjectedText>()(["text", "span", "condition", "afterGenerationPrompt"], ["text", "span", "afterGenerationPrompt"])],
  ["InjectedText.condition", defs.injectedText.properties.condition, keys<NonNullable<InjectedText["condition"]>>()(["span", "test"], ["span", "test"])],
  ["TriggerCandidate", defs.triggerCandidate, keys<TriggerCandidate>()(["value", "op", "input", "test", "span"], ["value", "op", "test", "span"])],
  [
    "TemplateReport",
    defs.templateReport,
    keys<TemplateReport>()(
      ["name", "sha256", "status", "severity", "validUtf8", "sites", "registry", "baseline", "findings", "injected", "triggers", "probes", "gaps"],
      ["name", "sha256", "status", "validUtf8", "sites", "registry", "baseline", "findings", "injected", "triggers", "probes", "gaps"],
    ),
  ],
  ["registry exact|whitespace", defs.templateReport.properties.registry.oneOf[0], keys<Branch<TemplateReport["registry"], "exact" | "whitespace">>()(["kind", "entry"], ["kind", "entry"])],
  ["registry none", defs.templateReport.properties.registry.oneOf[1], keys<Branch<TemplateReport["registry"], "none">>()(["kind"], ["kind"])],
  ["baseline registry", defs.templateReport.properties.baseline.oneOf[0], keys<Branch<TemplateReport["baseline"], "registry">>()(["kind", "entry"], ["kind", "entry"])],
  [
    "baseline upstream",
    defs.templateReport.properties.baseline.oneOf[1],
    keys<Branch<TemplateReport["baseline"], "upstream">>()(["kind", "repo", "revision", "path", "templateName"], ["kind", "repo", "revision", "path", "templateName"]),
  ],
  ["baseline none", defs.templateReport.properties.baseline.oneOf[2], keys<Branch<TemplateReport["baseline"], "none">>()(["kind"], ["kind"])],
  ["probes", defs.templateReport.properties.probes, keys<TemplateReport["probes"]>()(["total", "rendered", "refused", "failed"], ["total", "rendered", "refused", "failed"])],
  [
    "ModelReport",
    defs.modelReport,
    keys<ModelReport>()(
      ["format", "id", "paths", "hfCache", "status", "hints", "profiles", "upstreamCandidates", "extractionComplete", "findings", "templates"],
      ["format", "id", "paths", "status", "hints", "profiles", "upstreamCandidates", "extractionComplete", "findings", "templates"],
    ),
  ],
  ["ModelReport.hints", defs.modelReport.properties.hints, keys<ModelReport["hints"]>()(["chatTemplateType", "toolParserType"], [])],
  [
    "ModelReport.profiles",
    defs.modelReport.properties.profiles,
    keys<ModelReport["profiles"]>()(["transformers-tokenizer", "transformers-processor", "mlx-lm", "llama.cpp"], ["transformers-tokenizer", "transformers-processor", "mlx-lm", "llama.cpp"]),
  ],
  ["profile source", defs.profileSource, keys<ProfileSource>()(["kind", "path", "name"], ["kind", "path", "name"])],
  ["upstream candidate", defs.modelReport.properties.upstreamCandidates.items, keys<ModelReport["upstreamCandidates"][number]>()(["repo", "key"], ["repo", "key"])],
];

const ENUMS: [string, unknown[], string[]][] = [
  ["RuleId", defs.ruleId.enum, members<RuleId>()(["parse_error", "template_list_mismatch", "intra_model_divergence", "unanalyzable", "dunder_access", "format_traversal", "folded_dunder", "dynamic_attribute", "gadget_traversal", "engine_fingerprint", "exec_surface", "unbaselined_text", "prefill_injection", "content_trigger", "nondeterministic_trigger", "url_in_text", "encoded_blob", "invisible_char", "render_divergence", "env_profile_divergence", "content_integrity", "tool_integrity", "render_dos", "local_comparison", "registry_divergence", "local_tamper", "scanner_error"])],
  ["Severity", defs.severity.enum, members<Severity>()(["HIGH", "MEDIUM", "LOW"])],
  ["SourceKind", defs.sourceKind.enum, members<SourceKind>()(["gguf", "tokenizer_config", "chat_template_jinja", "chat_template_json", "additional_chat_templates", "processor_config", "bare"])],
  ["TemplateStatus", defs.templateStatus.enum, members<TemplateStatus>()(["known-good", "known-good-variant", "clean-unverified", "findings", "incomplete", "no_template"])],
  ["TemplateReport.status", defs.templateReport.properties.status.enum, members<TemplateReport["status"]>()(["known-good", "known-good-variant", "clean-unverified", "findings", "incomplete"])],
  ["TriggerOp", defs.triggerCandidate.properties.op.enum, members<TriggerOp>()(["==", "!=", "in", "not in", "startswith", "endswith", "slice", "<", "<=", ">", ">="])],
  ["test class", defs.testClass.enum, members<TriggerCandidate["test"]>()(["presence", "content", "nondeterministic"])],
  ["ModelReport.format", defs.modelReport.properties.format.enum, members<ModelReport["format"]>()(["gguf", "hf", "bare"])],
  ["ExitCode", S.properties.exitCode.enum, members<ScanReport["exitCode"]>()([0, 1, 2, 3])],
  ["registry kind", defs.templateReport.properties.registry.oneOf[0].properties.kind.enum, members<Branch<TemplateReport["registry"], "exact" | "whitespace">["kind"]>()(["exact", "whitespace"])],
];

describe("report.schema.json matches src/types.ts field for field", () => {
  for (const [name, node, want] of OBJECTS) {
    test(`${name}: same fields, same required fields, closed`, () => {
      expect(props(node).all.sort()).toEqual(want.all.sort());
      expect([...props(node).required].sort()).toEqual(want.required.sort());
      expect(node.additionalProperties).toBe(false);
    });
  }
  for (const [name, actual, want] of ENUMS) {
    test(`${name}: same members`, () => {
      expect(actual.map(String).sort()).toEqual(want.sort());
    });
  }
});

describe("fixtures stay honest", () => {
  test("SHA and span helpers make schema-valid values", () => {
    expect(SHA("a")).toMatch(/^[0-9a-f]{64}$/);
    expect(span(2, 3)).toEqual({ start: 0, end: 1, line: 2, col: 3 });
  });
});
