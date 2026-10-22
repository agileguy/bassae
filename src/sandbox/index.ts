import type { Renderer } from "../types.ts";
import type { WorkerOptions } from "./launcher.ts";

export { sandboxAvailable } from "./launcher.ts";
export type { SandboxKind, SandboxStatus, WorkerOptions } from "./launcher.ts";

export function createRenderer(_options: WorkerOptions = {}): Renderer {
  throw new Error("not implemented");
}
