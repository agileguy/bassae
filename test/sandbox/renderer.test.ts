import { Template } from "@huggingface/jinja";
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRenderer, sandboxAvailable } from "../../src/sandbox/index.ts";
import { darwinRss, linuxTreeRss, runWorker } from "../../src/sandbox/launcher.ts";
import { MEMORY_EXIT_CODE, MESSAGE_KEEP, SPENT_EXIT_CODE, TIMEOUT_EXIT_CODE, TRUNCATED } from "../../src/sandbox/protocol.ts";
import type { RenderFailure, RenderRequest, RenderResult } from "../../src/types.ts";

const status = await sandboxAvailable();
const live = status.available;
if (!live) {
  console.warn(`\n[sandbox] SKIPPING live render tests: ${status.reason}\n[sandbox] Only fail-closed behavior is checked here.\n`);
}

const BUN = process.execPath;
const ROGUE = join(import.meta.dir, "rogue-worker.ts");
const PROBE = join(import.meta.dir, "render-probe.ts");
const POLLUTED = join(import.meta.dir, "polluted-parent.ts");
const DEAD = join(import.meta.dir, "dead-worker.ts");
const BUSY = join(import.meta.dir, "busy-worker.ts");
const SLOW = 30_000;
// Spins for hours on small ranges, staying near 100 MiB for its first seconds, so only a timeout or a kill ends it.
const SPIN = "{% for i in range(1000) %}{% for j in range(1000) %}{% for k in range(1000) %}{% endfor %}{% endfor %}{% endfor %}";

const req = (id: string, context: Record<string, unknown> = {}, extra: Partial<RenderRequest> = {}): RenderRequest => ({
  id,
  context,
  profile: "hf-default",
  ...extra,
});

const ok = (id: string, output: string): RenderResult => ({ id, ok: true, output });
const failed = (id: string, failure: RenderFailure): RenderResult => ({ id, ok: false, failure, message: expect.any(String) });
/** Not attempted because an earlier render on the template breached `cap` (Decisions 02:58). */
const skipped = (id: string, cap: RenderFailure): RenderResult => ({ id, ok: false, failure: "skipped", message: expect.stringContaining(`hit the ${cap} cap`) });

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const value = await fn();
  return [value, performance.now() - start];
}

const renderer = createRenderer();

/** Stops this process's event loop, as a scanner busy elsewhere does, for `ms`. */
const block = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const CHATML =
  "{% for message in messages %}<|im_start|>{{ message.role }}\n{{ message.content }}<|im_end|>\n{% endfor %}" +
  "{% if add_generation_prompt %}<|im_start|>assistant\n{% endif %}";

describe("fail closed", () => {
  test("with no sandbox available, every result is a sandbox failure", async () => {
    const results = await createRenderer({ sandbox: "none" }).renderBatch("{{ x }}", [req("a"), req("b")]);
    expect(results).toEqual([failed("a", "sandbox"), failed("b", "sandbox")]);
  });

  test("when the sandboxed worker dies before it is ready, every result is a sandbox failure", async () => {
    const broken = createRenderer({ command: [BUN, "-e", "process.exit(3)"] });
    const results = await broken.renderBatch("{{ x }}", [req("a"), req("b"), req("c")]);
    expect(results).toEqual([failed("a", "sandbox"), failed("b", "sandbox"), failed("c", "sandbox")]);
  });

  test("the default renderer renders, or fails closed when the sandbox is unavailable", async () => {
    const results = await renderer.renderBatch("{{ x }}", [req("a", { x: "hi" })]);
    expect(results).toEqual(live ? [ok("a", "hi")] : [failed("a", "sandbox")]);
  });

  test("an empty batch starts nothing and returns nothing", async () => {
    expect(await createRenderer({ sandbox: "none" }).renderBatch("{{ x }}", [])).toEqual([]);
  });
});

describe.skipIf(!live)("from any working directory", () => {
  // The caller's own working directory, not just the worker's: the probe imports and runs the renderer from there.
  for (const cwd of [tmpdir(), "/"]) {
    test(
      `renders when the calling process runs from ${cwd}`,
      async () => {
        const proc = Bun.spawn([BUN, PROBE], { cwd, stdout: "pipe", stderr: "pipe" });
        const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        expect(err).toBe("");
        expect(JSON.parse(out)).toEqual({ status, results: [ok("a", "hi")] });
      },
      SLOW,
    );
  }
});

