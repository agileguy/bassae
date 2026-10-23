import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Io, run } from "../../src/cli/main.ts";
import { type Command, parseArgs, USAGE } from "../../src/cli/args.ts";
import { defaultRootCandidates, defaultRoots } from "../../src/cli/roots.ts";
import type { ExitCode, ScanOptions, ScanReport } from "../../src/types.ts";
import { makeTree, removeTrees } from "../helpers/tree.ts";
import { RAW } from "./fixtures/hostile.ts";
import { everything, finding, model, report, template } from "./fixtures/reports.ts";

const REV = "0123456789abcdef0123456789abcdef01234567";

afterAll(removeTrees);

function ok(argv: string[]): Command {
  const parsed = parseArgs(argv);
  if (!parsed.ok) throw new Error(`expected ok, got: ${parsed.error}`);
  return parsed.command;
}

function error(argv: string[]): string {
  const parsed = parseArgs(argv);
  if (parsed.ok) throw new Error(`expected a usage error for ${JSON.stringify(argv)}`);
  return parsed.error;
}

describe("parseArgs: scan", () => {
  test("no arguments scans the default locations", () => {
    expect(ok([])).toEqual({ kind: "scan", json: false, online: false, templates: [], paths: [] });
  });

  test("paths, --json and repeated --template", () => {
    expect(ok(["--json", "a", "--template", "t1.jinja", "b", "--template=t2.jinja"])).toEqual({
      kind: "scan",
      json: true,
      online: false,
      templates: ["t1.jinja", "t2.jinja"],
      paths: ["a", "b"],
    });
  });

  test("--online with a pinned --upstream, in either spelling", () => {
    const want: Command = { kind: "scan", json: false, online: true, upstream: { repo: "Qwen/Qwen3-8B", revision: REV }, templates: [], paths: ["m"] };
    expect(ok(["--online", "--upstream", `Qwen/Qwen3-8B@${REV}`, "m"])).toEqual(want);
    expect(ok([`--upstream=Qwen/Qwen3-8B@${REV}`, "m", "--online"])).toEqual(want);
  });

  test("an upper-case revision is normalized", () => {
    const c = ok(["--online", "--upstream", `a/b@${REV.toUpperCase()}`]);
    expect(c.kind === "scan" && c.upstream?.revision).toBe(REV);
  });

  test("everything after -- is a path, even when it looks like an option", () => {
    expect(ok(["--", "--json", "-x"])).toEqual({ kind: "scan", json: false, online: false, templates: [], paths: ["--json", "-x"] });
  });

  test("a lone - is a path", () => {
    expect(ok(["-"])).toMatchObject({ kind: "scan", paths: ["-"] });
  });
});

describe("USAGE", () => {
  test("exit 3 names parse errors beside scanner errors (contracts SF7)", () => {
    expect(USAGE.replace(/\s+/g, " ")).toContain("else 3 any incomplete template, scanner or parse error, or usage error; else 1 any MEDIUM; else 0.");
  });

  test("a finding outside any template has no position to print (contracts r2)", () => {
    expect(USAGE.replace(/\s+/g, " ")).toContain("In the human report, a finding outside any template prints no position.");
  });
});

