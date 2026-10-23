import { expect, test } from "bun:test";
import { clip, decodeChild, encode, MESSAGE_KEEP, TRUNCATED } from "../../src/sandbox/protocol.ts";

test("encode writes one line per message", () => {
  const line = encode({ t: "res", result: { id: "a", ok: true, output: "x\ny" }, ms: 1 });
  expect(line.endsWith("\n")).toBe(true);
  expect(line.slice(0, -1)).not.toContain("\n");
});

test("decodeChild round-trips ready, parsed and results, each step with the worker's own timing", () => {
  expect(decodeChild('{"t":"ready"}')).toEqual({ t: "ready" });
  expect(decodeChild('{"t":"parsed","ms":3.5}')).toEqual({ t: "parsed", ms: 3.5 });
  const ok = { t: "res", result: { id: "a", ok: true, output: "hi" }, ms: 0 } as const;
  expect(decodeChild(encode(ok).trim())).toEqual(ok);
  const bad = { t: "res", result: { id: "b", ok: false, failure: "parse", message: "m" }, ms: 1 } as const;
  expect(decodeChild(encode(bad).trim())).toEqual(bad);
  const stack = { t: "res", result: { id: "c", ok: false, failure: "stack", message: "m" }, ms: 12 } as const;
  expect(decodeChild(encode(stack).trim())).toEqual(stack);
  const memory = { t: "res", result: { id: "d", ok: false, failure: "memory", message: "RangeError: Out of memory" }, ms: 7 } as const;
  expect(decodeChild(encode(memory).trim())).toEqual(memory);
});

test("decodeChild rejects malformed lines", () => {
  for (const line of ["", "nope", "[]", "null", '{"t":"res"}', '{"t":"res","result":{"id":1,"ok":true,"output":"x"},"ms":1}']) {
    expect(decodeChild(line)).toBeUndefined();
  }
});

test("a step without a time the parent can use is malformed: the worker's clock is the one the caps go by", () => {
  const result = { id: "a", ok: true, output: "x" };
  for (const ms of [undefined, null, "1", -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(decodeChild(JSON.stringify({ t: "res", result, ms }))).toBeUndefined();
    expect(decodeChild(JSON.stringify({ t: "parsed", ms }))).toBeUndefined();
  }
  // JSON has no Infinity: an overflowing literal parses to it.
  expect(decodeChild('{"t":"parsed","ms":1e999}')).toBeUndefined();
});

test("decodeChild drops extra fields", () => {
  const line = '{"t":"res","result":{"id":"a","ok":true,"output":"x","extra":1},"ms":2}';
  expect(decodeChild(line)).toEqual({ t: "res", result: { id: "a", ok: true, output: "x" }, ms: 2 });
  expect(decodeChild(`{"t":"parsed","ms":1,"pad":"${"x".repeat(100)}"}`)).toEqual({ t: "parsed", ms: 1 });
});

test("the worker cannot claim failures only the parent can see", () => {
  for (const failure of ["timeout", "sandbox", "skipped", "made_up"]) {
    const line = JSON.stringify({ t: "res", result: { id: "a", ok: false, failure, message: "m" }, ms: 1 });
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
  const line = JSON.stringify({ t: "res", result: { id: "a", ok: false, failure: "render_error", message: "y".repeat(3_000_000) }, ms: 1 });
  expect(decodeChild(line)).toEqual({ t: "res", result: { id: "a", ok: false, failure: "render_error", message: "y".repeat(MESSAGE_KEEP) + TRUNCATED }, ms: 1 });
});
