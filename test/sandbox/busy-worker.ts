// Test-only. The real render worker, with a second thread kept busy 3 ms in every 10, so the process
// uses about 1.3 s of CPU a second, as a render that allocates hard does with its GC threads.
// Usage: bun busy-worker.ts

const nap = new Int32Array(new SharedArrayBuffer(4));

if (Bun.isMainThread) {
  const helper = new Worker(import.meta.path);
  // The render worker starts only once the helper is busy, so a helper that cannot start fails the startup.
  await new Promise((resolve, reject) => {
    helper.onmessage = resolve;
    helper.onerror = reject;
  });
  helper.unref();
  await import("../../src/sandbox/worker.ts");
} else {
  postMessage("busy");
  for (;;) {
    for (const until = performance.now() + 3; performance.now() < until; );
    Atomics.wait(nap, 0, 0, 7);
  }
}
