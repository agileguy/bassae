// The transform allowlist's code half (Constraints: "transform allowlist"). registry/transforms.json names each
// legitimate rendering an upstream template applies and cites the lines that do it; every id there has exactly
// one matcher here, and each matcher accepts exactly that rendering, never something near it (ISC-22.3, ISC-22.4).
//
// A content matcher places one input's rendering in the output: a rewrite in place (trim, think-stripping), a
// move (the gemma-3 fold) or a drop (gpt-oss past analysis). A tool matcher ports a template's own tool syntax,
// so a tool's rendering can be compared as exact text. The stock template is the reference: a port prints exactly
// what the cited lines print for every shape they handle, including what they leave out, and the allowlist entry
// lists those losses. For a shape the template does not handle, or a key it never reads, the port returns
// undefined and the tool stays unexplained (fail closed).

export type Role = "system" | "user" | "assistant" | "tool";

/** One input whose rendering a content matcher may explain. */
export interface ScanInput {
  role: Role;
  /** Index of its message in `messages`. */
  message: number;
  /** `thinking` for an assistant message's reasoning field, otherwise its content. */
  field: "content" | "thinking";
  text: string;
}

/** What a content matcher sees: the output, where the input may start, and its neighbours. */
export interface ContentScan {
  output: string;
  /** End of the previous input's rendering. */
  from: number;
  inputs: readonly ScanInput[];
  /** The input to explain, an index into `inputs`. */
  index: number;
  /** The variables the template was rendered with: messages, add_generation_prompt, ... */
  context: Record<string, unknown>;
  /** The role the last role marker in output[a, b) names, or undefined when there is none. */
  markerRole(a: number, b: number): Role | undefined;
  /** Where `text` takes its place at or after `from` under `role`, or -1, by the rule the verbatim check uses. */
  place(text: string, role: Role, from: number): number;
  /** The texts input `i` may render as: verbatim, then each allowlisted rewrite of it. Absent means verbatim only. */
  renderings?(i: number): string[];
}

export interface ContentMatch {
  start: number;
  end: number;
  /** How many inputs, from `index` on, the rendering accounts for. */
  covers: number;
}

export interface ContentMatcher {
  /** For a rewrite in place: the text the input renders as, or undefined when the transform does not apply or changes nothing. */
  rewrite?(input: ScanInput, context: Record<string, unknown>): string | undefined;
  match(scan: ContentScan): ContentMatch | undefined;
}

/** One tool definition rendered in a template's own syntax. */
export interface ToolSite {
  name: string;
  start: number;
  end: number;
}

