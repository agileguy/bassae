// The renderer the scanner calls: one sandboxed worker per template, which stops at the first cap breach.

import { CAP_FAILURES, DEFAULT_RENDER_LIMITS, type Renderer, type RenderLimits, type RenderRequest, type RenderResult } from "../types.ts";
import { openDarwinRss, runWorker, type WorkerOptions } from "./launcher.ts";

export { sandboxAvailable } from "./launcher.ts";
export type { SandboxKind, SandboxStatus, WorkerOptions } from "./launcher.ts";

/** The bytes a request takes on the pipe, or undefined when it cannot cross it. */
function size(request: RenderRequest): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(request));
  } catch {
    return undefined;
  }
}

// A worker reads and holds its whole batch before it renders, so a batch is cut at this much request JSON: about
// 45 MiB of worker at its peak, well under the 256 MiB memory cap. A request bigger than that goes alone.
const MAX_BATCH_BYTES = 16 * 2 ** 20;

const isBreach = (r: RenderResult) => !r.ok && CAP_FAILURES.has(r.failure);

// After the first cap breach nothing more renders for the template (Decisions 02:58), whatever the renders between
// would have done: a render that fails at once must not buy a hostile template another timeout. The rest of the
// batch is `skipped`, not the cap: those requests never ran, so they breached nothing of their own.
async function renderAll(template: string, requests: RenderRequest[], sizes: number[], limits: RenderLimits, options: WorkerOptions): Promise<RenderResult[]> {
  const results: RenderResult[] = [];
  while (results.length < requests.length) {
    let end = results.length + 1;
    for (let bytes = sizes[results.length]!; end < requests.length && bytes + sizes[end]! <= MAX_BATCH_BYTES; end++) bytes += sizes[end]!;
    let sandboxError: string | undefined;
    try {
      const run = await runWorker(template, requests.slice(results.length, end), limits, options);
      // A breach before the template parsed fails every request the worker had; the first one carries it, as any other breach.
      const at = run.results.findIndex(isBreach);
      if (at >= 0) {
        const hit = run.results[at] as RenderResult & { ok: false };
        results.push(...run.results.slice(0, at + 1));
        const message = `not attempted: an earlier render on this template hit the ${hit.failure} cap`;
        for (const { id } of requests.slice(results.length)) results.push({ id, ok: false, failure: "skipped", message });
        break;
      }
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
  // macOS reads a worker's memory through libproc. Open it now, before any probe is built, so nothing a template
  // does to the scanner's objects can stop it opening later. Should it fail here, the first poll fails closed.
  if (process.platform === "darwin" && !options.residentMemory) {
    try {
      openDarwinRss();
    } catch {
      // left to the first poll
    }
  }
  return {
    async renderBatch(template, requests, limits = {}) {
      const caps: RenderLimits = {
        timeoutMs: limits.timeoutMs ?? DEFAULT_RENDER_LIMITS.timeoutMs,
        maxRssBytes: limits.maxRssBytes ?? DEFAULT_RENDER_LIMITS.maxRssBytes,
        maxOutputBytes: limits.maxOutputBytes ?? DEFAULT_RENDER_LIMITS.maxOutputBytes,
      };
      // A request that cannot cross the pipe fails on its own; the rest still render.
      const sizes = requests.map(size);
      const rejected = requests.map((r, i): RenderResult | undefined =>
        sizes[i] !== undefined ? undefined : { id: r.id, ok: false, failure: "render_error", message: "request is not JSON-serializable" },
      );
      const kept = sizes.flatMap((bytes) => (bytes === undefined ? [] : [bytes]));
      const rendered = await renderAll(template, requests.filter((_, i) => !rejected[i]), kept, caps, options);
      let next = 0;
      return rejected.map((r) => r ?? rendered[next++]!);
    },
  };
}
