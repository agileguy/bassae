import { expect, test } from "bun:test";
import { clip, decodeChild, encode, MESSAGE_KEEP, TRUNCATED } from "../../src/sandbox/protocol.ts";

test("encode writes one line per message", () => {
  const line = encode({ t: "res", result: { id: "a", ok: true, output: "x\ny" } });
  expect(line.endsWith("\n")).toBe(true);
  expect(line.slice(0, -1)).not.toContain("\n");
});

test("decodeChild round-trips ready, parsed and results", () => {
  expect(decodeChild('{"t":"ready"}')).toEqual({ t: "ready" });
  expect(decodeChild('{"t":"parsed"}')).toEqual({ t: "parsed" });
  const ok = { t: "res", result: { id: "a", ok: true, output: "hi" } } as const;
  expect(decodeChild(encode(ok).trim())).toEqual(ok);
  const bad = { t: "res", result: { id: "b", ok: false, failure: "parse", message: "m" } } as const;
  expect(decodeChild(encode(bad).trim())).toEqual(bad);
  const stack = { t: "res", result: { id: "c", ok: false, failure: "stack", message: "m" } } as const;
  expect(decodeChild(encode(stack).trim())).toEqual(stack);
});

test("decodeChild rejects malformed lines", () => {
  for (const line of ["", "nope", "[]", "null", '{"t":"res"}', '{"t":"res","result":{"id":1,"ok":true,"output":"x"}}']) {
    expect(decodeChild(line)).toBeUndefined();
  }
});

test("decodeChild drops extra fields", () => {
  const line = '{"t":"res","result":{"id":"a","ok":true,"output":"x","extra":1}}';
  expect(decodeChild(line)).toEqual({ t: "res", result: { id: "a", ok: true, output: "x" } });
  expect(decodeChild(`{"t":"parsed","pad":"${"x".repeat(100)}"}`)).toEqual({ t: "parsed" });
});

test("the worker cannot claim failures only the parent can see", () => {
  for (const failure of ["timeout", "memory", "sandbox", "made_up"]) {
    const line = JSON.stringify({ t: "res", result: { id: "a", ok: false, failure, message: "m" } });
    expect(decodeChild(line)).toBeUndefined();
  }
});

test("clip keeps short messages and cuts long ones at about 4 KiB, ending in a marker", () => {
  expect(clip("short")).toBe("short");
  expect(clip("x".repeat(MESSAGE_KEEP))).toBe("x".repeat(MESSAGE_KEEP));
  const long = clip("x".repeat(2 ** 21));
  expect(long).toBe("x".repeat(MESSAGE_KEEP) + TRUNCATED);
  expect(MESSAGE_KEEP).toBe(4096);
});

test("clip never splits a surrogate pair", () => {
  const clipped = clip("x".repeat(MESSAGE_KEEP - 1) + "\u{1f600}".repeat(10));
  expect(clipped).toBe("x".repeat(MESSAGE_KEEP - 1) + TRUNCATED);
  expect(clipped.isWellFormed()).toBe(true);
});

test("decodeChild caps a failure message from the worker, however long", () => {
  const line = JSON.stringify({ t: "res", result: { id: "a", ok: false, failure: "render_error", message: "y".repeat(3_000_000) } });
  expect(decodeChild(line)).toEqual({ t: "res", result: { id: "a", ok: false, failure: "render_error", message: "y".repeat(MESSAGE_KEEP) + TRUNCATED } });
});