export interface ToolMatcher {
  /** `tool` exactly as the cited template prints it, or undefined when it uses a feature the port does not cover. */
  render(tool: unknown): string | undefined;
  /** Other texts a pinned variant of the cited template prints for a tool `render` covers; the entry cites each. */
  variants?(tool: unknown): string[];
  /** Every tool definition rendered this way in `output`, bounded as `render` bounds it. */
  sites(output: string): ToolSite[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

// jinja2's |trim is Python's str.strip(); the renderer's is JS trim(). Only what both strip counts, so a
// character one of them would keep is never explained away.
const EDGE_SPACE = /^[\t\n\v\f\r \p{Zs}\u2028\u2029]+|[\t\n\v\f\r \p{Zs}\u2028\u2029]+$/gu;
export const trim = (s: string) => s.replace(EDGE_SPACE, "");

/** `text` where it takes its place at or after `scan.from` under `role`, as the verbatim check places a content. */
function under(scan: ContentScan, text: string, role: Role, covers = 1): ContentMatch | undefined {
  const start = scan.place(text, role, scan.from);
  return start < 0 ? undefined : { start, end: start + text.length, covers };
}

/** A rewrite of one role's content in place. */
function rewrite(roles: readonly Role[], fn: (text: string, input: ScanInput, context: Record<string, unknown>) => string | undefined): ContentMatcher {
  const apply = (input: ScanInput, context: Record<string, unknown>) => {
    if (!roles.includes(input.role) || input.field !== "content") return undefined;
    const text = fn(input.text, input, context);
    return text === input.text ? undefined : text;
  };
  return {
    rewrite: apply,
    match(scan) {
      const input = scan.inputs[scan.index]!;
      const text = apply(input, scan.context);
      return text === undefined ? undefined : under(scan, text, input.role);
    },
  };
}

const messagesOf = (context: Record<string, unknown>): unknown[] => (Array.isArray(context.messages) ? context.messages : []);

// ---- content transforms ----

// Qwen3 lines 34-41: content after the last </think>, leading newlines removed, unless reasoning_content was passed.
const stripPastThink = rewrite(["assistant"], (text, input, context) => {
  const m = messagesOf(context)[input.message];
  if (isObj(m) && m.reasoning_content !== undefined && m.reasoning_content !== null) return undefined;
  const at = text.lastIndexOf("</think>");
  return at < 0 ? undefined : text.slice(at + "</think>".length).replace(/^\n+/, "");
});

// gemma-4 macro strip_thinking: keep each part before <|channel>, between <channel|> splits, then trim.
const stripGemmaThinkingChannel = rewrite(["assistant"], (text) =>
  trim(
    text
      .split("<channel|>")
      .map((part) => (part.includes("<|channel>") ? part.split("<|channel>")[0]! : part))
      .join(""),
  ),
);

const trimContent = rewrite(["system", "user", "assistant", "tool"], (text) => trim(text));

// gemma-3 lines 2-14 and 27: messages[0]['content'] + '\n\n' is prefixed to the first turn, which the template
// requires to be the user's (line 18). The system text is not trimmed; the user text renders as that turn does.
const foldSystemIntoFirstUser: ContentMatcher = {
  match(scan) {
    const sys = scan.inputs[scan.index]!;
    const user = scan.inputs[scan.index + 1];
    if (sys.role !== "system" || sys.field !== "content" || sys.message !== 0) return undefined;
    if (user?.role !== "user" || user.field !== "content" || user.message !== 1) return undefined;
    for (const text of scan.renderings?.(scan.index + 1) ?? [user.text]) {
      const found = under(scan, `${sys.text}\n\n${text}`, "user", 2);
      if (found) return found;
    }
    return undefined;
  },
};

// gpt-oss lines 273-295 and 312-314: a turn's analysis (its thinking, or the content of a tool-call turn) is dropped
// when a later assistant turn without tool calls follows; a turn without tool calls drops its thinking unless it is
// the last message and no generation prompt is added (lines 302-307).
const dropPastAnalysis: ContentMatcher = {
  match(scan) {
    const input = scan.inputs[scan.index]!;
    const messages = messagesOf(scan.context);
    const m = messages[input.message];
    if (input.role !== "assistant" || !isObj(m)) return undefined;
    const toolCalls = "tool_calls" in m;
    if (input.field !== "thinking" && !(toolCalls && input.field === "content")) return undefined;
    if (input.text === "" || scan.output.includes(input.text, scan.from)) return undefined;
    if (toolCalls) {
      const finalFollows = messages.slice(input.message + 1).some((x) => isObj(x) && x.role === "assistant" && !("tool_calls" in x));
      if (!finalFollows) return undefined;
    } else if (input.message === messages.length - 1 && !scan.context.add_generation_prompt) {
      return undefined;
    }
    return { start: scan.from, end: scan.from, covers: 1 };
  },
};

export const CONTENT_MATCHERS: Readonly<Record<string, ContentMatcher>> = {
  "strip-past-think": stripPastThink,
  "strip-gemma-thinking-channel": stripGemmaThinkingChannel,
  "trim-content": trimContent,
  "fold-system-into-first-user": foldSystemIntoFirstUser,
  "drop-past-analysis": dropPastAnalysis,
};

// ---- tool renderings ----

/** True when `o` has no key outside `keys`. A key a rendering never prints would otherwise vanish unexplained. */
const onlyKeys = (o: Obj, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));

type Fn = Obj & { name: string; description: string };

/** A named, described function holding nothing but its parameters and the `extra` keys the template prints. */
const namedFunction = (fn: unknown, extra: readonly string[] = []): Fn | undefined =>
  isObj(fn) && onlyKeys(fn, ["name", "description", "parameters", ...extra]) && isStr(fn.name) && isStr(fn.description) ? (fn as Fn) : undefined;

/** The function an OpenAI-style tool wraps, when the wrapper holds nothing else. */
function functionOf(tool: unknown, extra: readonly string[] = []): Fn | undefined {
  if (!isObj(tool) || !onlyKeys(tool, ["type", "function"]) || (tool.type !== undefined && tool.type !== "function")) return undefined;
  return namedFunction(tool.function, extra);
}

// The schemas the gpt-oss and gemma ports judge: standard JSON Schema as OpenAI-style tools write it, plus the
// `nullable` flag those templates read. A node has one of seven types and may carry a description, a non-empty
// string enum on a string, items on an array, properties and a required list naming only them on an object, a
// default, and `nullable: true` (the templates test it for truth, so a false one would vanish). Any other shape
// is one these ports cannot judge, so the tool stays unexplained (fail closed).
type Schema = Obj & {
  type: string;
  description?: string;
  enum?: string[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  nullable?: true;
};
const SCHEMA_TYPES = new Set(["string", "number", "integer", "boolean", "null", "array", "object"]);
const SCHEMA_KEYS = ["type", "description", "enum", "items", "properties", "required", "default", "nullable"];
// Deeper than any tool definition needs; it only bounds the recursion on a hostile one.
const MAX_DEPTH = 16;

function isJson(v: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (v === null || isStr(v) || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => isJson(x, depth + 1));
  return isObj(v) && Object.values(v).every((x) => isJson(x, depth + 1));
}

function isSchema(node: unknown, depth = 0): node is Schema {
  if (depth > MAX_DEPTH || !isObj(node) || !onlyKeys(node, SCHEMA_KEYS)) return false;
  const { type, properties, required } = node;
  if (!isStr(type) || !SCHEMA_TYPES.has(type)) return false;
  if (node.description !== undefined && !isStr(node.description)) return false;
  if (node.enum !== undefined && (type !== "string" || !isStrList(node.enum) || node.enum.length === 0)) return false;
  if (node.items !== undefined && (type !== "array" || !isSchema(node.items, depth + 1))) return false;
  if (properties !== undefined && (type !== "object" || !isObj(properties) || !Object.values(properties).every((p) => isSchema(p, depth + 1)))) return false;
  // A rendering that keys on properties cannot show a required name that is not one.
  if (required !== undefined && (type !== "object" || !isStrList(required) || !required.every((r) => isObj(properties) && Object.hasOwn(properties, r)))) return false;
  if (node.nullable !== undefined && node.nullable !== true) return false;
  return node.default === undefined || isJson(node.default);
}

/**
 * A tool's parameters: an object schema with nothing on the object itself but its properties and required list.
 * No pinned template reads a description or default there, so one would vanish.
 */
const rootSchema = (params: unknown): params is Schema => isSchema(params) && params.type === "object" && onlyKeys(params, ["type", "properties", "required"]);

/** Truthiness as the templates test it: empty strings, lists and mappings, zero and none are false. */
const truthy = (v: unknown) => (Array.isArray(v) ? v.length > 0 : isObj(v) ? Object.keys(v).length > 0 : Boolean(v));

/** The renderer's |tojson: ", " and ": " between items, keys in insertion order, strings and numbers as JSON.stringify writes them. */
function toJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(toJson).join(", ")}]`;
  if (isObj(v)) return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${toJson(x)}`).join(", ")}}`;
  return JSON.stringify(v);
}

/** Every `open ... close` span, bounded inside the delimiters, named by `name(inner)`. */
function delimited(output: string, open: string, close: string, name: (inner: string) => string): ToolSite[] {
  const sites: ToolSite[] = [];
  for (let at = output.indexOf(open); at >= 0; at = output.indexOf(open, at + 1)) {
    const start = at + open.length;
    const end = output.indexOf(close, start);
    if (end < 0) break;
    sites.push({ name: name(output.slice(start, end)), start, end });
    at = end;
  }
  return sites;
}

// gpt-oss lines 10-105, macro render_typescript_type. The port prints what the template prints, losses included
// (each listed in the allowlist entry): integer as number, null as `any`, an array of scalar items as the bare
// element type (`string[]`), whatever else the items hold unprinted, and an element type longer than 50 characters
// as `any[]`. A node's description and default are printed only at the top level, by the tool loop below.
// `nullable` is printed only on a string without an enum and on an array; anywhere else it would vanish, so the
// tool is not explained.
const SCALAR_ARRAYS: Record<string, string> = { string: "string[]", number: "number[]", integer: "number[]", boolean: "boolean[]" };
function tsType(s: Schema): string | undefined {
  const orNull = (type: string) => (s.nullable ? `${type} | null` : type);
  if (s.nullable && !(s.type === "array" || (s.type === "string" && !s.enum))) return undefined;
  switch (s.type) {
    case "array": {
      if (!s.items) return orNull("any[]");
      const scalar = SCALAR_ARRAYS[s.items.type];
      if (scalar) return s.items.nullable ? undefined : orNull(scalar);
      const inner = tsType(s.items);
      if (inner === undefined) return undefined;
      return orNull(inner.length > 50 ? "any[]" : `${inner}[]`);
    }
    case "string":
      return s.enum ? `"${s.enum.join('" | "')}"` : orNull("string");
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "object": {
      if (!truthy(s.properties)) return "object";
      const required = s.required ?? [];
      const fields: string[] = [];
      for (const [name, spec] of Object.entries(s.properties!)) {
        const type = tsType(spec);
        if (type === undefined) return undefined;
        // The type is printed by a {{ }} tag indented under ": ", so the newline and indent stay in the output.
        fields.push(`${name}${required.includes(name) ? "" : "?"}: \n                ${type}`);
      }
      return `{\n${fields.join(", ")}}`;
    }
    default:
      return "any";
  }
}

// gpt-oss lines 108-148 and 250-253: a TypeScript namespace. Each tool is `// <description>` and
// `type <name> = (_: {...}) => any;`, each parameter `// <description>` when it has one, then
// `<name>?: <type>,` with the `?` when it is not required and its default after the type when it has one.
const gptOssTools: ToolMatcher = {
  render(tool) {
    const fn = functionOf(tool);
    if (!fn) return undefined;
    const head = `// ${fn.description}\ntype ${fn.name} = `;
    const params = fn.parameters;
    if (params === undefined) return `${head}() => any;\n\n`;
    if (!rootSchema(params)) return undefined;
    if (!truthy(params.properties)) return `${head}() => any;\n\n`;
    const required = params.required ?? [];
    let out = `${head}(_: {\n`;
    for (const [name, spec] of Object.entries(params.properties!)) {
      const type = tsType(spec);
      if (type === undefined) return undefined;
      if (truthy(spec.description)) out += `// ${spec.description}\n`;
      out += `${name}${required.includes(name) ? "" : "?"}: ${type}`;
      if (spec.default !== undefined) {
        // Lines 129-136: beside an enum the default is concatenated raw, which only a string survives.
        if (spec.enum && !isStr(spec.default)) return undefined;
        out += `, // default: ${spec.enum ? spec.default : toJson(spec.default)}`;
      }
      out += ",\n";
    }
    return `${out}}) => any;\n\n`;
  },
  sites(output) {
    const sites: ToolSite[] = [];
    for (const block of delimited(output, "namespace functions {\n\n", "} // namespace functions", () => "")) {
      const body = output.slice(block.start, block.end);
      // Entries follow one another: each runs from the end of the one before (a description may span lines)
      // through the `=> any;` that ends its type.
      let start = 0;
      for (const m of body.matchAll(/^type (\S+) = /gm)) {
        const close = body.indexOf("=> any;\n\n", m.index!);
        const end = close < 0 ? body.length : close + "=> any;\n\n".length;
        sites.push({ name: m[1]!, start: block.start + start, end: block.start + end });
        start = end;
      }
    }
    return sites;
  },
};