describe.skipIf(!live || process.platform !== "darwin")("a polluted scanner", () => {
  // bun:ffi's dlopen throws once Object.prototype has a property of its own, so libproc opens with the renderer,
  // before any probe is built. A fresh process, because this one opened it long ago.
  test(
    "still reads a worker's memory when Object.prototype is polluted after the renderer is made",
    async () => {
      const proc = Bun.spawn([BUN, POLLUTED], { stdout: "pipe", stderr: "pipe" });
      const [out] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(JSON.parse(out)).toEqual([ok("a", "hi")]);
    },
    SLOW,
  );
});

describe.skipIf(!live)("a worker that dies before reading its batch", () => {
  // The batch outruns the pipe, so the writes still pending when the worker dies reject. Unhandled, any one of them
  // ends the whole scan with exit 3. A fresh process, so that what it counts is only its own.
  test(
    "fails each of its requests as `sandbox` and leaves no rejection unhandled",
    async () => {
      const proc = Bun.spawn([BUN, DEAD], { stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect({ code, err: err.slice(0, 2000) }).toEqual({ code: 0, err: "" });
      expect(JSON.parse(out)).toEqual({ unhandled: 0, failures: [Array(80).fill("sandbox"), Array(80).fill("sandbox")] });
    },
    SLOW,
  );
});

describe.skipIf(!live)("rendering", () => {
  test("returns one result per request, in order, with ids echoed", async () => {
    const requests = Array.from({ length: 20 }, (_, i) => req(`r${i}`, { n: i }));
    const results = await renderer.renderBatch("<{{ n }}>", requests);
    expect(results).toEqual(requests.map((r, i) => ok(r.id, `<${i}>`)));
  });

  test("output is byte-identical to the library rendering in-process", async () => {
    const tricky = "plain, \u0000 nul,   sep, ‮ bidi, \u{1f600} emoji, \"quotes\" and \\ slashes\n";
    const context = {
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: tricky },
      ],
      add_generation_prompt: true,
    };
    const results = await renderer.renderBatch(CHATML, [req("a", context)]);
    expect(results).toEqual([ok("a", new Template(CHATML).render(context))]);
  });

  test("a template that does not parse fails every request with parse", async () => {
    const results = await renderer.renderBatch("{% if %}", [req("a"), req("b")]);
    expect(results).toEqual([failed("a", "parse"), failed("b", "parse")]);
  });

  test("a render error fails that request and the batch carries on", async () => {
    const src = "{% if boom %}{{ raise_exception('boom') }}{% endif %}fine";
    const results = await renderer.renderBatch(src, [req("a"), req("b", { boom: true }), req("c")]);
    expect(results).toEqual([ok("a", "fine"), failed("b", "render_error"), ok("c", "fine")]);
    expect((results[1] as { message: string }).message).toContain("boom");
  });

  test("a request that cannot be serialized fails alone", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const results = await renderer.renderBatch("{{ x }}", [req("a", { x: 1 }), req("b", cyclic), req("c", { x: 3 })]);
    expect(results).toEqual([ok("a", "1"), failed("b", "render_error"), ok("c", "3")]);
  });

  test("concurrent batches do not interfere", async () => {
    const batches = await Promise.all(
      ["a", "b", "c", "d"].map((tag) => renderer.renderBatch(`${tag}{{ n }}`, [req("1", { n: 1 }), req("2", { n: 2 })])),
    );
    expect(batches).toEqual(["a", "b", "c", "d"].map((tag) => [ok("1", `${tag}1`), ok("2", `${tag}2`)]));
  });
});

describe.skipIf(!live)("environment profiles (ISC-22.2)", () => {
  test("the dict-defined probe renders differently under each profile", async () => {
    const src = "{% if dict is defined %}[PAYLOAD]{% else %}clean{% endif %}";
    const results = await renderer.renderBatch(src, [req("hf", {}), req("j2", {}, { profile: "jinja2-globals" })]);
    expect(results).toEqual([ok("hf", "clean"), ok("j2", "[PAYLOAD]")]);
  });

  test("jinja2-globals stubs are callable inside the sandbox", async () => {
    const src = "{% set c = cycler('x', 'y') %}{{ c.next() }}{{ c.next() }}{{ dict(a=1).a }}{{ lipsum() | length > 0 }}";
    const results = await renderer.renderBatch(src, [req("j2", {}, { profile: "jinja2-globals" })]);
    expect(results).toEqual([ok("j2", "xy1true")]);
  });
});

