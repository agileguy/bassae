// Tool integrity (ISC-22.4): every tool definition a probe passes renders JSON-equivalent to its input, unless a
// transform on the allowlist documents the template's own rendering of it.
//
// A tool passes when some JSON value in the output equals it, or its function member, whatever the key order and
// whitespace. Failing that, an allowlisted rendering must print it exactly as the cited template, or a pinned
// variant the entry cites, would. What is left over is the issue: a tool that never arrived, or arrived changed,
// and any tool definition in the output that the probe did not pass.
//
// The output is the template's to choose, so what checking it costs is bounded (Decisions, review round 1): the
// JSON scan has a character budget and a depth bound, the allowlisted sites a count, and the issues returned a
// count. Past a bound the check says so in an issue, so the tool is never passed unchecked.

import type { Transform } from "../registry/index.ts";
import type { IntegrityIssue, Probe } from "../types.ts";
import { TOOL_MATCHERS, type ToolMatcher } from "./transforms.ts";

export interface JsonValue {
  value: unknown;
  /** Where its text starts and ends in the scanned text. */
  start: number;
  end: number;
}

/**
 * The JSON values found, whether the scan stopped at its budget before reaching the end, and whether it skipped a
 * value nested deeper than MAX_JSON_DEPTH.
 */
export type JsonValues = JsonValue[] & { exhausted: boolean; deep: boolean };

// Characters a scan may examine before it gives up. Outputs are a few kilobytes; this only stops a hostile one.
const SCAN_BUDGET = 5_000_000;
/**
 * Nesting a JSON value may have and still be parsed. A tool definition needs a few dozen levels; the bound keeps
 * the recursion in `same` shallow, whatever the template prints.
 */
export const MAX_JSON_DEPTH = 256;
/** Allowlisted tool renderings checked in one output. A probe passes two tools, so an honest output has a few. */
export const MAX_TOOL_SITES = 256;
/** Issues returned for one output: the first ones, then one that counts the rest. */
export const MAX_TOOL_ISSUES = 20;

/**
 * The end of the bracketed text opening at `start`, or -1, and the depth it reached; `spend` counts the characters
 * examined.
 */
function closing(text: string, start: number, spend: (n: number) => boolean): { end: number; depth: number } {
  let depth = 0;
  let deepest = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    if (!spend(1)) return { end: -1, depth: deepest };
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") deepest = Math.max(deepest, ++depth);
    else if ((c === "}" || c === "]") && --depth === 0) return { end: i + 1, depth: deepest };
  }
  return { end: -1, depth: deepest };
}

