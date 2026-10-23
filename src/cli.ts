#!/usr/bin/env bun
// bassae's entry point. It installs the crash handlers before anything else loads, then loads the command,
// cli/main.ts, and runs it. A failure while the command loads (a package that is not installed, a module that
// throws as it evaluates) is then reported like any other: one line on stderr and exit 3, never the 1 bun
// gives on its own, which ISC-28 keeps for a MEDIUM finding. So nothing here is imported statically.

// A module, so the await below may sit at the top level. It exports nothing.
export {};

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Until escape.ts has loaded, and if it never does, everything but printable ASCII is escaped, the backslash
// included: stricter than the real escapeText, never looser (ISC-44).
let escapeText = (s: string) => s.replace(/[^\x20-\x5b\x5d-\x7e]/gu, (ch) => `\\u{${ch.codePointAt(0)!.toString(16).toUpperCase()}}`);

// Whatever escapes main() altogether, a failure to load, a throw in a callback or a promise nobody awaited,
// is 3 as well.
const crash = (e: unknown) => {
  try {
    process.stderr.write(`${escapeText(`bassae: internal error: ${errorMessage(e)}`)}\n`);
  } finally {
    process.exit(3);
  }
};

if (import.meta.main) {
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  try {
    ({ escapeText } = await import("./cli/escape.ts"));
    const { main } = await import("./cli/main.ts");
    process.exitCode = await main(process.argv.slice(2));
  } catch (e) {
    crash(e);
  }
}
