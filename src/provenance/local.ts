// Local comparison (ISC-23): a GGUF beside, or linked into, an HF model
// directory is diffed against that directory's own templates. Neither side is
// trusted. A converter may have copied the template faithfully, or someone may
// have edited either file, so the result is labeled a local comparison and is
// never a baseline (Principles: a sibling file is not a trusted baseline).

import { dirname } from "node:path";
import { diffLines, unifiedDiff } from "../diff.ts";
import { clip } from "../rules/finalize.ts";
import type { ExtractedTemplate, Finding, ModelRecord } from "../types.ts";
import { firstChange, sameIgnoringWhitespace } from "./divergence.ts";

export interface LocalPair {
  gguf: ModelRecord;
  hf: ModelRecord;
}

/**
 * Each GGUF paired with every HF model whose directory directly holds it: by any path the walk reached the
 * GGUF through (a GGUF linked into a model directory), or by its realpath (a model directory reached through
 * a link). Pure: it compares the records' paths and ids and touches no file.
 */
export function pairLocal(models: readonly ModelRecord[]): LocalPair[] {
  const byDir = new Map<string, ModelRecord[]>();
  for (const hf of models) {
    if (hf.format !== "hf") continue;
    for (const dir of new Set([...hf.paths, hf.id])) {
      const list = byDir.get(dir) ?? [];
      if (!list.includes(hf)) list.push(hf);
      byDir.set(dir, list);
    }
  }
  const out: LocalPair[] = [];
  for (const gguf of models) {
    if (gguf.format !== "gguf") continue;
    const seen = new Set<ModelRecord>();
    for (const file of [...gguf.paths, gguf.id]) {
      for (const hf of byDir.get(dirname(file)) ?? []) {
        if (seen.has(hf)) continue;
        seen.add(hf);
        out.push({ gguf, hf });
      }
    }
  }
  return out;
}

/**
 * One MEDIUM local_comparison per GGUF template that differs from every same-name template in the HF model,
 * with a unified diff against the one a runtime would most likely load. A template equal to any of them,
 * or differing only in whitespace (Decisions 23:30, as ISC-24.2), gives nothing; so does a name the HF
 * model does not carry.
 */
export function compareLocal(gguf: ModelRecord, hf: ModelRecord): Finding[] {
  const out: Finding[] = [];
  for (const t of gguf.templates) {
    const same = hf.templates.filter((h) => h.source.name === t.source.name);
    if (same.length === 0 || same.some((h) => sameIgnoringWhitespace(h.text, t.text))) continue;
    // Reader order is source order; a template some other source shadows is the weaker comparison.
    const against = same.find((h) => !h.shadowed) ?? same[0]!;
    out.push(localComparison(t, against));
  }
  return out;
}

function localComparison(t: ExtractedTemplate, against: ExtractedTemplate): Finding {
  const diff = diffLines(against.text, t.text);
  const span = firstChange(t.text, diff);
  const where = against.source.key ? `${against.source.path} (${against.source.key})` : against.source.path;
  return {
    ruleId: "local_comparison",
    severity: "MEDIUM",
    message: `local comparison, not upstream: template "${t.source.name}" differs from ${where}; neither file is a trusted baseline`,
    file: t.source.path,
    templateName: t.source.name,
    templateSha256: t.sha256,
    span,
    excerpt: clip(t.text.slice(span.start, span.end)),
    detail: {
      comparison: "local",
      trusted: false,
      against: { file: against.source.path, kind: against.source.kind, ...(against.source.key ? { key: against.source.key } : {}), sha256: against.sha256 },
      diff: unifiedDiff(against.text, t.text, `local: ${where} [${against.source.name}]`, `local: ${t.source.path} [${t.source.name}]`),
      coarse: diff.coarse,
    },
  };
}
