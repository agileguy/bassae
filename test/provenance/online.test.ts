import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHfModel } from "../../src/hf/index.ts";
import { fetchUpstream, UpstreamError } from "../../src/provenance/index.ts";
import type { Baseline } from "../../src/types.ts";
import { recordedFetcher, setDir } from "./recorded.ts";

const QWEN = "Qwen/Qwen2.5-0.5B-Instruct";
const QWEN_REV = "7ae557604adf67be50417f59c2c2f167def9a775";
const REV = "0123456789abcdef0123456789abcdef01234567";
const SECRET = "hf_doNotSendThisTokenAnywhere0123456789";

const made: string[] = [];
let savedToken: string | undefined;
beforeAll(() => {
  // A token in the environment must never reach a request (ISC-41).
  savedToken = process.env.HF_TOKEN;
  process.env.HF_TOKEN = SECRET;
});
afterAll(() => {
  if (savedToken === undefined) delete process.env.HF_TOKEN;
  else process.env.HF_TOKEN = savedToken;
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const gitBlob = (b: Uint8Array) => createHash("sha1").update(`blob ${b.byteLength}\0`).update(b).digest("hex");
const enc = (s: string | Uint8Array) => (typeof s === "string" ? new TextEncoder().encode(s) : s);

/** What the local HF reader extracts from these files: the oracle for byte identity. */
async function localTemplates(files: Record<string, string | Uint8Array>) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "bassae-oracle-"));
  made.push(dir);
  for (const [path, body] of Object.entries(files)) {
    const parts = path.split("/");
    if (parts.length > 1) Bun.spawnSync(["mkdir", "-p", join(dir, ...parts.slice(0, -1))]);
    writeFileSync(join(dir, ...parts), enc(body));
  }
  return (await readHfModel(dir)).templates;
}

interface FakeOptions {
  /** Status and headers per resolve path, overriding the default 200. */
  override?: Record<string, { status: number; headers?: Record<string, string>; body?: string }>;
  listing?: unknown;
  listingHeaders?: Record<string, string>;
}

/** A huggingface.co stand-in serving `files` at REV the way the hub does: 404 EntryNotFound for anything absent, etag = git blob SHA-1. */
function fakeHub(repo: string, files: Record<string, string | Uint8Array>, opts: FakeOptions = {}) {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    const resolve = `https://huggingface.co/${repo}/resolve/${REV}/`;
    const tree = `https://huggingface.co/api/models/${repo}/tree/${REV}/additional_chat_templates`;
    if (url === tree) {
      if (opts.listing === undefined) return new Response("{}", { status: 404, headers: { "x-error-code": "EntryNotFound" } });
      return new Response(JSON.stringify(opts.listing), { status: 200, headers: opts.listingHeaders });
    }
    if (url.startsWith(resolve)) {
      const path = url.slice(resolve.length).split("/").map(decodeURIComponent).join("/");
      const o = opts.override?.[path];
      if (o) return new Response(o.body ?? "", { status: o.status, headers: o.headers });
      const body = files[path];
      if (body === undefined) return new Response("Entry not found", { status: 404, headers: { "x-error-code": "EntryNotFound" } });
      const bytes = enc(body);
      return new Response(bytes, { status: 200, headers: { etag: `"${gitBlob(bytes)}"`, "x-repo-commit": REV } });
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  return { fetcher, requests };
}

function expectNoCredentials(requests: { url: string; init?: RequestInit }[]) {
  expect(requests.length).toBeGreaterThan(0);
  for (const { url, init } of requests) {
    expect(url.startsWith("https://huggingface.co/")).toBe(true);
    const headers = new Headers(init?.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
    for (const [, v] of headers) expect(v).not.toContain(SECRET);
    expect(url).not.toContain(SECRET);
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("manual");
  }
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(UpstreamError);
    return e as Error;
  }
  throw new Error("expected a rejection");
}

const upstream = (b: Baseline) => {
  if (b.kind !== "upstream") throw new Error(`expected an upstream baseline, got ${b.kind}`);
  return b;
};

describe("recorded: Qwen/Qwen2.5-0.5B-Instruct@7ae5576 (ISC-41)", () => {
  const dir = setDir(QWEN, QWEN_REV);

  test("one upstream baseline, byte-identical to what the local reader extracts", async () => {
    const { fetcher, requests } = recordedFetcher(dir);
    const baselines = await fetchUpstream(QWEN, QWEN_REV, fetcher);
    expect(baselines).toHaveLength(1);
    const b = upstream(baselines[0]!);
    expect(b).toMatchObject({ kind: "upstream", repo: QWEN, revision: QWEN_REV, path: "tokenizer_config.json", templateName: "default" });

    // The recorded 200 body is tokenizer_config.json exactly; the hub's etag is its git blob hash.
    const body = readFileSync(join(dir, "01.body"));
    expect(gitBlob(body)).toBe("07bfe0640cb5a0037f9322287fbfc682806cf672");
    const [local] = await localTemplates({ "tokenizer_config.json": body });
    expect(b.text).toBe(local!.text);
    expect(createHash("sha256").update(b.text).digest("hex")).toBe(local!.sha256);
    expect(b.text).toStartWith("{%- if tools %}");

    expectNoCredentials(requests);
    // The resolve redirect was followed by hand, and every documented source was asked for.
    expect(requests.map((r) => r.url.replace(/\?.*$/, ""))).toEqual([
      `https://huggingface.co/${QWEN}/resolve/${QWEN_REV}/tokenizer_config.json`,
      `https://huggingface.co/api/resolve-cache/models/${QWEN}/${QWEN_REV}/tokenizer_config.json`,
      `https://huggingface.co/${QWEN}/resolve/${QWEN_REV}/chat_template.jinja`,
      `https://huggingface.co/${QWEN}/resolve/${QWEN_REV}/chat_template.json`,
      `https://huggingface.co/${QWEN}/resolve/${QWEN_REV}/processor_config.json`,
      `https://huggingface.co/api/models/${QWEN}/tree/${QWEN_REV}/additional_chat_templates`,
    ]);
  });

  test("an uppercase revision is the same pin", async () => {
    const { fetcher } = recordedFetcher(dir);
    const [b] = await fetchUpstream(QWEN, QWEN_REV.toUpperCase(), fetcher);
    expect(upstream(b!).revision).toBe(QWEN_REV);
  });

  test("the temp dir is removed afterwards", async () => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith("bassae-upstream-"));
    await fetchUpstream(QWEN, QWEN_REV, recordedFetcher(dir).fetcher);
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith("bassae-upstream-"))).toEqual(before);
  });
});

