// Test-only. Makes a renderer, then sets a property on Object.prototype before the first render, as a probe path
// once could (review round 1, runtime 1), and prints what came back.
// Usage: bun polluted-parent.ts

import { createRenderer } from "../../src/sandbox/index.ts";

const renderer = createRenderer();
const proto = Object.prototype as Record<string, unknown>;
proto.unavailable = "x";
try {
  const results = await renderer.renderBatch("{% for i in range(300000) %}{% endfor %}{{ x }}", [{ id: "a", context: { x: "hi" }, profile: "hf-default" }]);
  process.stdout.write(JSON.stringify(results) + "\n");
} finally {
  delete proto.unavailable;
}
