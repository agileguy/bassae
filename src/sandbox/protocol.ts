// Line-delimited JSON between the renderer and its sandboxed worker.
// The parent writes one init line and one line per request, then closes stdin.
// The worker writes one ready line once it has loaded, one parsed line once the template has
// parsed or failed to, then one result line per request, in order.

import type { RenderFailure, RenderRequest, RenderResult } from "../types.ts";

export interface InitMessage {
  t: "init";
  template: string;
  maxOutputBytes: number;
  /** CPU time the worker may spend on the parse, and then on each render, before the kernel kills it. */
  cpuMs: number;
}

export interface RequestMessage {
  t: "req";
  request: RenderRequest;
}

export type ParentMessage = InitMessage | RequestMessage;

export type ChildMessage = { t: "ready" } | { t: "parsed" } | { t: "res"; result: RenderResult };

export function encode(message: ParentMessage | ChildMessage): string {
  return JSON.stringify(message) + "\n";
}

export const MESSAGE_KEEP = 4096;
export const TRUNCATED = "… [truncated]";

/** Cuts a failure message to MESSAGE_KEEP characters. A template controls what it raises, so no message may grow the parent's memory. */
export function clip(message: string): string {
  if (message.length <= MESSAGE_KEEP) return message;
  // Never leave half a surrogate pair at the cut.
  const end = /[\uD800-\uDBFF]/.test(message[MESSAGE_KEEP - 1]!) ? MESSAGE_KEEP - 1 : MESSAGE_KEEP;
  return message.slice(0, end) + TRUNCATED;
}

// The worker can only report what it can see. Timeouts and sandbox failures are the parent's call, and so is
// memory, except when the engine itself refuses an allocation.
const CHILD_FAILURES: ReadonlySet<string> = new Set<RenderFailure>(["parse", "render_error", "output_limit", "stack", "memory"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses one line from the worker. Anything malformed comes back undefined, because the worker handles hostile input. */
export function decodeChild(line: string): ChildMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObject(value)) return undefined;
  if (value.t === "ready") return { t: "ready" };
  if (value.t === "parsed") return { t: "parsed" };
  if (value.t !== "res" || !isObject(value.result)) return undefined;
  const r = value.result;
  if (typeof r.id !== "string") return undefined;
  if (r.ok === true && typeof r.output === "string") {
    return { t: "res", result: { id: r.id, ok: true, output: r.output } };
  }
  if (r.ok === false && typeof r.failure === "string" && CHILD_FAILURES.has(r.failure) && typeof r.message === "string") {
    return { t: "res", result: { id: r.id, ok: false, failure: r.failure as RenderFailure, message: clip(r.message) } };
  }
  return undefined;
}
