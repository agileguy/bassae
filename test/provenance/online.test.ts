import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHfModel } from "../../src/hf/index.ts";
import { gzipSync } from "node:zlib";
import { fetchUpstream, UpstreamError } from "../../src/provenance/index.ts";
import { HubClient } from "../../src/provenance/online.ts";
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
  /** Status and headers per resolve path, overriding the default 200. A 200 keeps the hub's commit and etag headers unless `bare`. */
  override?: Record<string, { status: number; headers?: Record<string, string>; body?: string | Uint8Array; bare?: boolean }>;
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
      if (o) {
        const bytes = enc(o.body ?? "");
        const hub = o.status === 200 && !o.bare ? hubHeaders(bytes) : {};
        return new Response(bytes, { status: o.status, headers: { ...hub, ...o.headers } });
      }
      const body = files[path];
      if (body === undefined) return new Response("Entry not found", { status: 404, headers: { "x-error-code": "EntryNotFound" } });
      const bytes = enc(body);
      return new Response(bytes, { status: 200, headers: hubHeaders(bytes) });
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  return { fetcher, requests };
}

/** What the hub sends with a file it serves directly: the commit, and the git blob hash as etag. */
const hubHeaders = (bytes: Uint8Array): Record<string, string> => ({ etag: `"${gitBlob(bytes)}"`, "x-repo-commit": REV });

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
    // Bodies as sent, never decompressed (round-1 review).
    expect(headers.get("accept-encoding")).toBe("identity");
    expect((init as { decompress?: boolean }).decompress).toBe(false);
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

  test("the hub states the commit and the etag on the first hop, so the fail-closed checks pass on real responses", () => {
    const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as { status: number; headers: Record<string, string> }[];
    expect(index[0]).toMatchObject({ status: 307, headers: { "x-repo-commit": QWEN_REV, "x-linked-etag": '"07bfe0640cb5a0037f9322287fbfc682806cf672"' } });
    // Every absent source is a first-hop 404 EntryNotFound.
    for (const r of index.filter((r) => r.status === 404)) expect(r.headers["x-error-code"]).toBe("EntryNotFound");
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
      return new Response(stream, { status: 200, headers: hubHeaders(enc("")) });
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
    const fetcher = (async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), { status: 200, headers: hubHeaders(enc("")) })) as unknown as typeof fetch;
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