describe.skipIf(!live)("strftime_now", () => {
  const src = '{{ strftime_now("%Y-%m-%d %H:%M %B %b") }}';

  test("reports the request's instant, in UTC", async () => {
    const results = await renderer.renderBatch(src, [
      req("a", {}, { now: "2027-03-04T05:06:07Z" }),
      req("b", {}, { now: "2027-03-04T23:30:00-05:00" }),
    ]);
    expect(results).toEqual([ok("a", "2027-03-04 05:06 March Mar"), ok("b", "2027-03-05 04:30 March Mar")]);
  });

  test("falls back to the real clock when now is absent, even after a pinned request", async () => {
    const before = new Date().toISOString().slice(0, 10);
    const results = await renderer.renderBatch('{{ strftime_now("%Y-%m-%d") }}', [
      req("pinned", {}, { now: "2001-01-01T00:00:00Z" }),
      req("real", {}),
    ]);
    const after = new Date().toISOString().slice(0, 10);
    expect(results[0]).toEqual(ok("pinned", "2001-01-01"));
    expect([ok("real", before), ok("real", after)]).toContainEqual(results[1]!);
  });

  test("an invalid instant fails that request", async () => {
    const results = await renderer.renderBatch(src, [req("a", {}, { now: "not a date" })]);
    expect(results).toEqual([failed("a", "render_error")]);
  });
});

