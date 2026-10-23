// The differential-rendering probe matrix (ISC-22).
//
// `explain` probes are ordinary use: each conversation shape with and without a system message, tools present and
// absent, add_generation_prompt both ways, at the reference date. A trigger candidate the injection rules class as
// presence is a documented vocabulary value, so it is ordinary use too. `vary` probes each change one thing a
// trigger could wait for: the date, the number of messages, the length of a content, or a trigger candidate's
// value placed where the template reads it.
//
// Every content is a distinct, benign, multi-word ASCII sentence and none holds another, so a verbatim search for
// one is unambiguous (ISC-22.3). Probe.inputs lists every string a probe passes, which is what removing input from
// output takes away (residue.ts).

import { parseTemplate } from "../parse/parse.ts";
import { children, type Node } from "../parse/support.ts";
import type { Probe, ProbeContent, TriggerCandidate } from "../types.ts";

export const REFERENCE_DATE = "2026-07-15T12:00:00Z";
// Ten years either side, in other months and on other weekdays, so a gate on the year, month or day shows up.
export const VARY_DATES = ["2016-03-01T09:30:00Z", "2036-11-30T23:15:00Z"] as const;
export const BOS = "<s>";
export const EOS = "</s>";

// Probes per template. The fixed matrix is 46 and a stock template has at most a few dozen trigger values, so
// the cap only cuts a template that lists hundreds; the cut probes leave the result incomplete.
export const MAX_PROBES = 160;
// The longest conversation and content a threshold probe builds. A threshold past them is cut, not probed.
const MAX_COUNT = 200;
const MAX_LENGTH = 200_000;

type Message = { role: string; content: unknown; [field: string]: unknown };

interface Spec {
  label: string;
  role: Probe["role"];
  messages: Message[];
  tools?: unknown[];
  gen?: boolean;
  now?: string;
  /** Top-level variables besides messages and tools: kwargs and documents. */
  extra?: Record<string, unknown>;
}

// ---- the conversations ----

const SYSTEM = "You are a patient guide for the harbor museum archive.";
const TALK: Message[] = [
  { role: "user", content: "Which ships docked at the old harbor last spring?" },
  { role: "assistant", content: "Three wooden schooners docked there during the spring festival." },
  { role: "user", content: "Did any of them carry painted figureheads?" },
  { role: "assistant", content: "Two of them carried carved figureheads painted in deep blue." },
  { role: "user", content: "Where are those figureheads displayed today?" },
];
const TOOL_ROUND: Message[] = [
  { role: "user", content: "What is the weather in Lisbon this afternoon?" },
  {
    role: "assistant",
    content: "",
    tool_calls: [{ id: "call_harbor_1", type: "function", function: { name: "get_weather", arguments: { city: "Lisbon" } } }],
  },
  { role: "tool", name: "get_weather", tool_call_id: "call_harbor_1", content: "Lisbon reports clear skies and a gentle sea breeze." },
];
// The keys a probe's tools use. A key a template's own candidate names may be added beside them, holding a note
// or the candidate's value (placeInTool), since the probe exercises the template's own branch.
interface Schema {
  type: string;
  description?: string;
  enum?: string[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  [key: string]: unknown;
}
interface Tool {
  type: string;
  function: { name: string; description: string; parameters: Schema; [key: string]: unknown };
  [key: string]: unknown;
}

// The tool set the integrity checks port (ISC-22.4): two tools that between them use standard JSON Schema, namely
// string, integer, number and boolean, an enum, an array with items, a nested object and required lists, with a
// description on every parameter, so a template that drops a tool or alters an enum or a nested description shows
// it. Every description is distinct and none holds another.
const TOOLS: Tool[] = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Report the current weather for a named city.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "The city to report on." },
          unit: { type: "string", description: "The temperature scale to use.", enum: ["celsius", "fahrenheit"] },
        },
        required: ["city"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_inventory",
      description: "Search the warehouse stock for matching goods.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free text to match against product names." },
          limit: { type: "integer", description: "The largest number of results to return." },
          max_price: { type: "number", description: "The highest unit price to include." },
          in_stock: { type: "boolean", description: "Whether to include only goods on hand." },
          tags: { type: "array", description: "Labels every result must carry.", items: { type: "string" } },
          filter: {
            type: "object",
            description: "Narrow the search to one region.",
            properties: {
              region: { type: "string", description: "The warehouse region code." },
              aisle: { type: "integer", description: "The aisle number inside the region." },
            },
            required: ["region"],
          },
        },
        required: ["query"],
      },
    },
  },
];
const DOCUMENT = { title: "Harbor tide table", text: "The spring tides at the harbor peak just after dawn." };
// Every shape ends on a user or tool turn, as a chat request does; a vary probe that ended on an assistant turn
// would show the template's continuation markup, which no explain probe prints.
const SHAPES: Record<string, Message[]> = { one: TALK.slice(0, 1), chat3: TALK.slice(0, 3), chat5: TALK, tool: TOOL_ROUND };
const EXTRA_TURN = "A short note about the harbor tides for the archive.";

