// The only place bassae starts a process. Everything it starts runs under the OS sandbox, or not at all.

import type { Subprocess } from "bun";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { CAP_FAILURES, type RenderFailure, type RenderLimits, type RenderRequest, type RenderResult } from "../types.ts";
import { clip, decodeChild, encode, MEMORY_EXIT_CODE, TIMEOUT_EXIT_CODE } from "./protocol.ts";

export type SandboxKind = "sandbox-exec" | "bwrap";

/** `degraded` names each protection this machine's sandbox lacks; it is empty at full strength. */
export type SandboxStatus = { available: true; kind: SandboxKind; degraded: string[] } | { available: false; reason: string };

export interface SpawnOptions {
  /** Which sandbox to use. "none" means no sandbox is available, so nothing starts. Defaults to the platform's own. */
  sandbox?: SandboxKind | "none";
  /** Files the command reads besides bun, the render worker and the jinja package, such as a test's own script. */
  readable?: string[];
}

export interface WorkerOptions extends SpawnOptions {
  /** What runs inside the sandbox. Defaults to the render worker. */
  command?: string[];
  /** Resident bytes of the process tree under `pid`, or undefined when they cannot be read. Defaults to the platform's own reader. */
  residentMemory?: (pid: number) => number | undefined;
}

export interface WorkerRun {
  /** Results for a prefix of the requests, in order. */
  results: RenderResult[];
  /** Set when the sandboxed worker could not start; requests after `results` were not attempted. */
  sandboxError?: string;
}

const BUN = realpathSync(process.execPath);
const WORKER_DIR = realpathSync(import.meta.dir);
const WORKER = join(WORKER_DIR, "worker.ts");
// The worker and what it imports at runtime. Type-only imports are erased, so ../types.ts is never read.
const WORKER_FILES = ["worker.ts", "polyfills.ts", "profiles.ts", "protocol.ts"].map((name) => join(WORKER_DIR, name));
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * bun finds @huggingface/jinja by listing each directory from the worker's up to the one whose
 * node_modules holds it. The sandbox lets it list those (names only) and read the package itself.
 */
function findJinja(): { listed: string[]; at: string; real: string } {
  const listed: string[] = [];
  for (let dir = WORKER_DIR; ; dir = dirname(dir)) {
    listed.push(dir);
    const at = join(dir, "node_modules", "@huggingface", "jinja");
    if (existsSync(at)) return { listed: [...listed, dirname(dirname(at)), dirname(at)], at, real: realpathSync(at) };
    if (dir === dirname(dir)) throw new Error(`@huggingface/jinja is not installed above ${WORKER_DIR}`);
  }
}
const JINJA = findJinja();

// UTC keeps strftime_now() identical across machines. The transpiler cache is off because the worker cannot write it.
// A fixed 1 MiB JS stack makes a runaway recursion overflow in about 100ms on macOS and Linux alike, where the
// default stacks race the timeout at different depths on each (ISC-31). Real templates nest nowhere near it.
// The option is a JSC internal: if bun ever drops it, bun refuses to start and the sandbox reports unavailable.
// On macOS, bun:ffi's dlopen asks xcode-select where the developer tools are; the sandbox denies its read of
// /var/select/developer_dir, and xcode-select says so on stderr. A DEVELOPER_DIR answers first, with no read.
const CHILD_ENV = {
  TZ: "UTC",
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  NO_COLOR: "1",
  BUN_JSC_maxPerThreadStackUsage: String(2 ** 20),
  DEVELOPER_DIR: "/nonexistent",
};

const STARTUP_MS = 10_000;
const POLL_MS = 10;
// The worker keeps the time cap by its own clock. This side's clock is the backstop, for a worker that cannot:
// it waits the cap and this grace for each step, counting only time this process was awake to see it, at most
// CREDIT_MS a poll, so a scanner whose event loop was held up elsewhere has not been waiting on the worker.
const GRACE_MS = 1000;
const CREDIT_MS = 50;
// How long a worker this side has killed gets for its last lines to be read, before the breach is judged without them.
const DRAIN_MS = 1000;
// Consecutive memory samples that may fail before the worker counts as over the cap.
const RSS_MISSES = 3;
const STDERR_KEEP = 2048;