describe.skipIf(!live)("caps (ISC-43)", () => {
  test(
    "range(10**10) hits the memory cap, and nothing after it in the batch is attempted",
    async () => {
      const src = "{% if boom %}{% for i in range(10**10) %}{% endfor %}{% endif %}fine";
      const [results, ms] = await timed(() => renderer.renderBatch(src, [req("a"), req("b", { boom: true }), req("c")]));
      expect(results).toEqual([ok("a", "fine"), failed("b", "memory"), skipped("c", "memory")]);
      expect(ms).toBeLessThan(2000 + 1500);
    },
    SLOW,
  );

  test(
    "a self-recursive macro overflows the stack, which is its own failure, and ends the batch",
    async () => {
      const src = "{% macro f(n) %}{{ f(n + 1) }}{% endmacro %}{% if boom %}{{ f(0) }}{% endif %}fine";
      const [results, ms] = await timed(() => renderer.renderBatch(src, [req("a"), req("b", { boom: true }), req("c")]));
      expect(results).toEqual([ok("a", "fine"), failed("b", "stack"), skipped("c", "stack")]);
      expect((results[1] as { message: string }).message).toContain("call stack");
      expect(ms).toBeLessThan(2000 + 1500);
    },
    SLOW,
  );

  test("a string that keeps doubling is a memory failure, though JSC stops it long before RSS grows", async () => {
    // JSC refuses a rope past its length limit in milliseconds; a Python engine would allocate every byte.
    const src = '{% set ns = namespace(s="a") %}{% if boom %}{% for i in range(64) %}{% set ns.s = ns.s ~ ns.s %}{% endfor %}{% endif %}{{ ns.s }}';
    const results = await renderer.renderBatch(src, [req("a"), req("b", { boom: true }), req("c")]);
    expect(results).toEqual([ok("a", "a"), failed("b", "memory"), skipped("c", "memory")]);
    expect((results[1] as { message: string }).message).toContain("Out of memory");
  });

  test(
    "a memory breach ends the batch as a timeout does: one breach, however many renders would breach",
    async () => {
      // Six of these in one batch each grew a fresh worker to the cap before (runtime review, r10gated).
      const src = "{% if boom %}{% for i in range(10**10) %}x{% endfor %}{% endif %}fine";
      const requests = [req("a"), ...Array.from({ length: 6 }, (_, i) => req(`b${i}`, { boom: true }))];
      const [results, ms] = await timed(() => renderer.renderBatch(src, requests));
      expect(results).toEqual([ok("a", "fine"), failed("b0", "memory"), ...requests.slice(2).map((r) => skipped(r.id, "memory"))]);
      expect(ms).toBeLessThan(2000 + 1500);
    },
    SLOW,
  );

  test(
    "a render that fails at once between two that hang does not buy the template another timeout",
    async () => {
      // The runtime review's alternating template: `dict` exists only under jinja2-globals, so hf-default fails
      // at once and jinja2-globals hangs. A rule counting timeouts in a row never fired on it. One range, reused,
      // keeps the spin's memory flat, so the time cap is the one it meets.
      const src = "{%- set d = dict(a=1) -%}{%- set r = range(10000) -%}{%- for i in r -%}{%- for j in r -%}{%- endfor -%}{%- endfor -%}done";
      const requests = Array.from({ length: 8 }, (_, i) => req(`r${i}`, {}, { profile: i % 2 ? "jinja2-globals" : "hf-default" }));
      const [results, ms] = await timed(() => renderer.renderBatch(src, requests, { timeoutMs: 500 }));
      expect(results).toEqual([failed("r0", "render_error"), failed("r1", "timeout"), ...requests.slice(2).map((r) => skipped(r.id, "timeout"))]);
      expect(ms).toBeLessThan(500 + 1500);
    },
    SLOW,
  );

  test(
    "a stack overflow while parsing is one stack breach, and nothing renders after it",
    async () => {
      const deep = "{{ " + "(".repeat(100_000) + "1" + ")".repeat(100_000) + " }}";
      const results = await renderer.renderBatch(deep, [req("a"), req("b")]);
      expect(results).toEqual([failed("a", "stack"), skipped("b", "stack")]);
    },
    SLOW,
  );

  test(
    "a doubly recursive macro runs into the 2 second timeout",
    async () => {
      const src = "{% macro f(n) %}{% if n > 0 %}{{ f(n - 1) }}{{ f(n - 1) }}{% endif %}{% endmacro %}{% if boom %}{{ f(60) }}{% endif %}fine";
      const [results, ms] = await timed(() => renderer.renderBatch(src, [req("a"), req("b", { boom: true }), req("c")]));
      expect(results).toEqual([ok("a", "fine"), failed("b", "timeout"), skipped("c", "timeout")]);
      expect(ms).toBeGreaterThanOrEqual(2000);
      expect(ms).toBeLessThan(2000 + 1500);
    },
    SLOW,
  );

  test(
    "more than 1MB of output is an output_limit failure",
    async () => {
      const src = "{% if big %}{% for i in range(120000) %}0123456789{% endfor %}{% endif %}fine";
      const results = await renderer.renderBatch(src, [req("a"), req("b", { big: true }), req("c")]);
      expect(results).toEqual([ok("a", "fine"), failed("b", "output_limit"), skipped("c", "output_limit")]);
    },
    SLOW,
  );

  test(
    "an error message is capped at about 4 KiB, ending in a truncation marker",
    async () => {
      // A 2 MiB string raised as an exception, in every request.
      const src = "{% set ns = namespace(s='x') %}{% for i in range(21) %}{% set ns.s = ns.s ~ ns.s %}{% endfor %}{{ raise_exception(ns.s) }}";
      const requests = Array.from({ length: 20 }, (_, i) => req(`r${i}`));
      const results = await renderer.renderBatch(src, requests);
      expect(results).toEqual(requests.map((r) => failed(r.id, "render_error")));
      for (const r of results as { message: string }[]) {
        expect(r.message.length).toBeLessThanOrEqual(MESSAGE_KEEP + TRUNCATED.length);
        expect(r.message).toEndWith(TRUNCATED);
      }
    },
    SLOW,
  );

  test(
    "a slow parse costs one timeout for the whole batch, not one per request",
    async () => {
      // The library's preprocessing is quadratic in a whitespace run: 60k spaces take over a second to parse.
      const slow = " ".repeat(60_000);
      const eight = Array.from({ length: 8 }, (_, i) => req(`r${i}`));
      const [one, oneMs] = await timed(() => renderer.renderBatch(slow, [req("a")], { timeoutMs: 500 }));
      const [all, allMs] = await timed(() => renderer.renderBatch(slow, eight, { timeoutMs: 500 }));
      console.log(`[sandbox] slow parse at timeoutMs 500: 1 request ${oneMs.toFixed(0)}ms, 8 requests ${allMs.toFixed(0)}ms`);
      expect(one).toEqual([failed("a", "timeout")]);
      expect(all).toEqual([failed("r0", "timeout"), ...eight.slice(1).map((r) => skipped(r.id, "timeout"))]);
      expect(allMs).toBeLessThan(oneMs + 400);
    },
    SLOW,
  );

  test(
    "after the first render times out, the rest of the batch is skipped and says it was not attempted",
    async () => {
      const eight = Array.from({ length: 8 }, (_, i) => req(`r${i}`));
      const [results, ms] = await timed(() => renderer.renderBatch(SPIN, eight, { timeoutMs: 500 }));
      console.log(`[sandbox] 8 hanging renders at timeoutMs 500: ${ms.toFixed(0)}ms`);
      // Only the one that ran timed out; the rest were never attempted, which is no cap breach of their own.
      expect(results).toEqual([failed("r0", "timeout"), ...eight.slice(1).map((r) => skipped(r.id, "timeout"))]);
      expect(results.slice(1).every((r) => (r as { message: string }).message.startsWith("not attempted"))).toBe(true);
      // One timeout's worth and a spawn, not eight.
      expect(ms).toBeLessThan(500 + 1000);
    },
    SLOW,
  );

  // GC and JIT threads count towards CPU time, so the worker's own CPU limit could beat its clock, and whether a
  // render timed out would turn on how busy a machine's GC threads are (ISC-31). At timeoutMs 8000 the limit is
  // 13 s of CPU, reached at 1.3 s a second only after 10 s, so the worker's clock comes first, by 2 s.
  test(
    "at a long timeout, a render using about 1.3 s of CPU a second still ends by the worker's clock",
    async () => {
      const busy = createRenderer({ command: [BUN, "--no-install", BUSY], readable: [BUSY] });
      const [results, ms] = await timed(() => busy.renderBatch(SPIN, [req("a")], { timeoutMs: 8000 }));
      console.log(`[sandbox] busy render at timeoutMs 8000 ended after ${ms.toFixed(0)}ms`);
      expect(results).toEqual([{ id: "a", ok: false, failure: "timeout", message: "render exceeded 8000ms by the worker's clock" }]);
    },
    SLOW,
  );

  test(
    "the worker times its own renders, so a render that runs on ends at the cap, long before the parent's backstop",
    async () => {
      const [results, ms] = await timed(() => renderer.renderBatch(SPIN, [req("a"), req("b")], { timeoutMs: 300 }));
      expect(results).toEqual([{ id: "a", ok: false, failure: "timeout", message: "render exceeded 300ms by the worker's clock" }, skipped("b", "timeout")]);
      console.log(`[sandbox] a render that runs on, at timeoutMs 300: ended after ${ms.toFixed(0)}ms`);
    },
    SLOW,
  );

  test(
    "a scanner that stalls for longer than the cap and its grace, while its renders are quick, sees no timeout",
    async () => {
      // The review's false render_dos: a ~10 ms render reported as a timeout because the scanner's own event loop
      // was busy elsewhere when the timer came due. 50 renders of about 30 ms at a 300 ms cap, and a 2 s stall among them.
      const src = "{%- set r = range(60000) -%}{%- for i in r -%}{%- endfor -%}ok";
      const requests = Array.from({ length: 50 }, (_, i) => req(`r${i}`));
      const pending = renderer.renderBatch(src, requests, { timeoutMs: 300 });
      await Bun.sleep(600);
      block(2000);
      expect(await pending).toEqual(requests.map((r) => ok(r.id, "ok")));
    },
    SLOW,
  );

  test("the output cap is exact", async () => {
    const src = "{% for i in range(n) %}x{% endfor %}";
    const results = await renderer.renderBatch(src, [req("at", { n: 100 }), req("over", { n: 101 })], { maxOutputBytes: 100 });
    expect(results).toEqual([ok("at", "x".repeat(100)), failed("over", "output_limit")]);
  });

  test(
    "custom limits apply per render",
    async () => {
      const src = "{% if spin %}{% for i in range(100000) %}{% for j in range(100000) %}{% endfor %}{% endfor %}{% endif %}done";
      const [results, ms] = await timed(() =>
        renderer.renderBatch(src, [req("a"), req("b", { spin: true }), req("c")], { timeoutMs: 300 }),
      );
      expect(results).toEqual([ok("a", "done"), failed("b", "timeout"), skipped("c", "timeout")]);
      expect(ms).toBeGreaterThanOrEqual(300);
      expect(ms).toBeLessThan(300 + 1500);
    },
    SLOW,
  );
});