const withSystem = (system: boolean, messages: Message[]): Message[] => (system ? [{ role: "system", content: SYSTEM }, ...messages] : messages);
const baseLabel = (shape: string, system: boolean, tools: boolean, gen: boolean) =>
  `${shape}/${system ? "system" : "no-system"}/${tools ? "tools" : "no-tools"}/${gen ? "gen" : "no-gen"}`;

/** `n` alternating turns, user first; an odd `n` ends on a user turn. Each says which turn it is, so none holds another. */
function longChat(n: number): Message[] {
  return Array.from({ length: n }, (_, i) =>
    i % 2 === 0
      ? { role: "user", content: `Turn ${i + 1} asks the harbor guide about the tides.` }
      : { role: "assistant", content: `Turn ${i + 1} answers with a note about the tides.` },
  );
}

/** A conversation of exactly `n` messages ending on a user turn: a system message first when `n` is even. */
function conversation(n: number): Message[] {
  return n % 2 === 1 ? longChat(n) : withSystem(true, longChat(n - 1));
}

/** A content of exactly `n` characters, with no space at either end. */
function longText(n: number): string {
  let text = "";
  for (let i = 1; text.length < n; i++) text += `Ledger entry ${i} records the cargo, tides and weather of one harbor day. `;
  text = text.slice(0, n);
  return text.endsWith(" ") ? `${text.slice(0, -1)}.` : text;
}

// ---- the fixed matrix ----

function explainSpecs(withTools: boolean): Spec[] {
  const out: Spec[] = [];
  for (const [shape, messages] of Object.entries(SHAPES)) {
    for (const system of [false, true]) {
      for (const tools of withTools ? [false, true] : [false]) {
        for (const gen of [false, true]) {
          out.push({ label: baseLabel(shape, system, tools, gen), role: "explain", messages: withSystem(system, messages), tools: tools ? TOOLS : undefined, gen });
        }
      }
    }
  }
  return out;
}

function varySpecs(withTools: boolean): Spec[] {
  const out: Spec[] = [];
  // The date bases: a chat in every system and tools combination, and a tool round trip, so a gate on the date
  // inside the system header or the tool list is reached even when a template refuses a system turn.
  const bases: [string, boolean, boolean][] = (
    [
      ["chat3", false, false],
      ["chat3", false, true],
      ["chat3", true, false],
      ["chat3", true, true],
      ["tool", false, true],
    ] as [string, boolean, boolean][]
  ).flatMap(([shape, system, tools]) => (withTools || !tools ? [[shape, system, tools]] : shape === "tool" ? [[shape, system, false]] : []));
  for (const now of VARY_DATES) {
    for (const [shape, system, tools] of bases) {
      const label = `date:${now.slice(0, 4)}/${baseLabel(shape, system, tools, true)}`;
      out.push({ label, role: "vary", messages: withSystem(system, SHAPES[shape]!), tools: tools ? TOOLS : undefined, now });
    }
  }
  // Fifty messages with a system turn first, and forty-nine without for templates that refuse one.
  out.push({ label: "count:50", role: "vary", messages: conversation(50) });
  out.push({ label: "count:49", role: "vary", messages: conversation(49) });
  const long = longText(48_000);
  out.push({ label: "long:user", role: "vary", messages: [{ role: "user", content: long }] });
  out.push({ label: "long:system", role: "vary", messages: [{ role: "system", content: long }, TALK[0]!] });
  return out;
}

