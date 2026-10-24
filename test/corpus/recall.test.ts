// ISC-32 and ISC-33: the malicious corpus through the real command. Each class folder under fixtures/malicious has
// an expected.json listing its fixtures and the findings each must raise; one --json scan of the whole corpus is
// checked against them.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { sandboxAvailable } from "../../src/sandbox/index.ts";
import type { Finding, RuleId, ScanReport, Severity } from "../../src/types.ts";
import { bassae, reportOf, ROOT, SCAN_TIMEOUT } from "../e2e/fixtures/cli.ts";

const CORPUS = join(ROOT, "fixtures", "malicious");

interface Entry {
  /** Relative to fixtures/malicious. A .jinja file is scanned with --template, anything else as a path. */
  path: string;
  expect: { ruleId: RuleId; severity: Severity }[];
  /** The named attacks of ISC-32 this fixture stands for. */
  tags: string[];
}

const CLASSES = readdirSync(CORPUS).filter((d) => statSync(join(CORPUS, d)).isDirectory());
const fixtures: Entry[] = [];
for (const d of CLASSES) {
  const file = join(CORPUS, d, "expected.json");
  if (existsSync(file)) fixtures.push(...((await Bun.file(file).json()) as { fixtures: Entry[] }).fixtures);
}

// Every rule classified as the corpus must treat it: "high" (some fixture must expect it at HIGH), "capped"
// (only ever MEDIUM or LOW, so the HIGH-coverage gate skips it), or "internal" (the scanner failing, never a
// fixture's doing). Typed Record<RuleId, …>, so adding a rule to the RuleId union fails the typecheck until it
// is classified here — the HIGH-coverage gate can no longer silently under-enforce (test-below cross-checks it).
const RULE_CLASS: Record<RuleId, "high" | "capped" | "internal"> = {
  parse_error: "high",
  unanalyzable: "high",
  dunder_access: "high",
  format_traversal: "high",
  folded_dunder: "high",
  dynamic_attribute: "high",
  gadget_traversal: "high",
  engine_fingerprint: "high",
  exec_surface: "high",
  prefill_injection: "high",
  content_trigger: "high",
  nondeterministic_trigger: "high",
  url_in_text: "high",
  invisible_char: "high",
  render_divergence: "high",
  env_profile_divergence: "high",
  content_integrity: "high",
  tool_integrity: "high",
  render_dos: "high",
  registry_divergence: "high",
  local_tamper: "high",
  // capped at MEDIUM or LOW by the rules, so never required at HIGH
  template_list_mismatch: "capped",
  intra_model_divergence: "capped",
  unbaselined_text: "capped",
  encoded_blob: "capped",
  local_comparison: "capped",
  // the scanner itself failing, not something a fixture shows
  scanner_error: "internal",
};

/** Every rule a template or model can raise at HIGH. */
const HIGH_RULES: readonly RuleId[] = (Object.keys(RULE_CLASS) as RuleId[]).filter((r) => RULE_CLASS[r] === "high");

/** The attacks ISC-32 names, each needing a fixture of its own. */
const NAMED = [
  "CVE-2024-34359",
  "CVE-2024-56326",
  "CVE-2025-27516",
  "CVE-2026-5760",
  "pillar-backdoor",
  "engine-fingerprint",
  "date-bomb",
  "content-drop",
  "always-on-injection",
] as const;

const abs = (e: Entry) => join(CORPUS, e.path);

/** Every finding the report holds for a fixture: on each model at or under its path, and on each of their templates. */
function findingsFor(report: ScanReport, e: Entry): Finding[] {
  const at = abs(e);
  const models = report.models.filter((m) => m.paths.some((p) => p === at || p.startsWith(`${at}/`)));
  return models.flatMap((m) => [...m.findings, ...m.templates.flatMap((t) => t.findings)]);
}

describe("the corpus file", () => {
  test("every fixture on disk is listed, and every listed fixture is on disk", () => {
    const listed = new Set(fixtures.map((e) => e.path));
    expect(listed.size).toBe(fixtures.length);
    // A fixture is any entry in a class folder other than its documentation and its expected.json.
    const onDisk = CLASSES.flatMap((d) => readdirSync(join(CORPUS, d)).map((f) => `${d}/${f}`)).filter(
      (p) => !p.endsWith(".md") && !p.endsWith("/expected.json"),
    );
    expect(onDisk.filter((p) => !listed.has(p))).toEqual([]);
    expect([...listed].filter((p) => !onDisk.includes(p))).toEqual([]);
  });

  test("every entry expects at least one finding", () => {
    expect(fixtures.filter((e) => e.expect.length === 0).map((e) => e.path)).toEqual([]);
  });

  test("ISC-32: at least 20 fixtures, every HIGH rule expected at HIGH, every named attack tagged", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(20);
    const high = new Set(fixtures.flatMap((e) => e.expect.filter((x) => x.severity === "HIGH").map((x) => x.ruleId)));
    expect(HIGH_RULES.filter((r) => !high.has(r))).toEqual([]);
    const tags = new Set(fixtures.flatMap((e) => e.tags));
    expect(NAMED.filter((t) => !tags.has(t))).toEqual([]);
  });
});

const sandbox = await sandboxAvailable();

describe.skipIf(!sandbox.available)("ISC-33: every fixture raises its expected findings through bassae --json", () => {
  // One scan of the whole corpus, shared by every case, started lazily by the first case that runs. A skipIf
  // describe body still executes at collection time, so building the promise eagerly would spawn a scan no test
  // awaits on a sandbox-less machine; `??=` keeps it to the machines that actually run the cases.
  const args = fixtures.flatMap((e) => (e.path.endsWith(".jinja") ? ["--template", abs(e)] : [abs(e)]));
  let scan: Promise<ScanReport> | undefined;
  const report = () => (scan ??= bassae(["--json", ...args]).then(reportOf));

  test.each(fixtures.map((e) => [e.path, e] as const))(
    "%s",
    async (_, e) => {
      const found = findingsFor(await report(), e).map((f) => `${f.ruleId} ${f.severity}`);
      const missing = e.expect.map((x) => `${x.ruleId} ${x.severity}`).filter((x) => !found.includes(x));
      expect({ path: e.path, missing }).toEqual({ path: e.path, missing: [] });
    },
    SCAN_TIMEOUT,
  );
});
