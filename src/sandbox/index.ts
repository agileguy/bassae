// The renderer the scanner calls: one sandboxed worker per template, respawned after any cap breach.

import { DEFAULT_RENDER_LIMITS, type Renderer, type RenderLimits, type RenderRequest, type RenderResult } from "../types.ts";
import { runWorker, type WorkerOptions } from "./launcher.ts";

export { sandboxAvailable } from "./launcher.ts";
export type { SandboxKind, SandboxStatus, WorkerOptions } from "./launcher.ts";

function serializable(request: RenderRequest): boolean {
  try {
    JSON.stringify(request);
    return true;
  } catch {
    return false;
  }
}

async function renderAll(template: string, requests: RenderRequest[], limits: RenderLimits, options: WorkerOptions): Promise<RenderResult[]> {
  const results: RenderResult[] = [];
  while (results.length < requests.length) {
    let sandboxError: string | undefined;
    try {
      const run = await runWorker(template, requests.slice(results.length), limits, options);
      results.push(...run.results);
      // Every run answers at least one request or says why it could not; anything else would loop forever.
      sandboxError = run.sandboxError ?? (run.results.length === 0 ? "worker made no progress" : undefined);
    } catch (e) {
      sandboxError = `renderer failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (sandboxError !== undefined) {
      for (const { id } of requests.slice(results.length)) results.push({ id, ok: false, failure: "sandbox", message: sandboxError });
    }
  }
  return results;
}

/**
 * Options can only pick a sandbox, declare there is none, change what runs inside one and what it may
 * read, or change how its memory is read. Nothing renders outside a sandbox; when none starts, every
 * result is a `sandbox` failure.
 */
export function createRenderer(options: WorkerOptions = {}): Renderer {
  return {
    async renderBatch(template, requests, limits = {}) {
      const caps: RenderLimits = {
        timeoutMs: limits.timeoutMs ?? DEFAULT_RENDER_LIMITS.timeoutMs,
        maxRssBytes: limits.maxRssBytes ?? DEFAULT_RENDER_LIMITS.maxRssBytes,
        maxOutputBytes: limits.maxOutputBytes ?? DEFAULT_RENDER_LIMITS.maxOutputBytes,
      };
      // A request that cannot cross the pipe fails on its own; the rest still render.
      const rejected = requests.map((r): RenderResult | undefined =>
        serializable(r) ? undefined : { id: r.id, ok: false, failure: "render_error", message: "request is not JSON-serializable" },
      );
      const rendered = await renderAll(template, requests.filter((_, i) => !rejected[i]), caps, options);
      let next = 0;
      return rejected.map((r) => r ?? rendered[next++]!);
    },
  };
}