const sbplString = (s: string) => `"${s.replace(/[\\"]/g, "\\$&")}"`;
const literal = (path: string) => `(literal ${sbplString(path)})`;

// The sysctls bun reads to start, as the sandbox's own report listed them, and no others: not the host's name, not
// other processes' arguments. Without them bun dies at startup, so a release that needs one more fails closed: the
// sandbox reports unavailable and nothing renders. hw.optional. is the CPU feature probes, a family per architecture.
const SYSCTLS = `(allow sysctl-read
  ${["kern.osproductversion", "kern.osvariant_status", "kern.iossupportversion", "kern.bootargs", "security.mac.lockdown_mode_state", "hw.activecpu", "hw.pagesize_compat"]
    .map((name) => `(sysctl-name ${sbplString(name)})`)
    .join(" ")}
  (sysctl-name-prefix "hw.optional."))`;

// Deny by default. Bun needs exec of itself and a few sysctl reads at startup. It may read "/", itself,
// system libraries, the ICU and timezone data that Intl needs for strftime, the worker's files and
// the jinja package, and list the directories it walks to find them. Nothing else, not even a stat:
// not the rest of the checkout, not $HOME. No writes, no network, no fork, no IPC.
const sbpl = (readable: string[]) => {
  const paths = new Set([BUN, ...WORKER_FILES, ...JINJA.listed, JINJA.at, ...readable, ...readable.map(dirname)]);
  return `(version 1)
(deny default)
(allow process-exec ${literal(BUN)})
${SYSCTLS}
(allow file-read* (literal "/") ${[...paths].map(literal).join(" ")} (subpath ${sbplString(JINJA.real)})
  (subpath "/usr/lib") (subpath "/System") (subpath "/usr/share/icu") (subpath "/private/var/db/timezone")
  (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))`;
};

// bwrap 0.8 added --disable-userns, which stops the worker making user namespaces of its own. Asking
// the binary itself what it supports runs nothing untrusted. An older bwrap still sandboxes, so it is
// used without the flag, and the status says so.
let bwrapHelp: string | undefined;
const helpOf = (bwrap: string) => (bwrapHelp ??= Bun.spawnSync([bwrap, "--help"], { stdout: "pipe", stderr: "pipe" }).stdout.toString());
const supportsDisableUserns = (bwrap: string) => helpOf(bwrap).includes("--disable-userns");

/** What a bwrap with this --help text cannot do that the sandbox would have it do. */
export function bwrapDegraded(help: string): string[] {
  return help.includes("--disable-userns") ? [] : ["bwrap has no --disable-userns (added in 0.8), so the worker can make user namespaces of its own"];
}

// New user, network, pid, ipc, uts and cgroup namespaces; a read-only root with only the system
// libraries, bun, the worker's files and the jinja package bound in, each at its own path, so the
// directories above them hold nothing else. The new network namespace has no route out.
const bwrapArgs = (bwrap: string, readable: string[]) => [
  bwrap,
  "--unshare-all",
  ...(supportsDisableUserns(bwrap) ? ["--unshare-user", "--disable-userns"] : []),
  "--die-with-parent",
  "--new-session",
  "--cap-drop", "ALL",
  "--ro-bind", "/usr", "/usr",
  "--ro-bind-try", "/lib", "/lib",
  "--ro-bind-try", "/lib64", "/lib64",
  "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
  ...[BUN, ...WORKER_FILES, ...readable].flatMap((p) => ["--ro-bind", p, p]),
  "--ro-bind", JINJA.real, JINJA.at,
  "--dev", "/dev",
  "--proc", "/proc",
  "--remount-ro", "/dev",
  "--remount-ro", "/",
  "--chdir", WORKER_DIR,
  "--",
];

function findBwrap(): string | undefined {
  return existsSync("/usr/bin/bwrap") ? "/usr/bin/bwrap" : (Bun.which("bwrap") ?? undefined);
}