describe.skipIf(!live)("the memory cap fails closed (ISC-43)", () => {
  test(
    "a worker whose memory stops being readable fails with memory",
    async () => {
      // Readable for long enough to start up and get into the render, unreadable from then on.
      const reads = new Map<number, number>();
      const blind = createRenderer({
        residentMemory: (pid) => {
          reads.set(pid, (reads.get(pid) ?? 0) + 1);
          return reads.get(pid)! > 30 ? undefined : 1;
        },
      });
      // The cap itself is out of reach, so only the unreadable samples can end this render early. They must fail for a
      // second first, since a worker on its way out cannot be read either: about 1.3 s in all, far short of the timeout.
      const [results, ms] = await timed(() => blind.renderBatch(SPIN, [req("a")], { timeoutMs: 10_000, maxRssBytes: 2 ** 34 }));
      expect(results).toEqual([failed("a", "memory")]);
      expect(ms).toBeLessThan(3000);
    },
    SLOW,
  );

  test(
    "the worker enforces the memory cap itself when the parent's reading never trips it",
    async () => {
      // The parent sees one byte for ever, as it would see nothing once killed, so only the worker's own watchdog
      // can stop range(10**7): ten million boxed integers, some 400 MiB, against a 128 MiB cap.
      const blind = createRenderer({ residentMemory: () => 1 });
      const src = "{% if boom %}{% set xs = range(10**7) %}{% endif %}fine";
      const cap = 128 * 2 ** 20;
      const [results, ms] = await timed(() => blind.renderBatch(src, [req("a"), req("b", { boom: true }), req("c")], { timeoutMs: 10_000, maxRssBytes: cap }));
      expect(results).toEqual([ok("a", "fine"), failed("b", "memory"), skipped("c", "memory")]);
      expect((results[1] as { message: string }).message).toBe("worker resident memory exceeded the 128MiB cap, by its own reading");
      expect(ms).toBeLessThan(5000);
    },
    SLOW,
  );

  test(
    "a breach the parent sees waits for the worker's last words, so it falls on the request the worker was on",
    async () => {
      // The worker answers its first request two seconds after the parse, while the parent's loop is stopped; the
      // parent's first reading after that is over the cap. Read first, the answer stands, and the breach is the next request's.
      let first: number | undefined;
      let stalled = false;
      const late = createRenderer({
        command: [BUN, ROGUE, "late"],
        readable: [ROGUE],
        residentMemory: () => {
          first ??= performance.now();
          if (performance.now() - first < 1500) return 1;
          if (!stalled) (stalled = true), block(2500);
          return 2 ** 40;
        },
      });
      expect(await late.renderBatch("", [req("a"), req("b")])).toEqual([ok("a", "late"), failed("b", "memory")]);
    },
    SLOW,
  );

  test(
    "a breach while the worker reads its batch is the sandbox's failure, never a cap breach charged to the first request",
    async () => {
      // 120 MiB of request JSON against a 96 MiB cap: it cannot all be held, however it is read.
      const big = "x".repeat(20 * 2 ** 20);
      const requests = Array.from({ length: 6 }, (_, i) => req(`r${i}`, { big }));
      const run = await runWorker("{{ big | length }}", requests, { timeoutMs: 2000, maxRssBytes: 96 * 2 ** 20, maxOutputBytes: 2 ** 20 });
      expect(run.results).toEqual([]);
      expect(run.sandboxError).toMatch(/^worker failed to start: .*memory/);
    },
    SLOW,
  );

  test(
    "a render is not charged with what earlier renders of the batch left behind",
    async () => {
      // One render of this peaks near 215 MiB, under the 256 MiB cap. Six back to back in one process peaked near
      // 400 MiB, and near 250 MiB with a full collection before each, since the allocator keeps the pages earlier
      // renders' garbage sat in (review round 2, SHOULD FIX 2). Each must be ok, as it is alone.
      const template =
        "{%- if tools -%}<|tools|>{{ tools | tojson }}{% for i in range(200000) %}[{% endfor %}{% for i in range(200000) %}]{% endfor %}<|end|>{%- endif -%}" +
        "{%- for m in messages -%}<|{{ m.role }}|>{{ m.content }}<|end|>{%- endfor -%}";
      const context = { tools: [{ type: "function", function: { name: "f" } }], messages: [{ role: "user", content: "hi" }] };
      const requests = Array.from({ length: 6 }, (_, i) => req(`r${i}`, context, { profile: "jinja2-globals" }));
      const results = await renderer.renderBatch(template, requests);
      expect(results.map((r) => (r.ok ? "ok" : `${r.failure}: ${r.message}`))).toEqual(Array(6).fill("ok"));
    },
    SLOW,
  );

  test(
    "a batch is split by size, so no worker has to hold more than 16 MiB of requests",
    async () => {
      // 49 MiB of requests, which one worker cannot hold under a 128 MiB cap; 16 MiB at a time, it can. A worker
      // holding one 16 MiB batch peaks near 104 MiB, so 96 MiB was too tight to pass every time. The template
      // tests the string but never copies it, as the library's slicing and length filter do.
      const big = "x".repeat(7 * 2 ** 20);
      const requests = Array.from({ length: 7 }, (_, i) => req(`r${i}`, { big }));
      const results = await renderer.renderBatch("{% if big %}big{% endif %}", requests, { maxRssBytes: 128 * 2 ** 20 });
      expect(results).toEqual(requests.map((r) => ok(r.id, "big")));
    },
    SLOW,
  );

  test(
    "a request bigger than a batch goes alone, and the rest still go together",
    async () => {
      const requests = [req("small"), req("huge", { big: "y".repeat(20 * 2 ** 20) }), req("after")];
      const results = await renderer.renderBatch("{% if big %}big{% else %}none{% endif %}", requests);
      expect(results).toEqual([ok("small", "none"), ok("huge", "big"), ok("after", "none")]);
    },
    SLOW,
  );

  test(
    "a memory reader that throws counts as unreadable instead of escaping",
    async () => {
      const broken = createRenderer({
        residentMemory: () => {
          throw new Error("no libproc");
        },
      });
      const results = await broken.renderBatch(SPIN, [req("a")], { timeoutMs: 10_000, maxRssBytes: 2 ** 34 });
      // It may fail during startup, which is a sandbox failure, or during the render; either way it fails closed, and fast.
      expect([[failed("a", "memory")], [failed("a", "sandbox")]]).toContainEqual(results);
    },
    SLOW,
  );

  test.skipIf(process.platform !== "darwin")("darwinRss reads a live process and says undefined, not 0, for a dead one", async () => {
    expect(darwinRss(process.pid)).toBeGreaterThan(0);
    const gone = Bun.spawn([BUN, "-e", "0"]);
    await gone.exited;
    expect(darwinRss(gone.pid)).toBeUndefined();
  });

  test.skipIf(process.platform !== "linux")("linuxTreeRss reads a live tree and says undefined, not 0, for a dead one", async () => {
    expect(linuxTreeRss(process.pid)).toBeGreaterThan(0);
    const gone = Bun.spawn([BUN, "-e", "0"]);
    await gone.exited;
    expect(linuxTreeRss(gone.pid)).toBeUndefined();
  });
});

