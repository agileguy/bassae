// ISC-34, ISC-34.1 and ISC-34.2 against the verified clean manifest, fixtures/clean-manifest.json, which
// scripts/build-clean-manifest.ts builds from this machine's models. The file's own checks run anywhere. The rest
// scan the manifest's models with the real command, so they run only for the entries this machine holds; CI holds
// none and skips them.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CleanManifest, ManifestEntry } from "../../scripts/build-clean-manifest.ts";
import { loadRegistry } from "../../src/registry/index.ts";
import { sandboxAvailable } from "../../src/sandbox/index.ts";
import type { Finding, ScanReport } from "../../src/types.ts";
import { bassae, reportOf, ROOT, SCAN_TIMEOUT } from "../e2e/fixtures/cli.ts";

const FILE = join(ROOT, "fixtures", "clean-manifest.json");
const text = await Bun.file(FILE).text();
const manifest = JSON.parse(text) as CleanManifest;

const HOME = homedir();
const expand = (p: string) => join(HOME, p.slice("~/".length));
const tilde = (p: string) => (p.startsWith(`${HOME}/`) ? `~${p.slice(HOME.length)}` : p);
const keyOf = (path: string, name: string) => `${path} [${name}]`;

// Code-unit order, as the build script sorts: locale order differs between machines.
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Each adjacent pair that is not strictly ascending, so a duplicate fails too. */
function outOfOrder<T>(xs: T[], cmp: (a: T, b: T) => number, show: (x: T) => string): string[] {
  return xs.slice(1).flatMap((x, i) => (cmp(xs[i]!, x) < 0 ? [] : [`${show(xs[i]!)} before ${show(x)}`]));
}

const ENTRY_KEYS = new Set(["path", "kind", "name", "sha256", "frozen", "model", "alsoAt", "proof"]);
const HEX = { "git-blob-sha1": /^[0-9a-f]{40}$/, sha256: /^[0-9a-f]{64}$/ };
// ~/.cache/huggingface/hub/models--<org>--<name>/snapshots/<commit>/<path in repo>
const IN_SNAPSHOT = /\/models--[^/]+\/snapshots\/[0-9a-f]{40}\//;

