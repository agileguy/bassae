// Test-only stand-in for the render worker that misbehaves on purpose, so the tests can check
// that the parent enforces the caps itself instead of trusting the worker.
// Usage: bun rogue-worker.ts <stall|wrong-id|claim-timeout|huge|exit|noisy|skip-ready>

import { encode, type RequestMessage } from "../../src/sandbox/protocol.ts";

const mode = process.argv[2];
if (mode !== "skip-ready") await Bun.write(Bun.stdout, encode({ t: "ready" }));
const lines = (await Bun.stdin.text()).split("\n").filter(Boolean).slice(1);
const ids = lines.map((line) => (JSON.parse(line) as RequestMessage).request.id);

switch (mode) {
  case "stall":
    setInterval(() => {}, 1000);
    break;
  case "wrong-id":
    for (const _ of ids) await Bun.write(Bun.stdout, encode({ t: "res", result: { id: "not-yours", ok: true, output: "" } }));
    break;
  case "claim-timeout":
    for (const id of ids) {
      await Bun.write(Bun.stdout, JSON.stringify({ t: "res", result: { id, ok: false, failure: "timeout", message: "lie" } }) + "\n");
    }
    break;
  case "huge":
    await Bun.write(Bun.stdout, "x".repeat(20 * 1024 * 1024));
    setInterval(() => {}, 1000);
    break;
  case "exit":
    process.exit(7);
    break;
  case "skip-ready":
    for (const id of ids) await Bun.write(Bun.stdout, encode({ t: "res", result: { id, ok: true, output: "early" } }));
    break;
  case "noisy":
    await Bun.write(Bun.stderr, "e".repeat(1024 * 1024));
    for (const id of ids) await Bun.write(Bun.stdout, encode({ t: "res", result: { id, ok: true, output: "noisy" } }));
    break;
}