// ---- trigger candidates ----

const EXPLAIN_ROLES = new Set(["system", "user", "assistant", "tool"]);

/** `value` inside a benign sentence: at its start for startswith or a slice of the start, at its end for endswith or a slice of the end, else in the middle. */
function sentence(value: string, op: TriggerCandidate["op"], sliceEnd: boolean): string {
  if (op === "startswith" || (op === "slice" && !sliceEnd)) return `${value} is how this question about the harbor begins.`;
  if (op === "endswith" || op === "slice") return `This question about the harbor ends with ${value}`;
  return `Please note that ${value} matters for this question about the harbor.`;
}

/** The value a numeric threshold passes at. */
function passing(op: TriggerCandidate["op"], n: number): number {
  if (op === ">") return n + 1;
  if (op === "<") return n - 1;
  return n;
}

// `[]` in a path: any element. The probe puts the value in the first one, or where its kind of input usually sits.
const ANY = Symbol("any element");
type Token = string | number | typeof ANY; // a field name, an element index (-1 is the last), or any element
const isIndex = (t: Token | undefined): t is number | typeof ANY => typeof t === "number" || t === ANY;
// OpenAI's function-name rule; a value that is a key or a name anywhere in a probe must pass it.
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

function parsePath(input: string): Token[] {
  const path = (input.match(/\[[^\]]*\]|[^.[\]]+/g) ?? []).map((t): Token => {
    if (!t.startsWith("[")) return t;
    const n = Number(t.slice(1, -1));
    return t !== "[]" && Number.isInteger(n) ? n : ANY;
  });
  // Writing along a path through `__proto__` would change Object.prototype in the scanner itself, so such a path
  // has no place and its value is sent as plain content.
  return path.includes("__proto__") ? [] : path;
}

// What the candidates' paths show a template reading under each node, so a key a probe adds holds the shape the
// template reads from it: a mapping of the keys it reads, a list when it reads elements, else a note.
type Reads = Map<string, Set<Token>>;
const readKey = (path: Token[]) => path.map((t) => (isIndex(t) ? "[]" : t)).join(".");

/** A path with every index read as any element and a tool's fields under `function`, as placeInTool reads `tools[].name`. */
function normalPath(path: Token[]): Token[] {
  const p = path.map((t) => (isIndex(t) ? ANY : t));
  if (p[0] === "tools" && p.length > 2 && p[2] !== "function" && p[2] !== "type") p.splice(2, 0, "function");
  return p;
}

function readsOf(triggers: readonly TriggerCandidate[]): Reads {
  const reads: Reads = new Map();
  for (const t of triggers) {
    const path = t.input ? normalPath(parsePath(t.input)) : [];
    for (let i = 1; i < path.length; i++) {
      const key = readKey(path.slice(0, i));
      reads.set(key, (reads.get(key) ?? new Set<Token>()).add(path[i]!));
    }
  }
  return reads;
}

/** What a key at `path` holds when a probe adds it: whatever the template reads under it, each part filled in turn, ending in `note`. */
function filled(reads: Reads, path: Token[], note: string): unknown {
  const under = reads.get(readKey(path));
  if (!under) return note;
  if (under.has(ANY)) return [filled(reads, [...path, ANY], note)];
  const out: Record<string, unknown> = {};
  for (const k of under) if (typeof k === "string") out[k] = filled(reads, [...path, k], note);
  return out;
}

const clone = <T>(v: T): T => structuredClone(v);

/** Sets `value` at `path` under `root`, creating objects and one-element arrays on the way. */
function setAt(root: Record<string, unknown>, path: Token[], value: unknown): void {
  let node: Record<string | number, unknown> | unknown[] = root;
  for (let i = 0; i < path.length; i++) {
    const token = path[i]!;
    const last = i === path.length - 1;
    if (isIndex(token)) {
      if (!Array.isArray(node)) return;
      const at = token === ANY ? 0 : token < 0 ? Math.max(node.length + token, 0) : token;
      if (last) node[at] = value;
      else {
        if (typeof node[at] !== "object" || node[at] === null) node[at] = isIndex(path[i + 1]) ? [] : {};
        node = node[at] as Record<string, unknown>;
      }
    } else {
      const obj = node as Record<string, unknown>;
      if (last) obj[token] = value;
      else {
        const wantArray = isIndex(path[i + 1]);
        if (wantArray ? !Array.isArray(obj[token]) : typeof obj[token] !== "object" || obj[token] === null) obj[token] = wantArray ? [] : {};
        node = obj[token] as Record<string, unknown>;
      }
    }
  }
}