describe("the manifest file", () => {
  test("every path is written from ~, and no home directory is named", () => {
    const paths = [
      ...manifest.roots,
      ...manifest.entries.flatMap((e) => [e.path, e.model, ...(e.alsoAt ?? [])]),
      ...manifest.justified.map((j) => j.path),
    ];
    expect(paths.filter((p) => !p.startsWith("~/"))).toEqual([]);
    expect(text).not.toMatch(/\/Users\/|\/home\//);
    expect(text.includes(HOME)).toBe(false);
  });

  test("it holds paths and hashes, never template text", () => {
    expect(text).not.toMatch(/\{[{%#]/);
    expect(manifest.entries.flatMap((e) => Object.keys(e).filter((k) => !ENTRY_KEYS.has(k)))).toEqual([]);
    expect(manifest.entries.filter((e) => !HEX.sha256.test(e.sha256)).map((e) => e.path)).toEqual([]);
  });

  test("entries are sorted by path then name, once each; justifications by rule then path", () => {
    expect(manifest.entries.length).toBeGreaterThan(0);
    const entryOrder = (a: ManifestEntry, b: ManifestEntry) => byCodeUnit(a.path, b.path) || byCodeUnit(a.name, b.name);
    expect(outOfOrder(manifest.entries, entryOrder, (e) => keyOf(e.path, e.name))).toEqual([]);
    type J = CleanManifest["justified"][number];
    const justOrder = (a: J, b: J) => byCodeUnit(a.ruleId, b.ruleId) || byCodeUnit(a.path, b.path);
    expect(outOfOrder(manifest.justified, justOrder, (j) => `${j.ruleId} ${j.path}`)).toEqual([]);
  });

  test("every entry and model sits under one of the manifest's roots, and each was frozen on a date", () => {
    const under = (p: string) => manifest.roots.some((r) => p.startsWith(`${r}/`));
    expect(manifest.entries.filter((e) => !under(e.path) || !under(e.model) || !e.path.startsWith(e.model)).map((e) => e.path)).toEqual([]);
    expect(manifest.entries.filter((e) => !/^\d{4}-\d{2}-\d{2}$/.test(e.frozen)).map((e) => e.path)).toEqual([]);
  });

  test("ISC-34.1: each entry cites a registry entry with its exact SHA-256, or says review is needed and why", () => {
    const registry = loadRegistry().entries.map((k) => k.entry);
    const unproven = manifest.entries.filter((e) => {
      if ("review" in e.proof) return e.proof.review !== "needed" || e.proof.why.trim() === "";
      const r = e.proof.registry;
      return !registry.some((x) => x.sha256 === e.sha256 && x.repo === r.repo && x.revision === r.revision && x.path === r.path && x.templateName === r.templateName);
    });
    expect(unproven.map((e) => keyOf(e.path, e.name))).toEqual([]);
  });

  test("ISC-34.1: a registry proof carries the download record its file was hashed against, and a file in an HF cache snapshot has its blob", () => {
    const bad = manifest.entries.filter((e) => {
      if ("review" in e.proof) return false;
      const i = e.proof.integrity;
      if (i.record === "none") return IN_SNAPSHOT.test(e.path);
      return !HEX[i.algorithm].test(i.etag) || (IN_SNAPSHOT.test(e.path) && i.record !== "hf-cache-blob");
    });
    expect(bad.map((e) => keyOf(e.path, e.name))).toEqual([]);
  });

  test("ISC-34.2: every justification names a rule, a path and a one-line reason", () => {
    const bad = manifest.justified.filter((j) => !/^[a-z_]+$/.test(j.ruleId) || j.reason.trim() === "" || /\n/.test(j.reason));
    expect(bad).toEqual([]);
  });
});

// An entry is on this machine when its file is. The rest are skipped one by one.
const present = manifest.entries.filter((e) => existsSync(expand(e.path)));
if (present.length === 0) console.warn(`\n[clean] SKIPPING the scan of the clean manifest: none of its ${manifest.entries.length} entries is on this machine\n`);
else if (present.length < manifest.entries.length) console.warn(`\n[clean] ${manifest.entries.length - present.length} of ${manifest.entries.length} manifest entries are not on this machine; skipping them\n`);

const sandbox = await sandboxAvailable();
if (present.length > 0 && !sandbox.available) console.warn(`\n[clean] SKIPPING ISC-34 and ISC-34.2 through the real renderer: ${sandbox.reason}\n`);

test("the sandboxed renderer is available where the run requires it", () => {
  if (process.env.BASSAE_REQUIRE_SANDBOX) expect(sandbox.available).toBe(true);
});

// One scan of the models behind the entries here, started by the first test that needs it and shared by the rest.
let scan: Promise<ScanReport> | undefined;
const report = () => (scan ??= bassae(["--json", ...[...new Set(present.map((e) => expand(e.model)))]]).then(reportOf));

/** The SHA-256 of each template the scan found, by the path it was found at (from ~) and its name. */
function foundIn(r: ScanReport): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of r.models) for (const t of m.templates) for (const s of t.sites) out.set(keyOf(tilde(s.path), t.name), t.sha256);
  return out;
}

function findingsIn(r: ScanReport): Finding[] {
  return [...r.findings, ...r.models.flatMap((m) => [...m.findings, ...m.templates.flatMap((t) => t.findings)])];
}

describe.skipIf(present.length === 0)("the manifest against this machine, through bassae --json", () => {
  test("every entry here still holds the template with that SHA-256", async () => {
    const found = foundIn(await report());
    const stale = present
      .filter((e) => found.get(keyOf(e.path, e.name)) !== e.sha256)
      .map((e) => `stale: ${keyOf(e.path, e.name)} is ${found.get(keyOf(e.path, e.name)) ?? "not found"}, manifest says ${e.sha256}`);
    expect(stale).toEqual([]);
  }, SCAN_TIMEOUT);

  test("every template the scan finds in the manifest's models has an entry", async () => {
    const listed = new Set(manifest.entries.map((e) => keyOf(e.path, e.name)));
    expect([...foundIn(await report()).keys()].filter((k) => !listed.has(k))).toEqual([]);
  }, SCAN_TIMEOUT);
});

describe.skipIf(present.length === 0 || !sandbox.available)("ISC-34 and ISC-34.2: the findings on the manifest's models", () => {
  test("ISC-34: zero HIGH findings", async () => {
    const high = findingsIn(await report()).filter((f) => f.severity === "HIGH");
    expect(high.map((f) => `${f.ruleId} ${tilde(f.file)}: ${f.message}`)).toEqual([]);
  }, SCAN_TIMEOUT);

  test("ISC-34.2: every MEDIUM and LOW matches a justification in the manifest", async () => {
    const justified = new Set(manifest.justified.map((j) => `${j.ruleId} ${j.path}`));
    const unexplained = findingsIn(await report()).filter((f) => f.severity !== "HIGH" && !justified.has(`${f.ruleId} ${tilde(f.file)}`));
    expect(unexplained.map((f) => `${f.severity} ${f.ruleId} ${tilde(f.file)}: ${f.message}`)).toEqual([]);
  }, SCAN_TIMEOUT);

  test("every justification for a file here still matches a finding", async () => {
    const raised = new Set(findingsIn(await report()).map((f) => `${f.ruleId} ${tilde(f.file)}`));
    const unused = manifest.justified.filter((j) => existsSync(expand(j.path)) && !raised.has(`${j.ruleId} ${j.path}`));
    expect(unused.map((j) => `${j.ruleId} ${j.path}`)).toEqual([]);
  }, SCAN_TIMEOUT);

  test("every model is analyzed to completion: none is incomplete", async () => {
    const incomplete = (await report()).models
      .filter((m) => m.status === "incomplete")
      .map((m) => `${tilde(m.paths[0] ?? m.id)}: ${m.templates.flatMap((t) => t.gaps).join("; ") || "extraction incomplete"}`);
    expect(incomplete).toEqual([]);
  }, SCAN_TIMEOUT);
});
