import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildGguf, str } from "../gguf/builder.ts";
import { readGgufSource, bytesSource } from "../../src/gguf/index.ts";
import { readHfModel } from "../../src/hf/index.ts";
import { checkIntraModel, createRegistry, loadPrecedence, loadRegistry, REGISTRY_DIR, registryStatus, resolveProfiles, whitespaceKey } from "../../src/registry/index.ts";
import { makeTemplate, makeTemplateFromString } from "../../src/template.ts";
import type { ExtractedTemplate, RegistryEntry, TemplateSource } from "../../src/types.ts";
import { makeTree, removeTrees } from "../helpers/tree.ts";

afterAll(removeTrees);

const ROOT = join(import.meta.dir, "../..");
const FIXTURES = join(import.meta.dir, "fixtures");
const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const src = (path = "/m/chat_template.jinja", name = "default"): TemplateSource => ({ kind: "chat_template_jinja", path, realPath: path, name });
const tpl = (text: string, source = src()) => makeTemplateFromString(source, text);

const registry = loadRegistry();
const byRepoRev = (repo: string, revision: string) => registry.entries.filter((k) => k.entry.repo === repo && k.entry.revision === revision);

describe("checked-in registry (ISC-24.1)", () => {
  test("every entry cites family, repo, a 40-hex commit, a path in the repo, a template name and a SHA-256 its pinned text hashes to", () => {
    expect(registry.entries.length).toBeGreaterThanOrEqual(35);
    for (const { entry, text } of registry.entries) {
      expect(entry.family).toMatch(/^[\w.-]+$/);
      expect(entry.repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
      expect(entry.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.path).toMatch(/^(tokenizer_config\.json|chat_template\.jinja|chat_template\.json|processor_config\.json|additional_chat_templates\/[^/]+\.jinja|[^/]+\.gguf)$/);
      expect(entry.templateName.length).toBeGreaterThan(0);
      const bytes = readFileSync(join(REGISTRY_DIR, "templates", `${entry.sha256}.jinja`));
      expect(sha(bytes)).toBe(entry.sha256);
      expect(text).toBe(new TextDecoder().decode(bytes));
    }
  });

  test("every entry comes from a repo@commit in sources.json, and every source yields an entry", () => {
    const { sources } = JSON.parse(readFileSync(join(REGISTRY_DIR, "sources.json"), "utf8")) as { sources: { family: string; repo: string; revision: string }[] };
    const pins = new Set(sources.map((s) => `${s.family} ${s.repo}@${s.revision}`));
    for (const { entry } of registry.entries) expect(pins.has(`${entry.family} ${entry.repo}@${entry.revision}`)).toBe(true);
    for (const s of sources) expect(byRepoRev(s.repo, s.revision).length).toBeGreaterThan(0);
  });

  test("templates/ holds exactly one file per distinct SHA-256, and nothing else", () => {
    const files = readdirSync(join(REGISTRY_DIR, "templates")).sort();
    expect(files).toEqual([...new Set(registry.entries.map((k) => `${k.entry.sha256}.jinja`))].sort());
  });

  test("the three clean fixtures are exact matches pinned to the repo and revision their README cites", () => {
    const cases: [string, string, string][] = [
      ["qwen2.5-0.5b-instruct.jinja", "Qwen/Qwen2.5-0.5B-Instruct", "7ae557604adf67be50417f59c2c2f167def9a775"],
      ["qwen3-0.6b.jinja", "mlx-community/Qwen3-0.6B-4bit", "73e3e38d981303bc594367cd910ea6eb48349da8"],
      ["qwen3-coder-30b.jinja", "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit", "6e302ea604ad9ab206367e2c501d1571023e7b6d"],
    ];
    for (const [file, repo, revision] of cases) {
      const t = makeTemplate(src(join(ROOT, "fixtures/clean", file)), new Uint8Array(readFileSync(join(ROOT, "fixtures/clean", file))));
      const m = registry.match(t);
      expect(m.kind).toBe("exact");
      expect(byRepoRev(repo, revision).some((k) => k.entry.sha256 === t.sha256)).toBe(true);
    }
  });

  test("loadRegistry refuses a pinned text that does not hash to its entry", () => {
    const text = "{{ bos_token }}{% for m in messages %}{{ m.content }}{% endfor %}";
    const good = sha(text);
    const entry = (over: Partial<RegistryEntry> = {}) => ({ family: "f", repo: "o/r", revision: "a".repeat(40), path: "chat_template.jinja", templateName: "default", sha256: good, ...over });
    const dir = (entries: unknown[], files: Record<string, string | Uint8Array> = { [`${good}.jinja`]: text }) =>
      makeTree({ "known-good.json": JSON.stringify({ entries }), templates: files });

    expect(loadRegistry(dir([entry()])).entries).toHaveLength(1);
    expect(() => loadRegistry(dir([entry()], { [`${good}.jinja`]: `${text} ` }))).toThrow(/hashes to/);
    expect(() => loadRegistry(dir([entry()], {}))).toThrow();
    expect(() => loadRegistry(dir([entry({ revision: "main" })]))).toThrow(/40-hex/);
    expect(() => loadRegistry(dir([entry({ path: "../x" })]))).toThrow(/path/);
    expect(() => loadRegistry(dir([{ ...entry(), extra: 1 }]))).toThrow(/unknown field/);
    expect(() => loadRegistry(dir([entry(), entry()]))).toThrow(/duplicate/);
    const bad = Uint8Array.of(0x7b, 0x7b, 0xff, 0x7d, 0x7d);
    expect(() => loadRegistry(dir([entry({ sha256: sha(bad) })], { [`${sha(bad)}.jinja`]: bad }))).toThrow();
  });

  test("the registry and its entries are frozen", () => {
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.entries)).toBe(true);
    expect(Object.isFrozen(registry.entries[0])).toBe(true);
    expect(Object.isFrozen(registry.entries[0]!.entry)).toBe(true);
  });

  test("nothing in src/registry can write a file or reach the network", () => {
    const dir = join(ROOT, "src/registry");
    // Node built-ins and the names imported from each: node:fs gives readFileSync only.
    const allowed: Record<string, string[]> = { "node:crypto": ["createHash"], "node:fs": ["readFileSync"], "node:path": ["join"], "node:url": ["fileURLToPath"] };
    for (const f of readdirSync(dir)) {
      const code = readFileSync(join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      for (const [, names, from] of code.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g)) {
        if (from!.startsWith(".")) continue;
        expect(allowed[from!]).toBeDefined();
        for (const n of names!.split(",").map((s) => s.trim()).filter(Boolean)) expect(allowed[from!]).toContain(n);
      }
      expect(code).not.toMatch(/import\s+\*|import\s*\(|require\s*\(|\bBun\.|\bfetch\s*\(|\bprocess\.|\bDeno\./);
      // Relative imports are other read-only modules, never the filesystem helpers in hf/ or gguf/ that open files.
      for (const [, from] of code.matchAll(/from\s+"(\.[^"]+)"/g)) expect(["../diff.ts", "../gguf/templates.ts", "../hf/cache.ts", "../rules/finalize.ts", "../types.ts", "../whitespace.ts"]).toContain(from!);
    }
  });
});

describe("matching (ISC-24, ISC-24.2)", () => {
  const known = registry.entries.find((k) => k.entry.repo === "mlx-community/Qwen3-0.6B-4bit")!;

  test("ISC-24: an exact SHA-256 match is known-good", () => {
    const m = registry.match(tpl(known.text));
    expect(m.kind).toBe("exact");
    expect(registryStatus(m)).toBe("known-good");
  });

  test("ISC-24.2: CRLF, indentation and trailing newlines are known-good-variant", () => {
    const variants = [
      known.text.replaceAll("\n", "\r\n"),
      known.text.replace(/\n( *)/g, "\n$1  "),
      `${known.text}\n\n`,
      `\t${known.text.trimEnd()}`,
    ];
    for (const v of variants) {
      expect(v).not.toBe(known.text);
      const m = registry.match(tpl(v));
      expect(m.kind).toBe("whitespace");
      expect(registryStatus(m)).toBe("known-good-variant");
      if (m.kind === "whitespace") expect(m.known.text).toBe(known.text);
    }
  });

  test("a change to a non-whitespace run is no match: `do not` against `donot`", () => {
    const base = "{% if x %}do not{% endif %}";
    const reg = createRegistry([{ entry: { family: "f", repo: "o/r", revision: "a".repeat(40), path: "p", templateName: "default", sha256: sha(base) }, text: base }]);
    expect(reg.match(tpl("{% if x %}do  not{% endif %}\n")).kind).toBe("whitespace");
    expect(reg.match(tpl("{% if x %}donot{% endif %}")).kind).toBe("none");
    expect(reg.match(tpl("{% if x %}do not {% endif %}")).kind).toBe("none"); // splits a run boundary differently
    expect(registryStatus(reg.match(tpl("{% if x %}not do{% endif %}")))).toBeUndefined();
  });

  test("whitespace means ASCII whitespace: an inserted U+FEFF, U+00A0 or U+2028 is a real change", () => {
    for (const ch of ["﻿", " ", " ", "​"]) {
      expect(registry.match(tpl(known.text.replace(" ", ch))).kind).toBe("none");
      expect(registry.match(tpl(`${ch}${known.text}`)).kind).toBe("none");
    }
    expect(whitespaceKey(" a\t\tb \r\n c\n")).toBe(whitespaceKey("a b c"));
    expect(whitespaceKey("a\u00a0b")).not.toBe(whitespaceKey("a b"));
  });

  test("bytes that are not UTF-8 never match as a variant", () => {
    const bytes = new TextEncoder().encode(`${known.text}\n`);
    const t: ExtractedTemplate = { ...makeTemplate(src(), bytes), validUtf8: false };
    expect(registry.match(t).kind).toBe("none");
  });

  test("among entries with the same text, the template's own repo is preferred", () => {
    const shared = registry.entries.filter((k) => k.entry.sha256 === known.entry.sha256).map((k) => k.entry.repo);
    expect(new Set(shared).size).toBeGreaterThanOrEqual(3);
    for (const repo of shared) {
      const path = `/h/models--${repo.replace("/", "--")}/snapshots/${"b".repeat(40)}/tokenizer_config.json`;
      const m = registry.match(tpl(known.text, { kind: "tokenizer_config", path, realPath: path, name: "default", key: "chat_template" }));
      expect(m.kind === "exact" && m.known.entry.repo).toBe(repo);
    }
  });

  test("forRepo returns every entry pinned to a repo, any revision, ignoring case", () => {
    const e4b = registry.forRepo("mlx-community/gemma-4-e4b-it-4bit");
    expect(new Set(e4b.map((k) => k.entry.revision))).toEqual(new Set(["475b9088d29754a3379866cf5aeb6b41acd313c2", "deb1db712068b1c9f83fb1c97f08c1204b9459a1"]));
    expect(registry.forRepo("MLX-Community/Gemma-4-E4B-IT-4bit")).toEqual(e4b);
    expect(registry.forRepo("lmstudio-community/gemma-4-26B-A4B-it-QAT-MLX-4bit").map((k) => k.entry.path).sort()).toEqual(["chat_template.jinja", "tokenizer_config.json"]);
    expect(registry.forRepo("nobody/nothing")).toEqual([]);
  });

  test("GGUF entries match what the GGUF reader extracts", () => {
    const gguf = registry.entries.find((k) => k.entry.repo === "Qwen/Qwen3-0.6B-GGUF")!;
    const { bytes } = buildGguf([["general.architecture", str("qwen3")], ["tokenizer.chat_template", str(gguf.text)]]);
    const record = readGgufSource(bytesSource(bytes), "/m/x.gguf");
    expect(registry.match(record.templates[0]!).kind).toBe("exact");
  });
});

describe("ISC-24.1 probe: loading, matching and intra-model checks never change registry/", () => {
  // Every file under registry/, by content hash and mtime.
  function snapshot(dir: string, out = new Map<string, string>()): Map<string, string> {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) snapshot(path, out);
      else out.set(path, `${sha(readFileSync(path))} ${st.mtimeMs}`);
    }
    return out;
  }

  test("hashes and mtimes are identical before and after", async () => {
    const before = snapshot(REGISTRY_DIR);
    expect(before.size).toBeGreaterThan(20);

    const reg = loadRegistry();
    const table = loadPrecedence();
    const models = [await readHfModel(join(FIXTURES, "every-source"))];
    const { bytes } = buildGguf([["tokenizer.chat_template", str(reg.entries[0]!.text)], ["tokenizer.chat_template.tool_use", str("{{ x }}")]]);
    models.push(readGgufSource(bytesSource(bytes), "/m/x.gguf"));
    for (const m of models) {
      for (const t of m.templates) reg.match(t);
      resolveProfiles(m, table);
      checkIntraModel(m, table);
    }
    for (const k of reg.entries) {
      reg.match(tpl(k.text));
      reg.match(tpl(`${k.text}\n`));
      reg.forRepo(k.entry.repo);
    }

    expect(snapshot(REGISTRY_DIR)).toEqual(before);
  });
});
