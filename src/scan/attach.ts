// Findings about a model as a whole: the readers' own, intra-model divergence (ISC-7.5), local tamper
// (ISC-40) and local comparisons (ISC-23). They pass through the same finalize as rule findings, then
// each moves onto every template whose file it names, where it counts toward that template's status.
// What names no template stays on the model.

import { capPerRule, dedupe, pushAll } from "../rules/finalize.ts";
import { isGapFinding } from "../status.ts";
import type { Finding, TemplateSite } from "../types.ts";

/**
 * Excerpts clipped, every finding given a span (the whole-template one when it has none of its own),
 * duplicates dropped and at most FINDING_CAP per rule, as for rule findings (Decisions 19:15). A hostile
 * GGUF repeating one key thousands of times then costs one summary finding, not thousands. `file` is what
 * the summary of a capped rule names: the model's id, or "<scan>" for the scan's own findings.
 */
export function finalizeFindings(findings: readonly Finding[], file: string): Finding[] {
  const out: Finding[] = [];
  pushAll(out, [...findings]);
  // dedupe keys on rule, span and message, which names one place only inside one file. These findings name
  // many files, and "cannot read" about two of them is two findings, so each file is deduplicated on its own.
  const byFile = new Map<string, Finding[]>();
  for (const f of out) {
    const list = byFile.get(f.file);
    if (list) list.push(f);
    else byFile.set(f.file, [f]);
  }
  const kept = new Set([...byFile.values()].flatMap(dedupe));
  return capPerRule(
    out.filter((f) => kept.has(f)),
    { file },
  );
}

/** Where a model finding can land: a template's sites and hash, and the findings and gaps it collects. */
export interface Attachable {
  sha256: string;
  sites: readonly TemplateSite[];
  findings: Finding[];
  gaps: string[];
}

/**
 * Appends each finding to every template it names, through its `file` (a site's path or realpath) or its
 * `templateSha256`, and returns the ones that name none. A file holding two templates, such as a GGUF or a
 * tokenizer_config.json with a list, puts a finding about that file on both, and the summary counts it
 * once per template. A scanner or parse error also gives each template it lands on a gap (ISC-42.1).
 */
export function attachModelFindings(findings: readonly Finding[], templates: readonly Attachable[]): Finding[] {
  const byFile = new Map<string, Set<Attachable>>();
  const bySha = new Map<string, Set<Attachable>>();
  const add = (map: Map<string, Set<Attachable>>, key: string, t: Attachable) => {
    const set = map.get(key);
    if (set) set.add(t);
    else map.set(key, new Set([t]));
  };
  for (const t of templates) {
    add(bySha, t.sha256, t);
    for (const s of t.sites) {
      add(byFile, s.path, t);
      add(byFile, s.realPath, t);
    }
  }
  const rest: Finding[] = [];
  for (const f of findings) {
    const targets = new Set([...(byFile.get(f.file) ?? []), ...(f.templateSha256 ? (bySha.get(f.templateSha256) ?? []) : [])]);
    if (targets.size === 0) rest.push(f);
    for (const t of targets) {
      t.findings.push(f);
      if (isGapFinding(f)) t.gaps.push(`${f.ruleId}: ${f.message}`);
    }
  }
  return rest;
}
