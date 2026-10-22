// The only place bassae starts a process. Everything it starts runs under the OS sandbox, or not at all.

import type { Subprocess } from "bun";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RenderFailure, RenderLimits, RenderRequest, RenderResult } from "../types.ts";
import { decodeChild, encode } from "./protocol.ts";

export type SandboxKind = "sandbox-exec" | "bwrap";

export type SandboxStatus = { available: true; kind: SandboxKind } | { available: false; reason: string };

export interface WorkerOptions {
  /** Which sandbox to use. "none" means no sandbox is available, so nothing renders. Defaults to the platform's own. */
  sandbox?: SandboxKind | "none";
  /** What runs inside the sandbox. Defaults to the render worker. */
  command?: string[];
}

export interface WorkerRun {
  /** Results for a prefix of the requests, in order. */
  results: RenderResult[];
  /** Set when the sandboxed worker could not start; requests after `results` were not attempted. */
  sandboxError?: string;
}

const BUN = realpathSync(process.execPath);
const WORKER = join(import.meta.dir, "worker.ts");
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

// What the worker may read: bun, this checkout, and the jinja package wherever it was installed.
const READ_ROOTS = [
  ...new Set([realpathSync(join(import.meta.dir, "../..")), dirname(dirname(realpathSync(Bun.resolveSync("@huggingface/jinja", import.meta.dir))))]),
];

// UTC keeps strftime_now() identical across machines. The transpiler cache is off because the worker cannot write it.
const CHILD_ENV = { TZ: "UTC", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", NO_COLOR: "1" };

const STARTUP_MS = 10_000;
const POLL_MS = 10;
const STDERR_KEEP = 2048;

const sbplString = (s: string) => `"${s.replace(/[\\"]/g, "\\$&")}"`;

// Deny by default. Bun needs exec of itself, sysctl reads at startup, and stat on any path while it
// resolves modules. Reads are limited to bun, the checkout, system libraries, and the ICU and
// timezone data that Intl needs for strftime. No writes, no network, no fork, no IPC.
const SBPL = `(version 1)
(deny default)
(allow process-exec (literal ${sbplString(BUN)}))
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read* (literal "/") (literal ${sbplString(BUN)}) ${READ_ROOTS.map((p) => `(subpath ${sbplString(p)})`).join(" ")}
  (subpath "/usr/lib") (subpath "/System") (subpath "/usr/share/icu") (subpath "/private/var/db/timezone")
  (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))`;

// New user, network, pid, ipc, uts and cgroup namespaces; a read-only root with only the
// system libraries, bun and the checkout bound in. The new network namespace has no route out.
const bwrapArgs = (bwrap: string) => [
  bwrap,
  "--unshare-all",
  "--die-with-parent",
  "--new-session",
  "--cap-drop", "ALL",
  "--ro-bind", "/usr", "/usr",
  "--ro-bind-try", "/lib", "/lib",
  "--ro-bind-try", "/lib64", "/lib64",
  "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
  ...[BUN, ...READ_ROOTS].flatMap((p) => ["--ro-bind", p, p]),
  "--dev", "/dev",
  "--proc", "/proc",
  "--remount-ro", "/dev",
  "--remount-ro", "/",
  "--",
];

function findBwrap(): string | undefined {
  return existsSync("/usr/bin/bwrap") ? "/usr/bin/bwrap" : (Bun.which("bwrap") ?? undefined);
}

/** The wrapped argv, or why there is no sandbox to wrap it in. */
function wrap(argv: string[], requested: SandboxKind | "none" | undefined): { kind: SandboxKind; argv: string[] } | { error: string } {
  const kind = requested ?? (process.platform === "darwin" ? "sandbox-exec" : process.platform === "linux" ? "bwrap" : "none");
  if (kind === "none") return { error: `no OS sandbox available on ${process.platform}` };
  if (kind === "sandbox-exec") {
    if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC)) return { error: `${SANDBOX_EXEC} not found` };
    return { kind, argv: [SANDBOX_EXEC, "-p", SBPL, ...argv] };
  }
  const bwrap = process.platform === "linux" ? findBwrap() : undefined;
  if (!bwrap) return { error: "bwrap (bubblewrap) not found" };
  // The memory cap needs the worker's pid, which sits under bwrap's own processes.
  if (!existsSync("/proc/thread-self/children")) return { error: "kernel has no /proc/*/children, so the memory cap cannot be enforced" };
  return { kind, argv: [...bwrapArgs(bwrap), ...argv] };
}

