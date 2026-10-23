import { describe, expect, test } from "bun:test";
import { CONTENT_MATCHERS, MATCHERS, TOOL_MATCHERS, type ContentScan, type Role, type ScanInput, type ToolMatcher } from "../../src/diffrender/transforms.ts";
import { markerRole, placeOf } from "../../src/diffrender/integrity.ts";
import { loadRegistry, loadTransforms } from "../../src/registry/index.ts";
import { createRenderer, sandboxAvailable } from "../../src/sandbox/index.ts";
import { HARBOR_TOOLS, PIPELINE_TOOLS, RICH_TOOLS, TIME_TOOL, WEATHER_TOOL } from "./fixtures/integrity/probes.ts";

const transforms = loadTransforms();
const registry = loadRegistry();
const live = (await sandboxAvailable()).available;
const renderer = createRenderer();

/** The pinned text of a registry template, by the start of its SHA-256. */
const pinned = (sha: string) => registry.entries.find((k) => k.entry.sha256.startsWith(sha))!.text;

async function render(template: string, context: Record<string, unknown>): Promise<string> {
  const [r] = await renderer.renderBatch(template, [{ id: "t", context, profile: "hf-default" }]);
  if (!r!.ok) throw new Error(`${r!.failure}: ${r!.message}`);
  return r!.output;
}

function scan(output: string, inputs: ScanInput[], index = 0, context: Record<string, unknown> = {}): ContentScan {
  return { output, from: 0, inputs, index, context, markerRole: (a, b) => markerRole(output, a, b), place: (text, role, from) => placeOf(output, text, role, from) };
}
const input = (role: Role, text: string, message = 0, field: ScanInput["field"] = "content"): ScanInput => ({ role, message, field, text });

describe("the allowlist is data plus code", () => {
  test("every id in registry/transforms.json has a matcher, and every matcher has an id", () => {
    expect(Object.keys(MATCHERS).sort()).toEqual(transforms.map((t) => t.id).sort());
  });

  test("each matcher is either a content matcher or a tool matcher, never both", () => {
    for (const id of Object.keys(MATCHERS)) expect(Number(id in CONTENT_MATCHERS) + Number(id in TOOL_MATCHERS)).toBe(1);
  });

  test("every entry cites a template pinned in the registry", () => {
    for (const t of transforms) {
      const [, repo, revision, path] = /^([^@]+)@([0-9a-f]{40}):(\S+)/.exec(t.source)!;
      expect(registry.entries.some((k) => k.entry.repo === repo && k.entry.revision === revision && k.entry.path === path)).toBe(true);
    }
  });
});

describe("trim-content", () => {
  const m = CONTENT_MATCHERS["trim-content"]!;

  test("explains content rendered through |trim, under its own role", () => {
    const out = "<|im_start|>user\nHello there, friend.<|im_end|>";
    expect(m.match(scan(out, [input("user", "  Hello there, friend.\n")]))).toEqual({ start: 17, end: 37, covers: 1 });
  });

  test("explains nothing when trimming changes nothing, or the trimmed text sits under another role", () => {
    expect(m.match(scan("<|im_start|>user\nHi there.", [input("user", "Hi there.")]))).toBeUndefined();
    expect(m.match(scan("<|im_start|>system\nHi there.", [input("user", " Hi there. ")]))).toBeUndefined();
  });

  test("does not accept a cut that is not a trim", () => {
    expect(m.match(scan("<|im_start|>user\nHello there", [input("user", " Hello there, friend. ")]))).toBeUndefined();
  });
});

describe("fold-system-into-first-user", () => {
  const m = CONTENT_MATCHERS["fold-system-into-first-user"]!;
  const sys = input("system", "Be brief.", 0);
  const user = input("user", "Where is Porto?", 1);

  test("explains a leading system content prefixed, with a blank line, to the first user turn", () => {
    const out = "<s><start_of_turn>user\nBe brief.\n\nWhere is Porto?<end_of_turn>\n";
    expect(m.match(scan(out, [sys, user]))).toEqual({ start: 23, end: 49, covers: 2 });
  });

  test("matches the real gemma-3 rendering", async () => {
    if (!live) return;
    const out = await render(pinned("7de1c58e"), {
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Where is Porto?" },
      ],
      bos_token: "<s>",
    });
    expect(m.match(scan(out, [sys, user]))).toMatchObject({ covers: 2 });
  });

  test("explains nothing for a system message that is not first, a fold under a system marker, or a different separator", () => {
    expect(m.match(scan("<start_of_turn>user\nBe brief.\n\nWhere is Porto?", [input("system", "Be brief.", 2), input("user", "Where is Porto?", 3)]))).toBeUndefined();
    expect(m.match(scan("<start_of_turn>system\nBe brief.\n\nWhere is Porto?", [sys, user]))).toBeUndefined();
    expect(m.match(scan("<start_of_turn>user\nBe brief.\nWhere is Porto?", [sys, user]))).toBeUndefined();
  });

  test("explains nothing when the next content is not the first user turn", () => {
    const out = "<start_of_turn>user\nBe brief.\n\nWhere is Porto?";
    expect(m.match(scan(out, [sys, input("tool", "Where is Porto?", 1)]))).toBeUndefined();
    expect(m.match(scan(out, [sys]))).toBeUndefined();
  });
});