describe("fails closed (round-1 review)", () => {
  test.each([
    ["no commit", { etag: `"${gitBlob(enc("x"))}"` }, "no x-repo-commit"],
    ["no etag", { "x-repo-commit": REV }, "did not state the file's etag"],
    ["an etag that is no hash", { "x-repo-commit": REV, etag: '"s3-etag-1"' }, "neither a git blob SHA-1 nor a SHA-256"],
    ["a weak etag that is no hash", { "x-repo-commit": REV, etag: 'W/"f-mY2VvLxuxB7KhsoOdQTlMTccuAQ"' }, "neither a git blob SHA-1 nor a SHA-256"],
  ])("a file served with %s is an error, not an unchecked file", async (_, headers, why) => {
    const { fetcher } = fakeHub("org/x", {}, { override: { "chat_template.jinja": { status: 200, body: "x", headers, bare: true } } });
    expect((await rejection(fetchUpstream("org/x", REV, fetcher))).message).toContain(why);
  });

  test("a later hop that states another commit is refused", async () => {
    const cdn = "https://cdn-lfs.huggingface.co/blob";
    const body = enc("{{ x }}");
    const inner = fakeHub("org/x", {}, { override: { "chat_template.jinja": { status: 302, headers: { location: cdn, "x-repo-commit": REV, "x-linked-etag": `"${gitBlob(body)}"` } } } });
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input) === cdn ? new Response(body, { status: 200, headers: { "x-repo-commit": "f".repeat(40) } }) : inner.fetcher(input, init)) as typeof fetch;
    expect((await rejection(fetchUpstream("org/x", REV, fetcher))).message).toContain("not the pinned");
  });

  test("a 404 means absent only from the hub on the first hop with EntryNotFound; a bare 404 or one after a redirect is an error", async () => {
    const cdn = "https://cdn-lfs.huggingface.co/blob";
    const redirect = { status: 302, headers: { location: cdn, "x-repo-commit": REV, "x-linked-etag": `"${gitBlob(enc("x"))}"` } };
    const cases: [string, typeof fetch][] = [
      ["bare 404 on the first hop", fakeHub("org/x", {}, { override: { "chat_template.jinja": { status: 404 } } }).fetcher],
      ["404 with another error code", fakeHub("org/x", {}, { override: { "chat_template.jinja": { status: 404, headers: { "x-error-code": "SomethingElse" } } } }).fetcher],
      ...(["", "EntryNotFound"].map((code) => {
        const inner = fakeHub("org/x", {}, { override: { "chat_template.jinja": redirect } });
        const fetcher = (async (input: string | URL | Request, init?: RequestInit) =>
          String(input) === cdn ? new Response("nope", { status: 404, headers: code ? { "x-error-code": code } : {} }) : inner.fetcher(input, init)) as typeof fetch;
        return [`404 ${code || "bare"} from the CDN after a redirect`, fetcher] as [string, typeof fetch];
      })),
      [
        "bare 404 for the listing",
        (async (input: string | URL | Request, init?: RequestInit) =>
          String(input).includes("/api/models/") ? new Response("", { status: 404 }) : fakeHub("org/x", {}).fetcher(input, init)) as typeof fetch,
      ],
    ];
    for (const [label, fetcher] of cases) {
      const e = await rejection(fetchUpstream("org/x", REV, fetcher));
      expect([label, e.message]).toEqual([label, expect.stringContaining("HTTP 404")]);
    }
  });

  test("a compressed body is refused before it is read; identity is accepted", async () => {
    const template = enc("{{ x }}");
    const gz = gzipSync(template);
    for (const encoding of ["gzip", "br", "deflate", "GZIP ", "identity, gzip"]) {
      const { fetcher } = fakeHub("org/x", {}, { override: { "chat_template.jinja": { status: 200, body: gz, headers: { "content-encoding": encoding, etag: `"${gitBlob(template)}"` } } } });
      expect((await rejection(fetchUpstream("org/x", REV, fetcher))).message).toContain("refusing Content-Encoding");
    }
    const { fetcher, requests } = fakeHub("org/x", {}, { override: { "chat_template.jinja": { status: 200, body: template, headers: { "content-encoding": "identity" } } } });
    expect((await fetchUpstream("org/x", REV, fetcher)).map(upstream).map((b) => b.text)).toEqual(["{{ x }}"]);
    expectNoCredentials(requests);
  });

  test("a gzip bomb through Bun's own fetch is refused before its body is read, without inflating", async () => {
    // 256 MiB of zeros in ~256 KiB of gzip, sent whatever the request asked for.
    const bomb = gzipSync(new Uint8Array(256 * 1024 * 1024), { level: 9 });
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        seen.push(req.headers.get("accept-encoding") ?? "");
        if (!new URL(req.url).pathname.endsWith("/tokenizer_config.json")) return new Response("", { status: 404, headers: { "x-error-code": "EntryNotFound" } });
        return new Response(bomb, { headers: { "content-encoding": "gzip", "x-repo-commit": REV, etag: `"${"0".repeat(40)}"` } });
      },
    });
    try {
      const local = ((input: string | URL | Request, init?: RequestInit) => fetch(String(input).replace("https://huggingface.co", `http://127.0.0.1:${server.port}`), init)) as typeof fetch;
      const before = process.memoryUsage().rss;
      expect((await rejection(fetchUpstream("org/x", REV, local))).message).toContain('refusing Content-Encoding "gzip"');
      expect(process.memoryUsage().rss - before).toBeLessThan(128 * 1024 * 1024);
      expect(seen[0]).toBe("identity");
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("additional templates whose names collide on a case-insensitive disk, or are too long for one, are read: nothing is written", async () => {
    const long = `${"a".repeat(300)}.jinja`;
    const files = { "additional_chat_templates/A.jinja": "upper", "additional_chat_templates/a.jinja": "lower", [`additional_chat_templates/${long}`]: "long" };
    const listing = Object.keys(files).map((path) => ({ type: "file", path }));
    const { fetcher } = fakeHub("org/x", files, { listing });
    const got = (await fetchUpstream("org/x", REV, fetcher)).map(upstream).map((b) => [b.path, b.templateName, b.text]);
    expect(got).toEqual([
      ["additional_chat_templates/A.jinja", "A", "upper"],
      ["additional_chat_templates/a.jinja", "a", "lower"],
      [`additional_chat_templates/${long}`, "a".repeat(300), "long"],
    ]);
  });

  test("a listed template the hub then says is absent is an error", async () => {
    const { fetcher } = fakeHub("org/x", {}, { listing: [{ type: "file", path: "additional_chat_templates/gone.jinja" }] });
    expect((await rejection(fetchUpstream("org/x", REV, fetcher))).message).toContain("listed but not found");
  });

  test("online.ts touches no filesystem, so fetched bytes can never land under a scanned path (ISC-35)", () => {
    const text = readFileSync(join(import.meta.dir, "..", "..", "src", "provenance", "online.ts"), "utf8");
    expect(text).not.toMatch(/from "node:(fs|fs\/promises|os)"|Bun\.(write|file)\(|readHfModel/);
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith("bassae-upstream-"))).toEqual([]);
  });
});