/** The node at `path` under `root`, reading `[]` as the first element, or undefined. */
function nodeAt(root: unknown, path: Token[]): unknown {
  let node = root;
  for (const token of path) {
    if (Array.isArray(node) && isIndex(token)) node = node.at(token === ANY ? 0 : token);
    else if (typeof node === "object" && node !== null && typeof token === "string") node = (node as Record<string, unknown>)[token];
    else return undefined;
  }
  return node;
}

// What a key a template looks for holds when a probe adds it.
const KEY_NOTE = "A note kept with this message for the archive.";
// The text of a text part a probe adds beside the message's own.
const PART_TEXT = "This second part repeats the question about the harbor.";

/**
 * Sets `value` at `path` under `target`, which sits at `at`. When the path ends on an object the conversation already
 * has there, a string compared with it can only be a key the template looks for, so the object gets that key unless
 * it has it; an object or list is never overwritten by a string. Returns false when the value has no legal place there.
 */
function putAt(target: Record<string, unknown>, path: Token[], value: string | number, reads: Reads, at: Token[]): boolean {
  const node = nodeAt(target, path);
  if (Array.isArray(node)) return false;
  if (typeof node === "object" && node !== null) {
    if (typeof value !== "string" || !NAME.test(value)) return false;
    if (!(value in node)) (node as Record<string, unknown>)[value] = filled(reads, [...at, ...path, value], KEY_NOTE);
    return true;
  }
  setAt(target, path, value);
  return true;
}

/** A content part a template tests, in the OpenAI form whose `type` names the field holding it; text that is not a type goes in a text part. */
function part(rest: Token[], value: string | number): Record<string, unknown> {
  const v = String(value);
  const atType = rest.length === 0 || (rest.length === 1 && rest[0] === "type");
  if (atType && NAME.test(v) && v !== "type") return { type: v, [v]: v === "text" ? PART_TEXT : `harbor_${v}_sample` };
  const [field] = rest;
  if (atType || field === "text" || typeof field !== "string") return { type: "text", text: v };
  const p: Record<string, unknown> = { type: field };
  setAt(p, rest, value);
  return p;
}

/** The probe that sends `value` where `path` says a template reads it. */
function place(path: Token[], value: string | number, reads: Reads): Omit<Spec, "label" | "role"> {
  const [root, , field] = path;
  const fallback = { messages: [{ role: "user", content: String(value) }] };
  const message: Token[] = ["messages", ANY];
  if (root === "messages" && path.length === 2) {
    // A message tested for a key: the shape whose messages have it, else the assistant turn of a chat with it added.
    if (typeof value !== "string" || !NAME.test(value)) return fallback;
    for (const shape of Object.values(SHAPES)) if (shape.some((m) => value in m)) return { messages: shape };
    const messages = clone(SHAPES.chat3!);
    messages[1]![value] = filled(reads, [...message, value], KEY_NOTE);
    return { messages };
  }
  if (root === "messages" && path.length > 2) {
    const index = path[1];
    // A tool call's fields sit on the assistant's call in the tool round trip; a result's id on the tool turn.
    if (field === "tool_calls" || field === "tool_call_id" || field === "reasoning_content" || field === "thinking" || field === "reasoning") {
      const messages = clone(field.startsWith("tool") ? TOOL_ROUND : SHAPES.chat3!);
      return putAt(messages[field === "tool_call_id" ? 2 : 1]!, path.slice(2), value, reads, message) ? { messages } : fallback;
    }
    if (field === "role") {
      const extra = { role: String(value), content: EXTRA_TURN };
      return { messages: index === 0 ? [extra, clone(TALK[0]!)] : [clone(TALK[0]!), extra] };
    }
    const user = clone(TALK[0]!);
    // A tested content part goes beside a text part holding the message's own sentence, which still renders.
    if (field === "content" && isIndex(path[3])) {
      user.content = [{ type: "text", text: TALK[0]!.content }, part(path.slice(4), value)];
      return { messages: [user] };
    }
    return putAt(user, path.slice(2), value, reads, message) ? { messages: [user] } : fallback;
  }
  if (root === "tools") return { messages: SHAPES.one!, tools: placeInTools(path, String(value), reads) };
  if (root === "documents" && path.length >= 2) {
    const documents: Record<string, unknown>[] = [clone(DOCUMENT)];
    return putAt(documents[0]!, path.slice(2), value, reads, ["documents", ANY]) ? { messages: SHAPES.one!, extra: { documents } } : fallback;
  }
  // A loop's own attributes are not context; its counters are handled as thresholds (triggerSpecs).
  if (root === "loop") return fallback;
  if (typeof root === "string" && root !== "messages" && root !== "tools" && root !== "documents") {
    const extra: Record<string, unknown> = {};
    setAt(extra, path, value);
    return { messages: SHAPES.one!, extra };
  }
  return fallback;
}