describe("assistant-side transforms", () => {
  test("strip-past-think keeps only the text after the last </think>, leading newlines removed", () => {
    const m = CONTENT_MATCHERS["strip-past-think"]!;
    const a = input("assistant", "<think>\nweighing it\n</think>\n\nPorto is mild in May.");
    expect(m.match(scan("<|im_start|>assistant\nPorto is mild in May.<|im_end|>", [a]))).toEqual({ start: 22, end: 43, covers: 1 });
    expect(m.match(scan("<|im_start|>assistant\nPorto is mild", [a]))).toBeUndefined();
    expect(m.match(scan("<|im_start|>user\nPorto is mild in May.", [a]))).toBeUndefined();
    expect(m.match(scan("<|im_start|>assistant\nPorto is mild in May.", [input("user", a.text)]))).toBeUndefined();
  });

  test("strip-gemma-thinking-channel drops each <|channel>...<channel|> block and trims", () => {
    const m = CONTENT_MATCHERS["strip-gemma-thinking-channel"]!;
    const a = input("assistant", "<|channel>thought\nhmm<channel|>  Porto is mild. ");
    expect(m.match(scan("<|turn>model\nPorto is mild.<turn|>", [a]))).toEqual({ start: 13, end: 27, covers: 1 });
    expect(m.match(scan("<|turn>model\nhmm Porto is mild.<turn|>", [input("assistant", "hmm Porto is mild.")]))).toBeUndefined();
  });

  test("drop-past-analysis drops a past turn's thinking only when a final assistant turn follows", () => {
    const m = CONTENT_MATCHERS["drop-past-analysis"]!;
    const thinking = input("assistant", "I should call the weather tool.", 1, "thinking");
    const call = { role: "assistant", thinking: thinking.text, tool_calls: [{ function: { name: "f", arguments: {} } }] };
    const after = [{ role: "user", content: "q" }, call, { role: "tool", content: "r" }, { role: "assistant", content: "done" }];
    const out = "<|start|>user<|message|>q<|end|><|start|>assistant to=functions.f<|channel|>commentary json<|message|>{}<|call|>";
    expect(m.match({ ...scan(out, [thinking], 0, { messages: after, add_generation_prompt: true }), from: 33 })).toEqual({ start: 33, end: 33, covers: 1 });
    // With no later final turn the analysis is kept, so its absence is not this transform.
    expect(m.match({ ...scan(out, [thinking], 0, { messages: after.slice(0, 3), add_generation_prompt: true }), from: 33 })).toBeUndefined();
    // Present text is not dropped text.
    const kept = out + `<|start|>assistant<|channel|>analysis<|message|>${thinking.text}<|end|>`;
    expect(m.match({ ...scan(kept, [thinking], 0, { messages: after, add_generation_prompt: true }), from: 33 })).toBeUndefined();
  });
});

// ---- tool renderings ----

type Tool = (typeof RICH_TOOLS)[number];
/** A tool's name, wrapped or bare. */
const nameOf = (t: object): string => ("function" in t ? (t.function as { name: string }) : (t as { name: string })).name;

const GEMMA4_SHAS = ["0a2c8073", "ae53464b", "29af862b", "36e3a42e", "85a08664", "2f1b4d75"];

/**
 * The pinned qwen3-coder template. The renderer does not implement |reject yet, so this copy skips the handled keys
 * with a continue instead, which visits the same keys in the same order.
 */
function qwenTemplate(): string {
  const loop = '{%- for json_key in param_fields.keys() | reject("in", handled_keys) %}';
  const template = pinned("672e747c");
  expect(template).toContain(loop);
  return template.replace(loop, "{%- for json_key in param_fields.keys() %}{%- if json_key in handled_keys %}{%- continue %}{%- endif %}");
}

const fn = <P extends Record<string, unknown>>(name: string, description: string, parameters: P) => ({ type: "function", function: { name, description, parameters } });

/** Every tool has a site, in order, and each tool the port explains reads exactly as the port prints it. */
function expectParity(m: ToolMatcher, output: string, tools: object[]) {
  const sites = m.sites(output);
  expect(sites.map((x) => x.name)).toEqual(tools.map(nameOf));
  for (const [i, tool] of tools.entries()) {
    const text = m.render(tool);
    if (text !== undefined) expect([nameOf(tool), output.slice(sites[i]!.start, sites[i]!.end)]).toEqual([nameOf(tool), text]);
  }
}

