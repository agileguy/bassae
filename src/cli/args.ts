// Command-line parsing, as a pure function: argv in, a command or one line of error out.
// Every refusal here becomes exit 3 before anything is read (ISC-28).

import { normalizeRevision, repoIdProblem } from "../provenance/hub.ts";

export type Command =
  | { kind: "help" }
  | { kind: "version" }
  | {
      kind: "scan";
      json: boolean;
      /** The only switch that allows a network call (ISC-36). */
      online: boolean;
      upstream?: { repo: string; revision: string };
      /** Bare templates (--template, ISC-39). */
      templates: string[];
      /** Empty means the default model locations. */
      paths: string[];
    }
  | { kind: "extract"; model: string; out: string };

export type Parsed = { ok: true; command: Command } | { ok: false; error: string };

export const USAGE = `Usage:
  bassae [--json] [--online [--upstream <repo>@<revision>]] [--template <file>]... [<path>...]
  bassae --extract <model> --out <dir>
  bassae --help | --version

Finds MLX and GGUF models under each <path>, extracts every chat template, and
reports what each one could do: code execution, hidden instructions, triggers,
content tampering, and divergence from a pinned known-good baseline.

With no <path> and no --template, scans the default model locations that exist:
the Hugging Face hub cache ($HF_HUB_CACHE, else $HF_HOME/hub, else
~/.cache/huggingface/hub), ~/.lmstudio/models, ~/.ollama/models
($OLLAMA_MODELS) and ~/.omlx.

Options:
  --json                 Print the report as JSON (schema/report.schema.json).
  --online               Allow network access. Nothing else does.
  --upstream <r>@<rev>   Compare with the templates of hub repo <r> (org/name) at
                         commit <rev> (40 hex). Needs --online.
  --template <file>      Also scan a template file on its own. Repeatable.
  --extract <model>      Write each template of <model> to --out as
                         <sha256 first 12>_<name>.jinja, exact bytes. Never
                         overwrites, never writes under the scanned path.
  --out <dir>            Where --extract writes.

A finding's position is line:col in the template, or "whole template" when it
is about the template as a whole; in JSON that span is start 0, end 0, line 1,
col 1. In the human report, a finding outside any template prints no position.
Control, bidi and invisible characters print escaped.

Exit codes: 2 any HIGH finding; else 3 any incomplete template, scanner or
parse error, or usage error; else 1 any MEDIUM; else 0.`;

const FLAGS = new Set(["--json", "--online", "--help", "-h", "--version"]);
const VALUED = new Set(["--upstream", "--template", "--extract", "--out"]);

class UsageError extends Error {}

function upstreamOf(value: string): { repo: string; revision: string } {
  const at = value.indexOf("@");
  const repo = at < 0 ? "" : value.slice(0, at);
  const revision = at < 0 ? "" : value.slice(at + 1);
  if (!repo || !revision) throw new UsageError("--upstream takes <repo>@<revision>, e.g. Qwen/Qwen3-8B@<40-hex commit>");
  const problem = repoIdProblem(repo);
  if (problem) throw new UsageError(`--upstream repo ${JSON.stringify(repo)}: ${problem}`);
  const rev = normalizeRevision(revision);
  if (!rev) throw new UsageError(`--upstream revision ${JSON.stringify(revision)} must be a full 40-hex commit hash, not a branch or tag`);
  return { repo, revision: rev };
}

function parse(argv: readonly string[]): Command {
  // Asking for help is never a usage error, whatever else is on the line.
  const end = argv.indexOf("--");
  const options = end < 0 ? argv : argv.slice(0, end);
  if (options.includes("--help") || options.includes("-h")) return { kind: "help" };

  const flags = new Set<string>();
  const once = new Map<string, string>();
  const templates: string[] = [];
  const paths: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      paths.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      paths.push(arg);
      continue;
    }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = eq < 0 ? arg : arg.slice(0, eq);
    if (FLAGS.has(name)) {
      if (eq >= 0) throw new UsageError(`${name} takes no value`);
      flags.add(name === "-h" ? "--help" : name);
      continue;
    }
    if (!VALUED.has(name)) throw new UsageError(`unknown option ${name}`);
    // A following option is a forgotten value, not a value; a value that starts with - needs the = spelling.
    const next = argv[i + 1];
    const value = eq >= 0 ? arg.slice(eq + 1) : next !== undefined && !next.startsWith("-") ? (i++, next) : "";
    if (!value) throw new UsageError(`${name} needs a value`);
    if (name === "--template") templates.push(value);
    else if (once.has(name)) throw new UsageError(`${name} may be given only once`);
    else once.set(name, value);
  }

  if (flags.has("--help")) return { kind: "help" };
  if (flags.has("--version")) return { kind: "version" };

  const model = once.get("--extract");
  const out = once.get("--out");
  if (model !== undefined || out !== undefined) {
    if (model === undefined) throw new UsageError("--out is only for --extract <model>");
    if (out === undefined) throw new UsageError("--extract needs --out <dir>");
    if (flags.size > 0 || templates.length > 0 || paths.length > 0 || once.has("--upstream")) {
      throw new UsageError("--extract <model> --out <dir> takes no other options or paths");
    }
    return { kind: "extract", model, out };
  }

  const online = flags.has("--online");
  const upstreamArg = once.get("--upstream");
  // No network without --online, and --upstream goes to the network (ISC-36).
  if (upstreamArg !== undefined && !online) throw new UsageError("--upstream fetches from the hub, so it needs --online");
  const command: Command = { kind: "scan", json: flags.has("--json"), online, templates, paths };
  if (upstreamArg !== undefined) command.upstream = upstreamOf(upstreamArg);
  return command;
}

export function parseArgs(argv: readonly string[]): Parsed {
  try {
    return { ok: true, command: parse(argv) };
  } catch (e) {
    if (e instanceof UsageError) return { ok: false, error: e.message };
    throw e;
  }
}