describe("parseArgs: usage errors", () => {
  test("--upstream without --online is refused (ISC-36)", () => {
    expect(error(["--upstream", `a/b@${REV}`, "m"])).toContain("--online");
  });

  test("--upstream must be org/name@<40-hex commit>", () => {
    expect(error(["--online", "--upstream", "a/b"])).toContain("<repo>@<revision>");
    expect(error(["--online", "--upstream", `@${REV}`])).toContain("<repo>@<revision>");
    expect(error(["--online", "--upstream", "a/b@"])).toContain("<repo>@<revision>");
    expect(error(["--online", "--upstream", "a/b@main"])).toContain("40-hex");
    expect(error(["--online", "--upstream", `datasets/x@${REV}`])).toContain("not a model namespace");
    expect(error(["--online", "--upstream", `ab@${REV}`])).toContain("org/name");
  });

  test("--upstream twice is refused", () => {
    expect(error(["--online", "--upstream", `a/b@${REV}`, "--upstream", `c/d@${REV}`])).toContain("once");
  });

  test("an option missing its value is refused", () => {
    expect(error(["--template"])).toContain("--template needs");
    expect(error(["--template", "--json"])).toContain("--template needs");
    expect(error(["--template="])).toContain("--template needs");
    expect(error(["--online", "--upstream"])).toContain("--upstream needs");
  });

  test("unknown options are refused, and a flag takes no value", () => {
    expect(error(["--jsno"])).toContain("unknown option --jsno");
    expect(error(["-j"])).toContain("unknown option -j");
    expect(error(["--json=yes"])).toContain("takes no value");
  });

  test("every error is one line", () => {
    for (const argv of [["--upstream", "x"], ["--nope"], ["--extract", "m"], ["--out", "o"], ["--extract", "m", "--out", "o", "--json"]]) {
      expect(error(argv)).not.toContain("\n");
    }
  });
});

describe("parseArgs: --extract", () => {
  test("--extract <model> --out <dir>, in any order", () => {
    expect(ok(["--extract", "m.gguf", "--out", "o"])).toEqual({ kind: "extract", model: "m.gguf", out: "o" });
    expect(ok(["--out=o", "--extract=m.gguf"])).toEqual({ kind: "extract", model: "m.gguf", out: "o" });
  });

  test("each half needs the other", () => {
    expect(error(["--extract", "m"])).toContain("--out");
    expect(error(["--out", "o"])).toContain("--extract");
  });

  test("scan options and paths do not mix with --extract", () => {
    for (const extra of [["--json"], ["--online"], ["--template", "t"], ["p"]]) {
      expect(error(["--extract", "m", "--out", "o", ...extra])).toContain("--extract");
    }
  });

  test("--extract and --out are given once", () => {
    expect(error(["--extract", "m", "--extract", "n", "--out", "o"])).toContain("once");
    expect(error(["--extract", "m", "--out", "o", "--out", "p"])).toContain("once");
  });
});

describe("parseArgs: --help and --version", () => {
  test("--help and -h win over everything else", () => {
    expect(ok(["--help"])).toEqual({ kind: "help" });
    expect(ok(["--json", "-h", "--nope"])).toEqual({ kind: "help" });
  });
  test("--version", () => {
    expect(ok(["--version"])).toEqual({ kind: "version" });
  });
});

describe("default roots", () => {
  const home = "/home/u";

  test("the hub cache follows HF_HUB_CACHE, then HF_HOME, then XDG_CACHE_HOME, then ~/.cache", () => {
    expect(defaultRootCandidates({ HF_HUB_CACHE: "/h", HF_HOME: "/x" }, home)[0]).toBe("/h");
    expect(defaultRootCandidates({ HF_HOME: "/x" }, home)[0]).toBe("/x/hub");
    expect(defaultRootCandidates({ XDG_CACHE_HOME: "/c" }, home)[0]).toBe("/c/huggingface/hub");
    expect(defaultRootCandidates({}, home)[0]).toBe("/home/u/.cache/huggingface/hub");
    expect(defaultRootCandidates({ HF_HUB_CACHE: "" }, home)[0]).toBe("/home/u/.cache/huggingface/hub");
    expect(defaultRootCandidates({ HF_HOME: "~/hf" }, home)[0]).toBe("/home/u/hf/hub");
  });

  test("LM Studio, Ollama and omlx", () => {
    expect(defaultRootCandidates({}, home)).toEqual([
      "/home/u/.cache/huggingface/hub",
      "/home/u/.lmstudio/models",
      "/home/u/.ollama/models",
      "/home/u/.omlx",
    ]);
    expect(defaultRootCandidates({ OLLAMA_MODELS: "/srv/ollama" }, home)[2]).toBe("/srv/ollama");
  });

  test("only the locations that exist are scanned", () => {
    const present = new Set(["/home/u/.ollama/models", "/home/u/.omlx"]);
    expect(defaultRoots({}, home, (p) => present.has(p))).toEqual(["/home/u/.ollama/models", "/home/u/.omlx"]);
    expect(defaultRoots({}, home, () => false)).toEqual([]);
  });
});

