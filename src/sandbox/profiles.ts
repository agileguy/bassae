// Render environments. A template can test which globals exist and behave differently in the
// scanner than in a victim's jinja2, so each probe renders under both (ISC-22.2).

import { Template } from "@huggingface/jinja";
import type { EnvProfile } from "../types.ts";

/** Unwraps the library's runtime values, which is how keyword arguments reach a JS function. */
function plain(value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [k, plain(v)]));
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === "object" && value !== null && "value" in value) return plain(value.value);
  return value;
}

/** Mapping built from keyword arguments, as jinja2's dict(a=1) and namespace(a=1) are. */
function mapping(...args: unknown[]): unknown {
  return Object.assign({}, ...args.map(plain).filter((a) => typeof a === "object" && a !== null && !Array.isArray(a)));
}

const LIPSUM = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.";

// Stand-ins for jinja2's default globals. They only need to exist and behave plausibly,
// so that `is defined` and ordinary calls take the branch jinja2 would.
const JINJA2_GLOBALS: Record<string, unknown> = {
  dict: mapping,
  namespace: mapping,
  cycler: (...items: unknown[]) => {
    let i = 0;
    return {
      current: items[0],
      next: () => items[i++ % items.length],
      reset: () => {
        i = 0;
      },
    };
  },
  joiner: (sep: unknown = ", ") => {
    let used = false;
    return () => (used ? sep : ((used = true), ""));
  },
  lipsum: () => LIPSUM,
};

// Names the library already defines are left alone: its own version is the real one,
// and supplying a name twice makes the library throw.
const missing = Object.fromEntries(
  Object.entries(JINJA2_GLOBALS).filter(([name]) => new Template(`{{ ${name} is defined }}`).render() !== "true"),
);

/** Extra globals a profile adds on top of the @huggingface/jinja defaults. */
export function profileGlobals(profile: EnvProfile): Record<string, unknown> {
  return profile === "jinja2-globals" ? missing : {};
}