const live = new Set<Subprocess>();
process.on("exit", () => {
  for (const proc of live) proc.kill("SIGKILL");
});

function launch(argv: string[], sandbox?: SandboxKind | "none"): { kind: SandboxKind; proc: Subprocess<"pipe", "pipe", "pipe"> } | { error: string } {
  const wrapped = wrap(argv, sandbox);
  if ("error" in wrapped) return wrapped;
  try {
    const proc = Bun.spawn(wrapped.argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: CHILD_ENV });
    live.add(proc);
    proc.exited.then(() => live.delete(proc));
    return { kind: wrapped.kind, proc };
  } catch (e) {
    return { error: `could not start ${wrapped.kind}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Starts `argv` under the OS sandbox, or returns undefined when there is none. */
export function spawnSandboxed(argv: string[], sandbox?: SandboxKind | "none"): Subprocess<"pipe", "pipe", "pipe"> | undefined {
  const launched = launch(argv, sandbox);
  return "proc" in launched ? launched.proc : undefined;
}

let availability: Promise<SandboxStatus> | undefined;

/** Whether a process can actually start under this platform's sandbox. Checked once per run. */
export function sandboxAvailable(): Promise<SandboxStatus> {
  availability ??= (async (): Promise<SandboxStatus> => {
    const launched = launch([BUN, "-e", "process.stdout.write('ok')"]);
    if ("error" in launched) return { available: false, reason: launched.error };
    const { kind, proc } = launched;
    const timer = setTimeout(() => proc.kill("SIGKILL"), STARTUP_MS);
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    if (code === 0 && out === "ok") return { available: true, kind };
    return { available: false, reason: `${kind} could not start a process (exit ${proc.signalCode ?? code}): ${err.trim().slice(0, 500)}` };
  })();
  return availability;
}

// ---- resident memory ----
// macOS does not enforce RLIMIT_AS, and bun reserves far more address space than it touches,
// so the memory cap is enforced by polling resident memory from outside.

let procTaskInfo: ((pid: number) => number) | undefined;

function darwinRss(pid: number): number {
  if (!procTaskInfo) {
    const { symbols } = dlopen("/usr/lib/libproc.dylib", {
      proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    });
    // struct proc_taskinfo is 96 bytes; pti_resident_size is its second u64. 4 is PROC_PIDTASKINFO.
    const info = new BigUint64Array(12);
    procTaskInfo = (p) => (symbols.proc_pidinfo(p, 4, 0n, ptr(info), 96) === 96 ? Number(info[1]) : 0);
  }
  return procTaskInfo(pid);
}

/** bwrap forks, so sum resident memory over the whole tree under the pid we started. */
function linuxTreeRss(pid: number): number {
  let total = 0;
  const pending = [pid];
  for (let p = pending.pop(); p !== undefined; p = pending.pop()) {
    try {
      const kb = /^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${p}/status`, "utf8"));
      if (kb) total += Number(kb[1]) * 1024;
      for (const tid of readdirSync(`/proc/${p}/task`)) {
        for (const child of readFileSync(`/proc/${p}/task/${tid}/children`, "utf8").split(" ")) {
          if (child.trim()) pending.push(Number(child));
        }
      }
    } catch {
      // The process exited between reads.
    }
  }
  return total;
}

const mib = (bytes: number) => `${(bytes / 2 ** 20).toFixed(0)}MiB`;

// ---- the worker run ----

/** Calls onLine for each complete line. Resolves true if a line outgrew maxChars, false at end of stream. */
async function readLines(stream: ReadableStream<Uint8Array>, maxChars: number, onLine: (line: string) => void): Promise<boolean> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    let start = 0;
    for (let nl = text.indexOf("\n"); nl >= 0; nl = text.indexOf("\n", start)) {
      onLine(pending + text.slice(start, nl));
      pending = "";
      start = nl + 1;
    }
    pending += text.slice(start);
    if (pending.length > maxChars) return true;
  }
  return false;
}

