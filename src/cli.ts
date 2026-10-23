#!/usr/bin/env bun
// bassae's entry point: parse the arguments, run a scan or an extract, print the result, and exit with
// the report's own code (ISC-28). Every usage error or refusal is one line on stderr and exit 3.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs, USAGE } from "./cli/args.ts";
import { escapeText } from "./cli/escape.ts";
import { extract, type Loader } from "./cli/extract.ts";
import { renderHuman } from "./cli/human.ts";
import { renderJson } from "./cli/json.ts";
import { defaultRootCandidates, defaultRoots, isDirectory } from "./cli/roots.ts";
import { loadModels, scan } from "./scan/index.ts";
import type { ExitCode, ScanOptions, ScanReport } from "./types.ts";

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
  const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as { version: string };
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

export async function run(argv: string[], io: Io = processIo()): Promise<ExitCode> {
  // One line, escaped: an argument or a path may carry anything (ISC-44).
  const refuse = async (message: string): Promise<ExitCode> => {
    await io.stderr(`${escapeText(`bassae: ${message}`)}\n`);
    return 3;
  };

  const parsed = parseArgs(argv);
  if (!parsed.ok) return refuse(`${parsed.error} (see bassae --help)`);
  const command = parsed.command;

  if (command.kind === "help") {
    await io.stdout(`${USAGE}\n`);
    return 0;
  }
  if (command.kind === "version") {
    await io.stdout(`bassae ${await io.version()}\n`);
    return 0;
  }

  if (command.kind === "extract") {
    const result = await extract(command.model, command.out, io.loadModels);
    if (result.stdout.length > 0) await io.stdout(`${result.stdout.join("\n")}\n`);
    if (result.stderr.length > 0) await io.stderr(`${result.stderr.join("\n")}\n`);
    return result.exitCode;
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
  await io.stdout(command.json ? renderJson(report) : renderHuman(report));
  // The pipeline set this through exitCodeOf, the same function that ranks statuses (ISC-28).
  return report.exitCode;
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2));
