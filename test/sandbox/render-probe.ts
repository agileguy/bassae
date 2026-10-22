// Test-only. Checks the sandbox and renders one template through the real renderer, then prints
// what came back, so a test can run it from any working directory.
// Usage: bun render-probe.ts

import { createRenderer, sandboxAvailable } from "../../src/sandbox/index.ts";

const status = await sandboxAvailable();
const results = await createRenderer().renderBatch("{{ x }}", [{ id: "a", context: { x: "hi" }, profile: "hf-default" }]);
process.stdout.write(JSON.stringify({ status, results }) + "\n");
