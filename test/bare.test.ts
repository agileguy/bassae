import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readBareTemplate } from "../src/bare.ts";
import { link, makeTree } from "./helpers/tree.ts";

test("ISC-39: a bare .jinja file becomes a one-template record", async () => {
  const body = "{% for m in messages %}{{ m.content }}{% endfor %}";
  const root = makeTree({ "evil.jinja": body, "via-link.jinja": link("evil.jinja") });
  const r = await readBareTemplate(join(root, "via-link.jinja"));
  expect(r.format).toBe("bare");
  expect(r.id).toBe(join(root, "evil.jinja"));
  expect(r.paths).toEqual([join(root, "via-link.jinja")]);
  expect(r.findings).toEqual([]);
  expect(r.hints).toEqual({});
  expect(r.specialTokens).toEqual([]);
  expect(r.templates).toHaveLength(1);
  const t = r.templates[0]!;
  expect(t.source).toEqual({ kind: "bare", path: join(root, "via-link.jinja"), realPath: join(root, "evil.jinja"), name: "default" });
  expect(t.text).toBe(body);
  expect(t.sha256).toBe(createHash("sha256").update(body).digest("hex"));
});

test("bytes are kept exactly, invalid UTF-8 included", async () => {
  const bytes = new Uint8Array([0x41, 0xc3, 0x28, 0x42]);
  const root = makeTree({ "t.jinja": bytes });
  const t = (await readBareTemplate(join(root, "t.jinja"))).templates[0]!;
  expect(t.bytes).toEqual(bytes);
  expect(t.validUtf8).toBe(false);
});

test("an unreadable path is a finding, not a throw", async () => {
  const root = makeTree({ dir: {} });
  for (const p of [join(root, "missing.jinja"), join(root, "dir")]) {
    const r = await readBareTemplate(p);
    expect(r.templates).toEqual([]);
    expect(r.findings.map((f) => [f.ruleId, f.file])).toEqual([["scanner_error", p]]);
  }
});
