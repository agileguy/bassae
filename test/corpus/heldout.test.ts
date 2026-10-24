// ISC-33.1: the held-out set, written by a different author after the rules were frozen. fixtures/heldout/heldout.json
// lists each template with the one threat class it stands for. A template counts as detected when the scan raises a
// finding at or above its class's severity: MEDIUM for an always-on injection, HIGH for every other class. A template that
// comes back incomplete without one, or that the scan can't read, is a miss. At least 90% must be detected.

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { sandboxAvailable } from "../../src/sandbox/index.ts";
import { SEVERITY_RANK, type Severity } from "../../src/types.ts";
import { bassae, reportOf, ROOT, SCAN_TIMEOUT } from "../e2e/fixtures/cli.ts";

const DIR = join(ROOT, "fixtures", "heldout");

const CLASSES = {
  "code-exec": "HIGH",
  "engine-fingerprint": "HIGH",
  "trigger-backdoor": "HIGH",
  "time-bomb": "HIGH",
  "shape-trigger": "HIGH",
  "always-on-injection": "MEDIUM",
  "content-drop": "HIGH",
  prefill: "HIGH",
  exfiltration: "HIGH",
  "hidden-text": "HIGH",
  "render-dos": "HIGH",
} as const satisfies Record<string, Severity>;

interface Entry {
  file: string;
  class: keyof typeof CLASSES;
  base: string;
  attack: string;
}

const set = (await Bun.file(join(DIR, "heldout.json")).json()) as { fixtures: Entry[] };

describe("the held-out file", () => {
  test("every template on disk is listed once, and every listed template is on disk", () => {
    const listed = set.fixtures.map((e) => e.file);
    expect(new Set(listed).size).toBe(listed.length);
    const onDisk = readdirSync(DIR).filter((f) => f.endsWith(".jinja"));
    expect(onDisk.filter((f) => !listed.includes(f))).toEqual([]);
    expect(listed.filter((f) => !onDisk.includes(f))).toEqual([]);
  });

  test("ISC-33.1: at least 10 templates, each naming a known threat class", () => {
    expect(set.fixtures.length).toBeGreaterThanOrEqual(10);
    expect(set.fixtures.filter((e) => !(e.class in CLASSES)).map((e) => e.file)).toEqual([]);
  });
});

const sandbox = await sandboxAvailable();

describe.skipIf(!sandbox.available)("ISC-33.1: the held-out set through bassae --json", () => {
  test(
    "at least 90% detected at their class's severity",
    async () => {
      const report = reportOf(await bassae(["--json", ...set.fixtures.flatMap((e) => ["--template", join(DIR, e.file)])]));
      const missed = set.fixtures.filter((e) => {
        const at = join(DIR, e.file);
        const models = report.models.filter((m) => m.paths.includes(at));
        const findings = models.flatMap((m) => [...m.findings, ...m.templates.flatMap((t) => t.findings)]);
        // A scanner_error is the scanner failing to analyze the fixture, not detecting its attack, so it never
        // counts as detection — even when its severity would otherwise clear the class's bar.
        return !findings.some((f) => f.ruleId !== "scanner_error" && SEVERITY_RANK[f.severity] >= SEVERITY_RANK[CLASSES[e.class]]);
      });
      const rate = (set.fixtures.length - missed.length) / set.fixtures.length;
      // Misses are reported, not hidden: each one is a rule gap with an owner.
      if (missed.length > 0) console.error(`[heldout] missed ${missed.length}: ${missed.map((e) => `${e.file} (${e.class})`).join(", ")}`);
      expect(rate).toBeGreaterThanOrEqual(0.9);
    },
    SCAN_TIMEOUT,
  );
});
