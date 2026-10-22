// Runs inside the OS sandbox. Parses one template and renders it once per request.
// The launcher enforces the time and memory caps from outside; this side only reports
// what it can see: parse failures, render errors and oversized output.

import { Template } from "@huggingface/jinja";
import type { RenderRequest, RenderResult } from "../types.ts";
import { profileGlobals } from "./profiles.ts";
import { encode, type ChildMessage, type InitMessage, type RequestMessage } from "./protocol.ts";

// strftime_now() reads the wall clock with `new Date()`. Pinning that clock per request lets the
// library's own strftime_now report the requested instant. The launcher sets TZ=UTC.
const RealDate = Date;
let pinnedMs: number | undefined;
globalThis.Date = new Proxy(RealDate, {
  construct(target, args, newTarget) {
    return Reflect.construct(target, args.length === 0 && pinnedMs !== undefined ? [pinnedMs] : args, newTarget);
  },
  get(target, prop, receiver) {
    if (prop === "now") return () => pinnedMs ?? target.now();
    return Reflect.get(target, prop, receiver);
  },
});

// Each result must reach the parent before the next render starts, because the parent
// times each render from the previous result.
async function send(message: ChildMessage): Promise<void> {
  await Bun.write(Bun.stdout, encode(message));
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function render(template: Template, request: RenderRequest, maxOutputBytes: number): RenderResult {
  const { id } = request;
  pinnedMs = undefined;
  if (request.now !== undefined) {
    const ms = RealDate.parse(request.now);
    if (Number.isNaN(ms)) return { id, ok: false, failure: "render_error", message: `now is not an ISO-8601 instant: ${request.now}` };
    pinnedMs = ms;
  }
  try {
    const output = template.render({ ...profileGlobals(request.profile), ...request.context });
    const bytes = Buffer.byteLength(output);
    if (bytes > maxOutputBytes) return { id, ok: false, failure: "output_limit", message: `output is ${bytes} bytes, cap ${maxOutputBytes}` };
    return { id, ok: true, output };
  } catch (e) {
    return { id, ok: false, failure: "render_error", message: errorMessage(e) };
  } finally {
    pinnedMs = undefined;
  }
}

await send({ t: "ready" });

const [head = "", ...rest] = (await Bun.stdin.text()).split("\n").filter(Boolean);
const init = JSON.parse(head) as InitMessage;
const requests = rest.map((line) => (JSON.parse(line) as RequestMessage).request);

let template: Template | undefined;
let parseError = "";
try {
  template = new Template(init.template);
} catch (e) {
  parseError = errorMessage(e);
}

for (const request of requests) {
  const result: RenderResult = template
    ? render(template, request, init.maxOutputBytes)
    : { id: request.id, ok: false, failure: "parse", message: parseError };
  await send({ t: "res", result });
}
