// Test-only. Starts a render that would spin for hours, says so, then waits to be killed, so a test
// can kill this process and check that its worker dies with it.
// Usage: bun orphan-parent.ts <wait|block|swallow|graceful>
//   wait:     idle on the event loop, so signal handlers can run.
//   block:    freeze the event loop, as a hung parent would, so not even the render timeout can fire.
//   swallow:  like wait, but live through SIGINT, as a host program may, and start a fresh render after each one.
//   graceful: like wait, but meet SIGTERM with a shutdown of its own that takes a second, then exit 0.

import { writeSync } from "node:fs";
import { createRenderer } from "../../src/sandbox/index.ts";

const mode = process.argv[2];
const block = mode === "block";
const spin = "{% for i in range(1000) %}{% for j in range(1000) %}{% for k in range(1000) %}{% endfor %}{% endfor %}{% endfor %}";

async function render(): Promise<void> {
  void createRenderer().renderBatch(spin, [{ id: "spin", context: {}, profile: "hf-default" }], { timeoutMs: block ? 1000 : 5000 });
  await Bun.sleep(300);
  writeSync(1, "rendering\n");
}

// Both listeners go in before the first render, so before the renderer's own. The renderer's still runs
// first: it kills the old workers, then the host's starts a fresh render, or shuts down.
if (mode === "swallow") process.on("SIGINT", () => void render());
if (mode === "graceful") {
  process.once("SIGTERM", async () => {
    await Bun.sleep(1000);
    writeSync(1, "shut down\n");
    process.exit(0);
  });
}
await render();
if (block) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
else await Bun.sleep(60_000);
