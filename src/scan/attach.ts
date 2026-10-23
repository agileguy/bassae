// Findings about a model as a whole: the readers' own, intra-model divergence (ISC-7.5), local tamper
// (ISC-40) and local comparisons (ISC-23). They pass through the same finalize as rule findings, and
// each moves onto every template whose file it names, where it counts toward that template's status.
// What names no template stays on the model.

import { capPerRule, dedupe, pushAll } from "../rules/finalize.ts";
import { isGapFinding } from "../status.ts";
import type { Finding, TemplateSite } from "../types.ts";

// Excerpts clipped and every finding given a span (the whole-template one when it has none of its own), as
// for rule findings (Decisions 19:15). dedupe keys on rule, span and message, which names one place only
// inside one file. These findings name many files, and "cannot read" about two of them is two findings, so
// each file is deduplicated on its own.
function prepare(findings: readonly Finding[]): Finding[] {
  const out: Finding[] = [];
  pushAll(out, [...findings]);
  const byFile = new Map<string, Finding[]>();
  for (const f of out) {
    const list = byFile.get(f.file);
    if (list) list.push(f);
    else byFile.set(f.file, [f]);
  }
  const kept = new Set([...byFile.values()].flatMap(dedupe));
  return out.filter((f) => kept.has(f));
}

/**
 * Findings that go nowhere else, such as the scan's own: prepared, then at most FINDING_CAP per rule. A walk
 * past thousands of unreadable entries then costs one summary finding, not thousands. `file` is what that
 * summary names, "<scan>" for the scan's own findings.
 */
export function finalizeFindings(findings: readonly Finding[], file: string): Finding[] {
  return capPerRule(prepare(findings), { file });
}

/** Where a model finding can land: a template's sites and hash, and the findings and gaps it collects. */
export interface Attachable {
  sha256: string;
  sites: readonly TemplateSite[];
  findings: Finding[];
  gaps: string[];
}

/**
 * Prepares a model's findings and appends each to every template it names, through its `file` (a site's path
 * or realpath) or its `templateSha256`; returns the ones that name none, for the model. A file holding two
 * templates, such as a GGUF or a tokenizer_config.json with a list, puts a finding about that file on both,
 * and the summary counts it once per template. A scanner or parse error also gives each template it lands on
 * a gap (ISC-42.1).
 *
 * The cap comes after placing, not before (contracts r2): findings bound for the same templates are capped
 * together, at most FINDING_CAP per rule, and a capped rule's summary goes where they would have gone. So
 * findings about other files can never fold a template's own scanner_error into a summary that lands
 * elsewhere, and a template keeps every gap it has. What stays on the model is capped as one, its summary
 * naming `modelId`. A hostile GGUF repeating one key thousands of times still costs one summary finding.
 */
export function attachModelFindings(findings: readonly Finding[], templates: readonly Attachable[], modelId: string): Finding[] {
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

  // A finding's templates are fixed by the set its file names and the set its hash names, so findings with
  // the same two sets share a bucket and are capped as one. The key is the sets, never the templates in
  // them, so a file holding thousands of templates costs each finding one lookup, not thousands.
  const ids = new Map<Set<Attachable>, number>();
  const idOf = (set: Set<Attachable> | undefined) => {
    if (!set) return -1;
    let id = ids.get(set);
    if (id === undefined) ids.set(set, (id = ids.size));
    return id;
  };
  const buckets = new Map<string, { files: Set<Attachable> | undefined; shas: Set<Attachable> | undefined; findings: Finding[] }>();
  for (const f of prepare(findings)) {
    const files = byFile.get(f.file);
    const shas = f.templateSha256 ? bySha.get(f.templateSha256) : undefined;
    const key = `${idOf(files)}:${idOf(shas)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.findings.push(f);
    else buckets.set(key, { files, shas, findings: [f] });
  }

  let rest: Finding[] = [];
  for (const { files, shas, findings: list } of buckets.values()) {
    const targets = new Set([...(files ?? []), ...(shas ?? [])]);
    if (targets.size === 0) {
      rest = capPerRule(list, { file: modelId });
      continue;
    }
    const first = list[0]!;
    const placed = capPerRule(list, { file: first.file, ...(shas && first.templateSha256 ? { templateSha256: first.templateSha256 } : {}) });
    for (const t of targets) {
      for (const f of placed) {
        t.findings.push(f);
        if (isGapFinding(f)) t.gaps.push(`${f.ruleId}: ${f.message}`);
      }
    }
  }
  return rest;
}