// A trigger aimed at a tool field goes only where an OpenAI-style tool with a standard JSON Schema allows it, since
// the integrity checks model that shape: a name or description as a string, a type from the JSON Schema vocabulary,
// a string in a string's enum, a property name. A key the candidate itself names is not invented, so a key the
// template tests for is added holding what the template reads under it (a note when it reads nothing there), and a
// key it compares holds the value; no other key is ever added. A value that cannot go where its path points goes
// into the first tool's description, which still reaches a template that prints it.
const JSON_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object", "null"]);
// The keywords whose values JSON Schema shapes, so a candidate's string is never written there as it is.
const SCHEMA_KEYS = new Set(["type", "description", "enum", "items", "properties", "required"]);
const TOOL_NOTE = "A note kept with this tool for the archive.";

/** The schema the fixed tools use for `type`, with `description` kept. */
function schemaOf(type: string, description: string | undefined): Schema {
  const d = description ? { description } : {};
  if (type === "array") return { type, ...d, items: { type: "string" } };
  if (type === "object") return { type, ...d, properties: { note: { type: "string", description: "A short remark for this field." } } };
  return { type, ...d };
}

/** The property `name` of an object schema, made a described string when it is new and `create` allows it. */
function property(node: Schema, name: string, create: boolean): Schema | undefined {
  if (node.type !== "object" || !NAME.test(name)) return undefined;
  const existing = node.properties?.[name];
  if (existing || !create) return existing;
  node.properties = { ...node.properties, [name]: { type: "string", description: `The ${name} setting for this request.` } };
  return node.properties[name];
}

/**
 * A key the template tests for on a tool, function or schema at `at`: kept when there, else added when `create`
 * allows, holding what the template reads under it or, for a schema keyword, a legal value of its kind.
 */
function addKey(node: Record<string, unknown>, key: string, create: boolean, schema: boolean, reads: Reads, at: Token[]): boolean {
  if (!NAME.test(key)) return false;
  if (key in node) return true;
  if (!create) return false;
  if (schema && SCHEMA_KEYS.has(key)) {
    const s = node as Schema;
    if (key === "description") s.description = TOOL_NOTE;
    else if (key === "enum" && s.type === "string") s.enum = ["harbor_enum_sample"];
    else if (key === "required" && s.type === "object") s.required = [];
    else if (key === "properties" && s.type === "object") s.properties = {};
    else return false;
    return true;
  }
  node[key] = filled(reads, [...at, key], TOOL_NOTE);
  return true;
}

/**
 * A key the candidate names and compares with `value`, at `at`, set to it unless JSON Schema shapes that key's
 * value. On a longer path the key holds what the template reads under it, with `value` where the path ends.
 */
function setNamed(node: Record<string, unknown>, path: Token[], value: string, create: boolean, reads: Reads, at: Token[]): boolean {
  const [key, next] = path;
  if (typeof key !== "string" || SCHEMA_KEYS.has(key)) return false;
  if (!(key in node) && !create) return false;
  if (path.length === 1) node[key] = value;
  else {
    if (typeof node[key] !== "object" || node[key] === null) {
      const held = filled(reads, [...at, key], TOOL_NOTE);
      node[key] = typeof held === "object" ? held : isIndex(next) ? [] : {};
    }
    setAt(node[key] as Record<string, unknown>, path.slice(1), value);
  }
  return true;
}

