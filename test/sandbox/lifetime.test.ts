// A worker must not outlive the renderer that started it, however the renderer dies (ISC-43).
// Each test runs a real renderer in its own process, kills that process mid-render, and watches the worker.

import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { constants } from "node:os";
import { basename, join } from "node:path";
import { sandboxAvailable } from "../../src/sandbox/index.ts";
import { spawnSandboxed } from "../../src/sandbox/launcher.ts";
import { encode, MEMORY_EXIT_CODE } from "../../src/sandbox/protocol.ts";

const status = await sandboxAvailable();
const PARENT = join(import.meta.dir, "orphan-parent.ts");
const WORKER = join(import.meta.dir, "../../src/sandbox/worker.ts");
// Where a core-dumping death sends its core. A pipe to a handler, as on GitHub's Ubuntu runners, can hold the dying process for seconds.
const CORE_PATTERN = process.platform === "linux" ? readFileSync("/proc/sys/kernel/core_pattern", "utf8").trim() : "-";

/** Every process under root, found by walking ps's parent links. */
function descendants(root: number): number[] {
  const children = new Map<number, number[]>();
  for (const row of Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="]).stdout.toString().trim().split("\n")) {
    const [pid, ppid] = row.trim().split(/\s+/).map(Number) as [number, number];
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found: number[] = [];
  for (const queue = [root]; queue.length > 0; ) {
    for (const child of children.get(queue.shift()!) ?? []) found.push(child), queue.push(child);
  }
  return found;
}

/** Running, as opposed to gone or a zombie waiting to be reaped. */
function running(pid: number): boolean {
  const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim();
  return stat !== "" && !stat.startsWith("Z");
}

/** Starts a renderer mid-render in its own process, kills it with `signal`, and times how long its workers last. */
async function killMidRender(mode: "wait" | "block", signal: NodeJS.Signals, patienceMs: number) {
  const parent = Bun.spawn([process.execPath, PARENT, mode], { stdout: "pipe", stderr: "inherit" });
  let workers: number[] = [];
  try {
    const { value } = await parent.stdout.getReader().read();
    expect(new TextDecoder().decode(value)).toStartWith("rendering");
    workers = descendants(parent.pid);
    // Proof the test is not vacuous: the worker is alive, mid-render, the moment its parent dies.
    expect(workers.length).toBeGreaterThan(0);
    expect(workers.every(running)).toBe(true);
    parent.kill(signal);
    await parent.exited;
    const start = performance.now();
    while (workers.some(running) && performance.now() - start < patienceMs) await Bun.sleep(50);
    return { survivors: workers.filter(running), ms: performance.now() - start, parentSignal: parent.signalCode };
  } finally {
    parent.kill("SIGKILL");
    for (const pid of workers) if (running(pid)) process.kill(pid, "SIGKILL");
  }
}

test.skipIf(!status.available)(
  "with no parent watching at all, the worker's own CPU limit ends a render that never finishes",
  async () => {
    const spin = "{% for i in range(1000) %}{% for j in range(1000) %}{% for k in range(1000) %}{% endfor %}{% endfor %}{% endfor %}";
    const worker = spawnSandboxed([process.execPath, "--no-install", WORKER])!;
    const start = performance.now();
    try {
      worker.stdin.write(encode({ t: "init", template: spin, maxOutputBytes: 1000, cpuMs: 500, maxRssBytes: 2 ** 30 }));
      worker.stdin.write(encode({ t: "req", request: { id: "a", context: {}, profile: "hf-default" } }));
      worker.stdin.end();
      const out = new Response(worker.stdout).text();
      const err = new Response(worker.stderr).text();
      const ended = await Promise.race([worker.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
      const ms = performance.now() - start;
      const how = ended ? `ended by ${worker.signalCode ?? `exit ${worker.exitCode}`}` : "still running";
      console.log(`[sandbox] worker ${how} after ${ms.toFixed(0)}ms at cpuMs 500, core_pattern ${CORE_PATTERN}`);
      expect(ended).toBe(true);
      console.log(`[sandbox] its stderr: ${(await err).trim() || "-"}`);
      expect(await out).toBe('{"t":"ready"}\n{"t":"parsed"}\n');
      // bwrap reports a child killed by a signal as exit 128 + the signal.
      expect(worker.signalCode === "SIGXCPU" || worker.exitCode === 128 + constants.signals.SIGXCPU).toBe(true);
      expect(ms).toBeLessThan(3000);
    } finally {
      worker.kill("SIGKILL");
    }
  },
  30_000,
);

test.skipIf(!status.available)(
  "with no parent watching at all, the worker's own memory watchdog ends a render that keeps allocating",
  async () => {
    const worker = spawnSandboxed([process.execPath, "--no-install", WORKER])!;
    try {
      worker.stdin.write(encode({ t: "init", template: "{% set xs = range(10**7) %}fine", maxOutputBytes: 1000, cpuMs: 10_000, maxRssBytes: 128 * 2 ** 20 }));
      worker.stdin.write(encode({ t: "req", request: { id: "a", context: {}, profile: "hf-default" } }));
      worker.stdin.end();
      const [out] = await Promise.all([new Response(worker.stdout).text(), new Response(worker.stderr).text(), worker.exited]);
      expect(out).toBe('{"t":"ready"}\n{"t":"parsed"}\n');
      expect(worker.exitCode).toBe(MEMORY_EXIT_CODE);
    } finally {
      worker.kill("SIGKILL");
    }
  },
  30_000,
);

// At its hard CPU limit Linux sends SIGKILL, which the parent cannot tell from any other kill. A host that already
// caps CPU time, here at 3 seconds, sets a hard limit well under what the worker would ask for one render.
test("a worker under a host's own CPU cap still ends by SIGXCPU, never by the hard limit's SIGKILL", async () => {
  const spin = "{% for i in range(1000) %}{% for j in range(1000) %}{% for k in range(1000) %}{% endfor %}{% endfor %}{% endfor %}";
  const worker = Bun.spawn(["/bin/sh", "-c", 'ulimit -t 3 && exec "$0" --no-install "$1"', process.execPath, WORKER], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    worker.stdin.write(encode({ t: "init", template: spin, maxOutputBytes: 1000, cpuMs: 10_000, maxRssBytes: 2 ** 30 }));
    worker.stdin.write(encode({ t: "req", request: { id: "a", context: {}, profile: "hf-default" } }));
    worker.stdin.end();
    const [out] = await Promise.all([new Response(worker.stdout).text(), new Response(worker.stderr).text(), worker.exited]);
    expect(out).toBe('{"t":"ready"}\n{"t":"parsed"}\n');
    expect(worker.signalCode).toBe("SIGXCPU");
  } finally {
    worker.kill("SIGKILL");
  }
}, 30_000);

// The kernel hands the /proc files of a process it will not dump to root, and leaves a dumpable one's with its
// own uid. As root the two look alike, so this runs for an ordinary user only, as it does in CI.
test.skipIf(!status.available || process.platform !== "linux" || process.getuid?.() === 0)(
  "the worker turns off its own core dumps before it says it is ready",
  async () => {
    const owners: Record<string, number> = {};
    const runs = { "plain bun": [process.execPath, "-e", "console.log('up'); setInterval(() => {}, 1000)"], worker: [process.execPath, "--no-install", WORKER] };
    for (const [name, argv] of Object.entries(runs)) {
      const proc = spawnSandboxed(argv)!;
      try {
        await proc.stdout.getReader().read();
        // The kernel names a process after the file it runs, cut to 15 bytes, whatever that file is called.
        const bun = descendants(proc.pid).find((pid) => readFileSync(`/proc/${pid}/comm`, "utf8").trim() === basename(process.execPath).slice(0, 15));
        expect(bun).toBeDefined();
        owners[name] = statSync(`/proc/${bun}/status`).uid;
      } finally {
        proc.kill("SIGKILL");
      }
    }
    expect(owners).toEqual({ "plain bun": process.getuid!(), worker: 0 });
  },
);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test.skipIf(!status.available)(
    `${signal} to a renderer with no listener of its own takes its worker down with it at once`,
    async () => {
      const { survivors, ms, parentSignal } = await killMidRender("wait", signal, 10_000);
      console.log(`[sandbox] worker gone ${ms.toFixed(0)}ms after ${signal} to its parent`);
      expect(survivors).toEqual([]);
      expect(ms).toBeLessThan(1000);
      // The renderer's handler kills the workers, then lets the signal end the process as it would have.
      expect(parentSignal).toBe(signal);
    },
    30_000,
  );
}

test.skipIf(!status.available)(
  "a host that lives through SIGINT and renders again has its new workers killed by the next SIGINT too",
  async () => {
    const parent = Bun.spawn([process.execPath, PARENT, "swallow"], { stdout: "pipe", stderr: "inherit" });
    const reader = parent.stdout.getReader();
    let said = "";
    const seen: number[] = [];
    try {
      const survivors: number[][] = [];
      for (let round = 1; round <= 2; round++) {
        while (said.split("rendering").length <= round) said += new TextDecoder().decode((await reader.read()).value);
        const workers = descendants(parent.pid).filter((pid) => !seen.includes(pid));
        seen.push(...workers);
        expect(workers.length).toBeGreaterThan(0);
        expect(workers.every(running)).toBe(true);
        parent.kill("SIGINT");
        const start = performance.now();
        while (workers.some(running) && performance.now() - start < 2000) await Bun.sleep(50);
        survivors.push(workers.filter(running));
      }
      expect(survivors).toEqual([[], []]);
      // The host chose to live through both, and did.
      expect(parent.exitCode).toBeNull();
    } finally {
      parent.kill("SIGKILL");
      for (const pid of seen) if (running(pid)) process.kill(pid, "SIGKILL");
    }
  },
  30_000,
);

// The host's listener is a once listener added before the renderer's, which is gone by the time a listener
// that ran after it could count the listeners: such a listener would think itself alone and end the process.
test.skipIf(!status.available)(
  "a host that shuts down in its own time on SIGTERM gets to finish, and its workers die at the signal",
  async () => {
    const parent = Bun.spawn([process.execPath, PARENT, "graceful"], { stdout: "pipe", stderr: "inherit" });
    let workers: number[] = [];
    try {
      const out = new Response(parent.stdout).text();
      while (descendants(parent.pid).length === 0) await Bun.sleep(50);
      await Bun.sleep(500);
      workers = descendants(parent.pid);
      expect(workers.every(running)).toBe(true);
      parent.kill("SIGTERM");
      const start = performance.now();
      while (workers.some(running) && performance.now() - start < 800) await Bun.sleep(20);
      // Gone while the host is still a second into its shutdown, so the renderer killed them, not the exit.
      const atSignal = { survivors: workers.filter(running), hostRunning: parent.exitCode === null && parent.signalCode === null };
      await parent.exited;
      expect({ atSignal, said: await out, exit: parent.signalCode ?? parent.exitCode }).toEqual({
        atSignal: { survivors: [], hostRunning: true },
        said: "rendering\nshut down\n",
        exit: 0,
      });
    } finally {
      parent.kill("SIGKILL");
      for (const pid of workers) if (running(pid)) process.kill(pid, "SIGKILL");
    }
  },
  30_000,
);

test.skipIf(!status.available)(
  "a worker dies within seconds of its renderer being SIGKILLed while hung",
  async () => {
    const { survivors, ms } = await killMidRender("block", "SIGKILL", 15_000);
    console.log(`[sandbox] worker gone ${ms.toFixed(0)}ms after SIGKILL to its hung parent`);
    expect(survivors).toEqual([]);
    // The worker's own CPU limit for one render at timeoutMs 1000 is 2.5 seconds, rounded up to a whole second.
    expect(ms).toBeLessThan(4500);
  },
  30_000,
);
