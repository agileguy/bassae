import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGgufModel } from "../../src/gguf/index.ts";
import { readHfModel } from "../../src/hf/index.ts";
import { checkLocalTamper } from "../../src/provenance/tamper.ts";
import { checkLocalTamper as fromIndex } from "../../src/provenance/index.ts";
import type { Finding } from "../../src/types.ts";
import { buildGguf, str } from "../gguf/builder.ts";

// The fixture trees' blob names and metadata etags were computed with `git hash-object`
// and `shasum -a 256`, independently of the code under test.
const FIXTURES = join(import.meta.dir, "fixtures");
const REV = "0123456789abcdef0123456789abcdef01234567";
const SHARED_REV = "89abcdef0123456789abcdef0123456789abcdef";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A fresh copy of a fixture tree, links kept as links. */
function copyOf(name: string): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "bassae-tamper-"));
  made.push(root);
  cpSync(join(FIXTURES, name), join(root, name), { recursive: true, verbatimSymlinks: true });
  return join(root, name);
}

/** Flips one bit of one byte, through any links. */
function flip(path: string, at = 0): void {
  const real = realpathSync(path);
  const bytes = readFileSync(real);
  bytes[at] = bytes[at]! ^ 0x01;
  writeFileSync(real, bytes);
}

/** SHA-256 and mtime of every real file under `root`, links followed, plus each entry's path: a scan must change none of it. */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const l = lstatSync(path);
      if (l.isDirectory()) walk(path);
      else {
        const s = statSync(path);
        out.set(path, `${createHash("sha256").update(readFileSync(path)).digest("hex")} ${s.mtimeMs} ${l.mtimeMs}`);
      }
    }
  };
  walk(root);
  return out;
}

const tamperFindings = (fs: Finding[]) => fs.filter((f) => f.ruleId === "local_tamper");

describe("hf cache blobs (ISC-40)", () => {
  test("an intact copy gives nothing; one flipped byte gives HIGH local_tamper", async () => {
    const cache = copyOf("hf-cache");
    const snap = join(cache, "models--acme--tiny-chat", "snapshots", REV);
    const model = await readHfModel(snap);
    expect(model.templates.length).toBeGreaterThan(0);
    expect(await checkLocalTamper(model)).toEqual([]);

    flip(join(snap, "tokenizer_config.json"), 10);
    const findings = await checkLocalTamper(model);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f).toMatchObject({ ruleId: "local_tamper", severity: "HIGH", file: join(snap, "tokenizer_config.json") });
    expect(f.detail).toMatchObject({ record: "hf-cache-blob", algorithm: "git-blob-sha1", expected: "086aadb7bdcdfd4284338a1dd4d88d73b3778a76" });
    expect(f.detail!.actual).not.toBe(f.detail!.expected);
  });

  test("index.ts exports the same check", () => {
    expect(fromIndex).toBe(checkLocalTamper);
  });

  test("a 64-hex blob name is checked as SHA-256 (LFS)", async () => {
    const cache = copyOf("hf-cache");
    const snap = join(cache, "models--acme--tiny-chat", "snapshots", REV);
    flip(join(snap, "tokenizer.json"), 3);
    const findings = await checkLocalTamper(await readHfModel(snap));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail).toMatchObject({ algorithm: "sha256", expected: "4fb6d9fdea4b7dd6eea5eaede261391b22f9393fe76ea30de2f5efb0061a277b" });
  });

  test("additional_chat_templates/*.jinja and chat_template.jinja are covered", async () => {
    const cache = copyOf("hf-cache");
    const snap = join(cache, "models--acme--tiny-chat", "snapshots", REV);
    flip(join(snap, "additional_chat_templates", "tool_use.jinja"));
    flip(join(snap, "chat_template.jinja"));
    const files = tamperFindings(await checkLocalTamper(await readHfModel(snap))).map((f) => f.file);
    expect(files.sort()).toEqual([join(snap, "additional_chat_templates", "tool_use.jinja"), join(snap, "chat_template.jinja")]);
  });

  test("shared blob store: the name comes from the snapshot link's first hop, never the realpath", async () => {
    const cache = copyOf("hf-cache");
    const snap = join(cache, "models--acme--shared-chat", "snapshots", SHARED_REV);
    // The realpath is <cache>/blobs/5e/<xet hash>, which is not the content's hash; an intact file must still pass.
    expect(realpathSync(join(snap, "chat_template.jinja"))).toEndWith(join("blobs", "5e", "5e1f0000000000000000000000000000000000000000000000000000000000aa"));
    const model = await readHfModel(snap);
    expect(await checkLocalTamper(model)).toEqual([]);
    flip(join(snap, "chat_template.jinja"));
    const findings = await checkLocalTamper(model);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail).toMatchObject({ algorithm: "sha256", expected: "4f05b98fc0a9dde9a39d4b6e17f3bf427b1eea5b95776755fd5d05cda72a3b35" });
  });

  test("a model reached through a directory link resolves blob links against the real directory", async () => {
    const cache = copyOf("hf-cache");
    const snap = join(cache, "models--acme--tiny-chat", "snapshots", REV);
    const linked = join(cache, "..", "served-model");
    symlinkSync(snap, linked);
    const model = await readHfModel(linked);
    expect(model.paths).toEqual([linked]);
    expect(await checkLocalTamper(model)).toEqual([]);
    flip(join(snap, "tokenizer_config.json"));
    expect(tamperFindings(await checkLocalTamper(model))).toHaveLength(1);
  });

  test("weights are hashed only with hashAll", async () => {
    const cache = copyOf("hf-cache");
    const snap = join(cache, "models--acme--tiny-chat", "snapshots", REV);
    flip(join(snap, "model.safetensors"));
    const model = await readHfModel(snap);
    expect(await checkLocalTamper(model)).toEqual([]);
    const all = await checkLocalTamper(model, { hashAll: true });
    expect(all).toHaveLength(1);
    expect(all[0]!.file).toBe(join(snap, "model.safetensors"));
  });

  test("a GGUF in the cache is hashed only with hashAll", async () => {
    const root = copyOf("hf-cache");
    const repo = join(root, "models--acme--tiny-GGUF");
    const gguf = buildGguf([["tokenizer.chat_template", str("{{ messages[0].content }}")]]).bytes;
    const sha = createHash("sha256").update(gguf).digest("hex");
    const snap = join(repo, "snapshots", REV);
    mkdirSync(snap, { recursive: true });
    mkdirSync(join(repo, "blobs"));
    writeFileSync(join(repo, "blobs", sha), gguf);
    symlinkSync(`../../blobs/${sha}`, join(snap, "tiny.gguf"));
    const model = await readGgufModel(join(snap, "tiny.gguf"));
    expect(await checkLocalTamper(model, { hashAll: true })).toEqual([]);
    flip(join(snap, "tiny.gguf"), gguf.length - 2);
    expect(await checkLocalTamper(model)).toEqual([]);
    const all = await checkLocalTamper(model, { hashAll: true });
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ ruleId: "local_tamper", severity: "HIGH", detail: { algorithm: "sha256", expected: sha } });
  });

  test("the check opens files read-only and writes nothing", async () => {
    const cache = copyOf("hf-cache");
    const snap = join(cache, "models--acme--tiny-chat", "snapshots", REV);
    flip(join(snap, "tokenizer_config.json"));
    const before = snapshot(cache);
    await checkLocalTamper(await readHfModel(snap), { hashAll: true });
    expect(snapshot(cache)).toEqual(before);
  });
});