/** Puts `value` where `path` points inside a parameters schema at `at`, or returns false when standard JSON Schema has no place for it there. */
function placeInSchema(node: Schema, path: Token[], value: string, isRoot: boolean, create: boolean, reads: Reads, at: Token[]): boolean {
  if (path.length === 0) return addKey(node, value, create, true, reads, at);
  const [key, next] = path;
  const leaf = path.length === 1 || (path.length === 2 && isIndex(next));
  if (key === "description" && path.length === 1) {
    node.description = value;
    return true;
  }
  if (key === "type" && path.length === 1) {
    if (!JSON_TYPES.has(value)) return false;
    // Function parameters are an object schema; any other type there is not a legal tool.
    if (isRoot) return value === "object";
    const schema = schemaOf(value, node.description);
    for (const k of Object.keys(node)) delete node[k];
    Object.assign(node, schema);
    return true;
  }
  if (key === "enum" && leaf) {
    if (isRoot || node.type !== "string") return false;
    if (!node.enum?.includes(value)) node.enum = [...(node.enum ?? []), value];
    return true;
  }
  if ((key === "required" || key === "properties") && leaf) {
    // A name tested against the required list or the property names: a property of that name, required if asked.
    if (!property(node, value, true)) return false;
    if (key === "required" && !node.required?.includes(value)) node.required = [...(node.required ?? []), value];
    return true;
  }
  if (key === "properties" && typeof next === "string") {
    const child = property(node, next, create);
    return child !== undefined && placeInSchema(child, path.slice(2), value, false, create, reads, [...at, key, next]);
  }
  if (key === "items" && node.type === "array" && node.items) return placeInSchema(node.items, path.slice(1), value, false, create, reads, [...at, key]);
  return setNamed(node, path, value, create, reads, at);
}

/** Puts `value` in a tool's field at `rest` (after `tools[i]`), or returns false. */
function placeInTool(tool: Tool, rest: Token[], value: string, create: boolean, reads: Reads): boolean {
  if (rest.length === 0) return addKey(tool, value, create, false, reads, ["tools", ANY]);
  if (rest.length === 1 && rest[0] === "type") return value === "function";
  // `tools[].name` reads a tool given without its function wrapper: the same fields.
  const path = rest[0] === "function" ? rest.slice(1) : rest;
  const fn = tool.function;
  const at: Token[] = ["tools", ANY, "function"];
  if (path.length === 0) return addKey(fn, value, create, false, reads, at);
  if (path.length === 1 && path[0] === "name") {
    if (!NAME.test(value)) return false;
    fn.name = value;
    return true;
  }
  if (path.length === 1 && path[0] === "description") {
    fn.description = value;
    return true;
  }
  if (path[0] === "parameters") return placeInSchema(fn.parameters, path.slice(1), value, true, create, reads, [...at, "parameters"]);
  // The function's own fields hold what OpenAI says they do; a key past them is the template's own.
  if (path[0] === "type" || path[0] === "name" || path[0] === "description") return false;
  return setNamed(fn, path, value, create, reads, at);
}

/** The fixed tools with `value` placed legally where `path` (from `tools`) points. */
function placeInTools(path: Token[], value: string, reads: Reads): Tool[] {
  const tools = clone(TOOLS);
  const at = path[1];
  const rest = path.slice(2);
  if (typeof at === "number") {
    const tool = tools.at(at);
    if (tool && placeInTool(tool, rest, value, true, reads)) return tools;
  } else if (at === ANY) {
    // Any tool: the first that already has the field, else the first tool with the field added.
    for (const tool of tools) {
      const trial = clone(tool);
      if (placeInTool(trial, rest, value, false, reads)) {
        Object.assign(tool, trial);
        return tools;
      }
    }
    if (placeInTool(tools[0]!, rest, value, true, reads)) return tools;
  }
  const fresh = clone(TOOLS);
  fresh[0]!.function.description = value;
  return fresh;
}

