// Test-only. Starts a render that would spin for hours, says so, then waits to be killed, so a test
// can kill this process and check that its worker dies with it.
// Usage: bun orphan-parent.ts <wait|block>
//   wait:  idle on the event loop, so signal handlers can run.
//   block: freeze the event loop, as a hung parent would, so not even the render timeout can fire.

import { writeSync } from "node:fs";
import { createRenderer } from "../../src/sandbox/index.ts";

const block = process.argv[2] === "block";
const spin = "{% for i in range(1000) %}{% for j in range(1000) %}{% for k in range(1000) %}{% endfor %}{% endfor %}{% endfor %}";
void createRenderer().renderBatch(spin, [{ id: "spin", context: {}, profile: "hf-default" }], { timeoutMs: block ? 1000 : 5000 });
await Bun.sleep(300);
writeSync(1, "rendering\n");
if (block) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
else await Bun.sleep(60_000);
