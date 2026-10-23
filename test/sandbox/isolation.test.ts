import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { bwrapDegraded, sandboxAvailable, spawnSandboxed } from "../../src/sandbox/launcher.ts";

const status = await sandboxAvailable();
if (!status.available) console.warn(`\n[sandbox] SKIPPING canary under the sandbox: ${status.reason}\n`);

const CANARY = join(import.meta.dir, "canary.ts");
const ROOT = join(import.meta.dir, "../..");

interface CanaryReport {
  write: string;
  read: string;
  stat: string;
  home: string;
  checkout: string;
  spawn: string;
  userns: string;
  sysctl: string;
  connect: string;
}

// The launcher passes --disable-userns only to a bwrap that has it (0.8 and later).
const disablesUserns = status.available && status.kind === "bwrap" && Bun.spawnSync(["bwrap", "--help"]).stdout.toString().includes("--disable-userns");

/** Runs the canary against fresh temp dirs, one of them in $HOME, a file in this checkout, and a live local TCP listener. */
async function runCanary(start: (argv: string[]) => { stdout: ReadableStream<Uint8Array>; exited: Promise<number> } | undefined) {
  const dir = mkdtempSync(join(tmpdir(), "bassae-canary-"));
  const home = mkdtempSync(join(homedir(), ".bassae-canary-"));
  const writePath = join(dir, "written.txt");
  const readPath = join(dir, "secret.txt");
  const homePath = join(home, "secret.txt");
  writeFileSync(readPath, "secret");
  writeFileSync(homePath, "secret");
  let accepted = 0;
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        accepted++;
        socket.end();
      },
      data() {},
    },
  });
  try {
    const proc = start([process.execPath, CANARY, writePath, String(server.port), readPath, homePath, join(ROOT, "package.json")]);
    if (!proc) throw new Error("sandbox refused to start the canary");
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return { report: JSON.parse(out) as CanaryReport, wrote: existsSync(writePath), accepted };
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

test("sandbox availability is reported, and required where CI says so", () => {
  console.log(`[sandbox] ${process.platform}: ${JSON.stringify(status)}`);
  if (process.env.BASSAE_REQUIRE_SANDBOX) expect(status.available).toBe(true);
  if (process.platform === "darwin") expect(status).toEqual({ available: true, kind: "sandbox-exec", degraded: [] });
  if (!status.available) expect(status.reason.length).toBeGreaterThan(0);
});

test("a bwrap without --disable-userns is a downgrade the status names, not a silent one", () => {
  expect(bwrapDegraded("usage: bwrap [OPTIONS...] [--] COMMAND [ARGS...]\n    --unshare-user  Create new user namespace")).toEqual([
    expect.stringContaining("--disable-userns"),
  ]);
  expect(bwrapDegraded("    --disable-userns  Disable further use of user namespaces inside sandbox")).toEqual([]);
  if (status.available && status.kind === "bwrap") expect(status.degraded).toEqual(disablesUserns ? [] : [expect.stringContaining("--disable-userns")]);
});

test("control: outside the sandbox the canary can write, read and connect", async () => {
  const { report, wrote, accepted } = await runCanary((argv) => Bun.spawn(argv, { stdout: "pipe" }));
  const userns = process.platform === "linux" ? "ok" : "n/a";
  const sysctl = process.platform === "darwin" ? "ok" : "n/a";
  expect(report).toEqual({ write: "ok", read: "ok", stat: "ok", home: "ok", checkout: "ok", spawn: "ok", userns, sysctl, connect: "ok" });
  expect(wrote).toBe(true);
  expect(accepted).toBe(1);
});

test.skipIf(!status.available)("under the worker's sandbox wrapper the canary cannot write, read or connect (ISC-43.1)", async () => {
  const { report, wrote, accepted } = await runCanary((argv) => spawnSandboxed(argv, { readable: [CANARY] }));
  console.log(`[sandbox] canary under ${status.available ? status.kind : "-"}: ${JSON.stringify(report)}`);
  expect(report.write).toStartWith("denied");
  expect(report.read).toStartWith("denied");
  expect(report.connect).toStartWith("denied");
  // Nothing beyond what the worker needs: not $HOME, not the rest of the checkout, not even a stat.
  expect(report.home).toStartWith("denied");
  expect(report.checkout).toStartWith("denied");
  expect(report.stat).toStartWith("denied");
  expect(wrote).toBe(false);
  expect(accepted).toBe(0);
  // bwrap has no exec filter; the macOS profile denies fork outright.
  if (status.available && status.kind === "sandbox-exec") expect(report.spawn).toStartWith("denied");
  // The macOS profile allows only the sysctls bun reads to start, not the host's name.
  if (status.available && status.kind === "sandbox-exec") expect(report.sysctl).toStartWith("denied");
  // Not even a helper the worker could reach may make a user namespace of its own.
  if (disablesUserns) expect(report.userns).toStartWith("denied");
});

test("with no sandbox, nothing is started at all", () => {
  expect(spawnSandboxed([process.execPath, "-e", "0"], { sandbox: "none" })).toBeUndefined();
});

async function sourceFiles(dir: string): Promise<{ path: string; text: string }[]> {
  const files = [];
  for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: join(ROOT, dir) })) {
    files.push({ path: `${dir}/${path}`, text: await Bun.file(join(ROOT, dir, path)).text() });
  }
  return files;
}

test("ISC-37: process spawning appears in src/ only in the launcher", async () => {
  const hits = (await sourceFiles("src")).filter((f) => /import.*jinja2|Bun\.spawn|child_process/.test(f.text)).map((f) => f.path);
  expect(hits).toEqual(["src/sandbox/launcher.ts"]);
});

test("ISC-36: nothing in src/sandbox reaches for the network", async () => {
  const net = /\bfetch\b|Bun\.(connect|listen|serve)|node:(net|http|https|http2|dgram|tls|dns)|\bWebSocket\b/;
  const hits = (await sourceFiles("src/sandbox")).filter((f) => net.test(f.text)).map((f) => f.path);
  expect(hits).toEqual([]);
});