describe("local_dir download metadata (ISC-40)", () => {
  test("an intact copy gives nothing; one flipped byte gives HIGH local_tamper citing the record", async () => {
    const dir = copyOf("local-dir");
    const model = await readHfModel(dir);
    expect(await checkLocalTamper(model)).toEqual([]);
    flip(join(dir, "chat_template.jinja"), 5);
    const findings = await checkLocalTamper(model);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleId: "local_tamper", severity: "HIGH", file: join(dir, "chat_template.jinja") });
    expect(findings[0]!.detail).toMatchObject({
      record: "download-metadata",
      recordPath: join(dir, ".cache", "huggingface", "download", "chat_template.jinja.metadata"),
      algorithm: "git-blob-sha1",
      commit: "7ae557604adf67be50417f59c2c2f167def9a775",
    });
  });

  test("records for nested paths are found under the local_dir root", async () => {
    const dir = copyOf("local-dir");
    flip(join(dir, "additional_chat_templates", "tool_use.jinja"));
    const findings = await checkLocalTamper(await readHfModel(dir));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail!.recordPath).toBe(join(dir, ".cache", "huggingface", "download", "additional_chat_templates", "tool_use.jinja.metadata"));
  });

  test("a model in a subfolder of a local_dir finds the root's records", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "bassae-tamper-"));
    made.push(root);
    const local = join(root, "dl");
    cpSync(join(FIXTURES, "local-dir", ".cache"), join(local, ".cache"), { recursive: true });
    const sub = join(local, "sub");
    cpSync(join(FIXTURES, "local-dir", "chat_template.jinja"), join(sub, "chat_template.jinja"));
    const meta = readFileSync(join(local, ".cache", "huggingface", "download", "chat_template.jinja.metadata"));
    mkdirSync(join(local, ".cache", "huggingface", "download", "sub"));
    writeFileSync(join(local, ".cache", "huggingface", "download", "sub", "chat_template.jinja.metadata"), meta);
    const model = await readHfModel(sub);
    expect(await checkLocalTamper(model)).toEqual([]);
    flip(join(sub, "chat_template.jinja"));
    expect(tamperFindings(await checkLocalTamper(model))).toHaveLength(1);
  });

  test("an unreadable record is a MEDIUM scanner_error, never a tamper finding", async () => {
    const dir = copyOf("local-dir");
    writeFileSync(join(dir, ".cache", "huggingface", "download", "tokenizer_config.json.metadata"), "garbage\n");
    const findings = await checkLocalTamper(await readHfModel(dir));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleId: "scanner_error", severity: "MEDIUM", file: join(dir, "tokenizer_config.json") });
  });

  test("an etag that is not a content hash is not checked", async () => {
    const dir = copyOf("local-dir");
    writeFileSync(join(dir, ".cache", "huggingface", "download", "chat_template.jinja.metadata"), `${"a".repeat(40)}\nnot-a-hash\n1761177600.5\n`);
    flip(join(dir, "chat_template.jinja"));
    expect(await checkLocalTamper(await readHfModel(dir))).toEqual([]);
  });

  test("a plain directory with no records gives nothing", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "bassae-tamper-"));
    made.push(root);
    writeFileSync(join(root, "chat_template.jinja"), "{{ messages }}");
    expect(await checkLocalTamper(await readHfModel(root))).toEqual([]);
  });
});
