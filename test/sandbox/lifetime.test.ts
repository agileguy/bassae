// A worker must not outlive the renderer that started it, however the renderer dies (ISC-43).
// Each test runs a real renderer in its own process, kills that process mid-render, and watches the worker.

import { expect, test } from "bun:test";
import { join } from "node:path";
import { sandboxAvailable } from "../../src/sandbox/index.ts";

const status = await sandboxAvailable();
const PARENT = join(import.meta.dir, "orphan-parent.ts");

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
  "SIGTERM to the renderer takes its worker down with it at once",
  async () => {
    const { survivors, ms, parentSignal } = await killMidRender("wait", "SIGTERM", 10_000);
    console.log(`[sandbox] worker gone ${ms.toFixed(0)}ms after SIGTERM to its parent`);
    expect(survivors).toEqual([]);
    expect(ms).toBeLessThan(1000);
    // The renderer's handler kills the workers, then lets the signal end the process as it would have.
    expect(parentSignal).toBe("SIGTERM");
  },
  30_000,
);

test.skipIf(!status.available)(
  "a worker dies within seconds of its renderer being SIGKILLed while hung",
  async () => {
    const { survivors, ms } = await killMidRender("block", "SIGKILL", 15_000);
    console.log(`[sandbox] worker gone ${ms.toFixed(0)}ms after SIGKILL to its hung parent`);
    expect(survivors).toEqual([]);
    // The worker's own CPU limit for one render at timeoutMs 1000 is 3 seconds.
    expect(ms).toBeLessThan(5000);
  },
  30_000,
);