// ---- run(): the command line wired to a stand-in scan ----

interface Captured {
  io: Io;
  out: string[];
  err: string[];
  scans: ScanOptions[];
  loads: string[][];
}

function capture(result: ScanReport | Error = report([]), extra: Partial<Io> = {}): Captured {
  const c: Captured = { out: [], err: [], scans: [], loads: [], io: undefined as unknown as Io };
  c.io = {
    stdout: async (t) => void c.out.push(t),
    stderr: async (t) => void c.err.push(t),
    env: {},
    home: "/home/u",
    scan: async (options) => {
      c.scans.push(options);
      if (result instanceof Error) throw result;
      return result;
    },
    loadModels: async (roots) => {
      c.loads.push(roots);
      return { models: [], findings: [], walked: [] };
    },
    exists: () => true,
    isDirectory: (p) => p === "/home/u/.omlx",
    version: async () => "9.9.9",
    ...extra,
  };
  return c;
}

describe("run: exit codes and output (ISC-28)", () => {
  test("the process exits with the report's own exit code", async () => {
    const cases: [ScanReport, ExitCode][] = [
      [report([model([template("known-good")])]), 0],
      [report([model([template("findings", [finding("MEDIUM", "url_in_text")])])]), 1],
      [report([model([template("findings", [finding("HIGH", "dunder_access")])])]), 2],
      [report([model([template("incomplete")])]), 3],
    ];
    for (const [r, code] of cases) {
      expect(r.exitCode).toBe(code);
      expect(await run(["/m"], capture(r).io)).toBe(code);
    }
  });

  test("human output by default, the report as JSON with --json", async () => {
    const r = everything();
    const human = capture(r);
    await run(["/m"], human.io);
    expect(human.out.join("")).toContain("Templates, worst first");
    const json = capture(r);
    await run(["--json", "/m"], json.io);
    expect(JSON.parse(json.out.join(""))).toEqual(JSON.parse(JSON.stringify(r)));
    expect(json.err).toEqual([]);
  });

  test("a hostile template name and excerpt print escaped in both modes (ISC-44)", async () => {
    const osc = "\x1b]52;c;Y3VybCBldmlsLnNoIHwgc2g=\x07\u{202e}";
    const r = report([model([template("findings", [finding("HIGH", "invisible_char", { excerpt: osc, templateName: osc })], { name: osc })])]);
    for (const argv of [["/m"], ["--json", "/m"]]) {
      const c = capture(r);
      await run(argv, c.io);
      expect(RAW.test(c.out.join("").replaceAll("\n", ""))).toBe(false);
    }
  });

  test("the scan gets exactly what the command line asked for", async () => {
    const c = capture();
    await run(["--online", "--upstream", `Qwen/Qwen3-8B@${REV}`, "--template", "t.jinja", "a", "b"], c.io);
    expect(c.scans).toEqual([{ roots: ["a", "b"], templates: ["t.jinja"], online: true, upstream: { repo: "Qwen/Qwen3-8B", revision: REV } }]);
  });

  test("offline unless --online (ISC-36)", async () => {
    const c = capture();
    await run(["a"], c.io);
    expect(c.scans[0]!.online).toBe(false);
    expect(c.scans[0]!.upstream).toBeUndefined();
  });

  test("with no path, the default locations that exist; with only --template, no roots", async () => {
    const c = capture();
    await run([], c.io);
    expect(c.scans[0]!.roots).toEqual(["/home/u/.omlx"]);
    const t = capture();
    await run(["--template", "t.jinja"], t.io);
    expect(t.scans[0]!.roots).toEqual([]);
  });

  test("a scan that throws is one line on stderr and exit 3", async () => {
    const c = capture(new Error("boom"));
    expect(await run(["/m"], c.io)).toBe(3);
    expect(c.err).toEqual(["bassae: scan failed: boom\n"]);
    expect(c.out).toEqual([]);
  });
});

