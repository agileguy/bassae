// Where bassae looks when it is given no path: each runtime's default model store on this machine.

import { statSync } from "node:fs";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

// A `~` at the start of an environment value means the home directory, as the runtimes read it.
function expand(value: string, home: string): string {
  return value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value;
}

function fromEnv(env: Env, name: string, home: string): string | undefined {
  const value = env[name];
  return value ? expand(value, home) : undefined;
}

/**
 * Every default location, in scan order:
 * - the Hugging Face hub cache, resolved the way huggingface_hub resolves it: HF_HUB_CACHE, else HF_HOME/hub,
 *   else XDG_CACHE_HOME/huggingface/hub, else ~/.cache/huggingface/hub;
 * - LM Studio's ~/.lmstudio/models;
 * - Ollama's store, OLLAMA_MODELS or ~/.ollama/models; its blobs are GGUF files without an extension,
 *   which discovery finds by magic bytes (ISC-1);
 * - omlx's ~/.omlx.
 */
export function defaultRootCandidates(env: Env, home: string): string[] {
  const hfHome = fromEnv(env, "HF_HOME", home);
  const xdg = fromEnv(env, "XDG_CACHE_HOME", home);
  const hub = fromEnv(env, "HF_HUB_CACHE", home) ?? (hfHome ? join(hfHome, "hub") : join(xdg ?? join(home, ".cache"), "huggingface", "hub"));
  const ollama = fromEnv(env, "OLLAMA_MODELS", home) ?? join(home, ".ollama", "models");
  return [hub, join(home, ".lmstudio", "models"), ollama, join(home, ".omlx")];
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The default locations that exist. Empty means there is nothing to scan, which the CLI treats as a usage error. */
export function defaultRoots(env: Env, home: string, exists: (path: string) => boolean = isDirectory): string[] {
  return defaultRootCandidates(env, home).filter(exists);
}