describe("in-memory extraction matches the HF readers on the same files", () => {
  const ok: [string, Record<string, string | Uint8Array>][] = [
    ["a template list", { "tokenizer_config.json": JSON.stringify({ chat_template: [{ name: "default", template: "A" }, { name: "tool_use", template: "B" }] }) }],
    ["null and absent chat_template", { "tokenizer_config.json": JSON.stringify({ chat_template: null }), "processor_config.json": "{}" }],
    ["bare NaN, as Python's json.load accepts", { "tokenizer_config.json": '{"model_max_length": NaN, "chat_template": "N"}' }],
    ["a lone surrogate escape", { "chat_template.json": '{"chat_template": "x\\ud800y"}' }],
    ["a .jinja that is not UTF-8", { "chat_template.jinja": new Uint8Array([0x7b, 0x7b, 0xff, 0x7d, 0x7d]) }],
    ["an empty list", { "tokenizer_config.json": JSON.stringify({ chat_template: [] }) }],
  ];
  test.each(ok)("%s: the same templates, byte for byte", async (_, files) => {
    const local = await localTemplates(files);
    const { fetcher } = fakeHub("org/x", files);
    const hub = new HubClient(fetcher);
    const { upstreamTemplates } = await import("../../src/provenance/online.ts");
    const remote = await upstreamTemplates(hub, "org/x", REV);
    const shape = (t: (typeof local)[number], path: string) => [path, t.source.kind, t.source.name, t.source.key, t.sha256, t.validUtf8, t.text];
    expect(remote.map((t) => shape(t, t.source.path))).toEqual(local.map((t) => shape(t, t.source.path.slice(t.source.path.indexOf("bassae-oracle-")).split("/").slice(1).join("/"))));
  });

  const bad: [string, Record<string, string | Uint8Array>][] = [
    ["not JSON", { "tokenizer_config.json": "{ nope" }],
    ["a JSON array", { "chat_template.json": "[]" }],
    ["a byte order mark", { "tokenizer_config.json": "\ufeff{}" }],
    ["invalid UTF-8 in JSON", { "processor_config.json": new Uint8Array([0x7b, 0xff, 0x7d]) }],
    ["a numeric chat_template", { "tokenizer_config.json": JSON.stringify({ chat_template: 3 }) }],
    ["a list entry without a name", { "tokenizer_config.json": JSON.stringify({ chat_template: [{ template: "A" }] }) }],
  ];
  test.each(bad)("%s: the readers record a problem, and the fetch fails", async (_, files) => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "bassae-oracle-"));
    made.push(dir);
    for (const [path, body] of Object.entries(files)) writeFileSync(join(dir, path), enc(body));
    const record = await readHfModel(dir);
    expect(record.extractionComplete && record.findings.length === 0).toBe(false);
    const { fetcher } = fakeHub("org/x", files);
    expect((await rejection(fetchUpstream("org/x", REV, fetcher))).message).toContain(Object.keys(files)[0]!);
  });
});

