// ISC-35: a scan never writes, renames or touches the mtime of anything under a root.

import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { scan } from "../../src/scan/index.ts";
import { link, makeTree, removeTrees } from "../helpers/tree.ts";
import { buildGguf, typicalKvs } from "../gguf/builder.ts";
import { CHATML, CHATML_HIGH, CHATML_MEDIUM, chatmlRegistry, gitBlob, hfCacheRepo, hfModel, options, REV_A, REV_B, snapshotTree, tokenizerConfig } from "./fixtures/pipeline.ts";

afterAll(removeTrees);

test("ISC-35: SHA-256 and mtime of every real file, and every directory's names, are identical before and after a scan", async () => {
  const files = { "tokenizer_config.json": tokenizerConfig(), "chat_template.jinja": CHATML };
  const tampered = hfCacheRepo({ [REV_A]: files });
  (tampered.blobs as Record<string, string>)[gitBlob(CHATML)] = CHATML_MEDIUM;
  const good = buildGguf(typicalKvs()).bytes;
  const root = makeTree({
    hub: { "models--acme--chat": hfCacheRepo({ [REV_A]: files, [REV_B]: files }), "models--acme--tampered": tampered },
    lab: { tuned: hfModel(CHATML_HIGH, { "model.gguf": buildGguf(typicalKvs(CHATML_MEDIUM)).bytes }) },
    omlx: { tuned: link("../lab/tuned"), loop: link("..") },
    "good.gguf": good,
    "bad.gguf": good.subarray(0, 40),
    "bare.jinja": CHATML,
  });
  const before = snapshotTree(root);
  expect(before.size).toBeGreaterThan(20);

  const report = await scan(options([join(root, "hub"), join(root, "omlx"), join(root, "good.gguf"), join(root, "bad.gguf")], { templates: [join(root, "bare.jinja")], registry: chatmlRegistry() }));
  expect(report.models.length).toBeGreaterThan(5);

  expect(snapshotTree(root)).toEqual(before);
});