describe("tool renderings", () => {
  const gptOss = TOOL_MATCHERS["gpt-oss-typescript-tools"]!;
  const gemma4 = TOOL_MATCHERS["gemma4-tool-declarations"]!;
  const functionGemma = TOOL_MATCHERS["functiongemma-tool-declarations"]!;
  const qwenXml = TOOL_MATCHERS["qwen-xml-tool-list"]!;

  test("gpt-oss: the port prints what the pinned template prints", async () => {
    if (!live) return;
    const out = await render(pinned("a4c9919c"), { messages: [{ role: "user", content: "hi" }], tools: [WEATHER_TOOL, TIME_TOOL] });
    for (const tool of [WEATHER_TOOL, TIME_TOOL]) expect(out).toContain(gptOss.render(tool)!);
    expect(gptOss.sites(out).map((s) => s.name)).toEqual(["get_weather", "get_local_time"]);
  });

  test("gpt-oss: names, descriptions, enum values and the required list all reach the rendering", () => {
    const text = gptOss.render(WEATHER_TOOL)!;
    expect(text).toBe(
      "// Look up the forecast for a city on a given day.\ntype get_weather = (_: {\n" +
        "// Name of the city to look up.\ncity: string,\n" +
        '// Temperature unit for the forecast.\nunit?: "celsius" | "fahrenheit",\n' +
        "// How many days ahead to forecast.\ndays: number,\n}) => any;\n\n",
    );
  });

  test("gpt-oss: a shape the port does not cover is not explained", () => {
    const union = structuredClone(WEATHER_TOOL);
    (union.function.parameters.properties as Record<string, unknown>).where = { type: ["string", "number"] };
    expect(gptOss.render(union)).toBeUndefined();
    const oneOf = structuredClone(WEATHER_TOOL);
    (oneOf.function.parameters.properties as Record<string, unknown>).where = { oneOf: [{ type: "string" }, { type: "number" }] };
    expect(gptOss.render(oneOf)).toBeUndefined();
    const ghostRequired = structuredClone(WEATHER_TOOL);
    ghostRequired.function.parameters.required.push("country");
    expect(gptOss.render(ghostRequired)).toBeUndefined();
    expect(gptOss.render(WEATHER_TOOL.function)).toBeUndefined();
  });

  test("gemma-4: the port prints what every pinned gemma-4 template prints", async () => {
    if (!live) return;
    for (const sha of GEMMA4_SHAS) {
      const out = await render(pinned(sha), { messages: [{ role: "user", content: "hi" }], tools: [WEATHER_TOOL, TIME_TOOL], bos_token: "<s>" });
      for (const tool of [WEATHER_TOOL, TIME_TOOL]) expect(out).toContain(gemma4.render(tool)!);
      expect(gemma4.sites(out).map((s) => s.name)).toEqual(["get_weather", "get_local_time"]);
    }
  });

  test("functiongemma: the port prints what the pinned template prints", async () => {
    if (!live) return;
    const out = await render(pinned("db61fb01"), { messages: [{ role: "user", content: "hi" }], tools: [WEATHER_TOOL, TIME_TOOL], bos_token: "<s>" });
    for (const tool of [WEATHER_TOOL, TIME_TOOL]) expect(out).toContain(functionGemma.render(tool)!);
    expect(functionGemma.sites(out).map((s) => s.name)).toEqual(["get_weather", "get_local_time"]);
  });

  test("qwen3-coder: the port prints what the pinned template prints", async () => {
    if (!live) return;
    const out = await render(qwenTemplate(), { messages: [{ role: "user", content: "hi" }], tools: [WEATHER_TOOL, TIME_TOOL] });
    for (const tool of [WEATHER_TOOL, TIME_TOOL]) expect(out).toContain(qwenXml.render(tool)!);
    expect(qwenXml.sites(out).map((s) => s.name)).toEqual(["get_weather", "get_local_time"]);
  });

  test("each tool rendering shows a changed description, enum value or required list as a different text", () => {
    for (const m of [gptOss, gemma4, functionGemma, qwenXml]) {
      const base = m.render(WEATHER_TOOL)!;
      const described = structuredClone(WEATHER_TOOL);
      described.function.description = "Look up the forecast for any city.";
      const enumed = structuredClone(WEATHER_TOOL);
      enumed.function.parameters.properties.unit.enum = ["celsius", "kelvin"];
      const required = structuredClone(WEATHER_TOOL);
      required.function.parameters.required = ["city"];
      for (const changed of [described, enumed, required]) expect(m.render(changed)).not.toBe(base);
    }
  });

  test("a site is found only inside the rendering's own container", () => {
    const gemmaText = gemma4.render(WEATHER_TOOL)!;
    expect(gemma4.sites(`<|turn>system\n${gemmaText}<turn|>`)).toEqual([]);
    expect(gemma4.sites(`<|turn>system\n<|tool>${gemmaText}<tool|><turn|>`).map((s) => s.name)).toEqual(["get_weather"]);
    expect(gptOss.sites(`// x\ntype f = () => any;\n\n`)).toEqual([]);
  });
});

// ---- standard JSON Schema, and the keys each template reads ----

type Schema = Record<string, unknown> & { properties?: Record<string, Schema>; items?: Schema; required?: string[]; enum?: string[] };
const paramsOf = (t: Tool) => (t.function as { parameters?: Schema }).parameters;

/** Every schema node under `root`, in a fixed order, each with its path. */
function nodesOf(root: Schema, path = "parameters"): [string, Schema][] {
  const out: [string, Schema][] = [[path, root]];
  for (const [k, v] of Object.entries(root.properties ?? {})) out.push(...nodesOf(v, `${path}.${k}`));
  if (root.items) out.push(...nodesOf(root.items, `${path}[]`));
  return out;
}