/** jinja2's dictsort: keys in case-insensitive order, ties kept in insertion order. */
const dictsort = <T>(entries: [string, T][]) =>
  [...entries].sort(([a], [b]) => {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });

// Keys the functiongemma and some gemma-4 parameter loops skip as schema keywords; a property so named is not ported.
const STANDARD_KEYS = new Set(["description", "type", "properties", "required", "nullable"]);

/**
 * A gemma rendering: its quote token, functiongemma's habit of printing every property's description (empty when
 * absent), and whether a property's `nullable` is printed (gemma-4) or never read (functiongemma).
 */
interface Gemma {
  q: string;
  alwaysDescribe: boolean;
  printsNullable: boolean;
}

/** Macro format_argument. None is refused: some pinned gemma-4 variants print it as null, the others as nothing. */
function gemmaArgument(v: unknown, q: string): string | undefined {
  if (isStr(v)) return `${q}${v}${q}`;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (!Array.isArray(v) && !isObj(v)) return undefined;
  const entries = Array.isArray(v) ? v.map((x) => ["", x] as [string, unknown]) : dictsort(Object.entries(v));
  const parts: string[] = [];
  for (const [k, x] of entries) {
    const arg = gemmaArgument(x, q);
    if (arg === undefined) return undefined;
    parts.push(Array.isArray(v) ? arg : `${q}${k}${q}:${arg}`);
  }
  return Array.isArray(v) ? `[${parts.join(",")}]` : `{${parts.join(",")}}`;
}