// An object only starts where `{` is followed by a key or by `}`, which keeps template braces like `{name}` out.
const OPENING = /\{(?=\s*["}])|\[/g;

/**
 * Every top-level JSON object or array in `text`, left to right. Text that only looks like JSON is skipped, and so
 * is bracketed text nested deeper than MAX_JSON_DEPTH, along with everything inside it.
 */
export function jsonValues(text: string, budget = SCAN_BUDGET): JsonValues {
  const found = [] as unknown as JsonValues;
  found.exhausted = false;
  found.deep = false;
  let left = budget;
  const spend = (n: number) => (left -= n) >= 0;
  OPENING.lastIndex = 0;
  for (let m = OPENING.exec(text); m; m = OPENING.exec(text)) {
    const { end, depth } = closing(text, m.index, spend);
    if (left < 0) {
      found.exhausted = true;
      break;
    }
    if (end < 0) continue;
    if (depth > MAX_JSON_DEPTH) {
      found.deep = true;
      OPENING.lastIndex = end;
      continue;
    }
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

/**
 * Deep equality of JSON values, with object keys in any order. It recurses only while both sides nest, and one side
 * is always a value jsonValues parsed, so MAX_JSON_DEPTH bounds the recursion.
 */
function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (isObj(a)) {
    if (!isObj(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
  }
  return a === b;
}

// The walks below keep their own stack, and push children one at a time: a spread of a long array as arguments
// would overflow the call stack as surely as recursion would.

/** Every object and array inside the values, the values included. */
function nested(values: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  const stack = [...values];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v !== "object" || v === null) continue;
    out.push(v);
    for (const x of Object.values(v)) stack.push(x);
  }
  return out;
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

/** The tool definitions in `values`, outermost only, left to right: a definition's own function member is not counted again. */
function definitions(values: readonly unknown[]): { name: string; value: unknown }[] {
  const out: { name: string; value: unknown }[] = [];
  const stack = [...values].reverse();
  while (stack.length > 0) {
    const v = stack.pop();
    const name = definedName(v);
    if (name !== undefined) out.push({ name, value: v });
    else if (typeof v === "object" && v !== null) for (const x of Object.values(v).reverse()) stack.push(x);
  }
  return out;
}

const toolName = (tool: unknown) => {
  const fn = isObj(tool) && isObj(tool.function) ? tool.function : tool;
  return isObj(fn) && typeof fn.name === "string" ? fn.name : "(unnamed)";
};

interface Site {
  m: ToolMatcher;
  name: string;
  text: string;
}

/** The allowlisted sites in `output`, at most MAX_TOOL_SITES, and whether there were more. */
function sitesOf(output: string, matchers: readonly ToolMatcher[]): { sites: Site[]; crowded: boolean } {
  const sites: Site[] = [];
  for (const m of matchers) {
    const room = MAX_TOOL_SITES - sites.length;
    const found = m.sites(output, room + 1);
    for (const s of found.slice(0, room)) sites.push({ m, name: s.name, text: output.slice(s.start, s.end) });
    if (found.length > room) return { sites, crowded: true };
  }
  return { sites, crowded: false };
}

/** The tool_integrity issues in one rendered probe's output. Empty when the probe passes no tools or every tool arrived intact. */
export function checkTools(probe: Probe, output: string, transforms: readonly Transform[]): IntegrityIssue[] {
  if (probe.tools.length === 0) return [];
  const matchers = [...new Set(transforms.flatMap((t) => (TOOL_MATCHERS[t.id] ? [TOOL_MATCHERS[t.id]!] : [])))];
  const found = jsonValues(output);
  const values = found.map((f) => f.value);
  const everything = nested(values);
  // The forms in which a probe tool may legitimately appear as JSON: itself, or its function member.
  const forms = (tool: unknown) => [tool, ...(isObj(tool) && tool.function !== undefined ? [tool.function] : [])];
  const isProbeTool = (v: unknown) => probe.tools.some((t) => forms(t).some((f) => same(f, v)));

  const { sites, crowded } = sitesOf(output, matchers);
  // A site shows a tool when its text is the cited template's rendering of it, or a pinned variant's. Each matcher
  // renders each tool once, whatever the number of sites: the texts it may print, and the tools each one shows.
  const texts = new Map<ToolMatcher, Map<string, number[]>>();
  for (const m of matchers) {
    const shown = new Map<string, number[]>();
    for (const [i, tool] of probe.tools.entries()) {
      const text = m.render(tool);
      if (text === undefined) continue;
      for (const t of new Set([text, ...(m.variants?.(tool) ?? [])])) shown.set(t, [...(shown.get(t) ?? []), i]);
    }
    texts.set(m, shown);
  }
  const shows = (site: Site) => texts.get(site.m)!.get(site.text) ?? [];

  const passed = new Set(sites.flatMap(shows));
  const failing = probe.tools.flatMap((tool, i) => {
    if (passed.has(i) || everything.some((v) => forms(tool).some((f) => same(f, v)))) return [];
    return [i];
  });

  // Definitions in the output that match no probe tool: JSON ones, and allowlisted renderings of no probe tool.
  const extras = [...definitions(values).filter((d) => !isProbeTool(d.value)).map((d) => d.name), ...sites.filter((s) => shows(s).length === 0).map((s) => s.name)];

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
  // What the check could not finish comes before the extras, so a listing of the first few issues shows it.
  if (found.exhausted) {
    issues.push({ ruleId: "tool_integrity", index: -1, message: "the output holds more bracketed text than the scan budget, so an added tool cannot be ruled out" });
  }
  if (found.deep) {
    issues.push({ ruleId: "tool_integrity", index: -1, message: `the output nests bracketed text deeper than ${MAX_JSON_DEPTH} levels, so a tool inside it cannot be checked` });
  }
  if (crowded) {
    issues.push({
      ruleId: "tool_integrity",
      index: -1,
      message: `the output holds more than ${MAX_TOOL_SITES} allowlisted tool renderings, too many tool sites to check, so an added or altered tool cannot be ruled out`,
    });
  }
  const total = issues.length + extras.length;
  for (const name of extras.slice(0, Math.max(0, MAX_TOOL_ISSUES - issues.length))) {
    issues.push({ ruleId: "tool_integrity", index: -1, message: `the output defines a tool the probe did not pass: ${name}` });
  }
  if (total <= MAX_TOOL_ISSUES) return issues;
  return [...issues.slice(0, MAX_TOOL_ISSUES), { ruleId: "tool_integrity", index: -1, message: `${total - MAX_TOOL_ISSUES} more tool_integrity issues in this output are not listed` }];
}
