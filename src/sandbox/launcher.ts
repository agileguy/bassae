// The only place bassae starts a process. Everything it starts runs under the OS sandbox, or not at all.

import type { Subprocess } from "bun";
import type { RenderLimits, RenderRequest, RenderResult } from "../types.ts";

export type SandboxKind = "sandbox-exec" | "bwrap";

export type SandboxStatus = { available: true; kind: SandboxKind } | { available: false; reason: string };

export interface WorkerOptions {
  /** Which sandbox to use. "none" means no sandbox is available, so nothing renders. Defaults to the platform's own. */
  sandbox?: SandboxKind | "none";
  /** What runs inside the sandbox. Defaults to the render worker. */
  command?: string[];
}

export interface WorkerRun {
  /** Results for a prefix of the requests, in order. */
  results: RenderResult[];
  /** Set when the sandboxed worker could not start; requests after `results` were not attempted. */
  sandboxError?: string;
}

/** Starts `argv` under the OS sandbox, or returns undefined when there is none. */
export function spawnSandboxed(_argv: string[], _sandbox?: SandboxKind | "none"): Subprocess<"pipe", "pipe", "pipe"> | undefined {
  throw new Error("not implemented");
}

export function sandboxAvailable(): Promise<SandboxStatus> {
  throw new Error("not implemented");
}

export function runWorker(
  _template: string,
  _requests: RenderRequest[],
  _limits: RenderLimits,
  _options: WorkerOptions = {},
): Promise<WorkerRun> {
  throw new Error("not implemented");
}
