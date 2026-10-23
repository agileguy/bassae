// Contracts r3: a model's findings are capped on each template they land on, whatever they name. A template
// holds at most FINDING_CAP of each rule and one summary counting exactly what it lost, so what a model's
// templates hold grows as their number, never as its square.

import { describe, expect, test } from "bun:test";
import { FINDING_CAP } from "../../src/rules/finalize.ts";
import { type Attachable, attachModelFindings } from "../../src/scan/attach.ts";
import type { Finding, Severity } from "../../src/types.ts";

const GGUF = "/m/x.gguf";

function template(sha256: string, path = GGUF, realPath = path): Attachable {
  return { sha256, sites: [{ kind: "gguf", path, realPath, shadowed: false }], findings: [], gaps: [] };
}

function finding(message: string, file: string, templateSha256?: string, severity: Severity = "MEDIUM"): Finding {
  return { ruleId: "parse_error", severity, message, file, ...(templateSha256 ? { templateSha256 } : {}) };
}

const held = (templates: readonly Attachable[]) => templates.reduce((n, t) => n + t.findings.length, 0);

describe("attachModelFindings: the cap holds on every template", () => {
  test("N findings, each naming the GGUF and one template's own hash: FINDING_CAP and a summary on each, N in all", () => {
    for (const n of [FINDING_CAP + 50, 4 * (FINDING_CAP + 50)]) {
      const templates = Array.from({ length: n }, (_, i) => template(`sha${i}`));
      const findings = templates.map((t, i) => finding(`key t${i} holds a NUL`, GGUF, t.sha256, "HIGH"));
      expect(attachModelFindings(findings, templates, "/m")).toEqual([]);
      expect(held(templates)).toBe(n * (FINDING_CAP + 1));
      for (const [i, t] of templates.entries()) {
        expect(t.findings).toHaveLength(FINDING_CAP + 1);
        expect(t.findings.at(-1)).toMatchObject({ severity: "HIGH", message: `${n - FINDING_CAP} more parse_error findings suppressed`, file: GGUF, detail: { suppressed: n - FINDING_CAP } });
        // A template's own finding is never the one it gives up for a finding about another.
        expect(t.findings).toContainEqual(expect.objectContaining(findings[i]!));
        expect(t.gaps).toEqual(t.findings.map((f) => `parse_error: ${f.message}`));
      }
    }
  });

  test("a mix of file, hash and both: each finding counted once per template, and each summary says what that template lost", () => {
    // a sits at P, read through the realpath R; b sits at P only.
    const P = "/m/link.gguf";
    const R = "/m/blobs/x.gguf";
    const a = template("a", P, R);
    const b = template("b", P);
    const range = (n: number, make: (i: number) => Finding) => Array.from({ length: n }, (_, i) => make(i));
    const aOwn = range(60, (i) => finding(`P, a's hash ${i}`, P, "a"));
    const realOnly = range(60, (i) => finding(`R ${i}`, R, undefined, i === 59 ? "HIGH" : "MEDIUM"));
    const bHashOnly = range(30, (i) => finding(`b's hash only ${i}`, "/m/elsewhere.json", "b"));
    const bOwn = range(40, (i) => finding(`P, b's hash ${i}`, P, "b"));
    const nowhere = finding("about no template", "/m/nowhere");
    const rest = attachModelFindings([...aOwn, ...realOnly, ...bHashOnly, ...bOwn, nowhere], [a, b], "/m");

    expect(rest).toEqual([expect.objectContaining(nowhere)]);
    // a: its own 60 (through P and its hash, once), R's 60 and P's 40 about b. 160, so 60 lost.
    // b: its own 30 + 40 (the 40 through P and its hash, once) and P's 60 about a. 130, so 30 lost.
    for (const [t, own, lost, severity] of [
      [a, aOwn, 60, "HIGH"],
      [b, [...bHashOnly, ...bOwn], 30, "MEDIUM"],
    ] as const) {
      expect(t.findings).toHaveLength(FINDING_CAP + 1);
      expect(new Set(t.findings.map((f) => f.message)).size).toBe(t.findings.length);
      for (const f of own) expect(t.findings).toContainEqual(expect.objectContaining(f));
      expect(t.findings.at(-1)).toMatchObject({ severity, message: `${lost} more parse_error findings suppressed`, detail: { suppressed: lost } });
    }
    expect(b.findings.some((f) => f.file === R)).toBe(false);
  });
});