describe("validation before any URL is built", () => {
  test.each([
    ["../etc/passwd", REV],
    ["Qwen", REV],
    ["a/b/c", REV],
    ["-a/b", REV],
    ["a/..", REV],
    ["a/b?x=", REV],
    ["a/b#", REV],
    ["https://huggingface.co/a/b", REV],
    ["a/b", "main"],
    ["a/b", "v1.0"],
    ["a/b", REV.slice(0, 12)],
    ["a/b", `${REV}/../x`],
    ["a/b", `${REV}?x`],
  ])("%p @ %p is refused", async (repo, revision) => {
    const { fetcher, requests } = fakeHub("a/b", {});
    await rejection(fetchUpstream(repo, revision, fetcher));
    expect(requests).toHaveLength(0);
  });
});

describe("hub responses", () => {
  const TEMPLATE = "{% for m in messages %}{{ m.role }}: {{ m.content }}\r\n{% endfor %}— é ✓";

  test("every documented source becomes one baseline, in reader order, with exact text", async () => {
    const files = {
      "tokenizer_config.json": JSON.stringify({ chat_template: [{ name: "default", template: "A{{ x }}" }, { name: "rag", template: "B" }] }),
      "chat_template.jinja": TEMPLATE,
      "chat_template.json": JSON.stringify({ chat_template: "C" }),
      "processor_config.json": JSON.stringify({ chat_template: "D" }),
      "additional_chat_templates/tool_use.jinja": "E",
      "additional_chat_templates/a b.jinja": "F",
    };
    const listing = [
      { type: "file", path: "additional_chat_templates/tool_use.jinja", oid: "x", size: 1 },
      { type: "file", path: "additional_chat_templates/a b.jinja", oid: "x", size: 1 },
      { type: "file", path: "additional_chat_templates/README.md", oid: "x", size: 1 },
      { type: "directory", path: "additional_chat_templates/old", oid: "x", size: 0 },
    ];
    const { fetcher, requests } = fakeHub("org/model", files, { listing });
    const baselines = (await fetchUpstream("org/model", REV, fetcher)).map(upstream);
    const local = await localTemplates(files);
    expect(baselines.map((b) => [b.path, b.templateName, b.text])).toEqual(
      local.map((t) => [t.source.path.slice(t.source.path.indexOf("bassae-oracle-")).split("/").slice(1).join("/"), t.source.name, t.text]),
    );
    expect(baselines.map((b) => b.templateName)).toEqual(["default", "rag", "default", "default", "a b", "tool_use", "default"]);
    expect(baselines.find((b) => b.path === "chat_template.jinja")!.text).toBe(TEMPLATE);
    expect(requests.some((r) => r.url.endsWith("/additional_chat_templates/a%20b.jinja"))).toBe(true);
    expect(requests.some((r) => r.url.endsWith("README.md"))).toBe(false);
    expectNoCredentials(requests);
  });

  test("a repo with no template source gives no baselines", async () => {
    const { fetcher } = fakeHub("org/base", { "config.json": "{}" });
    expect(await fetchUpstream("org/base", REV, fetcher)).toEqual([]);
  });

  test.each([401, 403])("HTTP %p is a clear gated-or-private error", async (status) => {
    const { fetcher } = fakeHub("org/gated", {}, { override: { "tokenizer_config.json": { status, headers: { "x-error-code": status === 403 ? "GatedRepo" : "RepoNotFound" } } } });
    const e = await rejection(fetchUpstream("org/gated", REV, fetcher));
    expect(e.message).toContain("gated, private or missing");
    expect(e.message).toContain(String(status));
  });

  test.each(["RepoNotFound", "RevisionNotFound"])("a 404 %p is an error, not a missing file", async (code) => {
    const { fetcher } = fakeHub("org/x", {}, { override: { "tokenizer_config.json": { status: 404, headers: { "x-error-code": code } } } });
    expect((await rejection(fetchUpstream("org/x", REV, fetcher))).message).toContain(code);
  });

  test("a 5xx is an error", async () => {
    const { fetcher } = fakeHub("org/x", {}, { override: { "chat_template.jinja": { status: 502 } } });
    expect((await rejection(fetchUpstream("org/x", REV, fetcher))).message).toContain("HTTP 502");
  });

  test("content that does not match the hub's etag is refused", async () => {
    const { fetcher } = fakeHub("org/x", {}, { override: { "chat_template.jinja": { status: 200, body: "{{ evil }}", headers: { etag: `"${gitBlob(enc("{{ good }}"))}"` } } } });
    expect((await rejection(fetchUpstream("org/x", REV, fetcher))).message).toContain("etag");
  });

  test("a 64-hex linked etag is checked as SHA-256", async () => {
    const good = enc("{{ lfs }}");
    const sha = createHash("sha256").update(good).digest("hex");
    const ok = fakeHub("org/x", {}, { override: { "chat_template.jinja": { status: 200, body: "{{ lfs }}", headers: { "x-linked-etag": `"${sha}"` } } } });
    expect((await fetchUpstream("org/x", REV, ok.fetcher)).map(upstream).map((b) => b.text)).toEqual(["{{ lfs }}"]);
    const bad = fakeHub("org/x", {}, { override: { "chat_template.jinja": { status: 200, body: "{{ lfz }}", headers: { "x-linked-etag": `"${sha}"` } } } });
    await rejection(fetchUpstream("org/x", REV, bad.fetcher));
  });

  test("a response for another commit is refused", async () => {
    const { fetcher } = fakeHub("org/x", {}, { override: { "chat_template.jinja": { status: 200, body: "x", headers: { "x-repo-commit": "f".repeat(40) } } } });
    expect((await rejection(fetchUpstream("org/x", REV, fetcher))).message).toContain("not the pinned");
  });

  test("upstream files the reader cannot parse are an error, never a partial set", async () => {
    const { fetcher } = fakeHub("org/x", { "tokenizer_config.json": "{ not json", "chat_template.jinja": "ok" });
    expect((await rejection(fetchUpstream("org/x", REV, fetcher))).message).toContain("tokenizer_config.json");
  });

  test("a network failure is an UpstreamError", async () => {
    const fetcher = (async () => {
      throw new TypeError("connection refused");
    }) as unknown as typeof fetch;
    expect((await rejection(fetchUpstream("org/x", REV, fetcher))).message).toContain("connection refused");
  });
});

