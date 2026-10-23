// ISC-26 through the real command: on the mixed tree the text report ranks templates HIGH → MEDIUM →
// LOW → clean, and every finding shows its rule ID, template name, line:col and file.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { sandboxAvailable } from "../../src/sandbox/index.ts";
import type { ScanReport } from "../../src/types.ts";
import { makeTree, removeTrees } from "../helpers/tree.ts";
import { bassae, reportOf, type Run } from "./fixtures/cli.ts";
import { CHATML_HIGH, CHATML_MEDIUM, type Fixture, modelAt, positionOf, statusTree } from "./fixtures/trees.ts";

afterAll(removeTrees);

const sandbox = await sandboxAvailable();
if (!sandbox.available) console.warn(`\n[e2e] SKIPPING the ranked report through the real renderer: ${sandbox.reason}\n`);

interface Block {
  severity?: string;
  status: string;
  model: string;
  rows: string[];
}

/** The "Templates, worst first" section, one block per template, in printed order. */
function templateBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const start = lines.indexOf("Templates, worst first");
  const end = lines.indexOf("Models");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const blocks: Block[] = [];
  for (const chunk of lines.slice(start + 1, end).join("\n").split("\n\n")) {
    const rows = chunk.split("\n").filter(Boolean);
    if (rows.length === 0) continue;
    // "HIGH  name  sha  status" for a template with findings, "status  name  sha" for one without.
    const head = rows[0]!.split("  ");
    const severity = ["HIGH", "MEDIUM", "LOW"].includes(head[0]!) ? head[0] : undefined;
    const model = /^ {2}model {5}(.*) \(\w+\)$/.exec(rows[1] ?? "")?.[1];
    if (!model) throw new Error(`no model line under ${rows[0]}`);
    blocks.push({ ...(severity ? { severity } : {}), status: severity ? head[3]! : head[0]!, model, rows });
  }
  return blocks;
}

describe.skipIf(!sandbox.available)("ISC-26: the human report on the mixed tree", () => {
  const root = makeTree(statusTree());
  const dir = (f: Fixture) => join(root, f);
  let human: Run;
  let report: ScanReport;
  beforeAll(async () => {
    human = await bassae([root]);
    report = reportOf(await bassae(["--json", root]));
  });

  test("exits 2 as the JSON report does, and ends in the summary line", () => {
    expect(human.code).toBe(2);
    expect(human.code).toBe(report.exitCode);
    expect(human.stdout).toMatch(/\nSummary: 9 models, 8 templates · HIGH 1, MEDIUM 1, LOW 1 · .* · exit 2\n$/);
  });

  test("templates are ranked HIGH, then MEDIUM, then LOW, then every template without a finding", () => {
    const blocks = templateBlocks(human.stdout);
    expect(blocks.map((b) => b.severity ?? "clean")).toEqual(["HIGH", "MEDIUM", "LOW", "clean", "clean", "clean", "clean", "clean"]);
    expect(blocks.slice(0, 3).map((b) => b.model)).toEqual(["findings-high", "findings-medium", "findings-low"].map((f) => modelAt(report, dir(f as Fixture)).id));
    expect(blocks.slice(0, 3).map((b) => b.status)).toEqual(["findings", "findings", "findings"]);
    expect(new Set(blocks.slice(3).map((b) => b.status))).toEqual(new Set(["incomplete", "clean-unverified", "known-good-variant", "known-good"]));
  });

  test("every finding in the JSON report prints with its rule ID, template name, line:col and file", () => {
    const findings = report.models.flatMap((m) => m.templates.flatMap((t) => t.findings));
    expect(findings).toHaveLength(3);
    for (const f of findings) {
      expect(f.span).toBeDefined();
      expect(human.stdout).toContain(`${f.severity.padEnd(7)} ${f.ruleId} · ${f.templateName} · ${f.span!.line}:${f.span!.col} · ${f.file}\n`);
    }
  });

  test("line:col is where the matched text sits in the raw template", () => {
    const at = (f: Fixture) => `${join(dir(f), "chat_template.jinja")}\n`;
    expect(human.stdout).toContain(`HIGH    dunder_access · default · ${positionOf(CHATML_HIGH, "__class__")} · ${at("findings-high")}`);
    expect(human.stdout).toContain(`MEDIUM  unbaselined_text · default · ${positionOf(CHATML_MEDIUM, "Always answer politely.")} · ${at("findings-medium")}`);
  });
});
