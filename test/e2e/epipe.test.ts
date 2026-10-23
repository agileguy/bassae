// Runtime SF6: a failure to print never weakens the exit code (ISC-28). A reader that goes away early (EPIPE)
// leaves the verdict standing; any other write error, uncaught exception or unhandled rejection is 3.

import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type Io, main, run } from "../../src/cli.ts";
import type { ScanReport } from "../../src/types.ts";
import { finding, model, report, template } from "../cli/fixtures/reports.ts";
import { makeTree, removeTrees } from "../helpers/tree.ts";
import { CHATML_HIGH } from "../scan/fixtures/pipeline.ts";
import { CLI, fixtureEnv, ROOT, SCAN_TIMEOUT } from "./fixtures/cli.ts";

afterAll(removeTrees);

const HIGH = report([model([template("findings", [finding("HIGH", "dunder_access")])])]);

function writeError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: write failed`), { code });
}

function io(stdout: Io["stdout"], extra: Partial<Io> = {}): Io {
  return {
    stdout,
    stderr: async () => undefined,
    env: {},
    home: "/home/u",
    scan: async (): Promise<ScanReport> => HIGH,
    loadModels: async () => ({ models: [], findings: [], walked: [] }),
    exists: () => true,
    isDirectory: () => false,
    version: async () => "9.9.9",
    ...extra,
  };
}

describe("run: a failed write", () => {
  test("EPIPE on stdout keeps the report's exit code", async () => {
    expect(HIGH.exitCode).toBe(2);
    expect(await run(["/m"], io(async () => Promise.reject(writeError("EPIPE"))))).toBe(2);
    expect(await run(["--json", "/m"], io(async () => Promise.reject(writeError("EPIPE"))))).toBe(2);
  });

  test("EPIPE on --help or --version keeps exit 0", async () => {
    expect(await run(["--help"], io(async () => Promise.reject(writeError("EPIPE"))))).toBe(0);
    expect(await run(["--version"], io(async () => Promise.reject(writeError("EPIPE"))))).toBe(0);
  });

  test("any other write error is 3, never the milder code the report holds", async () => {
    const clean = report([model([template("known-good")])]);
    expect(clean.exitCode).toBe(0);
    for (const code of ["EIO", "ENOSPC", "EBADF"]) {
      expect(await run(["/m"], io(async () => Promise.reject(writeError(code)), { scan: async () => clean }))).toBe(3);
    }
    expect(await run(["/m"], io(async () => Promise.reject(new Error("no code at all"))))).toBe(3);
  });
});

describe("main: nothing escapes as a milder code", () => {
  test("a rejection anywhere in run is 3, with one escaped line on stderr", async () => {
    const err: string[] = [];
    const code = await main(["/m"], {
      ...io(async () => undefined),
      stderr: async (t) => void err.push(t),
      exists: () => {
        throw new Error("stat exploded \x1b[2J");
      },
    });
    expect(code).toBe(3);
    expect(err).toEqual(["bassae: internal error: stat exploded \\x1B[2J\n"]);
  });
});

describe("the real command", () => {
  // CHATML_HIGH and 4000 literals: a HIGH report of about a megabyte, far past what a pipe buffers.
  const dir = makeTree({ "high.jinja": CHATML_HIGH + Array.from({ length: 4000 }, (_, i) => `note${i}{{ pad }}`).join("") });
  const high = join(dir, "high.jinja");

  async function piped(args: string[], reader: string): Promise<{ code: string; stderr: string }> {
    const script = `"$0" "$@" | ${reader} > /dev/null; echo "\${PIPESTATUS[0]}"`;
    const p = Bun.spawn(["bash", "-c", script, process.execPath, CLI, ...args], { cwd: ROOT, env: fixtureEnv(), stdout: "pipe", stderr: "pipe" });
    const [out, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code: out.trim(), stderr };
  }

  test("piped into head -c 100, a HIGH scan still exits 2", async () => {
    for (const args of [["--json", "--template", high], ["--template", high]]) {
      const result = await piped(args, "head -c 100");
      expect(result).toEqual({ code: "2", stderr: "" });
    }
  }, SCAN_TIMEOUT);

  test("piped into a reader that never reads, a HIGH scan still exits 2", async () => {
    expect(await piped(["--json", "--template", high], "true")).toEqual({ code: "2", stderr: "" });
  }, SCAN_TIMEOUT);

  test("an uncaught exception or an unhandled rejection exits 3", async () => {
    const hooks = makeTree({
      "throw.ts": `setTimeout(() => { throw new Error("late throw"); }, 0);`,
      "reject.ts": `setTimeout(() => { Promise.reject(new Error("late rejection")); }, 0);`,
    });
    for (const [file, message] of [["throw.ts", "late throw"], ["reject.ts", "late rejection"]] as const) {
      const p = Bun.spawn([process.execPath, "--preload", join(hooks, file), CLI, "--version"], { cwd: ROOT, env: fixtureEnv(), stdout: "pipe", stderr: "pipe" });
      const [, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      expect(code).toBe(3);
      expect(stderr).toContain(`bassae: internal error: ${message}`);
    }
  }, SCAN_TIMEOUT);
});