const quotedList = (items: readonly string[], q: string) => `[${items.map((i) => `${q}${i}${q}`).join(",")}]`;

/** Macro format_parameters: each property in dictsort order. */
function gemmaParameters(properties: Record<string, Schema>, g: Gemma): string | undefined {
  const fields: string[] = [];
  for (const [key, spec] of dictsort(Object.entries(properties))) {
    const field = STANDARD_KEYS.has(key) ? undefined : gemmaProperty(key, spec, g);
    if (field === undefined) return undefined;
    fields.push(field);
  }
  return fields.join(",");
}

/**
 * One property: its description, then its enum (a string) or items (an array), then `nullable:true` (gemma-4),
 * then its properties and required list (an object), then its upper-cased type. A property's own default is not
 * printed: a loss the allowlist entry lists.
 */
function gemmaProperty(key: string, s: Schema, g: Gemma): string | undefined {
  const { q } = g;
  const parts: string[] = [];
  if (g.alwaysDescribe || truthy(s.description)) parts.push(`description:${q}${s.description ?? ""}${q}`);
  if (s.type === "string" && s.enum) parts.push(`enum:${gemmaArgument(s.enum, q)}`);
  if (s.type === "array" && s.items) {
    const items = gemmaItems(s.items, g);
    if (items === undefined) return undefined;
    parts.push(`items:{${items}}`);
  }
  if (s.nullable) {
    if (!g.printsNullable) return undefined;
    parts.push("nullable:true");
  }
  if (s.type === "object") {
    // Without properties the template walks the object's own keys as if they were properties; only the standard
    // keys are skipped there, so a default would print as a property.
    if (s.properties === undefined && s.default !== undefined) return undefined;
    const inner = s.properties === undefined ? "" : gemmaParameters(s.properties, g);
    if (inner === undefined) return undefined;
    parts.push(`properties:{${inner}}`);
    if (truthy(s.required)) parts.push(`required:${quotedList(s.required!, q)}`);
  }
  parts.push(`type:${q}${s.type.toUpperCase()}${q}`);
  return `${key}:{${parts.join(",")}}`;
}

