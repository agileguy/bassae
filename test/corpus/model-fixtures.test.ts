// The model fixtures under fixtures/malicious/models are generated: their GGUFs and hash-named blobs come from
// scripts/build-model-fixtures.ts. The committed tree must be exactly what it writes, byte for byte and link for
// link, so a fixture can never drift from the generator that documents it. Regenerate with
// `bun scripts/build-model-fixtures.ts`.

import { expect, test } from "bun:test";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { HAND_WRITTEN, MODELS, modelFixtures } from "../../scripts/build-model-fixtures.ts";

const built = modelFixtures();

/** Every file and link under fixtures/malicious/models other than the hand-written ones, relative to it. */
function onDisk(dir = MODELS, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = prefix + e.name;
    if (e.isDirectory()) return onDisk(join(dir, e.name), `${rel}/`);
    return prefix === "" && HAND_WRITTEN.includes(e.name) ? [] : [rel];
  });
}

test("the generator gives the same entries every time", () => {
  expect(modelFixtures()).toEqual(built);
});

test("every generated file and link is committed as generated", () => {
  const differs: string[] = [];
  for (const [rel, entry] of built) {
    const path = join(MODELS, rel);
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (entry.kind === "link") {
      if (!st?.isSymbolicLink() || readlinkSync(path) !== entry.target) differs.push(rel);
    } else if (!st?.isFile() || !Buffer.from(entry.bytes).equals(readFileSync(path))) differs.push(rel);
  }
  expect(differs).toEqual([]);
});

test("nothing else is on disk, so a stale file from an older run cannot linger", () => {
  expect(onDisk().filter((rel) => !built.has(rel))).toEqual([]);
});

test("every link is relative and stays inside its own fixture", () => {
  const escapes = [...built]
    .filter(([, e]) => e.kind === "link")
    .filter(([rel, e]) => {
      const target = (e as { target: string }).target;
      const fixture = rel.split("/")[0]!;
      const resolved = normalize(join(dirname(rel), target));
      return target.startsWith("/") || !resolved.startsWith(`${fixture}/`);
    })
    .map(([rel]) => rel);
  expect(escapes).toEqual([]);
});
