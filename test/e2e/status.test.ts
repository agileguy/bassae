// ISC-42, ISC-42.1, ISC-27 and ISC-28 through the real command: one fixture per status, each scanned
// alone with --json, then mixed trees for exit-code precedence, then the usage errors.

import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { sandboxAvailable } from "../../src/sandbox/index.ts";
import { makeTree, removeTrees } from "../helpers/tree.ts";
import { bassae, reportOf, type Run, schemaErrors } from "./fixtures/cli.ts";
import { EXPECTED, type Fixture, LFM2, modelAt, statusTree } from "./fixtures/trees.ts";

afterAll(removeTrees);

const sandbox = await sandboxAvailable();
if (!sandbox.available) console.warn(`\n[e2e] SKIPPING statuses through the real renderer: ${sandbox.reason}\n`);

test("the sandboxed renderer is available where CI requires it", () => {
  if (process.env.BASSAE_REQUIRE_SANDBOX) expect(sandbox.available).toBe(true);
});

const root = makeTree(statusTree());
const FIXTURES = Object.keys(EXPECTED) as Fixture[];
const dir = (f: Fixture) => join(root, f);

// Each fixture is scanned once and shared by the tests below.
const runs = new Map<string, Promise<Run>>();
const scanJson = (...paths: string[]) => {
  const key = paths.join("\0");
  if (!runs.has(key)) runs.set(key, bassae(["--json", ...paths]));
  return runs.get(key)!;
};

describe.skipIf(!sandbox.available)("ISC-42: one fixture per status, through bassae --json", () => {
  test.each(FIXTURES)("%s", async (fixture) => {
    const report = reportOf(await scanJson(dir(fixture)));
    const model = modelAt(report, dir(fixture));
    expect(report.renderer).toMatchObject({ available: true });
    expect(model.status).toBe(EXPECTED[fixture]);
    if (fixture === "no-template") {
      // Never clean-unverified: there is nothing to vouch for.
      expect(model).toMatchObject({ templates: [], extractionComplete: true });
      return;
    }
    expect(model.templates).toHaveLength(1);
    expect<string>(model.templates[0]!.status).toBe(EXPECTED[fixture]);
  });

  test("known-good is the registry's own bytes; the variant differs in whitespace only", async () => {
    const good = modelAt(reportOf(await scanJson(dir("known-good"))), dir("known-good")).templates[0]!;
    expect(good).toMatchObject({ findings: [], gaps: [], sha256: LFM2.sha256, registry: { kind: "exact", entry: { sha256: LFM2.sha256 } } });
    const variant = modelAt(reportOf(await scanJson(dir("known-good-variant"))), dir("known-good-variant")).templates[0]!;
    expect(variant).toMatchObject({ findings: [], gaps: [], registry: { kind: "whitespace" } });
  });

  test("each findings fixture carries the severity its rule gives", async () => {
    const severity = async (f: Fixture) => modelAt(reportOf(await scanJson(dir(f))), dir(f)).templates[0]!;
    expect(await severity("findings-high")).toMatchObject({ severity: "HIGH", findings: [{ ruleId: "dunder_access" }] });
    expect(await severity("findings-medium")).toMatchObject({ severity: "MEDIUM", findings: [{ ruleId: "unbaselined_text" }] });
    expect(await severity("findings-low")).toMatchObject({ severity: "LOW", findings: [{ ruleId: "registry_divergence" }], baseline: { kind: "registry" } });
  });

  test("ISC-42.1: a probe the scanner cannot build leaves the template incomplete, not clean", async () => {
    const t = modelAt(reportOf(await scanJson(dir("incomplete"))), dir("incomplete")).templates[0]!;
    expect(t.findings).toEqual([]);
    expect(t.probes.failed).toBeGreaterThan(0);
    expect(t.gaps).toEqual([expect.stringMatching(/^differential rendering incomplete: /)]);
  });

  test("ISC-42.1: a template that refuses every probe leaves nothing checked, so it is incomplete", async () => {
    const t = modelAt(reportOf(await scanJson(dir("incomplete-refuses"))), dir("incomplete-refuses")).templates[0]!;
    expect(t.findings).toEqual([]);
    expect(t.probes).toMatchObject({ rendered: 0, failed: 0 });
    expect(t.probes.refused).toBe(t.probes.total);
    expect(t.gaps).toEqual([expect.stringMatching(/^differential rendering incomplete: /)]);
  });

  test("the whole tree: every template gets exactly one status, and the summary counts them", async () => {
    const report = reportOf(await scanJson(root));
    expect(report.models).toHaveLength(FIXTURES.length);
    for (const f of FIXTURES) expect(modelAt(report, dir(f)).status).toBe(EXPECTED[f]);
    expect(report.summary.statuses).toEqual({ "known-good": 1, "known-good-variant": 1, "clean-unverified": 1, findings: 3, incomplete: 2, no_template: 1 });
  });
});

describe.skipIf(!sandbox.available)("ISC-27: real --json output validates against schema/report.schema.json", () => {
  test.each(FIXTURES)("%s", async (fixture) => {
    expect(schemaErrors(await scanJson(dir(fixture)))).toEqual([]);
  });

  test("the mixed tree", async () => {
    expect(schemaErrors(await scanJson(root))).toEqual([]);
    expect(schemaErrors(await scanJson(dir("findings-high"), dir("incomplete"), dir("findings-medium")))).toEqual([]);
  });
});

describe.skipIf(!sandbox.available)("ISC-28: the exit code from the real binary", () => {
  const CODES: Record<Fixture, number> = {
    "known-good": 0,
    "known-good-variant": 0,
    "clean-unverified": 0,
    "findings-high": 2,
    "findings-medium": 1,
    // LOW-only exits 0.
    "findings-low": 0,
    incomplete: 3,
    "incomplete-refuses": 3,
    "no-template": 0,
  };

  test.each(FIXTURES)("%s", async (fixture) => {
    const run = await scanJson(dir(fixture));
    expect(run.code).toBe(CODES[fixture]);
    expect<number>(reportOf(run).exitCode).toBe(run.code);
  });

  test.each([
    ["HIGH, incomplete and MEDIUM", ["findings-high", "incomplete", "findings-medium"], 2],
    ["incomplete and MEDIUM", ["incomplete", "findings-medium"], 3],
    ["MEDIUM and LOW", ["findings-medium", "findings-low"], 1],
    ["LOW and known-good", ["findings-low", "known-good"], 0],
    ["the whole tree", [""], 2],
  ] as [string, string[], number][])("mixed: %s exits %d", async (_name, fixtures, code) => {
    const run = await scanJson(...fixtures.map((f) => (f ? join(root, f) : root)));
    expect(run.code).toBe(code);
    expect<number>(reportOf(run).exitCode).toBe(code);
  });
});

describe("ISC-28: usage errors exit 3 with one line on stderr and nothing on stdout", () => {
  const REV = "0123456789abcdef0123456789abcdef01234567";
  test.each([
    ["--upstream without --online", ["--upstream", `Qwen/Qwen3-8B@${REV}`, "."], /needs --online/],
    ["a path that does not exist", [join(root, "no-such-model")], /no such file or directory/],
    ["--extract without --out", ["--extract", dir("known-good")], /--extract needs --out/],
  ] as [string, string[], RegExp][])("%s", async (_name, args, message) => {
    const run = await bassae(args);
    expect(run.code).toBe(3);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/^bassae: [^\n]*\n$/);
    expect(run.stderr).toMatch(message);
  });
});