describe("redirects", () => {
  const redirectTo = (location: string) => ({ "chat_template.jinja": { status: 302, headers: { location } } });

  test.each([
    "https://evil.example/x",
    "http://huggingface.co/x",
    "https://huggingface.co.evil.example/x",
    "https://user:pw@cdn-lfs.huggingface.co/x",
    "file:///etc/passwd",
  ])("to %p is refused", async (location) => {
    const { fetcher, requests } = fakeHub("org/x", {}, { override: redirectTo(location) });
    expect((await rejection(fetchUpstream("org/x", REV, fetcher))).message).toContain("refusing a redirect");
    expect(requests.every((r) => r.url.startsWith("https://huggingface.co/"))).toBe(true);
  });

  test("to the hub's CDN is followed, and its etag is checked against the first hop", async () => {
    const body = enc("{{ cdn }}");
    const cdn = "https://cas-bridge.xethub.hf.co/blob?sig=1";
    const inner = fakeHub("org/x", {}, { override: { "chat_template.jinja": { status: 302, headers: { location: cdn, "x-linked-etag": `"${gitBlob(body)}"`, "x-repo-commit": REV } } } });
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input) === cdn ? new Response(body, { status: 200, headers: { etag: '"s3-etag-1"' } }) : inner.fetcher(input, init)) as typeof fetch;
    expect((await fetchUpstream("org/x", REV, fetcher)).map(upstream).map((b) => b.text)).toEqual(["{{ cdn }}"]);
  });

  test("a redirect loop stops", async () => {
    const self = `https://huggingface.co/org/x/resolve/${REV}/chat_template.jinja`;
    const { fetcher } = fakeHub("org/x", {}, { override: redirectTo(self) });
    expect((await rejection(fetchUpstream("org/x", REV, fetcher))).message).toContain("redirects");
  });
});

