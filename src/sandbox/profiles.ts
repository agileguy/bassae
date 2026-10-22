import type { EnvProfile } from "../types.ts";

/** Extra globals a profile adds on top of the @huggingface/jinja defaults. */
export function profileGlobals(_profile: EnvProfile): Record<string, unknown> {
  throw new Error("not implemented");
}
