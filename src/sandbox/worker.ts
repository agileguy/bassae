// Runs inside the OS sandbox. Parses one template and renders it once per request.
// The launcher enforces the time and memory caps from outside; this side only reports
// what it can see: parse failures, render errors, stack overflows and oversized output.
// It also limits its own CPU time, because the launcher's caps die with the launcher.

import { Template } from "@huggingface/jinja";
import { dlopen, FFIType, ptr, type FFIFunction } from "bun:ffi";
import type { RenderFailure, RenderRequest, RenderResult } from "../types.ts";
import { profileGlobals } from "./profiles.ts";
import { clip, encode, type ChildMessage, type InitMessage, type RequestMessage } from "./protocol.ts";

// macOS has no parent-death signal, so a parent killed with SIGKILL would leave a hung render running
// for good. RLIMIT_CPU is the backstop: re-armed before the parse and before each render, it lets the
// kernel kill this process with SIGXCPU once one step has used its share of CPU. RLIMIT_CPU is
// resource 0 on macOS and Linux, and struct rlimit is two 64-bit counts on both. Loading it before the
// ready line means a sandbox without it fails to start rather than rendering without a backstop.
const RLIMIT_CPU = 0;
// musl's loader answers to "libc.so.6" with itself, so the one name serves glibc and musl alike.
const LIBC = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";

/** Functions from the C library. Without them there is no CPU backstop, so the worker refuses to start and says why. */
function fromLibc<Fns extends Record<string, FFIFunction>>(fns: Fns) {
  try {
    return dlopen(LIBC, fns).symbols;
  } catch (e) {
    throw new Error(`no RLIMIT_CPU backstop, so the worker will not start: cannot load ${LIBC}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const libc = fromLibc({
  getrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  setrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
});
const rlimit = new BigUint64Array(2);
if (libc.getrlimit(RLIMIT_CPU, ptr(rlimit)) !== 0) throw new Error("getrlimit(RLIMIT_CPU) failed");

// SIGXCPU dumps core. Where core_pattern pipes the core to a handler, as systemd-coredump does on
// GitHub's Ubuntu runners, the kernel holds the dying worker, pipes and all, until the handler has
// read and analysed it: seconds, not milliseconds. A non-dumpable process skips the dump whatever
// core_pattern says, and keeps its templates and contexts out of the host's crash store too.
// macOS writes cores only to /cores, which only root may write, and the default RLIMIT_CORE is 0.
if (process.platform === "linux") {
  const PR_SET_DUMPABLE = 4;
  const { prctl } = fromLibc({ prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 } });
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) !== 0) throw new Error("prctl(PR_SET_DUMPABLE) failed");
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** Lets the process use `ms` more CPU time before SIGXCPU, and lowers the hard limit to `totalMs` more when given. */
function limitCpu(ms: number, totalMs?: number): void {
  const { user, system } = process.cpuUsage();
  const used = (user + system) / 1e6;
  if (totalMs !== undefined) rlimit[1] = min(rlimit[1]!, BigInt(Math.ceil(used + totalMs / 1000)));
  rlimit[0] = min(BigInt(Math.ceil(used + ms / 1000)), rlimit[1]!);
  if (libc.setrlimit(RLIMIT_CPU, ptr(rlimit)) !== 0) throw new Error("setrlimit(RLIMIT_CPU) failed");
}

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

// Each line must reach the parent before the next step starts, because the parent
// times the parse from the ready line and each render from the line before it.
async function send(message: ChildMessage): Promise<void> {
  await Bun.write(Bun.stdout, encode(message));
}

/** A thrown value as a failure kind and a message the parent will accept. */
function failure(e: unknown, otherwise: RenderFailure): { failure: RenderFailure; message: string } {
  // A recursive macro or deeply nested template exhausts the stack; that is a resource cap, not a template error.
  // So is a string past JSC's length limit: JSC refuses it at once, where a Python engine would allocate it all.
  const cap = !(e instanceof RangeError) ? undefined : /call stack/i.test(e.message) ? "stack" : /out of memory/i.test(e.message) ? "memory" : undefined;
  return { failure: cap ?? otherwise, message: clip(e instanceof Error ? `${e.name}: ${e.message}` : String(e)) };
}

function render(template: Template, request: RenderRequest, maxOutputBytes: number): RenderResult {
  const { id } = request;
  pinnedMs = undefined;
  if (request.now !== undefined) {
    const ms = RealDate.parse(request.now);
    if (Number.isNaN(ms)) return { id, ok: false, failure: "render_error", message: clip(`now is not an ISO-8601 instant: ${request.now}`) };
    pinnedMs = ms;
  }
  try {
    const output = template.render({ ...profileGlobals(request.profile), ...request.context });
    const bytes = Buffer.byteLength(output);
    if (bytes > maxOutputBytes) return { id, ok: false, failure: "output_limit", message: `output is ${bytes} bytes, cap ${maxOutputBytes}` };
    return { id, ok: true, output };
  } catch (e) {
    return { id, ok: false, ...failure(e, "render_error") };
  } finally {
    pinnedMs = undefined;
  }
}

await send({ t: "ready" });

const [head = "", ...rest] = (await Bun.stdin.text()).split("\n").filter(Boolean);
const init = JSON.parse(head) as InitMessage;
const requests = rest.map((line) => (JSON.parse(line) as RequestMessage).request);

// The hard limit covers the parse and every render, plus a second; the soft limit covers one step at a time.
limitCpu(init.cpuMs, (requests.length + 1) * init.cpuMs + 1000);
let template: Template | undefined;
let parseFailure = { failure: "parse" as RenderFailure, message: "" };
try {
  template = new Template(init.template);
} catch (e) {
  parseFailure = failure(e, "parse");
}
await send({ t: "parsed" });

for (const request of requests) {
  limitCpu(init.cpuMs);
  const result: RenderResult = template ? render(template, request, init.maxOutputBytes) : { id: request.id, ok: false, ...parseFailure };
  await send({ t: "res", result });
}
