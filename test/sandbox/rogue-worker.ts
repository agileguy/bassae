// Test-only stand-in for the render worker that misbehaves on purpose, so the tests can check
// that the parent enforces the caps itself instead of trusting the worker.
// Usage: bun rogue-worker.ts <stall|wrong-id|claim-timeout|huge|exit|ffi-exit|noisy|skip-ready|fat-error|wide-error|fat-parsed|xcpu|lagging|late|slow-claim>

import { dlopen, FFIType } from "bun:ffi";
import { encode, type RequestMessage } from "../../src/sandbox/protocol.ts";

const mode = process.argv[2];
const say = (line: string) => Bun.write(Bun.stdout, line);
const fails = (id: string, message: string) => JSON.stringify({ t: "res", result: { id, ok: false, failure: "render_error", message }, ms: 1 }) + "\n";
const answers = (id: string, output: string, ms = 1) => say(encode({ t: "res", result: { id, ok: true, output }, ms }));

if (mode !== "skip-ready") await say(encode({ t: "ready" }));
const lines = (await Bun.stdin.text()).split("\n").filter(Boolean).slice(1);
const ids = lines.map((line) => (JSON.parse(line) as RequestMessage).request.id);
if (mode === "fat-parsed") await say(JSON.stringify({ t: "parsed", ms: 1, pad: "p".repeat(100_000) }) + "\n");
else if (mode !== "skip-ready") await say(encode({ t: "parsed", ms: 1 }));

switch (mode) {
  case "stall":
    setInterval(() => {}, 1000);
    break;
  case "wrong-id":
    for (const _ of ids) await answers("not-yours", "");
    break;
  case "claim-timeout":
    for (const id of ids) {
      await say(JSON.stringify({ t: "res", result: { id, ok: false, failure: "timeout", message: "lie" }, ms: 1 }) + "\n");
    }
    break;
  case "huge":
    await say("x".repeat(20 * 1024 * 1024));
    setInterval(() => {}, 1000);
    break;
  case "exit":
    process.exit(7);
    break;
  case "ffi-exit":
    // Loads the C library as the real worker does, which on macOS once wrote an xcode-select line to stderr, then dies saying why.
    dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", { getpid: { args: [], returns: FFIType.i32 } });
    await Bun.write(Bun.stderr, "worker fell over\n");
    process.exit(7);
    break;
  case "skip-ready":
    for (const id of ids) await answers(id, "early");
    break;
  case "noisy":
    await Bun.write(Bun.stderr, "e".repeat(1024 * 1024));
    for (const id of ids) await answers(id, "noisy");
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
    // What the kernel does once a step has used its CPU allowance, to a worker that has turned off core dumps as the real one does.
    if (process.platform === "linux") {
      dlopen("libc.so.6", { prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 } }).symbols.prctl(4, 0, 0, 0, 0);
    }
    process.kill(process.pid, "SIGXCPU");
    setInterval(() => {}, 1000);
    break;
  case "lagging":
    // Each answer comes 800 ms after the last, though by the worker's clock each render took 1 ms.
    for (const id of ids) {
      await Bun.sleep(800);
      await answers(id, "lagging");
    }
    break;
  case "late":
    // Answers the first request two seconds after the parse, then never answers again.
    await Bun.sleep(2000);
    await answers(ids[0]!, "late");
    setInterval(() => {}, 1000);
    break;
  case "slow-claim":
    // Answers at once, but by its own clock every render took far longer than any cap.
    for (const id of ids) await answers(id, "slow", 10_000_000);
    break;
}
