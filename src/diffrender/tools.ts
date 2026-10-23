// Tool integrity (ISC-22.4): every tool definition a probe passes renders JSON-equivalent to its input, unless a
// transform on the allowlist documents the template's own rendering of it.
//
// A tool passes when some JSON value in the output equals it, or its function member, whatever the key order and
// whitespace. Failing that, an allowlisted rendering must print it exactly as the cited template, or a pinned
// variant the entry cites, would. What is left over is the issue: a tool that never arrived, or arrived changed,
// and any tool definition in the output that the probe did not pass.

import type { Transform } from "../registry/index.ts";
import type { IntegrityIssue, Probe } from "../types.ts";
import { TOOL_MATCHERS } from "./transforms.ts";

export interface JsonValue {
  value: unknown;
  /** Where its text starts and ends in the scanned text. */
  start: number;
  end: number;
}

/** The JSON values found, and whether the scan stopped at its budget before reaching the end. */
export type JsonValues = JsonValue[] & { exhausted: boolean };

// Characters a scan may examine before it gives up. Outputs are a few kilobytes; this only stops a hostile one.
const SCAN_BUDGET = 5_000_000;

/** The end of the bracketed text opening at `start`, or -1; `spend` counts the characters examined. */
function closing(text: string, start: number, spend: (n: number) => boolean): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    if (!spend(1)) return -1;
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if ((c === "}" || c === "]") && --depth === 0) return i + 1;
  }
  return -1;
}

// An object only starts where `{` is followed by a key or by `}`, which keeps template braces like `{name}` out.
const OPENING = /\{(?=\s*["}])|\[/g;

/** Every top-level JSON object or array in `text`, left to right. Text that only looks like JSON is skipped. */
export function jsonValues(text: string, budget = SCAN_BUDGET): JsonValues {
  const found = [] as unknown as JsonValues;
  found.exhausted = false;
  let left = budget;
  const spend = (n: number) => (left -= n) >= 0;
  OPENING.lastIndex = 0;
  for (let m = OPENING.exec(text); m; m = OPENING.exec(text)) {
    const end = closing(text, m.index, spend);
    if (left < 0) {
      found.exhausted = true;
      break;
    }
    if (end < 0) continue;
    try {
      found.push({ value: JSON.parse(text.slice(m.index, end)), start: m.index, end });
      OPENING.lastIndex = end;
    } catch {
      // Not JSON after all; the next opening may be.
    }
  }
  return found;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep equality of JSON values, with object keys in any order. */
function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (isObj(a)) {
    if (!isObj(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
  }
  return a === b;
}

/** Every object and array inside `v`, `v` included. */
function* nested(v: unknown): Generator<unknown> {
  if (typeof v !== "object" || v === null) return;
  yield v;
  for (const x of Object.values(v)) yield* nested(x);
}

/**
 * The name a tool definition declares, or undefined when `v` is not one. A definition is OpenAI-style
 * (`type: "function"` around a named function) or a bare named function with a description or a parameter
 * schema. A tool call names a function too, but carries `arguments`, or (Llama 3.x) its arguments as
 * `parameters` with no description, so it is not a definition.
 */
function definedName(v: unknown): string | undefined {
  if (!isObj(v)) return undefined;
  const fn = v.function;
  if (v.type === "function" && isObj(fn) && typeof fn.name === "string" && !("arguments" in fn)) return fn.name;
  if (typeof v.name !== "string" || "arguments" in v) return undefined;
  const schema = isObj(v.parameters) && (v.parameters.type === "object" || isObj(v.parameters.properties));
  return typeof v.description === "string" || schema ? v.name : undefined;
}

/** The tool definitions in `values`, outermost only: a definition's own function member is not counted again. */
function* definitions(values: readonly unknown[]): Generator<{ name: string; value: unknown }> {
  for (const v of values) {
    const name = definedName(v);
    if (name !== undefined) yield { name, value: v };
    else if (typeof v === "object" && v !== null) yield* definitions(Object.values(v));
  }
}

const toolName = (tool: unknown) => {
  const fn = isObj(tool) && isObj(tool.function) ? tool.function : tool;
  return isObj(fn) && typeof fn.name === "string" ? fn.name : "(unnamed)";
};

/** The tool_integrity issues in one rendered probe's output. Empty when the probe passes no tools or every tool arrived intact. */
export function checkTools(probe: Probe, output: string, transforms: readonly Transform[]): IntegrityIssue[] {
  if (probe.tools.length === 0) return [];
  const matchers = transforms.flatMap((t) => (TOOL_MATCHERS[t.id] ? [TOOL_MATCHERS[t.id]!] : []));
  const found = jsonValues(output);
  const values = found.map((f) => f.value);
  const everything = values.flatMap((v) => [...nested(v)]);
  // The forms in which a probe tool may legitimately appear as JSON: itself, or its function member.
  const forms = (tool: unknown) => [tool, ...(isObj(tool) && tool.function !== undefined ? [tool.function] : [])];
  const isProbeTool = (v: unknown) => probe.tools.some((t) => forms(t).some((f) => same(f, v)));

  const sites = matchers.flatMap((m) => m.sites(output).map((s) => ({ m, name: s.name, text: output.slice(s.start, s.end) })));
  // A site shows a tool when its text is the cited template's rendering of it, or a pinned variant's.
  const shows = (site: (typeof sites)[number], tool: unknown) => {
    const text = site.m.render(tool);
    return text !== undefined && (site.text === text || (site.m.variants?.(tool) ?? []).includes(site.text));
  };

  const failing = probe.tools.flatMap((tool, i) => {
    if (everything.some((v) => forms(tool).some((f) => same(f, v)))) return [];
    if (sites.some((s) => shows(s, tool))) return [];
    return [i];
  });

  // Definitions in the output that match no probe tool: JSON ones, and allowlisted renderings of no probe tool.
  const extras = [
    ...[...definitions(values)].filter((d) => !isProbeTool(d.value)).map((d) => d.name),
    ...sites.filter((s) => !probe.tools.some((t) => shows(s, t))).map((s) => s.name),
  ];

  const issues: IntegrityIssue[] = [];
  for (const i of failing) {
    const name = toolName(probe.tools[i]);
    const changed = extras.indexOf(name);
    if (changed >= 0) {
      extras.splice(changed, 1);
      issues.push({ ruleId: "tool_integrity", index: i, message: `tool ${i} (${name}) is altered: the output defines ${name} differently from the input` });
    } else {
      issues.push({
        ruleId: "tool_integrity",
        index: i,
        message: `tool ${i} (${name}) is missing: no JSON value in the output equals it, and no allowlisted rendering shows it verbatim`,
      });
    }
  }
  for (const name of extras) issues.push({ ruleId: "tool_integrity", index: -1, message: `the output defines a tool the probe did not pass: ${name}` });
  if (found.exhausted) {
    issues.push({ ruleId: "tool_integrity", index: -1, message: "the output holds more bracketed text than the scan budget, so an added tool cannot be ruled out" });
  }
  return issues;
}
