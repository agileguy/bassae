// ISC-36 and ISC-37 for the shipped tool: a whole scan succeeds with the network denied to the command,
// and the source holds no Python and starts processes only in the renderer launcher.
//
// How the deny-network run goes: the renderer launches its worker under the same kind of OS sandbox, and
// on macOS sandbox-exec refuses to nest (sandbox_apply: Operation not permitted). The renderer is then
// unavailable inside, which proves the scan needs no network, and the report says so honestly: every
// template without a HIGH is incomplete. Where nesting works (bwrap inside bwrap or unshare on Linux),
// the renderer runs and every status is what it is outside. The test accepts either way and logs which.
// No sandbox is ever turned off to make it pass.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { makeTree, removeTrees } from "../helpers/tree.ts";
import { bassae, fixtureEnv, reportOf, ROOT, schemaErrors, SCAN_TIMEOUT } from "./fixtures/cli.ts";
import { EXPECTED, type Fixture, modelAt, statusTree } from "./fixtures/trees.ts";

afterAll(removeTrees);

/** A wrapper that runs a command with no network, or why this machine has none. */
function denyNetwork(): { wrap: string[]; how: string } | { reason: string } {
  if (process.platform === "darwin") {
    const exec = "/usr/bin/sandbox-exec";
    return existsSync(exec) ? { wrap: [exec, "-p", "(version 1)(allow default)(deny network*)"], how: "sandbox-exec, deny network*" } : { reason: `${exec} not found` };
  }
  if (process.platform === "linux") {
    // A new network namespace holds only its own loopback: nothing outside it is reachable.
    const candidates = [
      { wrap: ["bwrap", "--unshare-net", "--dev-bind", "/", "/", "--"], how: "bwrap --unshare-net" },
      { wrap: ["unshare", "--user", "--map-root-user", "--net", "--"], how: "unshare --net" },
    ];
    for (const c of candidates) {
      if (Bun.which(c.wrap[0]!) && Bun.spawnSync([...c.wrap, "true"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0) return c;
    }
    return { reason: "neither bwrap --unshare-net nor unshare --net can start a process" };
  }
  return { reason: `no deny-network wrapper on ${process.platform}` };
}

const deny = denyNetwork();
if ("reason" in deny) console.warn(`\n[e2e] SKIPPING the deny-network scan: ${deny.reason}\n`);

test("a deny-network wrapper exists where CI requires the sandbox", () => {
  if (process.env.BASSAE_REQUIRE_SANDBOX) expect(deny).toHaveProperty("wrap");
});

describe.skipIf("reason" in deny)("ISC-36: the scan succeeds with the network denied", () => {
  const { wrap, how } = "wrap" in deny ? deny : { wrap: [], how: "" };

  test("control: the wrapper really cuts off a server this test is listening on", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("up") });
    try {
      const probe = `fetch("http://127.0.0.1:${server.port}/").then(async (r) => console.log("reached " + (await r.text())), () => console.log("denied"))`;
      const run = async (prefix: string[]) => {
        const p = Bun.spawn([...prefix, process.execPath, "-e", probe], { env: fixtureEnv(), stdout: "pipe", stderr: "ignore" });
        const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
        return out.trim();
      };
      expect(await run([])).toBe("reached up");
      expect(await run(wrap)).toBe("denied");
    } finally {
      server.stop(true);
    }
  }, SCAN_TIMEOUT);

  test("a whole scan of the mixed tree completes and reports honestly", async () => {
    const root = makeTree(statusTree());
    const fixtures = Object.keys(EXPECTED) as Fixture[];
    const run = await bassae(["--json", root], { wrap });
    const report = reportOf(run);
    expect(schemaErrors(run)).toEqual([]);
    expect(run.code).toBe(report.exitCode);
    expect(report.online).toBe(false);
    expect(report.models).toHaveLength(fixtures.length);

    // The rules that need no renderer still ran: the dunder is HIGH, so the exit code is 2 either way.
    expect(modelAt(report, join(root, "findings-high")).templates[0]).toMatchObject({ status: "findings", severity: "HIGH" });
    expect(run.code).toBe(2);

    if (report.renderer.available) {
      console.log(`[e2e] deny-network scan under ${how}: the renderer nested (${report.renderer.kind}), statuses as without the wrapper`);
      for (const f of fixtures) expect(modelAt(report, join(root, f)).status).toBe(EXPECTED[f]);
      return;
    }
    console.log(`[e2e] deny-network scan under ${how}: renderer unavailable inside it (${report.renderer.reason})`);
    expect(report.renderer.reason.length).toBeGreaterThan(0);
    for (const t of report.models.flatMap((m) => m.templates)) {
      if (t.severity === "HIGH") continue;
      expect(t.status).toBe("incomplete");
      expect(t.gaps).toContain(`renderer unavailable: ${report.renderer.reason}`);
    }
    expect(modelAt(report, join(root, "no-template")).status).toBe("no_template");
  }, SCAN_TIMEOUT);
});

/** Every file under `dir`, relative to the checkout, skipping installed packages and git's own files. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push(relative(ROOT, p));
  }
  return out;
}

describe("ISC-37: no Python in the shipped tool", () => {
  test("no .py file outside scripts/fixtures/", () => {
    expect(filesUnder(ROOT).filter((f) => f.endsWith(".py") && !f.startsWith("scripts/fixtures/"))).toEqual([]);
  });

  test("no Python dependency, and no package script that runs Python", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    const deps = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap((k) => Object.keys(pkg[k] ?? {}));
    expect(deps.length).toBeGreaterThan(0);
    expect(deps.filter((d) => /python|pyodide|jinja2|^py[-_]/i.test(d))).toEqual([]);
    expect(Object.values(pkg.scripts ?? {}).filter((s) => /\b(python3?|pip3?|uv|pyodide)\b/.test(s))).toEqual([]);
  });

  test("Bun.spawn, child_process and any jinja2 import appear in src/ only in the renderer launcher", () => {
    const pattern = /import.*jinja2|Bun\.spawn|child_process/;
    const hits = filesUnder(join(ROOT, "src")).filter((f) => pattern.test(readFileSync(join(ROOT, f), "utf8")));
    expect(hits).toEqual(["src/sandbox/launcher.ts"]);
  });
});