describe("HubClient.range, for GGUF prefixes", () => {
  const SIZE = 10_000;
  const blob = new Uint8Array(SIZE).map((_, i) => i % 251);
  /** The hub's LFS answer: a redirect stating commit, etag and size, then the CDN's 206. */
  function lfs(cdnAnswer: (range: string | null) => Response, first: Record<string, string> = {}) {
    const cdn = "https://cas-bridge.xethub.hf.co/blob";
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (String(input) === cdn) return cdnAnswer(new Headers(init?.headers).get("range"));
      return new Response("", { status: 302, headers: { location: cdn, "x-repo-commit": REV, "x-linked-size": String(SIZE), "x-linked-etag": `"${"a".repeat(64)}"`, ...first } });
    }) as typeof fetch;
    return { fetcher, requests };
  }
  const partial = (from: number, to: number, size = SIZE, extra: Record<string, string> = {}) =>
    new Response(blob.slice(from, to + 1), { status: 206, headers: { "content-range": `bytes ${from}-${to}/${size}`, ...extra } });

  test("a 206 with the asked-for Content-Range gives the prefix and the full size; the Range goes to every hop", async () => {
    const { fetcher, requests } = lfs((range) => (range === "bytes=0-999" ? partial(0, 999) : new Response("", { status: 400 })));
    const got = await new HubClient(fetcher).range("org/x", REV, "m.gguf", 1000);
    expect(got.size).toBe(SIZE);
    expect(got.bytes).toEqual(blob.slice(0, 1000));
    expect(requests.map((r) => new Headers(r.init?.headers).get("range"))).toEqual(["bytes=0-999", "bytes=0-999"]);
    expectNoCredentials(requests.filter((r) => r.url.startsWith("https://huggingface.co/")));
  });

  test("a file shorter than the range gives the whole file", async () => {
    const { fetcher } = lfs(() => partial(0, SIZE - 1));
    expect((await new HubClient(fetcher).range("org/x", REV, "m.gguf", 50_000)).bytes).toEqual(blob);
  });

  test.each([
    ["a 200 that ignores the Range", () => new Response(blob, { status: 200 }), {}, "not 206"],
    ["no Content-Range", () => new Response(blob.slice(0, 1000), { status: 206 }), {}, "Content-Range"],
    ["a Content-Range for other bytes", () => partial(0, 499), {}, "not the 1000 bytes asked for"],
    ["a Content-Range not from the start", () => partial(500, 1499), {}, "Content-Range"],
    ["a size that disagrees with the linked size", () => partial(0, 999, SIZE + 1), {}, "linked size"],
    ["a short body", () => new Response(blob.slice(0, 10), { status: 206, headers: { "content-range": `bytes 0-999/${SIZE}` } }), {}, "not the 1000"],
    ["no commit", () => partial(0, 999), { "x-repo-commit": "" }, "no x-repo-commit"],
    ["another commit", () => partial(0, 999), { "x-repo-commit": "f".repeat(40) }, "not the pinned"],
    ["a compressed body", () => partial(0, 999, SIZE, { "content-encoding": "gzip" }), {}, "Content-Encoding"],
  ] as [string, () => Response, Record<string, string>, string][])("%s is an error", async (_, answer, first, why) => {
    const { fetcher } = lfs(answer, first);
    const e = await rejection(new HubClient(fetcher).range("org/x", REV, "m.gguf", 1000));
    expect(e.message).toContain(why);
  });

  test("a body past the asked-for bytes is cut off at the cap", async () => {
    const { fetcher } = lfs(() => new Response(blob, { status: 206, headers: { "content-range": `bytes 0-999/${SIZE}` } }));
    expect((await rejection(new HubClient(fetcher).range("org/x", REV, "m.gguf", 1000))).message).toContain("limit");
  });

  test("json() reads only hub API paths", async () => {
    const { fetcher, requests } = fakeHub("org/x", {});
    await rejection(new HubClient(fetcher).json("https://evil.example/api/x"));
    await rejection(new HubClient(fetcher).json("//evil.example/api/x"));
    expect(requests).toHaveLength(0);
  });
});

describe("network code stays in online.ts (ISC-36)", () => {
  test("no other source file or script reaches the network; build-registry goes through HubClient", () => {
    const root = join(import.meta.dir, "..", "..");
    const network = /\bfetch\s*\(|=\s*fetch\b|globalThis\.fetch|Bun\.connect|Bun\.listen|WebSocket|from "node:(net|http|https|http2|tls|dgram)"/;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith(join("provenance", "online.ts")) && network.test(readFileSync(p, "utf8"))) offenders.push(p);
      }
    };
    walk(join(root, "src"));
    walk(join(root, "scripts"));
    expect(offenders).toEqual([]);
    expect(readFileSync(join(root, "scripts", "build-registry.ts"), "utf8")).toContain('from "../src/provenance/online.ts"');
  });
});
