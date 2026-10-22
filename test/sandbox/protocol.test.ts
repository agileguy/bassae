import { expect, test } from "bun:test";
import { decodeChild, encode } from "../../src/sandbox/protocol.ts";

test("encode writes one line per message", () => {
  const line = encode({ t: "res", result: { id: "a", ok: true, output: "x\ny" } });
  expect(line.endsWith("\n")).toBe(true);
  expect(line.slice(0, -1)).not.toContain("\n");
});

test("decodeChild round-trips ready and results", () => {
  expect(decodeChild('{"t":"ready"}')).toEqual({ t: "ready" });
  const ok = { t: "res", result: { id: "a", ok: true, output: "hi" } } as const;
  expect(decodeChild(encode(ok).trim())).toEqual(ok);
  const bad = { t: "res", result: { id: "b", ok: false, failure: "parse", message: "m" } } as const;
  expect(decodeChild(encode(bad).trim())).toEqual(bad);
});

test("decodeChild rejects malformed lines", () => {
  for (const line of ["", "nope", "[]", "null", '{"t":"res"}', '{"t":"res","result":{"id":1,"ok":true,"output":"x"}}']) {
    expect(decodeChild(line)).toBeUndefined();
  }
});

test("decodeChild drops extra fields", () => {
  const line = '{"t":"res","result":{"id":"a","ok":true,"output":"x","extra":1}}';
  expect(decodeChild(line)).toEqual({ t: "res", result: { id: "a", ok: true, output: "x" } });
});

test("the worker cannot claim failures only the parent can see", () => {
  for (const failure of ["timeout", "memory", "sandbox", "made_up"]) {
    const line = JSON.stringify({ t: "res", result: { id: "a", ok: false, failure, message: "m" } });
    expect(decodeChild(line)).toBeUndefined();
  }
});
