import { Template } from "@huggingface/jinja";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createRenderer, sandboxAvailable } from "../../src/sandbox/index.ts";
import type { RenderFailure, RenderRequest, RenderResult } from "../../src/types.ts";

const status = await sandboxAvailable();
const live = status.available;
if (!live) {
  console.warn(`\n[sandbox] SKIPPING live render tests: ${status.reason}\n[sandbox] Only fail-closed behavior is checked here.\n`);
}

const BUN = process.execPath;
const ROGUE = join(import.meta.dir, "rogue-worker.ts");
const SLOW = 30_000;

const req = (id: string, context: Record<string, unknown> = {}, extra: Partial<RenderRequest> = {}): RenderRequest => ({
  id,
  context,
  profile: "hf-default",
  ...extra,
});

const ok = (id: string, output: string): RenderResult => ({ id, ok: true, output });
const failed = (id: string, failure: RenderFailure): RenderResult => ({ id, ok: false, failure, message: expect.any(String) });

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const value = await fn();
  return [value, performance.now() - start];
}

const renderer = createRenderer();

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
    "range(10**10) hits the memory cap, the child is replaced and the batch carries on",
    async () => {
      const src = "{% if boom %}{% for i in range(10**10) %}{% endfor %}{% endif %}fine";
      const [results, ms] = await timed(() => renderer.renderBatch(src, [req("a"), req("b", { boom: true }), req("c")]));
      expect(results).toEqual([ok("a", "fine"), failed("b", "memory"), ok("c", "fine")]);
      expect(ms).toBeLessThan(2000 + 1500);
    },
    SLOW,
  );

  test(
    "a self-recursive macro fails within the caps and the batch carries on",
    async () => {
      const src = "{% macro f(n) %}{{ f(n + 1) }}{% endmacro %}{% if boom %}{{ f(0) }}{% endif %}fine";
      const [results, ms] = await timed(() => renderer.renderBatch(src, [req("a"), req("b", { boom: true }), req("c")]));
      expect(results[0]).toEqual(ok("a", "fine"));
      expect(results[1]).toMatchObject({ id: "b", ok: false });
      expect(results[2]).toEqual(ok("c", "fine"));
      expect(ms).toBeLessThan(2000 + 1500);
    },
    SLOW,
  );

  test(
    "a doubly recursive macro runs into the 2 second timeout",
    async () => {
      const src = "{% macro f(n) %}{% if n > 0 %}{{ f(n - 1) }}{{ f(n - 1) }}{% endif %}{% endmacro %}{% if boom %}{{ f(60) }}{% endif %}fine";
      const [results, ms] = await timed(() => renderer.renderBatch(src, [req("a"), req("b", { boom: true }), req("c")]));
      expect(results).toEqual([ok("a", "fine"), failed("b", "timeout"), ok("c", "fine")]);
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
      expect(results).toEqual([ok("a", "fine"), failed("b", "output_limit"), ok("c", "fine")]);
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
        renderer.renderBatch(src, [req("a", { spin: true }), req("b"), req("c", { spin: true })], { timeoutMs: 300 }),
      );
      expect(results).toEqual([failed("a", "timeout"), ok("b", "done"), failed("c", "timeout")]);
      expect(ms).toBeLessThan(600 + 1500);
    },
    SLOW,
  );
});

describe.skipIf(!live)("the parent does not trust the worker", () => {
  const rogue = (mode: string) => createRenderer({ command: [BUN, ROGUE, mode] });
  const two = [req("a"), req("b")];

  test("a worker that never answers is timed out", async () => {
    expect(await rogue("stall").renderBatch("", two, { timeoutMs: 200 })).toEqual([failed("a", "timeout"), failed("b", "timeout")]);
  });

  test("a result for the wrong request is a protocol error", async () => {
    expect(await rogue("wrong-id").renderBatch("", two)).toEqual([failed("a", "render_error"), failed("b", "render_error")]);
  });

  test("a worker cannot claim a failure only the parent can see", async () => {
    expect(await rogue("claim-timeout").renderBatch("", two)).toEqual([failed("a", "render_error"), failed("b", "render_error")]);
  });

  test("an oversized line is cut off at the output cap", async () => {
    const results = await rogue("huge").renderBatch("", two, { maxOutputBytes: 1000 });
    expect(results).toEqual([failed("a", "output_limit"), failed("b", "output_limit")]);
  });

  test("a worker that exits mid-batch fails the in-flight request", async () => {
    expect(await rogue("exit").renderBatch("", two)).toEqual([failed("a", "render_error"), failed("b", "render_error")]);
  });

  test("results before the ready line mean the worker never started properly", async () => {
    expect(await rogue("skip-ready").renderBatch("", two)).toEqual([failed("a", "sandbox"), failed("b", "sandbox")]);
  });

  test("a worker that floods stderr does not stall the batch", async () => {
    expect(await rogue("noisy").renderBatch("", two)).toEqual([ok("a", "noisy"), ok("b", "noisy")]);
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