const OTHER_TYPE: Record<string, string> = { string: "boolean", number: "string", integer: "string", boolean: "string", null: "string" };
/** A different default of the same kind. */
const otherDefault = (d: unknown) => (typeof d === "string" ? `${d} again` : typeof d === "number" ? d + 1 : typeof d === "boolean" ? !d : null);

/** Each one-field change the brief says a rendering must show: a name, a description, a type, an enum value, a default or a required list, at any node. */
function mutants(tool: Tool): [string, Tool][] {
  const out: [string, Tool][] = [];
  const change = (what: string, edit: (copy: Tool) => void) => {
    const copy = structuredClone(tool);
    edit(copy);
    out.push([what, copy]);
  };
  change("function name", (c) => (c.function.name += "_x"));
  change("function description", (c) => (c.function.description = "A different purpose entirely."));
  const params = paramsOf(tool);
  if (!params) return out;
  const at = (c: Tool, k: number) => nodesOf(paramsOf(c)!)[k]![1];
  for (const [k, [path, node]] of nodesOf(params).entries()) {
    if (node.description !== undefined) change(`${path} description`, (c) => (at(c, k).description = "Changed wording here."));
    else change(`${path} description added`, (c) => (at(c, k).description = "An added description."));
    if (node.enum) change(`${path} enum`, (c) => (at(c, k).enum = ["other_value", ...node.enum!.slice(1)]));
    if (node.default !== undefined) change(`${path} default`, (c) => (at(c, k).default = otherDefault(node.default)));
    if (node.required?.length) change(`${path} required dropped`, (c) => at(c, k).required!.pop());
    const optional = Object.keys(node.properties ?? {}).find((p) => !node.required?.includes(p));
    if (optional) change(`${path} required added`, (c) => (at(c, k).required = [...(node.required ?? []), optional]));
    for (const p of Object.keys(node.properties ?? {})) {
      change(`${path}.${p} renamed`, (c) => {
        const n = at(c, k);
        n.properties = Object.fromEntries(Object.entries(n.properties!).map(([key, v]) => [key === p ? `${p}_x` : key, v]));
        if (n.required) n.required = n.required.map((r) => (r === p ? `${p}_x` : r));
      });
    }
    const other = OTHER_TYPE[node.type as string];
    if (other && k > 0) {
      change(`${path} type`, (c) => {
        const n = at(c, k);
        n.type = other;
        delete n.enum;
      });
    }
  }
  return out;
}

