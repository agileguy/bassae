// Item 13 — every malicious code-execution fixture is HIGH and carries its
// expected ruleId. This pins the end-to-end behaviour of the ISC-13..16 rules
// against the checked-in corpus of attack templates. A fixture may raise more
// than one rule (a format-spec string also names a dunder); we assert only that
// the expected rule is present and HIGH.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeCodeExec } from "../../src/rules/index.ts";
import { makeTemplate } from "../../src/template.ts";
import type { RuleId } from "../../src/types.ts";

const DIR = join(import.meta.dir, "../../fixtures/malicious/codeexec");

const CASES: [string, RuleId][] = [
  ["dunder_dot.jinja", "dunder_access"],
  ["dunder_subscript.jinja", "dunder_access"],
  ["dynamic_attribute.jinja", "dynamic_attribute"],
  ["engine_fingerprint.jinja", "engine_fingerprint"],
  ["exec_surface.jinja", "exec_surface"],
  ["folded_dunder.jinja", "folded_dunder"],
  ["format_traversal.jinja", "format_traversal"],
  ["gadget_traversal.jinja", "gadget_traversal"],
];

test.each(CASES)("malicious fixture %s raises HIGH %s", (file, ruleId) => {
  const path = join(DIR, file);
  const t = makeTemplate({ kind: "bare", path, realPath: path, name: "default" }, new Uint8Array(readFileSync(path)));
  const findings = analyzeCodeExec({ template: t, scaffolding: new Set(), knownGood: false }).findings;
  const f = findings.find((x) => x.ruleId === ruleId);
  expect({ file, present: Boolean(f), high: f?.severity === "HIGH" }).toEqual({ file, present: true, high: true });
});
