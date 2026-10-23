// Runs inside the OS sandbox. Parses one template and renders it once per request.
// It times each step by its own clock and ends itself once one runs past the time cap, so a
// busy parent cannot make a quick render look slow; the launcher's clock is only a backstop.
// It reports what else it can see: parse failures, render errors, stack overflows and oversized
// output. It also watches its own memory and CPU time, because the launcher's caps die with the launcher.

import { Template } from "@huggingface/jinja";
import { dlopen, FFIType, ptr, type FFIFunction } from "bun:ffi";
import type { RenderFailure, RenderRequest, RenderResult } from "../types.ts";
import { installPolyfills } from "./polyfills.ts";
import { profileGlobals } from "./profiles.ts";
import { clip, encode, MEMORY_EXIT_CODE, TIMEOUT_EXIT_CODE, type ChildMessage, type InitMessage, type RequestMessage } from "./protocol.ts";

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

/**
 * Lets the process use `ms` more CPU time before SIGXCPU, and lowers the hard limit to `totalMs` more when given.
 * At the hard limit the kernel sends SIGKILL, which the parent cannot tell from any other kill, so the soft
 * limit stays a second under it: a step that runs into the hard limit, ours or the host's, still ends by SIGXCPU.
 */
function limitCpu(ms: number, totalMs?: number): void {
  const { user, system } = process.cpuUsage();
  const used = (user + system) / 1e6;
  if (totalMs !== undefined) rlimit[1] = min(rlimit[1]!, BigInt(Math.ceil(used + totalMs / 1000)));
  rlimit[0] = min(BigInt(Math.ceil(used + ms / 1000)), rlimit[1]! - 1n);
  if (libc.setrlimit(RLIMIT_CPU, ptr(rlimit)) !== 0) throw new Error("setrlimit(RLIMIT_CPU) failed");
}

// A thread of the worker's own keeps the time cap, and backs the parent's memory cap, which dies with the parent.
// The main thread marks when each step starts; the thread ends the process once a step has run past the cap by
// that clock, whatever the parent's event loop is doing. It also polls resident memory and ends the process past
// the cap. RLIMIT_AS cannot do that, since JSC reserves far more address space than it uses, and macOS enforces no
// RSS limit. process.exit from a thread ends only the thread, so the thread calls _exit itself. It loads before
// the ready line for the same reason the CPU backstop does, and learns the caps from the init line.
const watchdog = new Worker(
  URL.createObjectURL(
    new Blob([
      `const { dlopen, FFIType } = require("bun:ffi");
const { _exit } = dlopen(${JSON.stringify(LIBC)}, { _exit: { args: [FFIType.i32], returns: FFIType.void } }).symbols;
onmessage = ({ data: { maxRssBytes, timeoutMs, started, origin } }) => {
  const step = new Int32Array(started);
  setInterval(() => {
    if (process.memoryUsage.rss() > maxRssBytes) _exit(${MEMORY_EXIT_CODE});
    const at = Atomics.load(step, 0);
    if (at > 0 && performance.timeOrigin + performance.now() - origin - (at - 1) > timeoutMs) _exit(${TIMEOUT_EXIT_CODE});
  }, 10);
  postMessage("armed");
};
postMessage("loaded");`,
    ]),
  ),
);
// When the step in progress started, in whole ms of the main thread's clock plus one; 0 between steps.
const started = new Int32Array(new SharedArrayBuffer(4));

/** Runs one step on the clock the watchdog keeps, and says how long it took. */
function timed<T>(fn: () => T): [T, number] {
  const start = performance.now();
  Atomics.store(started, 0, Math.floor(start) + 1);
  try {
    return [fn(), performance.now() - start];
  } finally {
    Atomics.store(started, 0, 0);
  }
}
const fromWatchdog = (expected: string) =>
  new Promise<void>((resolve, reject) => {
    watchdog.onmessage = ({ data }) => (data === expected ? resolve() : reject(new Error(`memory watchdog said ${String(data)}`)));
    watchdog.onerror = (e) => reject(new Error(`no memory backstop, so the worker will not start: ${e.message}`));
  });
await fromWatchdog("loaded");

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

// Each line must reach the parent before the next step starts, because the parent's
// backstop clock runs from the line before.
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

/** Stdin a line at a time, so a batch is never held whole as one string. */
async function* lines(): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let parts: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    let start = 0;
    for (let nl = chunk.indexOf(0x0a); nl >= 0; nl = chunk.indexOf(0x0a, start)) {
      parts.push(chunk.subarray(start, nl));
      yield decoder.decode(Buffer.concat(parts));
      parts = [];
      start = nl + 1;
    }
    if (start < chunk.length) parts.push(chunk.slice(start));
  }
  if (parts.length > 0) yield decoder.decode(Buffer.concat(parts));
}

installPolyfills();

const input = lines();
const init = JSON.parse((await input.next()).value ?? "") as InitMessage;
watchdog.postMessage({ maxRssBytes: init.maxRssBytes, timeoutMs: init.timeoutMs, started: started.buffer, origin: performance.timeOrigin });
await fromWatchdog("armed");
// Armed, it need not keep the process alive once the last result is out.
watchdog.unref();

// The batch is read and parsed before the ready line, a request at a time and under the memory watchdog, so a
// batch too big to hold fails to start, and is never charged to the first request as a cap breach.
const requests: RenderRequest[] = [];
for await (const line of input) if (line) requests.push((JSON.parse(line) as RequestMessage).request);

// The soft limit covers one step at a time; the hard limit, the parse and every render. Each step's soft limit
// rounds up to a whole second, so the hard limit allows a second more per step, and the second it keeps clear.
limitCpu(init.cpuMs, (requests.length + 1) * (init.cpuMs + 1000) + 1000);
await send({ t: "ready" });

let parseFailure = { failure: "parse" as RenderFailure, message: "" };
const [template, parseMs] = timed((): Template | undefined => {
  try {
    return new Template(init.template);
  } catch (e) {
    parseFailure = failure(e, "parse");
    return undefined;
  }
});
await send({ t: "parsed", ms: parseMs });

for (const request of requests) {
  limitCpu(init.cpuMs);
  const [result, ms] = timed((): RenderResult => (template ? render(template, request, init.maxOutputBytes) : { id: request.id, ok: false, ...parseFailure }));
  await send({ t: "res", result, ms });
}
