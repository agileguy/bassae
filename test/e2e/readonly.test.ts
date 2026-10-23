// ISC-35 through the real command: a full scan, in both output modes, leaves the SHA-256 and mtime of
// every file under the scanned tree as they were, links followed, and every directory's names too.

import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { buildGguf, typicalKvs } from "../gguf/builder.ts";
import { link, makeTree, removeTrees } from "../helpers/tree.ts";
import { snapshotTree } from "../scan/fixtures/pipeline.ts";
import { bassae, reportOf } from "./fixtures/cli.ts";
import { statusTree } from "./fixtures/trees.ts";

afterAll(removeTrees);

test("ISC-35: a full scan of a mixed tree, human then --json, changes nothing under it", async () => {
  // The status fixtures (findings-low is a Hugging Face cache whose snapshot files link into blobs/),
  // plus a GGUF, a symlinked model directory and a symlink loop.
  const root = makeTree({
    ...statusTree(),
    gguf: { "model.gguf": buildGguf(typicalKvs()).bytes },
    omlx: { tuned: link("../findings-high"), loop: link("..") },
  });
  const before = snapshotTree(root);
  expect([...before.keys()].some((p) => p.includes("/blobs/"))).toBe(true);

  const human = await bassae([root]);
  expect(human.stdout).toContain("\nSummary: ");
  const json = await bassae(["--json", root]);
  const report = reportOf(json);

  // The scan reached what the snapshot covers: the GGUF, the blob behind each cache link, and the linked directory.
  expect(report.models.some((m) => m.format === "gguf")).toBe(true);
  const sites = report.models.flatMap((m) => m.templates.flatMap((t) => t.sites));
  expect(sites.some((s) => s.realPath.includes("/blobs/"))).toBe(true);
  expect(report.models.some((m) => m.paths.includes(join(root, "omlx", "tuned")))).toBe(true);

  expect(snapshotTree(root)).toEqual(before);
});
