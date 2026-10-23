// Runs the real bassae command as a subprocess, with HOME and every model-store variable pointed into a
// temp dir, so no test ever scans the machine's own model folders.

import Ajv2020 from "ajv/dist/2020";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import schema from "../../../schema/report.schema.json";
import type { ScanReport } from "../../../src/types.ts";

export const ROOT = join(import.meta.dir, "..", "..", "..");
export const CLI = join(ROOT, "src", "cli.ts");

// A whole-tree scan runs the real command and renders every template in the sandbox: about 3 s on a CI runner,
// so a test running two would pass Bun's 5 s default only on a fast machine.
export const SCAN_TIMEOUT = 60_000;

// A HOME with no model stores in it. Not a makeTree tree: each test file's removeTrees must not take it away.
const HOME = mkdtempSync(join(realpathSync(tmpdir()), "bassae-e2e-home-"));
process.on("exit", () => rmSync(HOME, { recursive: true, force: true }));

/** The environment every run gets: what bun needs, and model locations that hold nothing. */
export function fixtureEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME,
    HF_HOME: join(HOME, "hf"),
    HF_HUB_CACHE: join(HOME, "hf", "hub"),
    XDG_CACHE_HOME: join(HOME, ".cache"),
    OLLAMA_MODELS: join(HOME, "ollama"),
    TMPDIR: tmpdir(),
    NO_COLOR: "1",
  };
  if (process.env.BASSAE_REQUIRE_SANDBOX) env.BASSAE_REQUIRE_SANDBOX = process.env.BASSAE_REQUIRE_SANDBOX;
  return { ...env, ...extra };
}

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout as raw bytes, for the byte checks of ISC-44. */
  bytes: Uint8Array;
}

/**
 * `bun src/cli.ts ...args`, optionally inside a wrapper command such as a deny-network sandbox.
 * Bun.spawn, not spawnSync: under bun test on macOS, spawnSync now and then misses a child's exit,
 * leaves it a zombie and spins at full CPU (bun 1.3.12).
 */
export async function bassae(args: string[], options: { wrap?: string[] } = {}): Promise<Run> {
  const p = Bun.spawn([...(options.wrap ?? []), process.execPath, CLI, ...args], { cwd: ROOT, env: fixtureEnv(), stdout: "pipe", stderr: "pipe" });
  const [out, stderr, code] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited]);
  const bytes = new Uint8Array(out);
  return { code, stdout: new TextDecoder().decode(bytes), stderr, bytes };
}

/** The parsed --json report of a run; fails loudly with stderr when there is none. */
export function reportOf(run: Run): ScanReport {
  try {
    return JSON.parse(run.stdout) as ScanReport;
  } catch {
    throw new Error(`no JSON report on stdout (exit ${run.code}): ${run.stderr.slice(0, 2000)}`);
  }
}

const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

/** Every error checked-in schema/report.schema.json finds in printed --json output (ISC-27). */
export function schemaErrors(run: Run): string[] {
  return validate(JSON.parse(run.stdout)) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}