/** A date at which strftime_now() prints `value`: a year, or a month or weekday name. */
function dateFor(value: string | number, op: TriggerCandidate["op"]): string | undefined {
  const year = typeof value === "number" ? passing(op, value) : /^\d{4}$/.test(value) ? Number(value) : NaN;
  if (Number.isInteger(year) && year >= 1970 && year <= 2199) return `${year}-07-15T12:00:00Z`;
  if (typeof value !== "string") return undefined;
  const name = value.toLowerCase();
  const month = MONTHS.findIndex((m) => m === name || m.slice(0, 3) === name);
  if (month >= 0) return `2026-${String(month + 1).padStart(2, "0")}-15T12:00:00Z`;
  // 2026-07-13 is a Monday.
  const day = WEEKDAYS.findIndex((d) => d === name || d.slice(0, 3) === name);
  if (day >= 0) return `2026-07-${13 + day}T12:00:00Z`;
  return undefined;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/** The probes one trigger candidate adds. `cut` counts thresholds too far to build. */
function triggerSpecs(t: TriggerCandidate, i: number, text: string | undefined, reads: Reads): { specs: Spec[]; cut: number } {
  const role: Probe["role"] = t.test === "presence" ? "explain" : "vary";
  const path = t.input ? parsePath(t.input) : [];
  const label = `trigger:${i}`;
  const { value, op } = t;
  // The comparison as the template writes it, when the text is at hand: which end a slice takes, whether a number is a length.
  const written = text?.slice(t.span.start, t.span.end);

  if (t.test === "nondeterministic") {
    // The clock is the input; a value it could print gets a probe at that date, anything else (chance) none.
    const now = dateFor(value, op);
    return { specs: now ? [{ label: `date:${now.slice(0, 10)}`, role, messages: SHAPES.chat3!, now }] : [], cut: 0 };
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value)) return { specs: [], cut: 0 };
    const n = passing(op, value);
    if (path[0] === "loop") {
      // A loop counter (`loop.index0 == 3`, `loop.length > 3`): most loops walk the messages, so a conversation that reaches it.
      const count = path[1] === "index0" || path[1] === "revindex0" ? n + 1 : n;
      if (role === "explain") return { specs: [], cut: 0 };
      return count >= 1 && count <= MAX_COUNT ? { specs: [{ label: `count:${count}`, role, messages: conversation(count) }], cut: 0 } : { specs: [], cut: 1 };
    }
    if (path.length > 0) return { specs: [{ label, role, ...place(path, n, reads) }], cut: 0 };
    // A threshold on a computed value: most likely a message count or a content length, so both are sent. A number
    // the comparison does not take a length of is a search position (`find('x') != -1`), whose substring has an
    // `in` candidate of its own.
    if (role === "explain" || n < 0) return { specs: [], cut: 0 };
    if (written !== undefined && !/\|\s*(?:length|count)\b|\blength\s*\(/.test(written)) return { specs: [], cut: 0 };
    const specs: Spec[] = [];
    let cut = 0;
    if (n >= 1 && n <= MAX_COUNT) specs.push({ label: `count:${n}`, role, messages: conversation(n) });
    else cut++;
    if (n >= 1 && n <= MAX_LENGTH) specs.push({ label: `length:${n}`, role, messages: [{ role: "user", content: longText(n) }] });
    else cut++;
    return { specs, cut };
  }
  if (value.trim() === "") return { specs: [], cut: 0 };
  if (role === "explain" && path.at(-1) === "role" && EXPLAIN_ROLES.has(value)) return { specs: [], cut: 0 };
  return {
    specs: [
      { label: `${label}/exact`, role, ...place(path, value, reads) },
      { label: `${label}/sentence`, role, ...place(path, sentence(value, op, written !== undefined && /\[\s*-/.test(written)), reads) },
    ],
    cut: 0,
  };
}

// ---- probes from specs ----

// Strings inside these are listed with their keys, since a template may print the whole object as JSON.
const KEYED = new Set(["tools", "documents", "arguments"]);

function collect(value: unknown, keys: boolean, out: Set<string>): void {
  if (typeof value === "string") {
    if (value) out.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collect(v, keys, out);
  } else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if (keys) out.add(k);
      collect(v, keys || KEYED.has(k), out);
    }
  }
}

