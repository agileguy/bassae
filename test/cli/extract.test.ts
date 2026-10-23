import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { extract, extractFileName, outRefusal, sanitizeName, writeTemplates } from "../../src/cli/extract.ts";
import { loadModels } from "../../src/scan/index.ts";
import { makeTemplate } from "../../src/template.ts";
import type { ExtractedTemplate, ModelRecord } from "../../src/types.ts";
import { buildGguf, typicalKvs } from "../gguf/builder.ts";
import { link, makeTree, removeTrees } from "../helpers/tree.ts";

afterAll(removeTrees);

const ALLOWED = /^[A-Za-z0-9._-]+$/;

function tpl(name: string, text: string | Uint8Array, path = "/m/chat_template.jinja"): ExtractedTemplate {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  return makeTemplate({ kind: "chat_template_jinja", path, realPath: path, name }, bytes);
}

function record(id: string, templates: ExtractedTemplate[], extra: Partial<ModelRecord> = {}): ModelRecord {
  return { format: "hf", id, paths: [id], templates, hints: {}, specialTokens: [], extractionComplete: true, findings: [], ...extra };
}

/** Every file under dir, as paths relative to it. */
function listAll(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() && !e.isSymbolicLink() ? listAll(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]));
}

describe("sanitizeName (ISC-29, ISC-29.2)", () => {
  const HOSTILE = ["../../x", "a/b", "a\\b", "x\u{0}y", ".hidden", "..", ".", "/", "", "\u{65e5}\u{672c}", "tool\u{dc80}use", "a b\tc\nd", "\x1b]52;c;x\x07"];

  test("only [A-Za-z0-9._-], never a leading dot, never empty", () => {
    for (const name of HOSTILE) {
      const s = sanitizeName(name);
      expect(s).toMatch(ALLOWED);
      expect(s.startsWith(".")).toBe(false);
      expect(s).not.toContain("/");
      expect(s).not.toContain("\\");
      expect(s).not.toContain("\u{0}");
    }
  });

  test("specific spellings", () => {
    expect(sanitizeName("tool_use")).toBe("tool_use");
    expect(sanitizeName("default")).toBe("default");
    expect(sanitizeName("a/b")).toBe("a_b");
    expect(sanitizeName("a\\b")).toBe("a_b");
    expect(sanitizeName("x\u{0}y")).toBe("x_y");
    expect(sanitizeName(".hidden")).toBe("_hidden");
    expect(sanitizeName("../../x")).toBe("___.._x");
    expect(sanitizeName("")).toBe("default");
    // One underscore per character, astral and lone surrogates included.
    expect(sanitizeName("\u{1f600}x\u{dc80}")).toBe("_x_");
  });

  test("length is capped", () => {
    expect(sanitizeName("a".repeat(1000)).length).toBe(64);
  });

  test("the file name is the SHA-256 prefix, the sanitized name and .jinja", () => {
    const t = tpl("tool_use", "{{ x }}");
    expect(extractFileName(t)).toBe(`${t.sha256.slice(0, 12)}_tool_use.jinja`);
  });
});