/** An array's items, key by key in dictsort order, none values skipped: properties and required as on an object, type upper-cased, anything else through format_argument. */
function gemmaItems(items: Schema, g: Gemma): string | undefined {
  const { q } = g;
  const parts: string[] = [];
  for (const [key, value] of dictsort(Object.entries(items))) {
    if (value === null) continue;
    let text: string | undefined;
    if (key === "properties") text = gemmaParameters(value as Record<string, Schema>, g);
    else if (key === "required") text = quotedList(value as string[], q);
    else if (key === "type") text = `${q}${(value as string).toUpperCase()}${q}`;
    else text = gemmaArgument(value, q);
    if (text === undefined) return undefined;
    parts.push(key === "properties" ? `properties:{${text}}` : `${key}:${text}`);
  }
  return parts.join(",");
}

/**
 * Macro format_function_declaration up to its closing brace: `declaration:<name>{description:<q>...<q>`, then
 * `,parameters:{properties:{...},required:[...],type:<q>OBJECT<q>}` when the tool has parameters.
 */
function gemmaDeclaration(fn: Fn, g: Gemma): string | undefined {
  const { q } = g;
  let out = `declaration:${fn.name}{description:${q}${fn.description}${q}`;
  if (fn.parameters === undefined) return out;
  const params = fn.parameters;
  if (!rootSchema(params)) return undefined;
  out += ",parameters:{";
  if (truthy(params.properties)) {
    const inner = gemmaParameters(params.properties!, g);
    if (inner === undefined) return undefined;
    out += `properties:{${inner}},`;
  }
  if (truthy(params.required)) out += `required:${quotedList(params.required!, q)},`;
  return `${out}type:${q}OBJECT${q}}`;
}