describe.skipIf(!live)("the parent does not trust the worker", () => {
  const rogue = (mode: string) => createRenderer({ command: [BUN, ROGUE, mode], readable: [ROGUE] });
  const two = [req("a"), req("b")];

  test("a worker that never answers is timed out", async () => {
    expect(await rogue("stall").renderBatch("", two, { timeoutMs: 200 })).toEqual([failed("a", "timeout"), skipped("b", "timeout")]);
  });

  test("a result for the wrong request is a protocol error", async () => {
    expect(await rogue("wrong-id").renderBatch("", two)).toEqual([failed("a", "render_error"), failed("b", "render_error")]);
  });

  test("a worker cannot claim a failure only the parent can see", async () => {
    expect(await rogue("claim-timeout").renderBatch("", two)).toEqual([failed("a", "render_error"), failed("b", "render_error")]);
  });

  test("an oversized line is cut off at the output cap", async () => {
    const results = await rogue("huge").renderBatch("", two, { maxOutputBytes: 1000 });
    expect(results).toEqual([failed("a", "output_limit"), skipped("b", "output_limit")]);
  });

  test("a worker killed by its own CPU limit timed out, however the sandbox reports the death", async () => {
    const start = performance.now();
    // The parent's own timer is far off, so only the exit path can call these timeouts this soon.
    expect(await rogue("xcpu").renderBatch("", two, { timeoutMs: 10_000 })).toEqual([failed("a", "timeout"), skipped("b", "timeout")]);
    expect(performance.now() - start).toBeLessThan(5000);
  }, 30_000);

  test("a worker that exits mid-batch fails the in-flight request", async () => {
    expect(await rogue("exit").renderBatch("", two)).toEqual([failed("a", "render_error"), failed("b", "render_error")]);
  });

  test("a worker that ends itself between renders hands the rest to a fresh one, which is sent only the rest", async () => {
    expect(await rogue("spent").renderBatch("", [req("a"), req("b"), req("c")])).toEqual([ok("a", "spent 3"), ok("b", "spent 2"), ok("c", "spent 1")]);
  });

  test("a worker that ends itself before answering anything fails the in-flight request", async () => {
    expect(await rogue("spent-early").renderBatch("", two)).toEqual([failed("a", "render_error"), failed("b", "render_error")]);
  });

  // A worker on its way out can no longer be read, and stays so until it has gone, which for a big one under load can
  // be longer than a few polls (review round 3, MUST FIX A). Each of these workers takes 300 ms to exit after its
  // answer, holding 128 MiB meanwhile, which this reader takes as unreadable. How it exited decides, never the reads.
  const readRss = process.platform === "darwin" ? darwinRss : linuxTreeRss;
  const lingering = (code: number) =>
    createRenderer({
      command: [BUN, ROGUE, "linger", String(code)],
      readable: [ROGUE],
      residentMemory: (pid) => {
        const bytes = readRss(pid);
        return bytes !== undefined && bytes > 96 * 2 ** 20 ? undefined : bytes;
      },
    });
  for (const [code, after] of [
    [SPENT_EXIT_CODE, [ok("b", "linger 2"), ok("c", "linger 1")]],
    [MEMORY_EXIT_CODE, [{ id: "b", ok: false, failure: "memory", message: expect.stringContaining("by its own reading") }, skipped("c", "memory")]],
    [TIMEOUT_EXIT_CODE, [failed("b", "timeout"), skipped("c", "timeout")]],
    [7, [failed("b", "render_error"), ok("c", "linger 1")]],
  ] as const) {
    test(
      `a worker that cannot be read while it exits ${code} is judged by its exit code, not as unreadable`,
      async () => {
        expect(await lingering(code).renderBatch("", [req("a"), req("b"), req("c")])).toEqual([ok("a", "linger 3"), ...after]);
      },
      SLOW,
    );
  }

  test("a worker's exit message keeps its stderr but not the macOS xcode-select line its FFI load provokes", async () => {
    expect(await rogue("ffi-exit").renderBatch("", [req("a")])).toEqual([
      { id: "a", ok: false, failure: "render_error", message: "worker exited (code 7): worker fell over" },
    ]);
  });

  test("results before the ready line mean the worker never started properly", async () => {
    expect(await rogue("skip-ready").renderBatch("", two)).toEqual([failed("a", "sandbox"), failed("b", "sandbox")]);
  });

  test("a worker that floods stderr does not stall the batch", async () => {
    expect(await rogue("noisy").renderBatch("", two)).toEqual([ok("a", "noisy"), ok("b", "noisy")]);
  });

  test("a failure message is capped in the parent, whatever the worker sends", async () => {
    const results = await rogue("fat-error").renderBatch("", two);
    expect(results).toEqual([failed("a", "render_error"), failed("b", "render_error")]);
    for (const r of results as { message: string }[]) expect(r.message).toBe("e".repeat(MESSAGE_KEEP) + TRUNCATED);
  });

  test("the bound on what one request may send is counted in bytes, for any message", async () => {
    // 6 x 1000 + 64 KiB is the bound here; the message is 90,000 bytes but only 30,000 characters.
    expect(await rogue("wide-error").renderBatch("", two, { maxOutputBytes: 1000 })).toEqual([
      failed("a", "output_limit"),
      skipped("b", "output_limit"),
    ]);
  });

  test("a step the worker timed past the cap is a timeout, however soon its answer came", async () => {
    const results = await rogue("slow-claim").renderBatch("", two, { timeoutMs: 500 });
    expect(results).toEqual([
      { id: "a", ok: false, failure: "timeout", message: "render took 10000000ms by the worker's clock, cap 500ms" },
      skipped("b", "timeout"),
    ]);
  });

  test(
    "the worker's clock is the one the cap goes by; the parent's is a backstop at the cap and a grace",
    async () => {
      // Each answer comes 800 ms after the last by the parent's clock, past the 300 ms cap but inside its grace, and
      // each render took 1 ms by the worker's: whatever held the answers up, it was not the template.
      const [results, ms] = await timed(() => rogue("lagging").renderBatch("", two, { timeoutMs: 300 }));
      expect(results).toEqual([ok("a", "lagging"), ok("b", "lagging")]);
      expect(ms).toBeGreaterThan(1600);
    },
    SLOW,
  );

  test("an oversized line before the template has parsed is one breach, and nothing renders after it", async () => {
    expect(await rogue("fat-parsed").renderBatch("", two, { maxOutputBytes: 1000 })).toEqual([
      failed("a", "output_limit"),
      skipped("b", "output_limit"),
    ]);
  });
});

