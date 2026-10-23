// Test-only canary. Run it under the same sandbox wrapper as the render worker; it tries
// what a hijacked worker would try and prints one JSON line saying what got through.
// Usage: bun canary.ts <write-path> <tcp-port> <read-path> <home-path> <checkout-path>

import { dlopen, FFIType, ptr } from "bun:ffi";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";

const [writePath = "", portArg = "0", readPath = "", homePath = "", checkoutPath = ""] = process.argv.slice(2);

function attempt(fn: () => void): string {
  try {
    fn();
    return "ok";
  } catch (e) {
    return `denied: ${(e as NodeJS.ErrnoException).code ?? String(e)}`;
  }
}

function tryConnect(port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("denied: timeout");
    }, 2000);
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve("ok");
    });
    socket.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve(`denied: ${e.code ?? e.message}`);
    });
  });
}

const report = {
  write: attempt(() => writeFileSync(writePath, "canary")),
  read: attempt(() => readFileSync(readPath)),
  stat: attempt(() => statSync(readPath)),
  home: attempt(() => readFileSync(homePath)),
  checkout: attempt(() => readFileSync(checkoutPath)),
  spawn: attempt(() => {
    const p = Bun.spawnSync(["/bin/echo", "canary"]);
    if (!p.success) throw new Error(`exit ${p.exitCode}`);
  }),
  // A threaded process cannot unshare a user namespace itself, so ask a single-threaded helper to. Linux only.
  userns:
    process.platform !== "linux"
      ? "n/a"
      : attempt(() => {
          const p = Bun.spawnSync(["/usr/bin/unshare", "--user", "/usr/bin/true"], { stderr: "pipe" });
          if (!p.success) throw new Error(p.stderr.toString().trim() || `exit ${p.exitCode}`);
        }),
  // A sysctl the worker has no use for, the host's name. macOS only: bwrap filters no sysctl.
  sysctl:
    process.platform !== "darwin"
      ? "n/a"
      : attempt(() => {
          const { sysctlbyname } = dlopen("/usr/lib/libSystem.B.dylib", {
            sysctlbyname: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
          }).symbols;
          const name = Buffer.from("kern.hostname\0");
          const value = new Uint8Array(256);
          const size = new BigUint64Array([256n]);
          if (sysctlbyname(ptr(name), ptr(value), ptr(size), null, 0) !== 0) throw new Error("sysctlbyname failed");
        }),
  connect: await tryConnect(Number(portArg)),
};
process.stdout.write(JSON.stringify(report) + "\n");
