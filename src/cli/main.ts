// The command itself: parse the arguments, run a scan or an extract, print the result, and exit with the
// report's own code (ISC-28). Every usage error or refusal is one line on stderr and exit 3. ../cli.ts, the
// entry point, loads this file only once its crash handlers are in place.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { loadModels, scan } from "../scan/index.ts";
import type { ExitCode, ScanOptions, ScanReport } from "../types.ts";
import { parseArgs, USAGE } from "./args.ts";
import { escapeText } from "./escape.ts";
import { extract, type Loader } from "./extract.ts";
import { renderHuman } from "./human.ts";
import { renderJson } from "./json.ts";
import { defaultRootCandidates, defaultRoots, isDirectory } from "./roots.ts";

/** Everything run() touches outside itself, so tests can stand in for the scan and the terminal. */
export interface Io {
  stdout(text: string): Promise<void>;
  stderr(text: string): Promise<void>;
  env: Record<string, string | undefined>;
  home: string;
  scan(options: ScanOptions): Promise<ScanReport>;
  loadModels: Loader;
  /** Whether a path given on the command line exists. */
  exists(path: string): boolean;
  /** Whether a default model location exists as a directory. */
  isDirectory(path: string): boolean;
  version(): Promise<string>;
}

async function packageVersion(): Promise<string> {
  const pkg = (await Bun.file(new URL("../../package.json", import.meta.url)).json()) as { version: string };
  return pkg.version;
}

export function processIo(): Io {
  return {
    stdout: async (text) => void (await Bun.write(Bun.stdout, text)),
    stderr: async (text) => void (await Bun.write(Bun.stderr, text)),
    env: process.env,
    home: homedir(),
    scan,
    loadModels,
    exists: existsSync,
    isDirectory,
    version: packageVersion,
  };
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const errorCode = (e: unknown) => (e as NodeJS.ErrnoException)?.code;

export async function run(argv: string[], io: Io = processIo()): Promise<ExitCode> {
  // One line, escaped: an argument or a path may carry anything (ISC-44).
  const refuse = async (message: string): Promise<ExitCode> => {
    await io.stderr(`${escapeText(`bassae: ${message}`)}\n`);
    return 3;
  };
  // A reader that stopped early (`| head`) changes nothing that was found, so the code stands. Any other
  // failure to print is the scanner's own, and is 3: never a milder code than the result (runtime SF6).
  const print = async (text: string, code: ExitCode): Promise<ExitCode> => {
    try {
      await io.stdout(text);
      return code;
    } catch (e) {
      return errorCode(e) === "EPIPE" ? code : 3;
    }
  };

  const parsed = parseArgs(argv);
  if (!parsed.ok) return refuse(`${parsed.error} (see bassae --help)`);
  const command = parsed.command;

  if (command.kind === "help") return print(`${USAGE}\n`, 0);
  if (command.kind === "version") return print(`bassae ${await io.version()}\n`, 0);

  if (command.kind === "extract") {
    const result = await extract(command.model, command.out, io.loadModels);
    const code = result.stdout.length > 0 ? await print(`${result.stdout.join("\n")}\n`, result.exitCode) : result.exitCode;
    if (result.stderr.length > 0) await io.stderr(`${result.stderr.join("\n")}\n`);
    return code;
  }

  for (const path of [...command.paths, ...command.templates]) {
    if (!io.exists(path)) return refuse(`no such file or directory: ${path}`);
  }
  let roots = command.paths;
  if (roots.length === 0 && command.templates.length === 0) {
    roots = defaultRoots(io.env, io.home, io.isDirectory);
    if (roots.length === 0) return refuse(`no path given, and none of the default model locations exists: ${defaultRootCandidates(io.env, io.home).join(", ")}`);
  }

  let report: ScanReport;
  try {
    report = await io.scan({ roots, templates: command.templates, online: command.online, ...(command.upstream ? { upstream: command.upstream } : {}) });
  } catch (e) {
    return refuse(`scan failed: ${errorMessage(e)}`);
  }
  // The pipeline set this through exitCodeOf, the same function that ranks statuses (ISC-28).
  return print(command.json ? renderJson(report) : renderHuman(report), report.exitCode);
}

/** run(), with a rejection from anywhere in it reported on one line and given exit 3, never a milder code (ISC-28). */
export async function main(argv: string[], io: Io = processIo()): Promise<ExitCode> {
  try {
    return await run(argv, io);
  } catch (e) {
    await io.stderr(`${escapeText(`bassae: internal error: ${errorMessage(e)}`)}\n`).catch(() => undefined);
    return 3;
  }
}
