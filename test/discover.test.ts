import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { discover, walk } from "../src/discover.ts";
import { hfCacheLocations } from "../src/hf/cache.ts";
import type { DiscoveredModel } from "../src/types.ts";
import { GGUF_BYTES, link, makeTree } from "./helpers/tree.ts";

const ids = (models: DiscoveredModel[], format: "gguf" | "hf") =>
  models.filter((m) => m.format === format).map((m) => m.id).sort();

const byId = (models: DiscoveredModel[], id: string) => {
  const m = models.find((x) => x.id === id);
  if (!m) throw new Error(`not discovered: ${id}`);
  return m;
};

describe("ISC-1: GGUF by magic only", () => {
  test("extension is ignored both ways, Ollama-style blobs included", async () => {
    const root = makeTree({
      "model.gguf": GGUF_BYTES,
      "renamed.bin": GGUF_BYTES,
      ollama: { models: { blobs: { "sha256-6a0746a1ec1aef3e7ec53868f220ff6e389f6f8ef87a01d77c96807de94ca2aa": GGUF_BYTES } } },
      "fake.gguf": "GGML not really",
      "empty.gguf": "",
      "notes.txt": "GGU",
    });
    const models = await discover([root]);
    expect(ids(models, "gguf")).toEqual(
      [
        join(root, "model.gguf"),
        join(root, "ollama/models/blobs/sha256-6a0746a1ec1aef3e7ec53868f220ff6e389f6f8ef87a01d77c96807de94ca2aa"),
        join(root, "renamed.bin"),
      ].sort(),
    );
    expect(ids(models, "hf")).toEqual([]);
  });

  test("a GGUF file passed directly as a root is found", async () => {
    const root = makeTree({ "blob": GGUF_BYTES });
    const models = await discover([join(root, "blob")]);
    expect(models).toEqual([{ format: "gguf", id: join(root, "blob"), paths: [join(root, "blob")] }]);
  });
});

describe("ISC-2: every HF/MLX model directory", () => {
  test("any one listed source makes a model directory", async () => {
    const root = makeTree({
      a: { "tokenizer_config.json": "{}" },
      b: { "chat_template.jinja": "{{ x }}" },
      c: { "chat_template.json": "{}" },
      d: { additional_chat_templates: { "tool_use.jinja": "{{ y }}" } },
      e: { "processor_config.json": "{}" },
      f: { "config.json": "{}", "model.safetensors": "x" },
      g: { h: { "tokenizer_config.json": "{}" } },
    });
    const models = await discover([root]);
    expect(ids(models, "hf")).toEqual(["a", "b", "c", "d", "e", "g/h"].map((d) => join(root, d)));
  });

  test("a model directory passed directly as a root is found", async () => {
    const root = makeTree({ m: { "chat_template.jinja": "x" } });
    expect(ids(await discover([join(root, "m")]), "hf")).toEqual([join(root, "m")]);
  });

  test(".no_exist sentinel trees are skipped", async () => {
    const root = makeTree({
      "models--org--name": { ".no_exist": { abc: { "chat_template.jinja": "", "processor_config.json": "" } } },
    });
    expect(await discover([root])).toEqual([]);
  });

  test("a GGUF inside a model directory is its own model", async () => {
    const root = makeTree({ m: { "tokenizer_config.json": "{}", "q8.gguf": GGUF_BYTES } });
    const models = await discover([root]);
    expect(ids(models, "hf")).toEqual([join(root, "m")]);
    expect(ids(models, "gguf")).toEqual([join(root, "m/q8.gguf")]);
  });

  test("missing roots and unreadable entries do not throw, and are reported by walk", async () => {
    const root = makeTree({ m: { "chat_template.jinja": "x" }, dangling: link("nowhere") });
    const { models, errors } = await walk([join(root, "missing"), root]);
    expect(ids(models, "hf")).toEqual([join(root, "m")]);
    expect(errors.map((e) => e.path).sort()).toEqual([join(root, "dangling"), join(root, "missing")]);
  });
});

