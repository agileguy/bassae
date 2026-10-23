// Findings about a model as a whole: the readers' own, intra-model divergence (ISC-7.5), local tamper
// (ISC-40) and local comparisons (ISC-23). They pass through the same finalize as rule findings, and
// each moves onto every template whose file it names, where it counts toward that template's status.
// What names no template stays on the model.

import { WHOLE_TEMPLATE } from "../parse/parse.ts";
import { capPerRule, dedupe, FINDING_CAP, pushAll } from "../rules/finalize.ts";
import { isGapFinding } from "../status.ts";
import { type Finding, type RuleId, SEVERITY_RANK, type Severity, type TemplateSite } from "../types.ts";

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
 * Prepares a model's findings and gives each to every template it names, through its `file` (a site's path or
 * realpath) or its `templateSha256`; returns the ones that name none, for the model, capped as one with the
 * summary naming `modelId`. A file holding many templates, such as a GGUF or a tokenizer_config.json with a
 * list, gives a finding about that file to each of them.
 *
 * The cap is per template, after placing (contracts r2, r3): of each rule a template keeps at most FINDING_CAP,
 * its own findings (those naming its hash) first, and one summary on that template counts exactly the rest it
 * was given. So a template's own scanner_error is never folded into a summary that lands elsewhere, findings
 * naming a file and a hash at once can never stack past the cap, and a GGUF with thousands of keys costs each
 * template at most FINDING_CAP and a summary. A scanner or parse error, and a summary of them, also gives the
 * template that keeps it a gap (ISC-42.1).
 */
export function attachModelFindings(findings: readonly Finding[], templates: readonly Attachable[], modelId: string): Finding[] {
  const files = new Set(templates.flatMap(keysOf));
  const hashes = new Set(templates.map((t) => t.sha256));
  const byFile = new Map<string, Piles>();
  const byHash = new Map<string, Piles>();
  const order = new Map<Finding, number>();
  const rest: Finding[] = [];
  for (const f of prepare(findings)) {
    order.set(f, order.size);
    const hash = f.templateSha256 !== undefined && hashes.has(f.templateSha256) ? f.templateSha256 : undefined;
    if (hash !== undefined) pile(byHash, hash, f);
    if (files.has(f.file)) pile(byFile, f.file, f, hash);
    else if (hash === undefined) rest.push(f);
  }
  for (const t of templates) {
    const shared = keysOf(t)
      .map((k) => byFile.get(k))
      .filter((p) => p !== undefined);
    place(t, byHash.get(t.sha256), shared, order);
  }
  return capPerRule(rest, { file: modelId });
}

const keysOf = (t: Attachable) => [...new Set(t.sites.flatMap((s) => [s.path, s.realPath]))];

// One rule's findings about one file, or naming one template hash. Only the first FINDING_CAP + 1 are held:
// all a template can keep from here, and the first it gives up, where its summary points. So placing costs
// each template at most that many per rule, never the length of a list every template in a GGUF shares.
interface Pile {
  head: Finding[];
  count: number;
  /** The highest seen, for the summary: a suppressed HIGH is not summarized as MEDIUM (finalize.ts). */
  severity: Severity;
  /** For a file's pile: how many of its findings name each template hash, and so reach that template twice. */
  hashed: Map<string, number>;
}
type Piles = Map<RuleId, Pile>;

function pile(into: Map<string, Piles>, key: string, f: Finding, hash?: string): void {
  let piles = into.get(key);
  if (!piles) into.set(key, (piles = new Map()));
  let p = piles.get(f.ruleId);
  if (!p) piles.set(f.ruleId, (p = { head: [], count: 0, severity: f.severity, hashed: new Map() }));
  if (p.head.length <= FINDING_CAP) p.head.push(f);
  p.count++;
  if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[p.severity]) p.severity = f.severity;
  if (hash !== undefined) p.hashed.set(hash, (p.hashed.get(hash) ?? 0) + 1);
}

// Per rule, `t` is given its own pile and its files' piles. A finding naming one of its files and its hash is in
// both, and counts once, as its own. The heads always hold enough to keep FINDING_CAP and point the summary at
// the first one given up: a file's pile holds FINDING_CAP + 1, and no more of those name `t`'s hash than `t`'s
// own pile holds. What `t` keeps goes on in the order the findings came, then the summaries.
function place(t: Attachable, own: Piles | undefined, shared: readonly Piles[], order: ReadonlyMap<Finding, number>): void {
  const kept: Finding[] = [];
  const summaries: Finding[] = [];
  for (const rule of new Set([...(own?.keys() ?? []), ...shared.flatMap((p) => [...p.keys()])])) {
    const mine = own?.get(rule);
    const others = shared.map((p) => p.get(rule)).filter((p) => p !== undefined);
    const given = [...(mine?.head ?? []), ...others.flatMap((p) => p.head.filter((f) => f.templateSha256 !== t.sha256))];
    const count = others.reduce((n, p) => n + p.count - (p.hashed.get(t.sha256) ?? 0), mine?.count ?? 0);
    kept.push(...given.slice(0, FINDING_CAP));
    if (count <= FINDING_CAP) continue;
    const first = given[FINDING_CAP]!;
    const severity = [mine, ...others].reduce<Severity>((s, p) => (p && SEVERITY_RANK[p.severity] > SEVERITY_RANK[s] ? p.severity : s), "LOW");
    const suppressed = count - FINDING_CAP;
    summaries.push({ ruleId: rule, severity, message: `${suppressed} more ${rule} findings suppressed`, file: first.file, templateSha256: t.sha256, span: first.span ?? { ...WHOLE_TEMPLATE }, detail: { suppressed } });
  }
  kept.sort((a, b) => order.get(a)! - order.get(b)!);
  for (const f of [...kept, ...summaries]) {
    t.findings.push(f);
    if (isGapFinding(f)) t.gaps.push(`${f.ruleId}: ${f.message}`);
  }
}