/** Keeps the first few KiB of a stream and drains the rest, so a chatty worker never blocks on a full pipe. */
async function keepHead(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let head = "";
  for await (const chunk of stream) if (head.length < STDERR_KEEP) head += decoder.decode(chunk, { stream: true });
  return head.slice(0, STDERR_KEEP).trim();
}

/**
 * Runs one sandboxed worker over the requests until they are all answered or one of them breaks a cap.
 * On a breach the worker is killed and the in-flight request fails; the caller starts a fresh worker for the rest.
 */
export async function runWorker(
  template: string,
  requests: RenderRequest[],
  limits: RenderLimits,
  options: WorkerOptions = {},
): Promise<WorkerRun> {
  const launched = launch(options.command ?? [BUN, "--no-install", WORKER], options.sandbox);
  if ("error" in launched) return { results: [], sandboxError: launched.error };
  const { kind, proc } = launched;
  const rss = kind === "sandbox-exec" ? darwinRss : linuxTreeRss;
  const stderr = keepHead(proc.stderr);
  // JSON escaping can grow output up to six-fold; anything longer than that is not a result line.
  const maxLine = limits.maxOutputBytes * 6 + 65536;

  return new Promise<WorkerRun>((resolve) => {
    const results: RenderResult[] = [];
    let ready = false;
    let settled = false;
    let timer: Timer | undefined;

    const settle = (sandboxError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      proc.kill("SIGKILL");
      resolve(sandboxError === undefined ? { results } : { results, sandboxError });
    };

    const fail = (failure: RenderFailure, message: string) => {
      if (!ready) return settle(`worker failed to start: ${message}`);
      const request = requests[results.length];
      if (request) results.push({ id: request.id, ok: false, failure, message });
      settle();
    };

    // Each render gets the full timeout from the moment the previous result arrived.
    const arm = () => {
      clearTimeout(timer);
      timer = ready
        ? setTimeout(() => fail("timeout", `render exceeded ${limits.timeoutMs}ms`), limits.timeoutMs)
        : setTimeout(() => settle(`worker did not start within ${STARTUP_MS}ms`), STARTUP_MS);
    };

    const poll = setInterval(() => {
      const bytes = rss(proc.pid);
      if (bytes > limits.maxRssBytes) fail("memory", `worker resident memory ${mib(bytes)} exceeded the ${mib(limits.maxRssBytes)} cap`);
    }, POLL_MS);

    const onLine = (line: string) => {
      if (settled) return;
      const message = decodeChild(line);
      if (!ready && message?.t === "ready") {
        ready = true;
        return arm();
      }
      const expected = requests[results.length];
      if (message?.t !== "res" || message.result.id !== expected?.id) return fail("render_error", "worker protocol error");
      const result = message.result;
      const bytes = result.ok ? Buffer.byteLength(result.output) : 0;
      results.push(
        bytes > limits.maxOutputBytes
          ? { id: result.id, ok: false, failure: "output_limit", message: `output is ${bytes} bytes, cap ${limits.maxOutputBytes}` }
          : result,
      );
      if (results.length === requests.length) settle();
      else arm();
    };

    arm();
    readLines(proc.stdout, maxLine, onLine).then(async (overflowed) => {
      if (settled) return;
      if (overflowed) return fail("output_limit", `worker wrote a line longer than ${maxLine} characters`);
      const code = await proc.exited;
      const detail = await stderr;
      if (settled) return;
      fail("render_error", `worker exited (${proc.signalCode ?? `code ${code}`})${detail ? `: ${detail}` : ""}`);
    });

    // The worker reads everything up front. A worker that dies early is reported by the exit path above.
    try {
      proc.stdin.write(encode({ t: "init", template, maxOutputBytes: limits.maxOutputBytes }));
      for (const request of requests) proc.stdin.write(encode({ t: "req", request }));
      Promise.resolve(proc.stdin.end()).catch(() => {});
    } catch {
      // Same: the exit path reports it.
    }
  });
}