describe.skipIf(!live)("throughput", () => {
  test(
    "measures spawn cost and a 60-request batch",
    async () => {
      const spawns: number[] = [];
      for (let i = 0; i < 7; i++) spawns.push((await timed(() => renderer.renderBatch("{{ x }}", [req("a", { x: 1 })])))[1]);
      spawns.sort((a, b) => a - b);
      const messages = [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello there, how are you today?" },
        { role: "assistant", content: "Fine, thanks." },
        { role: "user", content: "Write a haiku about sandboxes." },
      ];
      const probes = Array.from({ length: 60 }, (_, i) =>
        req(`p${i}`, { messages, add_generation_prompt: i % 2 === 0 }, { profile: i % 3 ? "hf-default" : "jinja2-globals", now: "2027-01-01T00:00:00Z" }),
      );
      const [results, batchMs] = await timed(() => renderer.renderBatch(CHATML, probes));
      expect(results.every((r) => r.ok)).toBe(true);
      const spawnMs = spawns[Math.floor(spawns.length / 2)]!;
      console.log(`[sandbox] ${status.available ? status.kind : "-"}: spawn+1 render median ${spawnMs.toFixed(1)}ms; 60-request batch ${batchMs.toFixed(1)}ms`);
      expect(batchMs).toBeLessThan(3000);
    },
    SLOW,
  );
});