const declarationName = (inner: string) => /^declaration:([^{]*)\{/.exec(inner)?.[1] ?? "";

const GEMMA4: Gemma = { q: '<|"|>', alwaysDescribe: false, printsNullable: true };

/**
 * A gemma-4 declaration with the function's response, when it has one: the cited template's text, and the text
 * the 29af862b variant prints. Undefined when the port does not cover the tool.
 */
function gemma4Declaration(tool: unknown): { cited: string; variant: string } | undefined {
  const fn = functionOf(tool, ["response"]);
  const head = fn && gemmaDeclaration(fn, GEMMA4);
  if (head === undefined) return undefined;
  const r = fn!.response;
  if (r === undefined) return { cited: `${head}}`, variant: `${head}}` };
  // Lines 106-116 read only the response's description and type, and upper-case the type, which fails on anything
  // but a string.
  if (!isObj(r) || !onlyKeys(r, ["description", "type"]) || !isStr(r.type) || (r.description !== undefined && !isStr(r.description))) return undefined;
  const { q } = GEMMA4;
  const type = r.type.toUpperCase();
  const description = truthy(r.description) ? `description:${q}${r.description}${q}` : "";
  // `,response:{`, the description and a comma when there is one, then `type:<q>OBJECT<q>}` only when the type
  // upper-cases to OBJECT: any other type is not printed (a listed loss), and the brace is then left open.
  const cited = `${head},response:{${description && `${description},`}${type === "OBJECT" ? `type:${q}OBJECT${q}}` : ""}}`;
  // 29af862b lines 122-136: the description, a comma only between it and the type, any non-empty type upper-cased
  // (format_type_argument, lines 1-13), and the brace always closed.
  const variant = `${head},response:{${[description, type && `type:${q}${type}${q}`].filter(Boolean).join(",")}}}`;
  return { cited, variant };
}

// gemma-4 lines 1-147 and 196-201: each tool is `<|tool>` + its declaration + `<tool|>`, strings quoted with <|"|>.
const gemma4Tools: ToolMatcher = {
  render: (tool) => gemma4Declaration(tool)?.cited,
  variants(tool) {
    const d = gemma4Declaration(tool);
    return d && d.variant !== d.cited ? [d.variant] : [];
  },
  sites: (output) => delimited(output, "<|tool>", "<tool|>", declarationName),
};

// functiongemma lines 1-124 and 143-148: the same declaration between <start_function_declaration> and
// <end_function_declaration>, strings quoted with <escape>, and every property's description printed. It has no
// response and never reads a property's `nullable`.
const functionGemmaTools: ToolMatcher = {
  render(tool) {
    const fn = functionOf(tool);
    const head = fn && gemmaDeclaration(fn, { q: "<escape>", alwaysDescribe: true, printsNullable: false });
    return head === undefined ? undefined : `${head}}`;
  },
  sites: (output) => delimited(output, "<start_function_declaration>", "<end_function_declaration>", declarationName),
};

/** The renderer's |string on a JSON value other than a mapping; it raises on none. */
const qwenString = (v: unknown) => (isStr(v) ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : Array.isArray(v) ? toJson(v) : undefined);

/** A value Qwen3-Coder prints whole: a mapping through |tojson, anything else through |string. */
const qwenValue = (v: unknown) => (isObj(v) ? toJson(v) : qwenString(v));

/**
 * Macro render_item_list: `\n<tag>[...]</tag>`, strings in backticks and numbers and booleans as printed, or
 * nothing for an absent or empty list. Undefined for anything it would print only in part.
 */
function itemList(items: unknown, tag: string): string | undefined {
  if (items === undefined) return "";
  if (!Array.isArray(items)) return undefined;
  const parts: string[] = [];
  for (const i of items) {
    if (isStr(i)) parts.push(`\`${i}\``);
    else if (typeof i === "number" || typeof i === "boolean") parts.push(String(i));
    else return undefined;
  }
  return parts.length > 0 ? `\n<${tag}>[${parts.join(", ")}]</${tag}>` : "";
}

// Lines 47-66: a parameter shows its name, then its type, trimmed description and enum when present, then every
// other key in its own order as a tag holding its value, then its own required list. The template prints every
// key it is given, so any JSON shape is ported, except values it cannot print: none (its |string fails on it), a
// description that is not a string (its |trim fails), and an enum that is not a non-empty list of strings,
// numbers or booleans.
const QWEN_HANDLED = ["type", "description", "enum", "required"];
function qwenParameter(name: string, spec: unknown): string | undefined {
  if (!isObj(spec) || !isJson(spec)) return undefined;
  let out = `\n<parameter>\n<name>${name}</name>`;
  if (spec.type !== undefined) {
    const type = qwenString(spec.type);
    if (type === undefined) return undefined;
    out += `\n<type>${type}</type>`;
  }
  if (spec.description !== undefined) {
    if (!isStr(spec.description)) return undefined;
    out += `\n<description>${trim(spec.description)}</description>`;
  }
  if (spec.enum !== undefined && (!Array.isArray(spec.enum) || spec.enum.length === 0)) return undefined;
  const values = itemList(spec.enum, "enum");
  const required = itemList(spec.required, "required");
  if (values === undefined || required === undefined) return undefined;
  out += values;
  for (const [key, value] of Object.entries(spec)) {
    if (QWEN_HANDLED.includes(key)) continue;
    // Line 58 normalises the tag: `-` and space become `_` and `$` is dropped (a listed loss).
    const tag = key.replaceAll("-", "_").replaceAll(" ", "_").replaceAll("$", "");
    const text = qwenValue(value);
    if (text === undefined) return undefined;
    out += `\n<${tag}>${text}</${tag}>`;
  }
  return `${out}${required}\n</parameter>`;
}

// Qwen3-Coder lines 1-16 and 36-79: an XML list inside <tools>. Each tool shows its name, trimmed description and
// parameters, then the tool's required list, then its `return` when it has one (lines 70-76).
const qwenXmlTools: ToolMatcher = {
  render(tool) {
    // Lines 40-42: an OpenAI-style tool renders its function member; a bare function renders as itself.
    const fn = isObj(tool) && tool.function !== undefined ? functionOf(tool, ["return"]) : namedFunction(tool, ["return"]);
    const params = fn?.parameters;
    // Line 46 reads tool.parameters.properties, so a tool without them stops the template. The template never
    // reads anything else on the parameters object, so anything else there would vanish.
    if (!fn || !isObj(params) || !onlyKeys(params, ["type", "properties", "required"]) || params.type !== "object" || !isObj(params.properties)) return undefined;
    let out = `<function>\n<name>${fn.name}</name>\n<description>${trim(fn.description)}</description>\n<parameters>`;
    for (const [name, spec] of Object.entries(params.properties)) {
      const parameter = qwenParameter(name, spec);
      if (parameter === undefined) return undefined;
      out += parameter;
    }
    const required = itemList(params.required, "required");
    if (required === undefined) return undefined;
    out += `${required}\n</parameters>`;
    if (fn.return !== undefined) {
      const value = isJson(fn.return) ? qwenValue(fn.return) : undefined;
      if (value === undefined) return undefined;
      out += `\n<return>${value}</return>`;
    }
    return `${out}\n</function>`;
  },
  sites(output) {
    const sites: ToolSite[] = [];
    for (const block of delimited(output, "<tools>", "</tools>", () => "")) {
      const body = output.slice(block.start, block.end);
      for (const fn of delimited(body, "<function>\n<name>", "\n</function>", (inner) => inner.slice(0, inner.indexOf("</name>")))) {
        const start = block.start + fn.start - "<function>\n<name>".length;
        sites.push({ name: fn.name, start, end: block.start + fn.end + "\n</function>".length });
      }
    }
    return sites;
  },
};

export const TOOL_MATCHERS: Readonly<Record<string, ToolMatcher>> = {
  "gpt-oss-typescript-tools": gptOssTools,
  "gemma4-tool-declarations": gemma4Tools,
  "functiongemma-tool-declarations": functionGemmaTools,
  "qwen-xml-tool-list": qwenXmlTools,
};

/** Every matcher, by allowlist id. A test holds its keys equal to the ids in registry/transforms.json. */
export const MATCHERS: Readonly<Record<string, ContentMatcher | ToolMatcher>> = { ...CONTENT_MATCHERS, ...TOOL_MATCHERS };