describe("run: usage errors are one line on stderr, exit 3, and nothing scanned", () => {
  const refused: [string, string[], Partial<Io>][] = [
    ["--upstream without --online", ["--upstream", `a/b@${REV}`, "m"], {}],
    ["an unknown option", ["--nope"], {}],
    ["a missing path", ["/no/such"], { exists: () => false }],
    ["a missing --template", ["--template", "/no/such.jinja"], { exists: () => false }],
    ["no path and no default location", [], { isDirectory: () => false }],
  ];
  for (const [what, argv, io] of refused) {
    test(what, async () => {
      const c = capture(report([]), io);
      expect(await run(argv, c.io)).toBe(3);
      expect(c.err).toHaveLength(1);
      expect(c.err[0]!.trimEnd()).not.toContain("\n");
      expect(c.err[0]).toStartWith("bassae: ");
      expect(c.out).toEqual([]);
      expect(c.scans).toEqual([]);
    });
  }

  test("an argument carrying an escape prints escaped", async () => {
    const c = capture(report([]), { exists: () => false });
    await run(["/tmp/\x1b]52;c;x\x07"], c.io);
    expect(c.err[0]).toContain("\\x1B]52;c;x\\x07");
  });
});

describe("run: --help, --version and --extract", () => {
  test("--help prints usage and exits 0, documenting the whole-template span", async () => {
    const c = capture();
    expect(await run(["--help"], c.io)).toBe(0);
    expect(c.out.join("")).toContain("Usage:");
    expect(c.out.join("")).toContain('"whole template"');
  });

  test("--version", async () => {
    const c = capture();
    expect(await run(["--version"], c.io)).toBe(0);
    expect(c.out).toEqual(["bassae 9.9.9\n"]);
  });

  test("--extract reads the model through loadModels and never scans", async () => {
    const root = makeTree({ model: {} });
    const c = capture();
    // The stand-in finds no model, so the extract exits 3 having written nothing.
    expect(await run(["--extract", join(root, "model"), "--out", join(root, "out")], c.io)).toBe(3);
    expect(c.loads).toEqual([[join(root, "model")]]);
    expect(c.scans).toEqual([]);
    expect(c.err.join("")).toContain("no model found");
    expect(readdirSync(root)).toEqual(["model"]);
  });
});

describe("the real binary", () => {
  const cli = join(import.meta.dir, "..", "..", "src", "cli.ts");

  test("a usage error exits 3 with one line on stderr and nothing on stdout", () => {
    const p = Bun.spawnSync(["bun", cli, "--upstream", `a/b@${REV}`]);
    expect(p.exitCode).toBe(3);
    expect(p.stdout.toString()).toBe("");
    expect(p.stderr.toString().trimEnd().split("\n")).toHaveLength(1);
  });

  test("--version reads package.json", () => {
    const p = Bun.spawnSync(["bun", cli, "--version"]);
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")) as { version: string };
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toBe(`bassae ${pkg.version}\n`);
  });

  test("no network API in the CLI's own code (ISC-36)", () => {
    const dir = join(import.meta.dir, "..", "..", "src");
    const files = [join(dir, "cli.ts"), ...readdirSync(join(dir, "cli")).map((f) => join(dir, "cli", f))];
    for (const f of files) expect(readFileSync(f, "utf8")).not.toMatch(/\bfetch\(|Bun\.connect|node:(net|http|https|dgram|tls)\b|Bun\.spawn|child_process/);
  });

  // Whole scans and --extract on real fixture trees: test/e2e.
});
