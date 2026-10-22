// Line-delimited JSON between the renderer and its sandboxed worker.
// The parent writes one init line and one line per request, then closes stdin.
// The worker writes one ready line once it has loaded, then one result line per request, in order.

import type { RenderFailure, RenderRequest, RenderResult } from "../types.ts";

export interface InitMessage {
  t: "init";
  template: string;
  maxOutputBytes: number;
}

export interface RequestMessage {
  t: "req";
  request: RenderRequest;
}

export type ParentMessage = InitMessage | RequestMessage;

export type ChildMessage = { t: "ready" } | { t: "res"; result: RenderResult };

export function encode(message: ParentMessage | ChildMessage): string {
  return JSON.stringify(message) + "\n";
}

// The worker can only report what it can see. Timeouts, memory and sandbox failures are the parent's call.
const CHILD_FAILURES: ReadonlySet<string> = new Set<RenderFailure>(["parse", "render_error", "output_limit"]);

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
  if (value.t !== "res" || !isObject(value.result)) return undefined;
  const r = value.result;
  if (typeof r.id !== "string") return undefined;
  if (r.ok === true && typeof r.output === "string") {
    return { t: "res", result: { id: r.id, ok: true, output: r.output } };
  }
  if (r.ok === false && typeof r.failure === "string" && CHILD_FAILURES.has(r.failure) && typeof r.message === "string") {
    return { t: "res", result: { id: r.id, ok: false, failure: r.failure as RenderFailure, message: r.message } };
  }
  return undefined;
}