describe("writeTemplates (ISC-29, ISC-29.2)", () => {
  test("writes each template's exact bytes, invalid UTF-8 included", async () => {
    const out = makeTree({});
    const raw = new Uint8Array([0x7b, 0x7b, 0x20, 0xff, 0xfe, 0x80, 0x20, 0x7d, 0x7d]);
    const ts = [tpl("default", "{{ messages }}"), tpl("bad", raw)];
    const result = await writeTemplates(out, ts);
    expect(result.problems).toEqual([]);
    expect(result.written.map((p) => p.slice(out.length + 1)).sort()).toEqual(ts.map(extractFileName).sort());
    for (const t of ts) expect(Buffer.compare(readFileSync(join(out, extractFileName(t))), t.bytes)).toBe(0);
  });

  test("hostile names write nothing outside --out", async () => {
    const root = makeTree({ out: {}, victim: { "keep.txt": "untouched" } });
    const out = join(root, "out");
    const names = ["../../x", "../victim/keep.txt", "a/b", "a\\b", "x\u{0}y", ".hidden", "..", "/etc/passwd"];
    const result = await writeTemplates(
      out,
      names.map((n, i) => tpl(n, `template ${i}`)),
    );
    expect(result.problems).toEqual([]);
    expect(listAll(root).sort()).toEqual([...names.map((n, i) => `out/${extractFileName(tpl(n, `template ${i}`))}`), "victim/keep.txt"].sort());
    expect(readFileSync(join(root, "victim", "keep.txt"), "utf8")).toBe("untouched");
    for (const f of readdirSync(out)) expect(f).toMatch(/^[0-9a-f]{12}_[A-Za-z0-9_-][A-Za-z0-9._-]*\.jinja$/);
  });

  test("identical content under one name is written once", async () => {
    const out = makeTree({});
    const result = await writeTemplates(out, [tpl("default", "same", "/a/chat_template.jinja"), tpl("default", "same", "/b/chat_template.jinja")]);
    expect(result.written).toHaveLength(1);
    expect(readdirSync(out)).toHaveLength(1);
  });

  test("an existing file with the same bytes is left alone and reported as present", async () => {
    const out = makeTree({});
    const t = tpl("default", "same");
    await writeTemplates(out, [t]);
    const again = await writeTemplates(out, [t]);
    expect(again.written).toEqual([]);
    expect(again.existing).toEqual([join(out, extractFileName(t))]);
    expect(again.problems).toEqual([]);
  });

  test("an existing file with other bytes is never overwritten", async () => {
    const t = tpl("default", "real template");
    const out = makeTree({ [extractFileName(t)]: "planted" });
    const result = await writeTemplates(out, [t]);
    expect(result.written).toEqual([]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("already exists");
    expect(readFileSync(join(out, extractFileName(t)), "utf8")).toBe("planted");
  });

  test("a planted symlink at the target name is not followed", async () => {
    const t = tpl("default", "real template");
    const root = makeTree({ out: {}, "victim.txt": "untouched" });
    const out = join(root, "out");
    symlinkSync(join(root, "victim.txt"), join(out, extractFileName(t)));
    // A dangling link too: O_CREAT alone would create its target.
    const u = tpl("other", "second template");
    symlinkSync(join(root, "created-through-link.txt"), join(out, extractFileName(u)));
    const result = await writeTemplates(out, [t, u]);
    expect(result.written).toEqual([]);
    expect(result.problems).toHaveLength(2);
    expect(readFileSync(join(root, "victim.txt"), "utf8")).toBe("untouched");
    expect(existsSync(join(root, "created-through-link.txt"))).toBe(false);
    expect(lstatSync(join(out, extractFileName(t))).isSymbolicLink()).toBe(true);
  });
});

describe("outRefusal (ISC-29.1, ISC-35)", () => {
  test("--out at, inside, or not yet existing under a scanned root is refused", async () => {
    const root = makeTree({ model: { "chat_template.jinja": "x", sub: {} }, elsewhere: {} });
    const model = join(root, "model");
    expect(await outRefusal(model, [model])).toContain("under the scanned path");
    expect(await outRefusal(join(model, "sub"), [model])).toContain("under the scanned path");
    expect(await outRefusal(join(model, "new", "deeper"), [model])).toContain("under the scanned path");
    expect(await outRefusal(join(root, "elsewhere", "..", "model", "x"), [model])).toContain("under the scanned path");
    expect(await outRefusal(join(root, "elsewhere"), [model])).toBeUndefined();
    expect(await outRefusal(join(root, "elsewhere", "new"), [model])).toBeUndefined();
  });

  test("a symlink into a scanned root is seen through", async () => {
    const root = makeTree({ model: { sub: {} }, links: {} });
    symlinkSync(join(root, "model", "sub"), join(root, "links", "into-model"));
    expect(await outRefusal(join(root, "links", "into-model", "out"), [join(root, "model")])).toContain("under the scanned path");
  });

  test("a scanned root reached through a symlink is compared by what it points at", async () => {
    const root = makeTree({ real: { model: {} }, link: {} });
    symlinkSync(join(root, "real", "model"), join(root, "link", "model"));
    expect(await outRefusal(join(root, "real", "model", "out"), [join(root, "link", "model")])).toContain("under the scanned path");
  });

  test("a different spelling of the same directory is still the same directory", async () => {
    const root = makeTree({ Models: { m: {} } });
    const lower = join(root, "models", "m", "out");
    // Only meaningful on a case-insensitive volume, the macOS default; elsewhere the path simply does not exist.
    if (existsSync(join(root, "models"))) expect(await outRefusal(lower, [join(root, "Models", "m")])).toContain("under the scanned path");
  });
});

describe("extract (ISC-29, ISC-29.1, ISC-29.2, ISC-35)", () => {
  test("loads the model through loadModels and writes every template", async () => {
    const root = makeTree({ model: { "chat_template.jinja": "x" } });
    const model = join(root, "model");
    const out = join(root, "out", "nested");
    const seen: [string[], string[]][] = [];
    const ts = [tpl("default", "{{ a }}"), tpl("tool_use", "{{ b }}")];
    const result = await extract(model, out, async (roots, templates) => {
      seen.push([roots, templates]);
      return { models: [record(model, ts)], findings: [], walked: [] };
    });
    expect(seen).toEqual([[[model], []]]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toEqual([]);
    expect(readdirSync(out).sort()).toEqual(ts.map(extractFileName).sort());
    expect(result.stdout.every((l) => l.startsWith("wrote "))).toBe(true);
  });

  test("an --out under the model is refused with exit 3 before anything is written or even read", async () => {
    const root = makeTree({ model: { "chat_template.jinja": "x" } });
    const model = join(root, "model");
    let loaded = false;
    const result = await extract(model, join(model, "out"), async () => {
      loaded = true;
      return { models: [record(model, [tpl("default", "x")])], findings: [], walked: [] };
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toHaveLength(1);
    expect(loaded).toBe(false);
    expect(existsSync(join(model, "out"))).toBe(false);
  });

  test("an --out under a directory the walk reached through a link is refused before writing", async () => {
    const root = makeTree({ store: { m: {} }, linked: {} });
    const target = join(root, "linked");
    const result = await extract(join(root, "store"), join(target, "out"), async () => ({ models: [record(target, [tpl("default", "x")])], findings: [], walked: [] }));
    expect(result.exitCode).toBe(3);
    expect(result.stderr[0]).toContain("under the scanned path");
    expect(existsSync(join(target, "out"))).toBe(false);
  });

  test("security S1: the directory of a template read through a file link is scanned, so --out there is refused", async () => {
    const root = makeTree({ model: { "tokenizer_config.json": "{}" }, elsewhere: { "t.jinja": "{{ messages }}" } });
    symlinkSync("../elsewhere/t.jinja", join(root, "model", "chat_template.jinja"));
    const elsewhere = join(root, "elsewhere");
    for (const out of [elsewhere, join(elsewhere, "new")]) {
      const result = await extract(join(root, "model"), out);
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toEqual([expect.stringContaining("under the scanned path")]);
    }
    expect(readdirSync(elsewhere)).toEqual(["t.jinja"]);
  });

  test("security S1: every directory the walk passed through on the way to a template counts as scanned", async () => {
    // model/a -> ../mid, mid/b -> ../far, far/x.gguf: the GGUF is read at model/a/b/x.gguf.
    const root = makeTree({ model: { a: link("../mid") }, mid: { b: link("../far") }, far: { "x.gguf": buildGguf(typicalKvs()).bytes } });
    const model = join(root, "model");
    const { models } = await loadModels([model], []);
    expect(models.map((m) => [m.id, m.paths])).toEqual([[join(root, "far", "x.gguf"), [join(model, "a", "b", "x.gguf")]]]);
    for (const dir of ["mid", "far"]) {
      const result = await extract(model, join(root, dir, "out"));
      expect(result.exitCode).toBe(3);
      expect(existsSync(join(root, dir, "out"))).toBe(false);
    }
    // A sibling the walk never entered is still a fine place to write.
    expect((await extract(model, join(root, "out"))).exitCode).toBe(0);
  });

  test("security S1: a linked directory the walk listed counts as scanned, though it holds no model", async () => {
    // model/notes -> ../side and side/more -> ../far: the walk lists both, and neither holds a model or a template.
    const root = makeTree({
      model: { "tokenizer_config.json": "{}", "chat_template.jinja": "{{ messages }}", notes: link("../side") },
      side: { "README.md": "notes", more: link("../far") },
      far: {},
    });
    const model = join(root, "model");
    expect((await loadModels([model], [])).walked).toEqual([model, join(root, "side"), join(root, "far")]);
    for (const dir of ["side", "far"]) {
      const result = await extract(model, join(root, dir, "out"));
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toEqual([expect.stringContaining("under the scanned path")]);
      expect(existsSync(join(root, dir, "out"))).toBe(false);
    }
    expect((await extract(model, join(root, "out"))).exitCode).toBe(0);
  });

  test("a missing model is a usage error", async () => {
    const root = makeTree({});
    const result = await extract(join(root, "nope"), join(root, "out"), async () => ({ models: [], findings: [], walked: [] }));
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toHaveLength(1);
    expect(existsSync(join(root, "out"))).toBe(false);
  });

  test("a path holding no model exits 3", async () => {
    const root = makeTree({ empty: {} });
    const result = await extract(join(root, "empty"), join(root, "out"), async () => ({ models: [], findings: [], walked: [] }));
    expect(result.exitCode).toBe(3);
    expect(result.stderr[0]).toContain("no model");
  });

  test("a model with no template writes nothing and says so", async () => {
    const root = makeTree({ m: {} });
    const result = await extract(join(root, "m"), join(root, "out"), async () => ({ models: [record(join(root, "m"), [])], findings: [], walked: [] }));
    expect(result.exitCode).toBe(0);
    expect(result.stderr[0]).toContain("no chat template");
  });

  test("an extraction that stopped short writes what it got and exits 3", async () => {
    const root = makeTree({ m: {} });
    const gguf = join(root, "m");
    const result = await extract(gguf, join(root, "out"), async () => ({
      models: [record(gguf, [tpl("default", "x")], { extractionComplete: false, findings: [{ ruleId: "parse_error", severity: "HIGH", message: "truncated KV section", file: gguf }] })],
      findings: [],
      walked: [],
    }));
    expect(result.exitCode).toBe(3);
    expect(readdirSync(join(root, "out"))).toHaveLength(1);
    expect(result.stderr.join("\n")).toContain("truncated KV section");
  });

  test("everything printed is escaped (ISC-44)", async () => {
    const root = makeTree({ m: {} });
    const m = join(root, "m");
    const result = await extract(m, join(root, "out\x1b]52;"), async () => ({
      models: [record(m, [tpl("x\x1b[2J", "x")], { findings: [{ ruleId: "scanner_error", severity: "MEDIUM", message: "bad \x1b]52;c;x\x07", file: m }] })],
      findings: [],
      walked: [],
    }));
    for (const line of [...result.stdout, ...result.stderr]) expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  });
});