describe("ISC-11: HF cache file symlinks", () => {
  const cache = () =>
    makeTree({
      "models--org--name": {
        blobs: { aaa: '{"chat_template": "{{ m }}"}', bbb: GGUF_BYTES },
        snapshots: {
          r1: { "tokenizer_config.json": link("../../blobs/aaa"), "model.gguf": link("../../blobs/bbb") },
          r2: { "tokenizer_config.json": link("../../blobs/aaa"), sub: { "model.gguf": link("../../../blobs/bbb") } },
        },
        refs: { main: "r2" },
      },
    });

  test("each snapshot is a model directory with its cache location", async () => {
    const root = cache();
    const models = await discover([root]);
    const snap = (r: string) => join(root, "models--org--name/snapshots", r);
    expect(ids(models, "hf")).toEqual([snap("r1"), snap("r2")]);
    expect(byId(models, snap("r1")).hfCache).toEqual({ repo: "org/name", revision: "r1", pathInRepo: "" });
    expect(byId(models, snap("r2")).hfCache).toEqual({ repo: "org/name", revision: "r2", pathInRepo: "" });
  });

  test("a blob reached from several snapshots is one model listing every path", async () => {
    const tree = cache();
    const models = await discover([tree]);
    const blob = join(tree, "models--org--name/blobs/bbb");
    expect(ids(models, "gguf")).toEqual([blob]);
    const m = byId(models, blob);
    expect(m.paths.sort()).toEqual(
      [blob, join(tree, "models--org--name/snapshots/r1/model.gguf"), join(tree, "models--org--name/snapshots/r2/sub/model.gguf")].sort(),
    );
    expect(m.hfCache?.repo).toBe("org/name");
    expect(hfCacheLocations(m.paths).sort((a, b) => a.revision.localeCompare(b.revision))).toEqual([
      { repo: "org/name", revision: "r1", pathInRepo: "model.gguf" },
      { repo: "org/name", revision: "r2", pathInRepo: "sub/model.gguf" },
    ]);
  });
});

describe("ISC-11.1: directory symlinks", () => {
  test("followed out of the root, the way ~/.omlx reaches ~/mlx-lab", async () => {
    const root = makeTree({
      omlx: { models: { ft: link("../../lab/runs/r1/fused") } },
      lab: { runs: { r1: { fused: { "chat_template.jinja": "x", "tokenizer_config.json": "{}" } } } },
    });
    const models = await discover([join(root, "omlx")]);
    expect(models).toEqual([{ format: "hf", id: join(root, "lab/runs/r1/fused"), paths: [join(root, "omlx/models/ft")] }]);
  });

  test("a directory reached by several paths is walked once and lists them all", async () => {
    const root = makeTree({
      real: { m1: { "tokenizer_config.json": "{}", "w.gguf": GGUF_BYTES } },
      links: { m1: link("../real/m1"), parent: link("../real") },
    });
    const models = await discover([join(root, "links"), join(root, "real")]);
    expect(ids(models, "hf")).toEqual([join(root, "real/m1")]);
    expect(byId(models, join(root, "real/m1")).paths.sort()).toEqual(
      [join(root, "links/m1"), join(root, "links/parent/m1"), join(root, "real/m1")].sort(),
    );
    expect(byId(models, join(root, "real/m1/w.gguf")).paths.sort()).toEqual(
      [join(root, "links/m1/w.gguf"), join(root, "links/parent/m1/w.gguf"), join(root, "real/m1/w.gguf")].sort(),
    );
  });

  test("a symlink loop terminates and still finds the model once", async () => {
    const root = makeTree({
      a: {
        "chat_template.jinja": "x",
        self: link("."),
        up: link(".."),
        b: { back: link("../..") },
      },
      x: link("y"),
      y: link("x"),
    });
    const models = await discover([root]);
    expect(models).toEqual([{ format: "hf", id: join(root, "a"), paths: [join(root, "a")] }]);
  });

  test("the same root given twice is walked once", async () => {
    const root = makeTree({ m: { "chat_template.jinja": "x" } });
    const models = await discover([root, root]);
    expect(models).toEqual([{ format: "hf", id: join(root, "m"), paths: [join(root, "m")] }]);
  });

  test("a model dir symlinked into an HF snapshot takes the snapshot's cache location", async () => {
    const root = makeTree({
      hub: { "models--o--n": { snapshots: { r9: { "chat_template.jinja": "x" } } } },
      omlx: { n: link("../hub/models--o--n/snapshots/r9") },
    });
    const models = await discover([join(root, "omlx")]);
    expect(models).toEqual([
      {
        format: "hf",
        id: join(root, "hub/models--o--n/snapshots/r9"),
        paths: [join(root, "omlx/n")],
        hfCache: { repo: "o/n", revision: "r9", pathInRepo: "" },
      },
    ]);
  });
});

// The real tree on this Mac, read-only. Skipped wherever it is absent (CI).
const omlx = join(homedir(), ".omlx");
const lab = join(homedir(), "mlx-lab");
test.skipIf(!existsSync(omlx) || !existsSync(lab))("ISC-11.1 probe: ~/.omlx reports the three mlx-lab fine-tunes", async () => {
  const models = await discover([omlx]);
  const fromLab = models.filter((m) => m.id.startsWith(lab + "/")).map((m) => m.paths.map((p) => p.slice(omlx.length + 1)));
  expect(fromLab.flat().sort()).toEqual(
    ["models/Qwen3-8B-sre-v1-150", "models/Qwen3-8B-sre-v1-300", "models/gemma-4-e4b-kp-alltime"].sort(),
  );
});