/** The wrapped argv, or why there is no sandbox to wrap it in. */
function wrap(argv: string[], { sandbox, readable = [] }: SpawnOptions): { kind: SandboxKind; argv: string[] } | { error: string } {
  const kind = sandbox ?? (process.platform === "darwin" ? "sandbox-exec" : process.platform === "linux" ? "bwrap" : "none");
  if (kind === "none") return { error: `no OS sandbox available on ${process.platform}` };
  if (kind === "sandbox-exec") {
    if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC)) return { error: `${SANDBOX_EXEC} not found` };
    return { kind, argv: [SANDBOX_EXEC, "-p", sbpl(readable), ...argv] };
  }
  const bwrap = process.platform === "linux" ? findBwrap() : undefined;
  if (!bwrap) return { error: "bwrap (bubblewrap) not found" };
  // The memory cap needs the worker's pid, which sits under bwrap's own processes.
  if (!existsSync("/proc/thread-self/children")) return { error: "kernel has no /proc/*/children, so the memory cap cannot be enforced" };
  return { kind, argv: [...bwrapArgs(bwrap, readable), ...argv] };
}

const live = new Set<Subprocess>();
const killLive = () => {
  for (const proc of live) proc.kill("SIGKILL");
};
process.on("exit", killLive);

// "exit" does not run when a signal ends the process, so the usual ones kill the workers too, every
// time: a host program that lives through one may start more workers. The listener goes ahead of any
// the host has, so it counts them all, a once listener included, and leaves the signal to them; when
// no one else listens, it steps aside and raises the signal again, so it takes its default action as
// if we had not been here, and cannot come back to us. Nothing runs on SIGKILL or an OOM kill: bwrap's
// --die-with-parent covers Linux. On macOS the orphaned worker runs on until it next writes to its
// dead parent, at the end of the step it is in, and dies of the broken pipe. A step that never ends
// dies by the worker's own clock at timeoutMs, and failing that at its own CPU limit: 1.5 × timeoutMs
// and a second, rounded up to a whole second, so an orphan costs less than 1.5 × timeoutMs + 2 s of CPU time.
let handlingSignals = false;
function killLiveOnSignals(): void {
  if (handlingSignals) return;
  handlingSignals = true;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const onSignal = () => {
      killLive();
      if (process.listenerCount(signal) > 1) return;
      process.off(signal, onSignal);
      process.kill(process.pid, signal);
    };
    process.prependListener(signal, onSignal);
  }
}

