// ISC-29, ISC-29.1, ISC-29.2 and ISC-35 through the real command: --extract writes each template's exact
// bytes under a safe name, refuses an --out under the model, and never touches the model itself.

import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { arr, buildGguf, str, T, typicalKvs } from "../gguf/builder.ts";
import { link, makeTree, removeTrees } from "../helpers/tree.ts";
import { snapshotTree } from "../scan/fixtures/pipeline.ts";
import { bassae } from "./fixtures/cli.ts";
import { sha256 } from "./fixtures/trees.ts";

afterAll(removeTrees);

// CRLF, a non-ASCII letter and two bytes that are not UTF-8: a copy that decoded and re-encoded would differ.
const DEFAULT = Buffer.concat([Buffer.from("{% for m in messages %}\r\n{{ m.content }} é "), Buffer.from([0xff, 0xfe]), Buffer.from("\r\n{% endfor %}")]);
const TOOL_USE = Buffer.from("{{ tools | tojson }}");

// Names that would leave --out, or hide in it, if used as they are (ISC-29.2).
const HOSTILE = ["../../x", "a/b", "c\\d", ".hidden", "e\0f", "..", "/abs"];
const body = (i: number) => `{% for m in messages %}{{ m.content }}{% endfor %}{# ${i} #}`;
const GGUF_NAMES = ["../../x", "a/b", "c\\d", ".hidden"];

function hostileGguf(): Uint8Array {
  const kvs = typicalKvs().filter(([k]) => !String(k).startsWith("tokenizer.chat_template"));
  kvs.push(["tokenizer.chat_template", str(body(-1))]);
  GGUF_NAMES.forEach((name, i) => kvs.push([`tokenizer.chat_template.${name}`, str(body(i))]));
  kvs.push(["tokenizer.chat_templates", arr(T.STRING, GGUF_NAMES)]);
  return buildGguf(kvs).bytes;
}

const root = makeTree({
  two: { "tokenizer_config.json": "{}", "chat_template.jinja": DEFAULT, additional_chat_templates: { "tool_use.jinja": TOOL_USE } },
  "hostile-hf": { "tokenizer_config.json": JSON.stringify({ chat_template: HOSTILE.map((name, i) => ({ name, template: body(i) })) }) },
  "hostile-gguf": { "model.gguf": hostileGguf() },
  // Each --out for the hostile models exists already, so anything new outside it is a write that escaped.
  outside: { "hostile-hf": {}, "hostile-gguf": {}, into: link("../two") },
});
const model = (name: string) => join(root, name);
const out = (name: string) => join(root, "outside", name);

/** The snapshot with every path at or under `dir` left out. */
function without(snapshot: Map<string, string>, dir: string): Map<string, string> {
  return new Map([...snapshot].filter(([path]) => path !== dir && !path.startsWith(`${dir}/`)));
}

describe("ISC-29: --extract writes <sha256-12>_<name>.jinja with the exact bytes", () => {
  test("a model with two named templates", async () => {
    const run = await bassae(["--extract", model("two"), "--out", out("two")]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);

    const expected = [
      [`${sha256(DEFAULT).slice(0, 12)}_default.jinja`, DEFAULT],
      [`${sha256(TOOL_USE).slice(0, 12)}_tool_use.jinja`, TOOL_USE],
    ] as const;
    expect(readdirSync(out("two")).sort()).toEqual(expected.map(([name]) => name).sort());
    for (const [name, bytes] of expected) {
      expect(sha256(readFileSync(join(out("two"), name)))).toBe(sha256(bytes));
      expect(run.stdout).toContain(`wrote ${join(out("two"), name)}\n`);
    }
  });
});

describe("ISC-29.1: an --out under the scanned model is refused with exit 3, and nothing is written", () => {
  test.each([
    ["a new directory inside the model", () => join(model("two"), "out")],
    ["the model directory itself", () => model("two")],
    ["a directory the model already has", () => join(model("two"), "additional_chat_templates")],
    ["a path that reaches the model through a symlink", () => join(out("into"), "sub")],
  ] as [string, () => string][])("%s", async (_name, outDir) => {
    const before = snapshotTree(root);
    const run = await bassae(["--extract", model("two"), "--out", outDir()]);
    expect(run.code).toBe(3);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/^bassae: refusing to write: --out .* is under the scanned path .*\n$/);
    expect(snapshotTree(root)).toEqual(before);
  });
});

describe("ISC-29.2: hostile template names write nothing outside --out", () => {
  // Only [A-Za-z0-9._-] after the hash, never a leading dot.
  const SAFE = /^[0-9a-f]{12}_[A-Za-z0-9_-][A-Za-z0-9._-]*\.jinja$/;

  test.each([
    ["tokenizer_config.json", "hostile-hf", HOSTILE.length],
    ["GGUF", "hostile-gguf", GGUF_NAMES.length + 1],
  ] as [string, string, number][])("names from %s", async (_kind, name, templates) => {
    const before = snapshotTree(root);
    const run = await bassae(["--extract", model(name), "--out", out(name)]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);

    // Everything but --out is as it was: no `x` beside the tree, nothing under the model.
    expect(without(snapshotTree(root), out(name))).toEqual(without(before, out(name)));
    const written = readdirSync(out(name), { withFileTypes: true });
    expect(written).toHaveLength(templates);
    for (const entry of written) {
      expect(entry.isFile()).toBe(true);
      expect(entry.name).toMatch(SAFE);
      // The name's hash is the hash of what it holds.
      expect(sha256(readFileSync(join(out(name), entry.name))).slice(0, 12)).toBe(entry.name.slice(0, 12));
    }
  });
});

describe("ISC-35: --extract to an outside --out leaves the model untouched", () => {
  test.each(["two", "hostile-hf", "hostile-gguf"])("%s", async (name) => {
    const before = snapshotTree(model(name));
    const run = await bassae(["--extract", model(name), "--out", out(`again-${name}`)]);
    expect(run.code).toBe(0);
    expect(readdirSync(out(`again-${name}`)).length).toBeGreaterThan(0);
    expect(snapshotTree(model(name))).toEqual(before);
  });
});