function contentsOf(messages: readonly Message[]): ProbeContent[] {
  const out: ProbeContent[] = [];
  messages.forEach((m, i) => {
    if (m.role !== "system" && m.role !== "user" && m.role !== "tool") return;
    if (typeof m.content === "string" && m.content) out.push({ role: m.role, message: i, text: m.content });
    else if (Array.isArray(m.content)) {
      // Text parts only: an image or other part's fields are not text the output must carry.
      for (const p of m.content) {
        const { type, text } = (p ?? {}) as { type?: unknown; text?: unknown };
        if ((type === undefined || type === "text") && typeof text === "string" && text) out.push({ role: m.role, message: i, text });
      }
    }
  });
  return out;
}

function toProbe(spec: Spec): Probe {
  // transformers' apply_chat_template always passes tools and documents, None when there are none, and templates
  // written for it test `tools is not none`; leaving them undefined would make ordinary use fail to render.
  const context: Record<string, unknown> = {
    bos_token: BOS,
    eos_token: EOS,
    documents: null,
    ...spec.extra,
    messages: spec.messages,
    add_generation_prompt: spec.gen ?? true,
    tools: spec.tools ?? null,
  };
  const inputs = new Set<string>();
  for (const [name, v] of Object.entries(context)) collect(v, KEYED.has(name), inputs);
  return {
    request: { id: spec.label, context, profile: "hf-default", now: spec.now ?? REFERENCE_DATE },
    role: spec.role,
    label: spec.label,
    contents: contentsOf(spec.messages),
    tools: spec.tools ?? [],
    inputs: [...inputs],
  };
}

export interface ProbeMatrix {
  /** Explain probes first, then vary probes, each in a fixed order. */
  probes: Probe[];
  /** Probes the cap cut, or thresholds too far to build; each leaves the result incomplete. */
  cut: number;
}

export interface ProbeOptions {
  /** False when the template never reads `tools` (readsTools): it cannot render them, so no probe passes any. */
  tools?: boolean;
  /** The template's text, where a trigger's span is read. */
  text?: string;
}

/** The fixed matrix plus each trigger candidate's probes, deduplicated and capped at MAX_PROBES. */
export function buildProbes(triggers: readonly TriggerCandidate[], options: ProbeOptions = {}): ProbeMatrix {
  const withTools = options.tools !== false;
  const specs = [...explainSpecs(withTools), ...varySpecs(withTools)];
  const reads = readsOf(triggers);
  let cut = 0;
  triggers.forEach((t, i) => {
    const r = triggerSpecs(t, i, options.text, reads);
    specs.push(...(withTools ? r.specs : r.specs.map((s) => ({ ...s, tools: undefined }))));
    cut += r.cut;
  });
  // Two candidates that send the same thing are one probe; the first keeps its label.
  const seen = new Set<string>();
  const unique: Spec[] = [];
  for (const s of specs) {
    const key = JSON.stringify([s.role, s.messages, s.tools, s.gen, s.now, s.extra]);
    const labelKey = `label:${s.label}`;
    if (seen.has(key) || seen.has(labelKey)) continue;
    seen.add(key);
    seen.add(labelKey);
    unique.push(s);
  }
  const ordered = [...unique.filter((s) => s.role === "explain"), ...unique.filter((s) => s.role === "vary")];
  cut += Math.max(0, ordered.length - MAX_PROBES);
  return { probes: ordered.slice(0, MAX_PROBES).map(toProbe), cut };
}

/**
 * Whether the template reads the variable `tools`, from the parse. Jinja has no dynamic variable lookup, so a template
 * that never names it cannot reach the tools a caller passes, and a probe that passes them would only show them
 * missing. An attribute (`x.tools`), a keyword argument's name or a binding called `tools` is not a read, and a name
 * in prose or inside another identifier (`use_tools`) is not one either. A template that does not parse is taken to
 * read it, so its tools are still checked.
 */
export function readsTools(text: string): boolean {
  const { program } = parseTemplate(text);
  if (!program) return true;
  const stack: unknown[] = [program];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    const n = node as Node;
    if (n.type === "Identifier" && n.value === "tools") return true;
    const skip = n.type === "MemberExpression" && !n.computed ? "property" : n.type === "KeywordArgumentExpression" ? "key" : n.type === "Set" ? "assignee" : n.type === "For" ? "loopvar" : undefined;
    stack.push(...children(node, skip));
  }
  return false;
}
