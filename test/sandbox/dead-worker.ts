// Test-only. Sends a batch far past a pipe's 64 KiB to worker commands that die before reading it (review round 2,
// MUST FIX 1), then prints each request's failure and how many rejections and exceptions nobody handled. The scanner
// treats either as a crash and exits 3, so the count must be 0.
// Usage: bun dead-worker.ts

import { createRenderer } from "../../src/sandbox/index.ts";

let unhandled = 0;
process.on("unhandledRejection", () => unhandled++);
process.on("uncaughtException", () => unhandled++);

const big = "x".repeat(200_000);
const requests = Array.from({ length: 80 }, (_, i) => ({ id: `r${i}`, context: { messages: [{ role: "user", content: big }] }, profile: "hf-default" as const }));
const commands = [
  ["/bin/sh", "-c", "exit 1"],
  [process.execPath, "-e", "process.stdin.destroy(); setTimeout(() => process.exit(0), 50)"],
];
const failures: string[][] = [];
for (const command of commands) {
  const results = await createRenderer({ command, readable: ["/bin/sh"] }).renderBatch("{{ x }}", requests);
  failures.push(results.map((r) => (r.ok ? "ok" : r.failure)));
}
// A write the worker never read rejects when the pipe breaks, which can be after the run has settled.
await new Promise((resolve) => setTimeout(resolve, 500));
process.stdout.write(JSON.stringify({ unhandled, failures }) + "\n");
