// Test-only canary. Run it under the same sandbox wrapper as the render worker; it tries
// what a hijacked worker would try and prints one JSON line saying what got through.
// Usage: bun canary.ts <write-path> <tcp-port> <read-path>

import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";

const [writePath = "", portArg = "0", readPath = ""] = process.argv.slice(2);

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
  spawn: attempt(() => {
    const p = Bun.spawnSync(["/bin/echo", "canary"]);
    if (!p.success) throw new Error(`exit ${p.exitCode}`);
  }),
  connect: await tryConnect(Number(portArg)),
};
process.stdout.write(JSON.stringify(report) + "\n");