function launch(argv: string[], options: SpawnOptions): { kind: SandboxKind; proc: Subprocess<"pipe", "pipe", "pipe"> } | { error: string } {
  const wrapped = wrap(argv, options);
  if ("error" in wrapped) return wrapped;
  killLiveOnSignals();
  try {
    // The worker's own directory, whatever the caller's: bun lists its working directory at startup, and the sandbox allows no other.
    const proc = Bun.spawn(wrapped.argv, { cwd: WORKER_DIR, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: CHILD_ENV });
    live.add(proc);
    proc.exited.then(() => live.delete(proc));
    return { kind: wrapped.kind, proc };
  } catch (e) {
    return { error: `could not start ${wrapped.kind}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Starts `argv` under the OS sandbox, or returns undefined when there is none. */
export function spawnSandboxed(argv: string[], options: SpawnOptions = {}): Subprocess<"pipe", "pipe", "pipe"> | undefined {
  const launched = launch(argv, options);
  return "proc" in launched ? launched.proc : undefined;
}

let availability: Promise<SandboxStatus> | undefined;

/** Whether a process can actually start under this platform's sandbox. Checked once per run. */
export function sandboxAvailable(): Promise<SandboxStatus> {
  availability ??= (async (): Promise<SandboxStatus> => {
    const launched = launch([BUN, "-e", "process.stdout.write('ok')"], {});
    if ("error" in launched) return { available: false, reason: launched.error };
    const { kind, proc } = launched;
    const timer = setTimeout(() => proc.kill("SIGKILL"), STARTUP_MS);
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    if (code === 0 && out === "ok") return { available: true, kind, degraded: kind === "bwrap" ? bwrapDegraded(helpOf(findBwrap()!)) : [] };
    return { available: false, reason: `${kind} could not start a process (exit ${proc.signalCode ?? code}): ${err.trim().slice(0, 500)}` };
  })();
  return availability;
}

// ---- resident memory ----
// macOS does not enforce RLIMIT_AS, and bun reserves far more address space than it touches,
// so the memory cap is enforced by polling resident memory from outside. A sample that cannot
// be read is undefined, never 0, so the poll can fail closed.

let procTaskInfo: ((pid: number) => number | undefined) | undefined;

/**
 * Opens libproc once. A renderer calls it when it is made, before any probe is built: bun:ffi's dlopen throws once
 * anything has set a property on Object.prototype, so an open left to the first poll could fail for a reason a
 * template chose, and every render then reads as a memory breach.
 */
export function openDarwinRss(): void {
  if (procTaskInfo) return;
  const { symbols } = dlopen("/usr/lib/libproc.dylib", {
    proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  });
  // struct proc_taskinfo is 96 bytes; pti_resident_size is its second u64. 4 is PROC_PIDTASKINFO.
  const info = new BigUint64Array(12);
  procTaskInfo = (p) => (symbols.proc_pidinfo(p, 4, 0n, ptr(info), 96) === 96 ? Number(info[1]) : undefined);
}

/** Resident bytes of one macOS process, or undefined when they cannot be read. */
export function darwinRss(pid: number): number | undefined {
  if (!procTaskInfo) openDarwinRss();
  return procTaskInfo!(pid);
}

const gone = (e: unknown) => ["ENOENT", "ESRCH"].includes((e as NodeJS.ErrnoException).code ?? "");

/** bwrap forks, so sum resident bytes over the whole tree under the pid we started. Undefined when the tree cannot be read. */
export function linuxTreeRss(pid: number): number | undefined {
  let total = 0;
  const pending = [pid];
  for (let p = pending.pop(); p !== undefined; p = pending.pop()) {
    try {
      const kb = /^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${p}/status`, "utf8"));
      if (kb) total += Number(kb[1]) * 1024;
      for (const tid of readdirSync(`/proc/${p}/task`)) {
        let children: string;
        try {
          children = readFileSync(`/proc/${p}/task/${tid}/children`, "utf8");
        } catch (e) {
          // A thread can exit between the listing and the read.
          if (gone(e)) continue;
          throw e;
        }
        for (const child of children.split(" ")) if (child.trim()) pending.push(Number(child));
      }
    } catch (e) {
      // A descendant can exit between reads. Anything else, or losing the process we started, is memory we cannot see.
      if (p !== pid && gone(e)) continue;
      return undefined;
    }
  }
  // A live process always has some resident memory; none at all means the reads saw nothing.
  return total > 0 ? total : undefined;
}

const mib = (bytes: number) => `${(bytes / 2 ** 20).toFixed(0)}MiB`;

// ---- the worker run ----

/**
 * Calls onLine for each complete line. The worker may send at most budget.left bytes until the
 * caller resets it; past that the read stops and resolves true. Resolves false at end of stream.
 */
