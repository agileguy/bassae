// Prints the analyzer's verdict on the template read from stdin, so a test can
// run it again under a 1 MiB stack and compare (ISC-31). Not a test file itself.
// Given the argument `canary`, it instead reports whether the library parser
// survives 4000 nested ifs, which a 1 MiB stack does not.

import { Template } from "@huggingface/jinja";
import { analyzeCodeExec } from "../../src/rules/index.ts";
import { makeTemplateFromString } from "../../src/template.ts";
import type { RuleResult } from "../../src/types.ts";

/** What must not depend on the stack: completeness, and every unanalyzable finding. */
export function verdict(r: RuleResult): unknown {
  const u = r.findings.filter((f) => f.ruleId === "unanalyzable").map((f) => ({ severity: f.severity, message: f.message, span: f.span }));
  return { complete: r.complete, unanalyzable: u };
}

export function analyze(src: string): RuleResult {
  const t = makeTemplateFromString({ kind: "bare", path: "/t", realPath: "/t", name: "default" }, src);
  return analyzeCodeExec({ template: t, scaffolding: new Set(), knownGood: false });
}

if (import.meta.main) {
  if (process.argv[2] === "canary") {
    let parsed = true;
    try {
      new Template("{% if a %}".repeat(4000) + "{% endif %}".repeat(4000));
    } catch {
      parsed = false;
    }
    console.log(JSON.stringify({ parsed }));
  } else {
    console.log(JSON.stringify(verdict(analyze(await Bun.stdin.text()))));
  }
}
