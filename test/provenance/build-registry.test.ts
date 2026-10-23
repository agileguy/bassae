import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { collect, type Source } from "../../scripts/build-registry.ts";
import { UpstreamError } from "../../src/provenance/online.ts";
import { buildGguf, typicalKvs } from "../gguf/builder.ts";

// scripts/build-registry.ts builds the trust root through the same HubClient as --online (round-1 review).

const REV = "0123456789abcdef0123456789abcdef01234567";
const CDN = "https://cas-bridge.xethub.hf.co/blob";
const TEMPLATE = "{% for m in messages %}{{ m.content }}{% endfor %}";
const enc = (s: string) => new TextEncoder().encode(s);
const gitBlob = (b: Uint8Array) => createHash("sha1").update(`blob ${b.byteLength}\0`).update(b).digest("hex");
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const gguf = buildGguf(typicalKvs()).bytes;
const SOURCES: Source[] = [
  { family: "f", repo: "org/hf", revision: REV },
  { family: "f", repo: "org/gguf", revision: REV, gguf: ["m.gguf"] },
];

interface Hub {
  /** /api/models/<repo>/revision/<rev> fields, overriding a public, ungated pin. */
  info?: Record<string, unknown>;
  /** How the CDN answers a GGUF range request. */
  cdn?: (range: string | null) => Response;
}

function fakeHub(opts: Hub = {}) {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    const range = new Headers(init?.headers).get("range");
    if (url === CDN) return opts.cdn ? opts.cdn(range) : new Response(gguf, { status: 206, headers: { "content-range": `bytes 0-${gguf.length - 1}/${gguf.length}` } });
    const info = /^https:\/\/huggingface\.co\/api\/models\/(org\/\w+)\/revision\/(\w+)$/.exec(url);
    if (info) return Response.json({ id: info[1], sha: info[2], gated: false, private: false, ...opts.info });
    if (url === `https://huggingface.co/org/hf/resolve/${REV}/chat_template.jinja`) {
      const body = enc(TEMPLATE);
      return new Response(body, { status: 200, headers: { etag: `"${gitBlob(body)}"`, "x-repo-commit": REV } });
    }
    if (url === `https://huggingface.co/org/gguf/resolve/${REV}/m.gguf`) {
      return new Response("", { status: 302, headers: { location: CDN, "x-repo-commit": REV, "x-linked-etag": `"${sha256(gguf)}"`, "x-linked-size": String(gguf.length) } });
    }
    if (url.startsWith("https://huggingface.co/")) return new Response("Entry not found", { status: 404, headers: { "x-error-code": "EntryNotFound" } });
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  return { fetcher, requests };
}

const quiet = () => {};

describe("build-registry reads the hub through HubClient (round-1 review)", () => {
  test("entries come from the pinned HF sources and GGUF prefix, with no credentials and identity encoding", async () => {
    const { fetcher, requests } = fakeHub();
    const { entries, texts } = await collect(SOURCES, fetcher, quiet);
    expect(entries.map((e) => [e.repo, e.path, e.templateName])).toEqual([
      ["org/gguf", "m.gguf", "default"],
      ["org/gguf", "m.gguf", "tool_use"],
      ["org/hf", "chat_template.jinja", "default"],
    ]);
    expect(new TextDecoder().decode(texts.get(entries[2]!.sha256))).toBe(TEMPLATE);
    for (const { url, init } of requests) {
      const headers = new Headers(init?.headers);
      expect(headers.has("authorization")).toBe(false);
      expect(headers.get("accept-encoding")).toBe("identity");
      expect(init?.credentials).toBe("omit");
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (url.endsWith("m.gguf") || url === CDN) expect(headers.get("range")).toBe(`bytes=0-${8 * 1024 * 1024 - 1}`);
    }
  });

  test.each([
    ["a CDN that ignores the Range and sends the whole file", () => new Response(gguf, { status: 200 }), "not 206"],
    ["a Content-Range for other bytes", () => new Response(gguf.slice(0, 10), { status: 206, headers: { "content-range": `bytes 0-9/${gguf.length}` } }), "not the"],
    ["a size that disagrees with the hub's", () => new Response(gguf, { status: 206, headers: { "content-range": `bytes 0-${gguf.length - 1}/${gguf.length + 5}` } }), "Content-Range"],
  ] as [string, () => Response, string][])("%s is refused", async (_, cdn, why) => {
    const { fetcher } = fakeHub({ cdn });
    const e = await collect(SOURCES, fetcher, quiet).catch((e: unknown) => e);
    expect(e).toBeInstanceOf(UpstreamError);
    expect((e as Error).message).toContain(why);
  });

  test("a redirect off the hub is refused, never followed", async () => {
    const { fetcher: inner } = fakeHub();
    const requests: string[] = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(String(input));
      if (String(input).endsWith("/chat_template.jinja")) return new Response("", { status: 302, headers: { location: "https://evil.example/x" } });
      return inner(input, init);
    }) as typeof fetch;
    const e = await collect(SOURCES, fetcher, quiet).catch((e: unknown) => e);
    expect((e as Error).message).toContain("refusing a redirect");
    expect(requests.some((u) => u.includes("evil"))).toBe(false);
  });

  test.each([
    [{ gated: "auto" }, "gated or private"],
    [{ private: true }, "gated or private"],
    [{ sha: "f".repeat(40) }, "resolved to"],
  ])("a pin the hub reports as %p is refused", async (info, why) => {
    const { fetcher } = fakeHub({ info });
    await expect(collect(SOURCES, fetcher, quiet)).rejects.toThrow(why);
  });

  test("a file whose bytes do not match the hub's etag is refused", async () => {
    const { fetcher: inner } = fakeHub();
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).endsWith("/chat_template.jinja")) return inner(input, init);
      return new Response("{{ evil }}", { status: 200, headers: { etag: `"${gitBlob(enc(TEMPLATE))}"`, "x-repo-commit": REV } });
    }) as typeof fetch;
    await expect(collect(SOURCES, fetcher, quiet)).rejects.toThrow("etag");
  });
});