async function readLines(stream: ReadableStream<Uint8Array>, budget: { left: number }, onLine: (line: string) => void): Promise<boolean> {
  const decoder = new TextDecoder();
  let parts: Uint8Array[] = [];
  for await (const chunk of stream) {
    // Split on the newline byte, which never occurs inside a multi-byte UTF-8 sequence.
    for (let start = 0; start <= chunk.length; ) {
      const nl = chunk.indexOf(0x0a, start);
      const end = nl < 0 ? chunk.length : nl + 1;
      budget.left -= end - start;
      if (budget.left < 0) return true;
      parts.push(chunk.subarray(start, nl < 0 ? end : nl));
      if (nl < 0) break;
      onLine(decoder.decode(Buffer.concat(parts)));
      parts = [];
      start = end;
    }
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
 * Runs one sandboxed worker over the requests until they are all answered, one of them breaks a cap, or the
 * worker dies. On a breach the worker is killed and the in-flight request fails, and the caller renders nothing
 * more for the template; after any other death the caller starts a fresh worker for the rest.
 * A breach before the template has parsed fails every request at once, since no fresh worker would parse it faster.
 * A breach before the worker has read its batch is a failure to start, not a cap breach: no request had begun.
 */
export async function runWorker(
  template: string,
  requests: RenderRequest[],
  limits: RenderLimits,
  options: WorkerOptions = {},
): Promise<WorkerRun> {
  const launched = launch(options.command ?? [BUN, "--no-install", WORKER], options);
  if ("error" in launched) return { results: [], sandboxError: launched.error };
  const { kind, proc } = launched;
  const rss = options.residentMemory ?? (kind === "sandbox-exec" ? darwinRss : linuxTreeRss);
  const stderr = keepHead(proc.stderr).catch(() => "");
  // JSON escaping can grow output up to six-fold. Past that, plus room for the envelope and a message,
  // nothing the worker sends between two results is well-formed, whatever kind of line it is.
  const perRequest = limits.maxOutputBytes * 6 + 65536;
  // The worker's own CPU limit per step, the backstop behind its clock. GC and JIT threads count towards
  // CPU time too, and a render that allocates hard uses about 1.3 s of CPU a second, so the limit allows
  // half as much again as the timeout, and a second. The worker's clock then ends a step first at any
  // timeout, and whether a render timed out does not turn on how busy a machine's GC threads are (ISC-31).
  const cpuMs = Math.ceil(limits.timeoutMs * 1.5) + 1000;

  return new Promise<WorkerRun>((resolve) => {
    const results: RenderResult[] = [];
    const budget = { left: perRequest };
    let ready = false;
    let parsed = false;
    let settled = false;
    let ended = false;
    let misses = 0;
    let poll: Timer | undefined;
    let drain: Timer | undefined;
    // Awake time since the worker's last line, by the backstop clock.
    let waited = 0;
    let tick = performance.now();
    // A breach seen from this side, held while the killed worker's last lines are read.
    let seen: { failure: RenderFailure; message: string; answered: number } | undefined;

    const settle = (sandboxError?: string) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(drain);
      proc.kill("SIGKILL");
      resolve(sandboxError === undefined ? { results } : { results, sandboxError: clip(sandboxError) });
    };

    const fail = (failure: RenderFailure, message: string) => {
      if (settled) return;
      if (!ready) return settle(`worker failed to start: ${message}`);
      for (const { id } of requests.slice(results.length, parsed ? results.length + 1 : undefined)) {
        results.push({ id, ok: false, failure, message: clip(message) });
      }
      settle();
    };

    /**
     * A breach seen from this side: the backstop clock, or the memory poll. The worker is killed first and its last
     * lines read, so the breach falls on the request it was on when it died, not on one it had already answered.
     */
    const breach = (failure: RenderFailure, message: string) => {
      if (settled || seen) return;
      seen = { failure, message, answered: results.length };
      clearInterval(poll);
      proc.kill("SIGKILL");
      drain = setTimeout(judge, DRAIN_MS);
    };
    const judge = () => {
      if (settled || !seen) return;
      // The answer was on its way when this side's clock ran out: the worker's clock says how long that render took.
      if (seen.failure === "timeout" && results.length > seen.answered) return settle();
      fail(seen.failure, seen.message);
    };

    const step = (name: string, ms: number) => (ms > limits.timeoutMs ? `${name} took ${Math.round(ms)}ms by the worker's clock, cap ${limits.timeoutMs}ms` : undefined);

    const onLine = (line: string) => {
      if (settled) return;
      const message = decodeChild(line);
      waited = 0;
      if (!ready && message?.t === "ready") {
        ready = true;
        return;
      }
      if (ready && !parsed && message?.t === "parsed") {
        const slow = step("template parse", message.ms);
        if (slow) return fail("timeout", slow);
        parsed = true;
        return;
      }
      const expected = requests[results.length];
      if (!parsed || message?.t !== "res" || message.result.id !== expected?.id) return fail("render_error", "worker protocol error");
      const result = message.result;
      const bytes = result.ok ? Buffer.byteLength(result.output) : 0;
      const slow = step("render", message.ms);
      results.push(
        bytes > limits.maxOutputBytes
          ? { id: result.id, ok: false, failure: "output_limit", message: `output is ${bytes} bytes, cap ${limits.maxOutputBytes}` }
          : slow
            ? { id: result.id, ok: false, failure: "timeout", message: slow }
            : result,
      );
      budget.left = perRequest;
      const last = results[results.length - 1]!;
      // The first cap breach ends the run, so the worker renders nothing after it.
      if (results.length === requests.length || (!last.ok && CAP_FAILURES.has(last.failure))) settle();
    };

    poll = setInterval(() => {
      const now = performance.now();
      waited += Math.min(now - tick, CREDIT_MS);
      tick = now;
      if (!ready && waited > STARTUP_MS) return settle(`worker did not start within ${STARTUP_MS}ms`);
      if (ready && waited > limits.timeoutMs + GRACE_MS) {
        return breach("timeout", `${parsed ? "render" : "template parse"} exceeded ${limits.timeoutMs}ms, and the worker did not stop itself`);
      }
      let bytes: number | undefined;
      try {
        bytes = rss(proc.pid);
      } catch {
        // A reader that throws has read nothing.
      }
      if (bytes === undefined) {
        // Once stdout has ended the worker is on its way out, and the exit path below says why.
        if (!ended && ++misses >= RSS_MISSES) breach("memory", `worker resident memory could not be read ${RSS_MISSES} times in a row`);
        return;
      }
      misses = 0;
      if (bytes > limits.maxRssBytes) breach("memory", `worker resident memory ${mib(bytes)} exceeded the ${mib(limits.maxRssBytes)} cap`);
    }, POLL_MS);
    // A broken pipe reads as end of stream; the exit path then reports it.
    readLines(proc.stdout, budget, onLine).catch(() => false).then(async (overflowed) => {
      if (settled) return;
      // This side killed the worker, so how it died says nothing; what it said before it died is all read.
      if (seen) return judge();
      if (overflowed) return fail("output_limit", `worker sent more than ${perRequest} bytes for one request`);
      ended = true;
      const code = await proc.exited;
      // Should a bun release ask xcode-select anyway, its complaint is about the sandbox, not the template.
      const detail = (await stderr).split("\n").filter((line) => !line.startsWith("xcode-select:")).join("\n").trim();
      if (settled) return;
      // SIGXCPU is the worker's own CPU limit, so its parse or render ran too long. bwrap reports
      // a child killed by a signal as exit 128 + the signal.
      if (proc.signalCode === "SIGXCPU" || (kind === "bwrap" && code === 128 + constants.signals.SIGXCPU)) {
        return fail("timeout", `worker exceeded its ${cpuMs}ms CPU limit`);
      }
      if (proc.signalCode === null && code === TIMEOUT_EXIT_CODE) {
        return fail("timeout", `${parsed ? "render" : "template parse"} exceeded ${limits.timeoutMs}ms by the worker's clock`);
      }
      // The worker's memory watchdog got there before this side's poll did.
      if (proc.signalCode === null && code === MEMORY_EXIT_CODE) {
        return fail("memory", `worker resident memory exceeded the ${mib(limits.maxRssBytes)} cap, by its own reading`);
      }
      fail("render_error", `worker exited (${proc.signalCode ?? `code ${code}`})${detail ? `: ${detail}` : ""}`);
    });

    // The worker reads everything before its ready line. A worker that dies early is reported by the exit path above.
    // Once the pipe is full a write returns a promise, which rejects when the worker dies before reading it. The
    // exit path reports that too, and a rejection left unhandled would end the whole scan, so each one is caught.
    const write = (line: string) => {
      const pending = proc.stdin.write(line);
      if (pending instanceof Promise) pending.catch(() => {});
    };
    try {
      write(encode({ t: "init", template, maxOutputBytes: limits.maxOutputBytes, timeoutMs: limits.timeoutMs, cpuMs, maxRssBytes: limits.maxRssBytes }));
      for (const request of requests) write(encode({ t: "req", request }));
      Promise.resolve(proc.stdin.end()).catch(() => {});
    } catch {
      // Same: the exit path reports it.
    }
  });
}