describe("caps and timeouts", () => {
  test("a declared length over the cap is refused before reading", async () => {
    const { fetcher } = fakeHub("org/x", {}, { override: { "chat_template.jinja": { status: 200, body: "x", headers: { "content-length": "999999" } } } });
    expect((await rejection(fetchUpstream("org/x", REV, fetcher, { maxBytes: 1000 }))).message).toContain("limit");
  });

  test("an undeclared body is cut off at the cap while it streams", async () => {
    let pulled = 0;
    const fetcher = (async (input: string | URL | Request) => {
      if (!String(input).endsWith("chat_template.jinja")) return new Response("", { status: 404, headers: { "x-error-code": "EntryNotFound" } });
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          pulled++;
          c.enqueue(new Uint8Array(1024)); // endless
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;
    expect((await rejection(fetchUpstream("org/x", REV, fetcher, { maxBytes: 64 * 1024 }))).message).toContain("limit");
    expect(pulled).toBeLessThan(200);
  });

  test("the budget across responses is capped too", async () => {
    const big = "x".repeat(600);
    const { fetcher } = fakeHub("org/x", { "chat_template.jinja": big, "tokenizer_config.json": JSON.stringify({ chat_template: big }) });
    await rejection(fetchUpstream("org/x", REV, fetcher, { maxTotalBytes: 1000 }));
  });

  test("a response that never comes times out", async () => {
    const fetcher = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const start = performance.now();
    expect((await rejection(fetchUpstream("org/x", REV, fetcher, { timeoutMs: 100 }))).message).toContain("100 ms");
    expect(performance.now() - start).toBeLessThan(2000);
  });

  test("a body that stalls times out", async () => {
    const fetcher = (async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), { status: 200 })) as unknown as typeof fetch;
    expect((await rejection(fetchUpstream("org/x", REV, fetcher, { timeoutMs: 100 }))).message).toContain("100 ms");
  });

  test("the request carries an abort signal", async () => {
    const { fetcher, requests } = fakeHub("org/x", { "chat_template.jinja": "x" });
    await fetchUpstream("org/x", REV, fetcher);
    for (const r of requests) expect(r.init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("additional_chat_templates listing", () => {
  test.each([
    "additional_chat_templates/../escape.jinja",
    "additional_chat_templates/sub/x.jinja",
    "additional_chat_templates/..",
    "other/x.jinja",
    "additional_chat_templates/a\\b.jinja",
  ])("an unexpected path %p is an error, never written", async (path) => {
    const { fetcher } = fakeHub("org/x", {}, { listing: [{ type: "file", path }] });
    expect((await rejection(fetchUpstream("org/x", REV, fetcher))).message).toContain("unexpected");
  });

  test("a paginated listing is refused rather than read partially", async () => {
    const { fetcher } = fakeHub("org/x", {}, { listing: [], listingHeaders: { link: `<https://huggingface.co/api/models/org/x/tree/${REV}/additional_chat_templates?cursor=abc>; rel="next"` } });
    expect((await rejection(fetchUpstream("org/x", REV, fetcher))).message).toContain("more than one page");
  });

  test("a listing that is not an array is an error", async () => {
    const { fetcher } = fakeHub("org/x", {}, { listing: { error: "x" } });
    await rejection(fetchUpstream("org/x", REV, fetcher));
  });
});

describe("network code stays in online.ts (ISC-36)", () => {
  test("no other source file reaches the network", () => {
    const src = join(import.meta.dir, "..", "..", "src");
    const network = /\bfetch\s*\(|=\s*fetch\b|globalThis\.fetch|Bun\.connect|Bun\.listen|WebSocket|from "node:(net|http|https|http2|tls|dgram)"/;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith(join("provenance", "online.ts")) && network.test(readFileSync(p, "utf8"))) offenders.push(p);
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
