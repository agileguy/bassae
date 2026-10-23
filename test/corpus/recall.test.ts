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

/** Every rule a template or model can raise at HIGH. scanner_error is the scanner failing, not something a fixture shows. */
const HIGH_RULES: readonly RuleId[] = [
  "parse_error",
  "unanalyzable",
  "dunder_access",
  "format_traversal",
  "folded_dunder",
  "dynamic_attribute",
  "gadget_traversal",
  "engine_fingerprint",
  "exec_surface",
  "prefill_injection",
  "content_trigger",
  "nondeterministic_trigger",
  "url_in_text",
  "invisible_char",
  "render_divergence",
  "env_profile_divergence",
  "content_integrity",
  "tool_integrity",
  "render_dos",
  "registry_divergence",
  "local_tamper",
];

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
  // One scan of the whole corpus, shared by every case.
  const args = fixtures.flatMap((e) => (e.path.endsWith(".jinja") ? ["--template", abs(e)] : [abs(e)]));
  const scan = bassae(["--json", ...args]).then(reportOf);

  test.each(fixtures.map((e) => [e.path, e] as const))(
    "%s",
    async (_, e) => {
      const found = findingsFor(await scan, e).map((f) => `${f.ruleId} ${f.severity}`);
      const missing = e.expect.map((x) => `${x.ruleId} ${x.severity}`).filter((x) => !found.includes(x));
      expect({ path: e.path, missing }).toEqual({ path: e.path, missing: [] });
    },
    SCAN_TIMEOUT,
  );
});
