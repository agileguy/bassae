// Test-only stand-in for the render worker that misbehaves on purpose, so the tests can check
// that the parent enforces the caps itself instead of trusting the worker.
// Usage: bun rogue-worker.ts <stall|wrong-id|claim-timeout|huge|exit|noisy|skip-ready|fat-error|wide-error|fat-parsed|xcpu>

import { encode, type RequestMessage } from "../../src/sandbox/protocol.ts";

const mode = process.argv[2];
const say = (line: string) => Bun.write(Bun.stdout, line);
const fails = (id: string, message: string) => JSON.stringify({ t: "res", result: { id, ok: false, failure: "render_error", message } }) + "\n";

if (mode !== "skip-ready") await say(encode({ t: "ready" }));
const lines = (await Bun.stdin.text()).split("\n").filter(Boolean).slice(1);
const ids = lines.map((line) => (JSON.parse(line) as RequestMessage).request.id);
if (mode === "fat-parsed") await say(JSON.stringify({ t: "parsed", pad: "p".repeat(100_000) }) + "\n");
else if (mode !== "skip-ready") await say(encode({ t: "parsed" }));

switch (mode) {
  case "stall":
    setInterval(() => {}, 1000);
    break;
  case "wrong-id":
    for (const _ of ids) await say(encode({ t: "res", result: { id: "not-yours", ok: true, output: "" } }));
    break;
  case "claim-timeout":
    for (const id of ids) {
      await say(JSON.stringify({ t: "res", result: { id, ok: false, failure: "timeout", message: "lie" } }) + "\n");
    }
    break;
  case "huge":
    await say("x".repeat(20 * 1024 * 1024));
    setInterval(() => {}, 1000);
    break;
  case "exit":
    process.exit(7);
    break;
  case "skip-ready":
    for (const id of ids) await say(encode({ t: "res", result: { id, ok: true, output: "early" } }));
    break;
  case "noisy":
    await Bun.write(Bun.stderr, "e".repeat(1024 * 1024));
    for (const id of ids) await say(encode({ t: "res", result: { id, ok: true, output: "noisy" } }));
    break;
  case "fat-error":
    // 2 MiB per message: inside the per-request byte bound at the default caps, so only the message cap stops it.
    for (const id of ids) await say(fails(id, "e".repeat(2 ** 21)));
    break;
  case "wide-error":
    // 90,000 bytes in 30,000 characters: the bound is in bytes, not characters.
    for (const id of ids) await say(fails(id, "€".repeat(30_000)));
    break;
  case "fat-parsed":
    setInterval(() => {}, 1000);
    break;
  case "xcpu":
    // What the kernel does once a step has used its CPU allowance.
    process.kill(process.pid, "SIGXCPU");
    setInterval(() => {}, 1000);
    break;
}