describe("tool renderings over standard JSON Schema", () => {
  const ALL = RICH_TOOLS.map(nameOf);
  // What each port explains: every tool but one with a description on its parameters object, which no pinned
  // template reads, and, for qwen3-coder, one without parameters, which its template cannot render.
  const EXPLAINS: Record<string, string[]> = {
    "gpt-oss-typescript-tools": ALL.filter((n) => n !== "scoped_search"),
    "gemma4-tool-declarations": ALL.filter((n) => n !== "scoped_search"),
    "functiongemma-tool-declarations": ALL.filter((n) => n !== "scoped_search"),
    "qwen-xml-tool-list": ALL.filter((n) => n !== "scoped_search" && n !== "ping"),
  };

  test("each port explains exactly the tools its template prints", () => {
    for (const [id, names] of Object.entries(EXPLAINS)) {
      for (const tool of RICH_TOOLS) expect([id, nameOf(tool), TOOL_MATCHERS[id]!.render(tool) !== undefined]).toEqual([id, nameOf(tool), names.includes(nameOf(tool))]);
      for (const tool of PIPELINE_TOOLS) expect([id, nameOf(tool), TOOL_MATCHERS[id]!.render(tool) !== undefined]).toEqual([id, nameOf(tool), true]);
    }
  });

  const user = [{ role: "user", content: "hi" }];
  // Both tool sets the probe matrix has passed, then the rest of the rich set.
  const SETS = [...PIPELINE_TOOLS, ...HARBOR_TOOLS, ...RICH_TOOLS.slice(2)];

  test.if(live)("gpt-oss: the port prints what the pinned template prints", async () => {
    expectParity(TOOL_MATCHERS["gpt-oss-typescript-tools"]!, await render(pinned("a4c9919c"), { messages: user, tools: SETS }), SETS);
  });

  test.if(live)("gemma-4: the port prints what every pinned gemma-4 template prints", async () => {
    for (const sha of GEMMA4_SHAS) {
      expectParity(TOOL_MATCHERS["gemma4-tool-declarations"]!, await render(pinned(sha), { messages: user, tools: SETS, bos_token: "<s>" }), SETS);
    }
  });

  test.if(live)("functiongemma: the port prints what the pinned template prints", async () => {
    expectParity(TOOL_MATCHERS["functiongemma-tool-declarations"]!, await render(pinned("db61fb01"), { messages: user, tools: SETS, bos_token: "<s>" }), SETS);
  });

  test.if(live)("qwen3-coder: the port prints what the pinned template prints", async () => {
    // A tool without parameters stops the template (it reads tool.parameters.properties), so it is left out here.
    const tools = SETS.filter((t) => nameOf(t) !== "ping");
    expectParity(TOOL_MATCHERS["qwen-xml-tool-list"]!, await render(qwenTemplate(), { messages: user, tools }), tools);
  });

  test.if(live)("quotes, escapes, numbers and defaults print as the renderer prints them", async () => {
    const odd = {
      type: "function",
      function: {
        name: "odd_one",
        description: '  Quotes "here", a back\\slash, café, <b> &   too.  ',
        parameters: {
          type: "object",
          properties: {
            "2": { type: "number", description: "Integer-like key.", default: 1.5 },
            ratio: { type: "number", default: -0.25 },
            list: { type: "array", items: { type: "number", default: [1e21, 0.1, -3] }, default: [1, "two", null, { b: 1, a: [true] }] },
            cfg: { type: "object", properties: { "a-b": { type: "string", enum: ['x"y', "é"] } }, default: { z: 1, a: 'q"<' } },
            flag: { type: "boolean", default: true },
            word: { type: "string", default: 'line\nbreak "q"' },
          },
          required: ["2", "cfg"],
        },
      },
    } as unknown as Tool;
    const cases: [string, string][] = [
      ["gpt-oss-typescript-tools", pinned("a4c9919c")],
      ...["0a2c8073", "29af862b", "85a08664", "2f1b4d75"].map((sha): [string, string] => ["gemma4-tool-declarations", pinned(sha)]),
      ["functiongemma-tool-declarations", pinned("db61fb01")],
      ["qwen-xml-tool-list", qwenTemplate()],
    ];
    for (const [id, template] of cases) {
      const m = TOOL_MATCHERS[id]!;
      expect([id, m.render(odd) === undefined]).toEqual([id, false]);
      expectParity(m, await render(template, { messages: user, tools: [odd], bos_token: "<s>" }), [odd]);
    }
  });

  // The documented losses (registry/transforms.json): the one-field changes a port's rendering does not show,
  // because the stock template does not print that field. The test below holds the changes that leave a rendering
  // as it was to exactly these, so a later change to a port cannot widen them unnoticed; everywhere else a
  // rendering shows every change byte for byte.
  const LOST: Record<string, string[]> = {
    "gpt-oss-typescript-tools": [
      // A description below the top level.
      "book_harbor_tour parameters.party.adults description",
      "book_harbor_tour parameters.party.children description",
      "search_inventory parameters.filter.region description",
      "search_inventory parameters.filter.aisle description",
      "plot_grid parameters.grid[] description added",
      // Scalar items print as their bare element type: their description, enum and default go.
      "book_harbor_tour parameters.stops[] description",
      "search_inventory parameters.tags[] description added",
      "plot_grid parameters.grid[][] description added",
      "tag_note parameters.tags[] description",
      "tag_note parameters.tags[] enum",
      "tag_note parameters.tags[] default",
      // An element type longer than 50 characters prints as any[]: everything inside it goes.
      "log_cargo parameters.crates[] description",
      "log_cargo parameters.crates[] required dropped",
      "log_cargo parameters.crates[] required added",
      "log_cargo parameters.crates[].mark renamed",
      "log_cargo parameters.crates[].weight renamed",
      "log_cargo parameters.crates[].mark description",
      "log_cargo parameters.crates[].mark type",
      "log_cargo parameters.crates[].weight description",
      "log_cargo parameters.crates[].weight type",
    ],
    // A property's default.
    "gemma4-tool-declarations": ["label", "hour", "loud", "tone"].map((p) => `set_alarm parameters.${p} default`),
    "functiongemma-tool-declarations": ["label", "hour", "loud", "tone"].map((p) => `set_alarm parameters.${p} default`),
  };

  test("a change to any name, description, type, enum value, default or required list shows, unless it is a documented loss", () => {
    for (const [id, m] of Object.entries(TOOL_MATCHERS)) {
      const unchanged: string[] = [];
      for (const tool of SETS) {
        const base = m.render(tool);
        if (base === undefined) continue;
        for (const [what, changed] of mutants(tool)) if (m.render(changed) === base) unchanged.push(`${nameOf(tool)} ${what}`);
      }
      expect([id, unchanged.sort()]).toEqual([id, [...(LOST[id] ?? [])].sort()]);
    }
  });

  test("each documented loss prints exactly as the stock template prints it", async () => {
    // gpt-oss: integer as number, null as any, scalar items as the bare element type, a nested description and
    // default unprinted, an element type longer than 50 characters as any[], a non-string default beside an enum as
    // the renderer concatenates it; nullable as `| null` where it is read.
    const gptOss = TOOL_MATCHERS["gpt-oss-typescript-tools"]!;
    const lossy = fn("lossy", "Every shape gpt-oss prints in part.", {
      type: "object",
      properties: {
        count: { type: "integer", description: "A whole number, printed as number." },
        nothing: { type: "null", description: "Printed as any." },
        marks: { type: "array", items: { type: "string", description: "One mark.", enum: ["x", "o"], default: "x" } },
        spot: { type: "object", properties: { row: { type: "integer", description: "Not printed.", default: 1 } }, default: { row: 2 } },
        rows: { type: "array", items: { type: "object", properties: { first_column: { type: "string" }, second_column: { type: "string" } } } },
        gone: { type: "string", default: null },
        maybe: { type: "string", nullable: true },
        maybes: { type: "array", items: { type: "array", items: { type: "number" }, nullable: true }, nullable: true },
        rank: { type: "string", enum: ["low", "high"], default: 2 },
        picks: { type: "string", enum: ["a"], default: ["a", null, [1, "x"], { k: true }] },
        place: { type: "string", enum: ["north"], default: { row: 1 } },
      },
      required: ["count"],
    });
    const gptText =
      "// Every shape gpt-oss prints in part.\ntype lossy = (_: {\n" +
      "// A whole number, printed as number.\ncount: number,\n" +
      "// Printed as any.\nnothing?: any,\n" +
      "marks?: string[],\n" +
      'spot?: {\nrow?: \n                number}, // default: {"row": 2},\n' +
      "rows?: any[],\n" +
      "gone?: string, // default: null,\n" +
      "maybe?: string | null,\n" +
      "maybes?: number[] | null[] | null,\n" +
      'rank?: "low" | "high", // default: 2,\n' +
      'picks?: "a", // default: a,undefined,[1, "x"],{"k": true},\n' +
      'place?: "north", // default: [object Map],\n' +
      "}) => any;\n\n";
    expect(gptOss.render(lossy)).toBe(gptText);

    // gemma-4 and functiongemma: a property's default is not printed, at any depth; an item's is. gemma-4 prints a
    // property's nullable, which functiongemma never reads, so there the tool stays unexplained.
    const defaults = fn("lossy", "Defaults gemma prints in part.", {
      type: "object",
      properties: {
        level: { type: "integer", description: "Its default is not printed.", default: 3, nullable: true },
        spot: { type: "object", properties: { row: { type: "integer", default: 1 } }, default: { row: 2 } },
        marks: { type: "array", items: { type: "string", default: "x", nullable: true } },
      },
    });
    const q = '<|"|>';
    const gemmaText =
      `declaration:lossy{description:${q}Defaults gemma prints in part.${q},parameters:{properties:{` +
      `level:{description:${q}Its default is not printed.${q},nullable:true,type:${q}INTEGER${q}},` +
      `marks:{items:{default:${q}x${q},nullable:true,type:${q}STRING${q}},type:${q}ARRAY${q}},` +
      `spot:{properties:{row:{type:${q}INTEGER${q}}},type:${q}OBJECT${q}}},type:${q}OBJECT${q}}}`;
    expect(TOOL_MATCHERS["gemma4-tool-declarations"]!.render(defaults)).toBe(gemmaText);
    expect(TOOL_MATCHERS["functiongemma-tool-declarations"]!.render(defaults)).toBeUndefined();
    const withoutNullable = structuredClone(defaults);
    delete (withoutNullable.function.parameters.properties.level as Record<string, unknown>).nullable;
    const e = "<escape>";
    expect(TOOL_MATCHERS["functiongemma-tool-declarations"]!.render(withoutNullable)).toBe(
      `declaration:lossy{description:${e}Defaults gemma prints in part.${e},parameters:{properties:{` +
        `level:{description:${e}Its default is not printed.${e},type:${e}INTEGER${e}},` +
        `marks:{description:${e}${e},items:{default:${e}x${e},nullable:true,type:${e}STRING${e}},type:${e}ARRAY${e}},` +
        `spot:{description:${e}${e},properties:{row:{description:${e}${e},type:${e}INTEGER${e}}},type:${e}OBJECT${e}}},type:${e}OBJECT${e}}}`,
    );

    if (!live) return;
    expectParity(gptOss, await render(pinned("a4c9919c"), { messages: [{ role: "user", content: "hi" }], tools: [lossy] }), [lossy]);
    for (const sha of GEMMA4_SHAS) {
      expectParity(TOOL_MATCHERS["gemma4-tool-declarations"]!, await render(pinned(sha), { messages: [{ role: "user", content: "hi" }], tools: [defaults], bos_token: "<s>" }), [defaults]);
    }
    expectParity(TOOL_MATCHERS["functiongemma-tool-declarations"]!, await render(pinned("db61fb01"), { messages: [{ role: "user", content: "hi" }], tools: [withoutNullable], bos_token: "<s>" }), [withoutNullable]);
  });

  test("gpt-oss: nested objects, arrays of arrays and defaults print as the template prints them", () => {
    const m = TOOL_MATCHERS["gpt-oss-typescript-tools"]!;
    const plain = (name: string) => structuredClone(RICH_TOOLS.find((t) => nameOf(t) === name)!);
    expect(m.render(plain("plot_grid"))).toBe("// Plot soundings on a grid of the bay.\ntype plot_grid = (_: {\ngrid: number[][],\n}) => any;\n\n");
    expect(m.render(plain("set_alarm"))).toBe(
      "// Set an alarm on the ship's bell.\ntype set_alarm = (_: {\n" +
        '// What the alarm is for.\nlabel?: string, // default: "Wake up",\n' +
        "// The hour it rings, from 0 to 23.\nhour: number, // default: 7,\n" +
        "// Whether it rings at full volume.\nloud?: boolean, // default: false,\n" +
        '// The sound it makes.\ntone?: "chime" | "bell", // default: chime,\n' +
        "snooze?: number,\n}) => any;\n\n",
    );
    // The pipeline's own tool: the nested descriptions are the template's loss, everything else shows.
    expect(m.render(PIPELINE_TOOLS[1]!)).toBe(
      "// Search the warehouse stock for matching goods.\ntype search_inventory = (_: {\n" +
        "// Free text to match against product names.\nquery: string,\n" +
        "// The largest number of results to return.\nlimit?: number,\n" +
        "// The highest unit price to include.\nmax_price?: number,\n" +
        "// Whether to include only goods on hand.\nin_stock?: boolean,\n" +
        "// Labels every result must carry.\ntags?: string[],\n" +
        "// Narrow the search to one region.\nfilter?: {\nregion: \n                string, aisle?: \n                number},\n" +
        "}) => any;\n\n",
    );
  });

  test.if(live)("gemma-4: a function's response prints as each pinned gemma-4 template prints it", async () => {
    const m = TOOL_MATCHERS["gemma4-tool-declarations"]!;
    const responses = [
      { type: "object" },
      { type: "OBJECT", description: "The report it returns." },
      { type: "A note kept with this tool for the archive." },
      { description: "The report it returns.", type: "note" },
      { type: "" },
    ];
    const tools = responses.map((response, i) => ({ type: "function", function: { name: `f${i}`, description: "d", parameters: { type: "object", properties: {} }, response } }));
    for (const sha of GEMMA4_SHAS) {
      const out = await render(pinned(sha), { messages: [{ role: "user", content: "hi" }], tools, bos_token: "<s>" });
      const sites = m.sites(out);
      expect(sites.map((s) => s.name)).toEqual(tools.map((t) => t.function.name));
      for (const [i, tool] of tools.entries()) {
        // 29af862b prints every type, and closes the brace, where the cited template does not: a pinned variant.
        const expected = sha === "29af862b" ? (m.variants!(tool)[0] ?? m.render(tool)!) : m.render(tool)!;
        expect([sha, i, out.slice(sites[i]!.start, sites[i]!.end)]).toEqual([sha, i, expected]);
      }
    }
    // A type that is not OBJECT is the cited template's loss; the variant shows it.
    expect(m.render(tools[2])).toEndWith(',response:{}');
    expect(m.variants!(tools[2])).toEqual([expect.stringContaining(',response:{type:<|"|>A NOTE KEPT WITH THIS TOOL FOR THE ARCHIVE.<|"|>}}')]);
    expect(m.variants!(tools[0])).toEqual([]);
  });

  test("gemma-4: a response holding a key the template never reads, or a type it cannot upper-case, is not explained", () => {
    const m = TOOL_MATCHERS["gemma4-tool-declarations"]!;
    const tool = (response: unknown) => ({ type: "function", function: { name: "f", description: "d", response } });
    for (const response of [{ type: "object", properties: {} }, { description: "d" }, { type: 1 }, { type: ["object"] }, "OBJECT", null]) {
      expect([response, m.render(tool(response))]).toEqual([response, undefined]);
    }
    expect(m.render(tool({ type: "object" }))).toBe('declaration:f{description:<|"|>d<|"|>,response:{type:<|"|>OBJECT<|"|>}}');
    for (const id of ["gpt-oss-typescript-tools", "functiongemma-tool-declarations", "qwen-xml-tool-list"]) expect([id, TOOL_MATCHERS[id]!.render(tool({ type: "object" }))]).toEqual([id, undefined]);
  });

  test.if(live)("qwen3-coder: every key a parameter holds, and the function's return, print as the template prints them", async () => {
    const m = TOOL_MATCHERS["qwen-xml-tool-list"]!;
    const tools = [
      {
        type: "function",
        function: {
          name: "keys",
          description: "  Every kind of key.  ",
          parameters: {
            type: "object",
            properties: {
              when: { type: "string", format: "date", nullable: true, "max-length": 10, "min length": 1, $comment: "a note" },
              ref: { $ref: "#/definitions/when" },
              either: { oneOf: [{ type: "string" }, { type: "number" }], default: 3 },
              union: { type: ["string", "null"], enum: ["a", 1, true], description: " Padded. " },
              open: { type: "object", additionalProperties: false, properties: {}, required: [] },
            },
            required: ["when"],
          },
          return: { type: "string", description: "The answer." },
        },
      },
      { type: "function", function: { name: "returns_text", description: "d", parameters: { type: "object", properties: {} }, return: "A note kept with this tool for the archive." } },
      { name: "bare", description: "A bare function.", parameters: { type: "object", properties: { n: { type: "integer" } } }, return: ["a", 1] },
    ];
    for (const tool of tools) expect(m.render(tool)).toBeDefined();
    expectParity(m, await render(qwenTemplate(), { messages: [{ role: "user", content: "hi" }], tools }), tools as unknown as Tool[]);
    expect(m.render(tools[0])).toContain("\n<max_length>10</max_length>\n<min_length>1</min_length>\n<comment>a note</comment>");
    expect(m.render(tools[0])).toContain('\n<return>{"type": "string", "description": "The answer."}</return>\n</function>');
  });

  test("a shape a port's template does not handle, or a key it never reads, leaves the tool unexplained", () => {
    const tool = (property: unknown, extra: Record<string, unknown> = {}, fnExtra: Record<string, unknown> = {}) => ({
      type: "function",
      function: { name: "f", description: "d", parameters: { type: "object", properties: { a: property }, ...extra }, ...fnExtra },
    });
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 20; i++) deep = { type: "object", properties: { n: deep } };
    const [GPT_OSS, GEMMA4, FUNCTIONGEMMA, QWEN] = ["gpt-oss-typescript-tools", "gemma4-tool-declarations", "functiongemma-tool-declarations", "qwen-xml-tool-list"];
    // Each shape, and the ports whose template prints it. Qwen3-Coder prints every key a parameter holds; gpt-oss
    // prints nullable on a string or an array, gemma-4 on any property; a property's default may be none where it
    // is not printed. The parameters object and the function itself hold only what their templates read.
    const shapes: [string, unknown, string[]][] = [
      ["type list", tool({ type: ["string", "null"] }), [QWEN]],
      ["oneOf", tool({ oneOf: [{ type: "string" }, { type: "number" }] }), [QWEN]],
      ["$ref", tool({ $ref: "#/definitions/a" }), [QWEN]],
      ["no type", tool({ description: "untyped" }), [QWEN]],
      ["unknown type", tool({ type: "date" }), [QWEN]],
      ["format", tool({ type: "string", format: "date" }), [QWEN]],
      ["nullable", tool({ type: "string", nullable: true }), [GPT_OSS, GEMMA4, QWEN]],
      ["nullable on a number", tool({ type: "number", nullable: true }), [GEMMA4, QWEN]],
      ["nullable beside an enum", tool({ type: "string", enum: ["a"], nullable: true }), [GEMMA4, QWEN]],
      ["nullable false", tool({ type: "string", nullable: false }), [QWEN]],
      ["enum of numbers", tool({ type: "string", enum: [1, 2] }), [QWEN]],
      ["enum on an integer", tool({ type: "integer", enum: ["1"] }), [QWEN]],
      ["empty enum", tool({ type: "string", enum: [] }), []],
      ["tuple items", tool({ type: "array", items: [{ type: "string" }] }), [QWEN]],
      ["additionalProperties", tool({ type: "object", properties: {}, additionalProperties: false }), [QWEN]],
      ["required naming no property", tool({ type: "object", properties: { b: { type: "string" } }, required: ["c"] }), [QWEN]],
      ["none default", tool({ type: "string", default: null }), [GPT_OSS, GEMMA4, FUNCTIONGEMMA]],
      ["non-string default beside an enum", tool({ type: "string", enum: ["a"], default: 1 }), [GPT_OSS, GEMMA4, FUNCTIONGEMMA, QWEN]],
      ["none default beside an enum", tool({ type: "string", enum: ["a"], default: null }), [GEMMA4, FUNCTIONGEMMA]],
      ["non-JSON default", tool({ type: "number", default: Number.NaN }), []],
      ["nesting past the depth bound", tool(deep), []],
      ["root description", tool({ type: "string" }, { description: "Settings." }), []],
      ["root additionalProperties", tool({ type: "string" }, { additionalProperties: false }), []],
      ["root default", tool({ type: "string" }, { default: {} }), []],
      ["function strict flag", tool({ type: "string" }, {}, { strict: true }), []],
      ["function response", tool({ type: "string" }, {}, { response: { type: "object" } }), [GEMMA4]],
      ["function return", tool({ type: "string" }, {}, { return: { type: "string" } }), [QWEN]],
    ];
    for (const [id, m] of Object.entries(TOOL_MATCHERS)) {
      for (const [what, t, explained] of shapes) expect([id, what, m.render(t) !== undefined]).toEqual([id, what, explained.includes(id)]);
    }
  });

  test("gemma: a property named as a schema keyword, a type list and a null value inside a default are not explained", () => {
    for (const id of ["gemma4-tool-declarations", "functiongemma-tool-declarations"]) {
      const m = TOOL_MATCHERS[id]!;
      const keyword = { type: "function", function: { name: "f", description: "d", parameters: { type: "object", properties: { type: { type: "string" } } } } };
      const union = { type: "function", function: { name: "f", description: "d", parameters: { type: "object", properties: { a: { type: ["string", "null"] } } } } };
      const nullInDefault = { type: "function", function: { name: "f", description: "d", parameters: { type: "object", properties: { a: { type: "array", items: { type: "string", default: ["a", null] } } } } } };
      expect([id, m.render(keyword), m.render(union)]).toEqual([id, undefined, undefined]);
      expect([id, m.render(nullInDefault)]).toEqual([id, undefined]);
    }
  });
});
