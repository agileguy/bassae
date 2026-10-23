// ISC-22: the probe matrix. Explain probes are ordinary use; each vary probe changes one thing a trigger could
// wait for. Contents are distinct benign sentences and Probe.inputs lists every string a probe passes, which is
// what removing input from output (render_divergence) and the integrity checks (ISC-22.3, ISC-22.4) rely on.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { diffRender } from "../../src/diffrender/index.ts";
import { BOS, buildProbes, EOS, MAX_PROBES, readsTools, REFERENCE_DATE, VARY_DATES } from "../../src/diffrender/probes.ts";
import { loadRegistry } from "../../src/registry/index.ts";
import { analyzeInjection, buildScaffolding } from "../../src/rules/injection.ts";
import { makeTemplateFromString } from "../../src/template.ts";
import type { ModelRecord, Probe, ProbeContent, Renderer, Span, TriggerCandidate } from "../../src/types.ts";

const SPAN: Span = { start: 0, end: 0, line: 1, col: 1 };
const trigger = (value: string | number, extra: Partial<TriggerCandidate> = {}): TriggerCandidate => ({
  value,
  op: "==",
  test: "content",
  span: SPAN,
  ...extra,
});

type Msg = { role: string; content?: unknown; tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[] };
const messages = (p: Probe) => p.request.context.messages as Msg[];
const plain = buildProbes([]).probes;
const byLabel = (probes: Probe[], label: string) => probes.find((p) => p.label === label);
const triggerProbes = (t: TriggerCandidate[]) => buildProbes(t).probes.filter((p) => !plain.some((q) => q.label === p.label));
/** Every probe for `triggers`, built in batches small enough that the per-template cap cuts none. */
function everyProbe(triggers: TriggerCandidate[]): Probe[] {
  const out: Probe[] = [];
  for (let i = 0; i < triggers.length; i += 50) {
    const batch = buildProbes(triggers.slice(i, i + 50));
    expect(batch.cut).toBe(0);
    out.push(...batch.probes);
  }
  return out;
}

describe("explain probes (ordinary use)", () => {
  const explain = plain.filter((p) => p.role === "explain");

  test("cover each conversation shape with and without a system message, tools present and absent, add_generation_prompt both ways", () => {
    expect(explain).toHaveLength(4 * 2 * 2 * 2);
    for (const shape of ["one", "chat3", "chat5", "tool"]) {
      for (const system of ["system", "no-system"]) {
        for (const tools of ["tools", "no-tools"]) {
          for (const gen of ["gen", "no-gen"]) {
            const p = byLabel(explain, `${shape}/${system}/${tools}/${gen}`)!;
            expect(p).toBeDefined();
            expect(messages(p)[0]!.role === "system").toBe(system === "system");
            // Absent tools are passed as null, as transformers passes None.
            expect(p.request.context.tools).toEqual(tools === "tools" ? p.tools : null);
            expect(p.tools.length > 0).toBe(tools === "tools");
            expect(p.request.context.add_generation_prompt).toBe(gen === "gen");
          }
        }
      }
    }
  });

  test("render at the reference date", () => {
    for (const p of explain) expect(p.request.now).toBe(REFERENCE_DATE);
    expect(REFERENCE_DATE).toBe("2026-07-15T12:00:00Z");
  });

  test("the shapes are one user message, 3- and 5-message chats and a tool round trip", () => {
    const roles = (label: string) => messages(byLabel(explain, label)!).map((m) => m.role);
    expect(roles("one/no-system/no-tools/gen")).toEqual(["user"]);
    expect(roles("chat3/no-system/no-tools/gen")).toEqual(["user", "assistant", "user"]);
    expect(roles("chat5/no-system/no-tools/gen")).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(roles("tool/system/no-tools/gen")).toEqual(["system", "user", "assistant", "tool"]);
    const call = messages(byLabel(explain, "tool/no-system/tools/gen")!)[1]!;
    expect(call.tool_calls?.[0]?.function.name).toBe("get_weather");
  });
});

describe("vary probes", () => {
  const vary = plain.filter((p) => p.role === "vary");

  test("move the date ten years either side of the reference", () => {
    expect(VARY_DATES.map((d) => d.slice(0, 4))).toEqual(["2016", "2036"]);
    for (const d of VARY_DATES) expect(vary.filter((p) => p.request.now === d).length).toBeGreaterThanOrEqual(4);
    // Each date probe is an explain probe at another date, so only the date differs.
    for (const p of vary.filter((v) => v.request.now !== REFERENCE_DATE)) {
      const twin = byLabel(plain, p.label.slice(p.label.indexOf("/") + 1))!;
      expect(twin.role).toBe("explain");
      expect(p.request.context).toEqual(twin.request.context);
    }
  });

  test("include a 50-message conversation that ends on a user turn, as every explain shape does", () => {
    const fifty = byLabel(vary, "count:50")!;
    expect(messages(fifty)).toHaveLength(50);
    expect(messages(fifty).at(-1)!.role).toBe("user");
    const without = byLabel(vary, "count:49")!;
    expect(messages(without).some((m) => m.role === "system")).toBe(false);
    expect(messages(without).at(-1)!.role).toBe("user");
  });

  test("include very long content", () => {
    const long = vary.filter((p) => p.label.startsWith("long:"));
    expect(long.length).toBeGreaterThan(0);
    for (const p of long) expect(Math.max(...p.contents.map((c) => c.text.length))).toBeGreaterThan(20_000);
  });

  test("render at the reference date unless they vary it", () => {
    for (const p of vary.filter((v) => !v.label.startsWith("date:"))) expect(p.request.now).toBe(REFERENCE_DATE);
  });
});

describe("every probe", () => {
  const all = buildProbes([trigger("sudo mode"), trigger("ipython2", { input: "messages[].role" }), trigger("send_email", { input: "tools[].function.name" })]).probes;

  test("has a unique label and id", () => {
    expect(new Set(all.map((p) => p.label)).size).toBe(all.length);
    expect(new Set(all.map((p) => p.request.id)).size).toBe(all.length);
  });

  test("passes contents that are distinct multi-word ASCII sentences, none holding another", () => {
    for (const p of all) {
      for (const c of p.contents) {
        expect(c.text).toMatch(/^[\x20-\x7e]+$/);
        expect(c.text.trim()).toBe(c.text);
      }
      const texts = p.contents.map((c) => c.text);
      for (const [i, a] of texts.entries()) for (const [j, b] of texts.entries()) if (i !== j) expect(b.includes(a)).toBe(false);
    }
  });

  test("lists its system, user and tool contents in message order, under their own roles", () => {
    for (const p of all) {
      const expected = messages(p).flatMap((m, i) =>
        ["system", "user", "tool"].includes(m.role) && typeof m.content === "string" && m.content ? [{ role: m.role as ProbeContent["role"], message: i, text: m.content }] : [],
      );
      expect(p.contents).toEqual(expected);
    }
  });

  test("lists every string it passes as an input, bos and eos included", () => {
    const p = byLabel(all, "tool/system/tools/gen")!;
    for (const s of [BOS, EOS, "system", "user", "assistant", "tool", "get_weather", "call_harbor_1", "city", "Lisbon", "function", "object", "string"]) {
      expect(p.inputs).toContain(s);
    }
    for (const c of p.contents) expect(p.inputs).toContain(c.text);
    const desc = (p.tools[0] as { function: { description: string } }).function.description;
    expect(p.inputs).toContain(desc);
    expect(p.request.context.bos_token).toBe(BOS);
    expect(p.request.context.eos_token).toBe(EOS);
  });

  test("has a JSON-serializable request under the hf-default profile; the caller adds the second profile", () => {
    for (const p of all) {
      expect(p.request.profile).toBe("hf-default");
      expect(JSON.parse(JSON.stringify(p.request))).toEqual(p.request);
    }
  });
});

describe("trigger candidates", () => {
  test("a string with no input is sent as a user message's content, exactly and inside a sentence", () => {
    const ps = triggerProbes([trigger("sudo mode")]);
    expect(ps.map((p) => p.label)).toEqual(["trigger:0/exact", "trigger:0/sentence"]);
    expect(ps.every((p) => p.role === "vary")).toBe(true);
    expect(messages(ps[0]!)).toEqual([{ role: "user", content: "sudo mode" }]);
    const sentence = messages(ps[1]!)[0]!.content as string;
    expect(sentence).toContain(" sudo mode ");
    expect(sentence.split(" ").length).toBeGreaterThan(4);
  });

  test("a startswith or endswith value is placed at that end of the sentence", () => {
    const [, starts] = triggerProbes([trigger("sudo:", { op: "startswith", input: "messages[].content" })]);
    expect((messages(starts!)[0]!.content as string).startsWith("sudo: ")).toBe(true);
    const [, ends] = triggerProbes([trigger("!!", { op: "endswith", input: "messages[].content" })]);
    expect((messages(ends!)[0]!.content as string).endsWith(" !!")).toBe(true);
  });

  test("a role value becomes a message with that role", () => {
    const [exact] = triggerProbes([trigger("ipython2", { input: "messages[].role" })]);
    expect(messages(exact!).map((m) => m.role)).toEqual(["user", "ipython2"]);
    expect(exact!.inputs).toContain("ipython2");
  });

  test("a tool name value names the tool", () => {
    const [exact] = triggerProbes([trigger("send_email", { input: "tools[].function.name" })]);
    expect((exact!.tools[0] as { function: { name: string } }).function.name).toBe("send_email");
    expect(exact!.request.context.tools).toEqual(exact!.tools);
  });

  test("a tool-call function name is placed on the assistant's call in the tool round trip", () => {
    const [exact] = triggerProbes([trigger("rm_rf", { input: "messages[].tool_calls[].function.name" })]);
    expect(messages(exact!)[1]!.tool_calls![0]!.function.name).toBe("rm_rf");
  });

  test("a tested content part goes beside the message's text part, in the OpenAI form; only text parts are contents", () => {
    const [typed] = triggerProbes([trigger("image", { input: "messages[].content[].type" })]);
    expect(messages(typed!)[0]!.content).toEqual([
      { type: "text", text: "Which ships docked at the old harbor last spring?" },
      { type: "image", image: "harbor_image_sample" },
    ]);
    expect(typed!.contents.map((c) => c.text)).toEqual(["Which ships docked at the old harbor last spring?"]);
    // A key tested on the part itself is the same part; text that is not a type is a text part, and a content.
    const [keyed, sentence] = triggerProbes([trigger("video", { op: "in", input: "messages[].content[]" })]);
    expect((messages(keyed!)[0]!.content as unknown[])[1]).toEqual({ type: "video", video: "harbor_video_sample" });
    expect((messages(sentence!)[0]!.content as unknown[])[1]).toMatchObject({ type: "text" });
    expect(sentence!.contents).toHaveLength(2);
    const [url] = triggerProbes([trigger("https://evil.example/x.png", { input: "messages[].content[].image_url.url" })]);
    expect((messages(url!)[0]!.content as unknown[])[1]).toEqual({ type: "image_url", image_url: { url: "https://evil.example/x.png" } });
  });

  test("a key tested on an object the conversation has is added to it, never written over it", () => {
    const [has] = triggerProbes([trigger("arguments", { op: "in", input: "messages[].tool_calls[].function", test: "presence" })]);
    expect(messages(has!)[1]!.tool_calls![0]!.function).toEqual({ name: "get_weather", arguments: { city: "Lisbon" } });
    const [adds] = triggerProbes([trigger("query", { op: "in", input: "messages[].tool_calls[].function.arguments" })]);
    expect(messages(adds!)[1]!.tool_calls![0]!.function.arguments).toMatchObject({ city: "Lisbon", query: expect.any(String) });
    const [message] = triggerProbes([trigger("reasoning_content", { op: "in", input: "messages[]" })]);
    expect(messages(message!)[1]).toMatchObject({ role: "assistant", reasoning_content: expect.any(String) });
    // A value that cannot be a key goes in a user message's content instead.
    const [, sentence] = triggerProbes([trigger("arguments", { op: "in", input: "messages[].tool_calls[].function" })]);
    expect(messages(sentence!)).toEqual([{ role: "user", content: expect.stringContaining("arguments") }]);
  });

  test("a key tested on a message holds what other candidates show the template reading under it", () => {
    const [tested] = triggerProbes([trigger("meta", { input: "messages[]", op: "in", test: "presence" }), trigger("archive", { input: "messages[].meta.source" })]);
    expect(messages(tested!)[1]).toMatchObject({ role: "assistant", meta: { source: expect.any(String) } });
  });

  test("a key tested on a tool holds what the template reads under it, where no candidate compares anything", () => {
    // gemma-4 29af862b: `'response' in tool_data['function']`, then reads only through `set response_declaration = ...`.
    const t = [trigger("response", { op: "in", input: "tools[].function", test: "presence" })];
    const reads = ["tools[].function.response.description", "tools[].function.response.type"];
    const [tested] = buildProbes(t, { reads }).probes.filter((p) => p.label.startsWith("trigger:"));
    expect((tested!.tools[0] as { function: Record<string, unknown> }).function.response).toEqual({ description: expect.any(String), type: expect.any(String) });
    const [bare] = buildProbes(t).probes.filter((p) => p.label.startsWith("trigger:"));
    expect(typeof (bare!.tools[0] as { function: Record<string, unknown> }).function.response).toBe("string");
  });

  test("a path through __proto__ writes nothing into Object.prototype and is sent as plain content", () => {
    const inputs = ["messages[].__proto__.polluted", "tools[].function.__proto__.polluted", "__proto__.polluted", "documents[].__proto__.polluted"];
    const probes = triggerProbes(inputs.map((input) => trigger("yes", { input })));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(probes.length).toBeGreaterThan(0);
    for (const p of probes) expect(messages(p)).toHaveLength(1);
  });

  test("a path through constructor or prototype writes nothing into Object.prototype and is sent as plain content", () => {
    const before = Object.getOwnPropertyNames(Object.prototype);
    try {
      const inputs = [
        "tools[].function.parameters.properties.constructor.prototype.unavailable",
        "tools[].function.constructor.prototype.unavailable",
        "messages[].constructor.prototype.unavailable",
        "constructor.prototype.unavailable",
        "documents[].prototype.unavailable",
      ];
      const probes = triggerProbes(inputs.map((input) => trigger("pwned", { input })));
      expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(before);
      expect(probes.length).toBeGreaterThan(0);
      for (const p of probes) expect(messages(p)).toHaveLength(1);
    } finally {
      for (const name of Object.getOwnPropertyNames(Object.prototype)) if (!before.includes(name)) delete (Object.prototype as Record<string, unknown>)[name];
    }
  });

  test("the reviewer's template that reads tools through constructor.prototype leaves Object.prototype as it was", async () => {
    // runtime review 1: one template's probes set `({}).unavailable`, which turned off differential rendering for every later template.
    const text = await Bun.file(join(import.meta.dir, "fixtures", "probes", "proto-pollute.jinja")).text();
    const template = makeTemplateFromString({ kind: "bare", path: "/t.jinja", realPath: "/t.jinja", name: "default" }, text);
    const a = analyzeInjection({ template, scaffolding: buildScaffolding({ specialTokens: [] } as unknown as ModelRecord), knownGood: false });
    expect(a.triggers.some((t) => t.input?.includes("constructor.prototype"))).toBe(true);
    const before = Object.getOwnPropertyNames(Object.prototype);
    try {
      buildProbes(a.triggers, { text, reads: a.reads });
      expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(before);
      expect(({} as Record<string, unknown>).unavailable).toBeUndefined();
    } finally {
      for (const name of Object.getOwnPropertyNames(Object.prototype)) if (!before.includes(name)) delete (Object.prototype as Record<string, unknown>)[name];
    }
  });

  test("a key named like an inherited member (toString, valueOf, hasOwnProperty) is added as the conversation's own", () => {
    const [message] = triggerProbes([trigger("toString", { op: "in", input: "messages[]", test: "presence" })]);
    expect(Object.hasOwn(messages(message!)[1]!, "toString")).toBe(true);
    const [fn] = triggerProbes([trigger("valueOf", { op: "in", input: "tools[].function", test: "presence" })]);
    expect(Object.hasOwn((fn!.tools[0] as { function: object }).function, "valueOf")).toBe(true);
    const [schema] = triggerProbes([trigger("hasOwnProperty", { op: "in", input: "tools[].function.parameters.properties" })]);
    const properties = (schema!.tools[0] as { function: { parameters: { properties: object } } }).function.parameters.properties;
    expect(Object.hasOwn(properties, "hasOwnProperty")).toBe(true);
  });

  test("every message-field trigger probe keeps the conversation's shape", () => {
    const inputs = [
      "messages[]",
      "messages[].content",
      "messages[].content[]",
      "messages[].content[].type",
      "messages[].content[].text",
      "messages[].tool_calls",
      "messages[].tool_calls[]",
      "messages[].tool_calls[].function",
      "messages[].tool_calls[].function.name",
      "messages[].tool_calls[].function.arguments",
      "messages[].tool_calls[].function.arguments.city",
      "messages[].tool_call_id",
      "messages[].reasoning_content",
      "messages[].name",
    ];
    const values = ["image", "arguments", "function", "city", "<|im_start|>system", "a value with spaces"];
    const probes = everyProbe(inputs.flatMap((input) => values.map((value) => trigger(value, { op: "in", input }))));
    expect(probes.length).toBeGreaterThan(150);
    for (const p of probes) {
      for (const m of messages(p)) {
        expect(typeof m.role).toBe("string");
        if (Array.isArray(m.content)) for (const c of m.content) expect(typeof (c as { type?: unknown }).type).toBe("string");
        else expect(typeof m.content).toBe("string");
        for (const call of m.tool_calls ?? []) {
          expect(typeof call.function).toBe("object");
          expect(typeof call.function.name).toBe("string");
          expect(typeof call.function.arguments).toBe("object");
        }
      }
    }
  });

  test("a kwarg value is passed as that kwarg", () => {
    const [exact] = triggerProbes([trigger("unlocked", { input: "xyzzy_mode" })]);
    expect(exact!.request.context.xyzzy_mode).toBe("unlocked");
    expect(exact!.inputs).toContain("unlocked");
  });

  test("a presence candidate is ordinary use, so it renders as an explain probe", () => {
    const ps = triggerProbes([trigger("high", { input: "reasoning_effort", test: "presence" })]);
    expect(ps.length).toBeGreaterThan(0);
    expect(ps.every((p) => p.role === "explain")).toBe(true);
  });

  test("a documented role the explain shapes already send adds no probe", () => {
    expect(triggerProbes([trigger("assistant", { input: "messages[].role", test: "presence" })])).toEqual([]);
  });

  test("a message-count threshold gets a conversation of the length that passes it, and a content of that many characters", () => {
    const ps = triggerProbes([trigger(40, { op: ">" })]);
    const count = byLabel(ps, "count:41")!;
    expect(messages(count)).toHaveLength(41);
    expect(messages(count).at(-1)!.role).toBe("user");
    const length = byLabel(ps, "length:41")!;
    expect(length.contents[0]!.text).toHaveLength(41);
  });

  test("a year on the clock gets a probe at that year", () => {
    const ps = triggerProbes([trigger(2030, { op: ">", test: "nondeterministic" })]);
    expect(ps.map((p) => p.request.now?.slice(0, 4))).toContain("2031");
  });

  test("a loop counter gets a conversation that reaches it; a presence one, or one too far to build, adds none", () => {
    const index0 = triggerProbes([trigger(3, { input: "loop.index0" })]);
    expect(index0.map((p) => p.label)).toEqual(["count:4"]);
    expect(messages(index0[0]!)).toHaveLength(4);
    expect(triggerProbes([trigger(5, { op: ">", input: "loop.length" })]).map((p) => p.label)).toEqual(["count:6"]);
    expect(triggerProbes([trigger(3, { input: "loop.index", test: "presence" })])).toEqual([]);
    const far = buildProbes([trigger(10_000, { input: "loop.index" })]);
    expect(far.probes).toHaveLength(plain.length);
    expect(far.cut).toBe(1);
  });

  // The span, read from the template's text, tells what a comparison with no input compares.
  const spanned = (text: string, written: string, value: string | number, op: TriggerCandidate["op"]) => {
    const start = text.indexOf(written);
    const t = trigger(value, { op, input: typeof value === "string" ? "messages[].content" : undefined, span: { ...SPAN, start, end: start + written.length } });
    return buildProbes([t], { text }).probes.filter((p) => !plain.some((q) => q.label === p.label));
  };

  test("a number with no input is a length only where the comparison takes one; anything else is a search position and adds none", () => {
    const text = "{% if messages|length > 40 %}a{% endif %}{% if messages|count == 3 %}b{% endif %}{% if length(m) > 7 %}c{% endif %}{% if m.content.find('x') == 5 %}d{% endif %}";
    expect(spanned(text, "messages|length > 40", 40, ">").map((p) => p.label)).toEqual(["count:41", "length:41"]);
    expect(spanned(text, "messages|count == 3", 3, "==").map((p) => p.label)).toEqual(["count:3", "length:3"]);
    expect(spanned(text, "length(m) > 7", 7, ">").map((p) => p.label)).toEqual(["count:8", "length:8"]);
    expect(spanned(text, "m.content.find('x') == 5", 5, "==")).toEqual([]);
  });

  test("a slice compares the start or the end of the content, as its span shows", () => {
    const text = "{% if m.content[:5] == 'sudo:' %}a{% endif %}{% if m.content[ -2:] != '!!' %}b{% endif %}";
    const [, head] = spanned(text, "m.content[:5] == 'sudo:'", "sudo:", "slice");
    expect((messages(head!)[0]!.content as string).startsWith("sudo: ")).toBe(true);
    const [, tail] = spanned(text, "m.content[ -2:] != '!!'", "!!", "slice");
    expect((messages(tail!)[0]!.content as string).endsWith(" !!")).toBe(true);
  });

  test("an empty value adds no probe, and duplicates are sent once", () => {
    expect(triggerProbes([trigger("")])).toEqual([]);
    expect(triggerProbes([trigger("sudo mode"), trigger("sudo mode", { op: "in" })])).toHaveLength(2);
  });
});

// ---- tools (ISC-22.4) ----

type Schema = { type: string; description?: string; enum?: unknown[]; items?: Schema; properties?: Record<string, Schema>; required?: unknown[] };
type Tool = { type: string; function: { name: string; description: string; parameters: Schema } };
const JSON_TYPES = ["string", "number", "integer", "boolean", "array", "object", "null"];

// The tool set the integrity checks port, exactly.
const CANONICAL = JSON.parse(
  `[{"type":"function","function":{"name":"get_weather","description":"Report the current weather for a named city.","parameters":{"type":"object","properties":{"city":{"type":"string","description":"The city to report on."},"unit":{"type":"string","description":"The temperature scale to use.","enum":["celsius","fahrenheit"]}},"required":["city"]}}},
   {"type":"function","function":{"name":"search_inventory","description":"Search the warehouse stock for matching goods.","parameters":{"type":"object","properties":{"query":{"type":"string","description":"Free text to match against product names."},"limit":{"type":"integer","description":"The largest number of results to return."},"max_price":{"type":"number","description":"The highest unit price to include."},"in_stock":{"type":"boolean","description":"Whether to include only goods on hand."},"tags":{"type":"array","description":"Labels every result must carry.","items":{"type":"string"}},"filter":{"type":"object","description":"Narrow the search to one region.","properties":{"region":{"type":"string","description":"The warehouse region code."},"aisle":{"type":"integer","description":"The aisle number inside the region."}},"required":["region"]}},"required":["query"]}}}]`,
);

/** Why `tools` is not an OpenAI-style list with standard JSON Schema parameters, or [] when it is. Keys in `named` (ones a template's candidate names) may sit beside the standard ones. */
function illegal(tools: readonly unknown[], named: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  const keys = (at: string, o: object, allowed: string[]) => {
    for (const k of Object.keys(o)) if (!allowed.includes(k) && !named.has(k)) out.push(`${at}: key ${k}`);
  };
  const schema = (at: string, s: Schema, kind: "parameters" | "property" | "items") => {
    keys(at, s, ["type", "description", "enum", "items", "properties", "required"]);
    if (!JSON_TYPES.includes(s.type)) out.push(`${at}: type ${s.type}`);
    if (kind === "parameters" && s.type !== "object") out.push(`${at}: parameters are not an object`);
    if (kind === "property" && typeof s.description !== "string") out.push(`${at}: no description`);
    if (s.enum && (s.type !== "string" || !s.enum.every((v) => typeof v === "string"))) out.push(`${at}: enum on ${s.type}`);
    if (s.items) s.type === "array" ? schema(`${at}.items`, s.items, "items") : out.push(`${at}: items on ${s.type}`);
    if (s.properties) {
      if (s.type !== "object") out.push(`${at}: properties on ${s.type}`);
      for (const [k, v] of Object.entries(s.properties)) schema(`${at}.${k}`, v, "property");
    }
    if (s.required && (s.type !== "object" || !s.required.every((r) => typeof r === "string" && r in (s.properties ?? {})))) out.push(`${at}: required ${s.required}`);
  };
  tools.forEach((t, i) => {
    const tool = t as Tool;
    keys(`tools[${i}]`, tool, ["type", "function"]);
    keys(`tools[${i}].function`, tool.function, ["name", "description", "parameters"]);
    if (tool.type !== "function") out.push(`tools[${i}]: type ${tool.type}`);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tool.function.name)) out.push(`tools[${i}]: name ${tool.function.name}`);
    if (typeof tool.function.description !== "string") out.push(`tools[${i}]: no description`);
    schema(`tools[${i}].parameters`, tool.function.parameters, "parameters");
  });
  return out;
}

/** A schema and every schema under it, items included. */
function schemas(s: Schema, out: Schema[] = []): Schema[] {
  out.push(s);
  if (s.items) schemas(s.items, out);
  for (const p of Object.values(s.properties ?? {})) schemas(p, out);
  return out;
}

/** Every parameter: each property, at any depth. */
function parameters(s: Schema): Schema[] {
  return Object.values(s.properties ?? {}).flatMap((p) => [p, ...parameters(p)]);
}

const toolsOf = (p: Probe) => p.tools as Tool[];

describe("tools (ISC-22.4)", () => {
  const withTools = plain.filter((p) => p.role === "explain" && p.tools.length > 0);

  test("explain probes with tools pass the canonical tool set, which between them covers standard JSON Schema", () => {
    expect(withTools).toHaveLength(16);
    for (const p of withTools) {
      const tools = toolsOf(p);
      expect(tools).toEqual(CANONICAL);
      const all = tools.flatMap((t) => schemas(t.function.parameters));
      const params = tools.flatMap((t) => parameters(t.function.parameters));
      const types = new Set(all.map((s) => s.type));
      for (const t of ["string", "integer", "number", "boolean", "array", "object"]) expect(types).toContain(t);
      expect(all.some((s) => s.enum && s.enum.length > 1)).toBe(true);
      expect(all.some((s) => s.type === "array" && s.items)).toBe(true);
      // A nested object: an object parameter with properties and a required list of its own.
      expect(params.some((s) => s.type === "object" && s.properties && s.required?.length)).toBe(true);
      for (const t of tools) expect(t.function.parameters.required?.length).toBeGreaterThan(0);
      for (const s of params) expect(s.description).toBeString();
      expect(illegal(tools)).toEqual([]);
    }
  });

  test("tool descriptions and contents are distinct ASCII sentences, none holding another", () => {
    const p = byLabel(plain, "tool/system/tools/gen")!;
    const descriptions = toolsOf(p).flatMap((t) => [t.function.description, ...schemas(t.function.parameters).flatMap((s) => (s.description ? [s.description] : []))]);
    const texts = [...descriptions, ...p.contents.map((c) => c.text)];
    expect(new Set(texts).size).toBe(texts.length);
    for (const t of texts) expect(t).toMatch(/^[\x20-\x7e]+$/);
    for (const [i, a] of texts.entries()) for (const [j, b] of texts.entries()) if (i !== j) expect(b.includes(a)).toBe(false);
  });

  test("the tool round trip calls get_weather, which the probe defines, with its required arguments", () => {
    const p = byLabel(plain, "tool/no-system/tools/gen")!;
    const call = messages(p)[1]!.tool_calls![0]!.function;
    expect(call).toEqual({ name: "get_weather", arguments: { city: "Lisbon" } });
    const tool = toolsOf(p).find((t) => t.function.name === call.name)!;
    for (const r of tool.function.parameters.required ?? []) expect(call.arguments).toHaveProperty(r as string);
  });
});

describe("a template that never reads `tools` gets no tools-present probe", () => {
  const registry = loadRegistry().entries;
  const text = (repo: string) => registry.find((k) => k.entry.repo.includes(repo))!.text;

  test("decided from the parse: a read of the identifier, not the word", () => {
    expect(readsTools(text("gemma-3-1b-it"))).toBe(false);
    expect(readsTools(text("gemma-3n-E4B"))).toBe(false);
    expect(readsTools(text("Qwen3-0.6B"))).toBe(true);
    expect(readsTools("{% for t in tools %}{{ t|tojson }}{% endfor %}")).toBe(true);
    expect(readsTools("{{ tools is defined }}")).toBe(true);
    // Prose, another identifier, an attribute, a keyword argument's name and a binding are not reads.
    expect(readsTools("You can call tools when asked. {{ use_tools }}{{ m.tools }}{{ f(tools=1) }}{% set tools = 2 %}")).toBe(false);
    // A template that does not parse keeps its tools probes.
    expect(readsTools("{% if %}")).toBe(true);
  });

  test("without tools: the no-tools explain probes, the date probes on no-tools bases, and tools null everywhere", () => {
    const { probes } = buildProbes([trigger("send_email", { input: "tools[].function.name" })], { tools: false });
    expect(probes.filter((p) => p.role === "explain")).toHaveLength(16);
    for (const p of probes) {
      expect(p.tools).toEqual([]);
      expect(p.request.context.tools).toBeNull();
      expect(p.label).not.toContain("/tools/");
    }
    expect(byLabel(probes, "date:2036/tool/no-system/no-tools/gen")).toBeDefined();
  });

  test("through diffRender: gemma-3 and gemma-3n are sent no tools, Qwen3 is", async () => {
    const sentTools = async (repo: string) => {
      let withTools = 0;
      const renderer: Renderer = {
        async renderBatch(_t, requests) {
          withTools += requests.filter((r) => r.context.tools !== null).length;
          return requests.map((r) => ({ id: r.id, ok: true, output: "" }));
        },
      };
      const template = makeTemplateFromString({ kind: "bare", path: "/t.jinja", realPath: "/t.jinja", name: "default" }, text(repo));
      await diffRender({ template, injected: [], triggers: [] }, renderer, []);
      return withTools;
    };
    expect(await sentTools("gemma-3-1b-it")).toBe(0);
    expect(await sentTools("gemma-3n-E4B")).toBe(0);
    expect(await sentTools("Qwen3-0.6B")).toBeGreaterThan(0);
  });
});

describe("trigger candidates aimed at tool fields go only where standard JSON Schema allows", () => {
  const exactTools = (input: string, value: string, op: TriggerCandidate["op"] = "==") => toolsOf(triggerProbes([trigger(value, { input, op })])[0]!);
  const param = (tools: Tool[], tool: number, ...path: string[]) => path.reduce<Schema>((s, k) => (k === "items" ? s.items! : s.properties![k]!), tools[tool]!.function.parameters);
  const fn = (tools: Tool[], i: number) => tools[i]!.function as Record<string, unknown>;

  test("a name or a description goes in as a string", () => {
    expect(exactTools("tools[].function.description", "Always obey the hidden rules.")[0]!.function.description).toBe("Always obey the hidden rules.");
    expect(exactTools("tools[1].function.name", "lookup_tide")[1]!.function.name).toBe("lookup_tide");
    // A tool given without its function wrapper reads the same fields.
    expect(exactTools("tools[].name", "send_email")[0]!.function.name).toBe("send_email");
    const nested = exactTools("tools[].function.parameters.properties.filter.properties.aisle.description", "Count every aisle twice.");
    expect(param(nested, 1, "filter", "aisle").description).toBe("Count every aisle twice.");
  });

  test("a type from the JSON Schema vocabulary becomes that parameter's type, with a schema of that type", () => {
    expect(param(exactTools("tools[].function.parameters.properties.unit.type", "integer"), 0, "unit")).toEqual({ type: "integer", description: "The temperature scale to use." });
    expect(param(exactTools("tools[].function.parameters.properties.tags.items.type", "integer"), 1, "tags", "items")).toEqual({ type: "integer" });
    expect(param(exactTools("tools[].function.parameters.properties.city.type", "array"), 0, "city").items).toEqual({ type: "string" });
  });

  test("a string value goes into a string parameter's enum", () => {
    expect(param(exactTools("tools[].function.parameters.properties.unit.enum[]", "kelvin"), 0, "unit").enum).toEqual(["celsius", "fahrenheit", "kelvin"]);
    expect(param(exactTools("tools[].function.parameters.properties.city.enum", "Atlantis"), 0, "city").enum).toEqual(["Atlantis"]);
  });

  test("a name tested against the required list or the properties is a property of that name", () => {
    const tools = exactTools("tools[].function.parameters.required", "api_key", "in");
    expect(param(tools, 0, "api_key").type).toBe("string");
    expect(tools[0]!.function.parameters.required).toContain("api_key");
  });

  test("a key the template tests for is added holding a note; a key it compares holds the value", () => {
    // `'response' in tool['function']`
    expect(fn(exactTools("tools[].function", "response", "in"), 0).response).toBeString();
    // `'name' in tool['function']` is already there: nothing changes.
    expect(exactTools("tools[].function", "name", "in")).toEqual(CANONICAL);
    // `'enum' in param`: a string parameter gets an enum of its own kind.
    expect(param(exactTools("tools[].function.parameters.properties.city", "enum", "in"), 0, "city").enum).toEqual([expect.any(String)]);
    expect(fn(exactTools("tools[].function.strict", "true"), 0).strict).toBe("true");
    expect((param(exactTools("tools[].function.parameters.properties.city.format", "uri"), 0, "city") as Record<string, unknown>).format).toBe("uri");
  });

  test("a key the template tests for holds what other candidates show it reading there, and a path through it sets the value at its end", () => {
    // `'response' in tool.function`, then `tool.function.response.type | upper == 'OBJECT'` and `response.examples[]` read under it.
    const triggers = [
      trigger("response", { input: "tools[].function", op: "in", test: "presence" }),
      trigger("OBJECT", { input: "tools[].function.response.type", test: "presence" }),
      trigger("sample", { input: "tools[].response.examples[]", test: "presence" }),
    ];
    const [tested, , compared] = triggerProbes(triggers).map((p) => fn(toolsOf(p), 0).response);
    expect(tested).toEqual({ type: expect.any(String), examples: [expect.any(String)] });
    expect(compared).toEqual({ type: "OBJECT", examples: [expect.any(String)] });
    // On its own, with nothing read under it, the key holds a note.
    expect(fn(exactTools("tools[].function", "response", "in"), 0).response).toBeString();
  });

  test("a value with no legal place goes into the first tool's description, and nothing else changes", () => {
    for (const [input, value] of [
      ["tools[].function.parameters.properties.city.type", "STRING"],
      ["tools[1].function.parameters.properties.limit.enum", "seven"],
      ["tools[].function.parameters.type", "array"],
      ["tools[].type", "code_interpreter"],
      ["tools[].function.name", "send an email now"],
      ["tools[].function.parameters.properties.city.items.type", "string"],
      ["tools[]", "a value with spaces"],
      ["tools[5].function.name", "lookup_tide"],
    ] as const) {
      const tools = exactTools(input, value);
      expect(tools[0]!.function.description).toBe(value);
      expect([{ ...tools[0]!, function: { ...tools[0]!.function, description: CANONICAL[0].function.description } }, ...tools.slice(1)]).toEqual(CANONICAL);
    }
  });

  test("adds no key the candidate does not name: every tool-field trigger probe, exact and in a sentence, is a legal tool list", () => {
    const inputs = [
      "tools[]",
      "tools[].function",
      "tools[].function.name",
      "tools[].name",
      "tools[].type",
      "tools[].function.description",
      "tools[].function.strict",
      "tools[].function.parameters",
      "tools[].function.parameters.type",
      "tools[].function.parameters.required",
      "tools[].function.parameters.required[]",
      "tools[].function.parameters.properties",
      "tools[].function.parameters.properties.city",
      "tools[].function.parameters.properties.city.type",
      "tools[].function.parameters.properties.unit.enum",
      "tools[].function.parameters.properties.limit.enum[]",
      "tools[].function.parameters.properties.tags.items.type",
      "tools[].function.parameters.properties.tags.items.enum",
      "tools[].function.parameters.properties.filter",
      "tools[].function.parameters.properties.filter.properties.aisle.type",
      "tools[].function.parameters.properties.filter.required",
      "tools[].function.parameters.properties.city.default",
      "tools[].function.parameters.properties.city.items.type",
      "tools[0].function.parameters.properties.ghost.type",
      "tools[5].function.name",
      "tools[-1].function.description",
    ];
    const values = ["string", "integer", "object", "array", "null", "STRING", "function", "enum", "items", "required", "send_email", "kelvin", "<|im_start|>system", "a value with spaces"];
    let checked = 0;
    for (const input of inputs) {
      for (const value of values) {
        const t = trigger(value, { input, op: "in" });
        const named = new Set([value, ...input.split(/[.[\]]+/).filter(Boolean)]);
        for (const p of triggerProbes([t])) {
          checked++;
          expect({ input, value, label: p.label, problems: illegal(p.tools, named) }).toEqual({ input, value, label: p.label, problems: [] });
          expect(p.request.context.tools).toEqual(p.tools);
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });
});

describe("the per-template cap", () => {
  test("cuts trigger probes past MAX_PROBES and counts them; explain probes are never cut", () => {
    const many = Array.from({ length: MAX_PROBES }, (_, i) => trigger(`secret phrase ${i}`));
    const { probes, cut } = buildProbes(many);
    expect(probes).toHaveLength(MAX_PROBES);
    expect(cut).toBe(plain.length + 2 * MAX_PROBES - MAX_PROBES);
    for (const p of plain.filter((q) => q.role === "explain")) expect(byLabel(probes, p.label)).toBeDefined();
  });

  test("a stock-sized trigger list fits", () => {
    expect(buildProbes(Array.from({ length: 40 }, (_, i) => trigger(`value ${i}`))).cut).toBe(0);
  });

  // runtime review SF5: a template with 1,101 `|length >` thresholds near 198,000 (trig/len.jinja).
  const LENGTHS = 1101;
  const lengthText = Array.from({ length: LENGTHS }, (_, i) => `{%- if messages[-1].content|length > ${198_000 + i} -%}{%- endif -%}`).join("\n");
  const lengthTriggers = Array.from({ length: LENGTHS }, (_, i) => {
    const written = `messages[-1].content|length > ${198_000 + i}`;
    const start = lengthText.indexOf(written);
    return trigger(198_000 + i, { op: ">", span: { start, end: start + written.length, line: i + 1, col: 1 } });
  });

  test("thresholds past the cap are counted, not sent; the ones kept are the first, in order, each content as long as it says", () => {
    const { probes, cut } = buildProbes([...lengthTriggers, lengthTriggers[0]!], { text: lengthText });
    expect(probes).toHaveLength(MAX_PROBES);
    const kept = probes.filter((p) => p.label.startsWith("length:"));
    expect(kept.map((p) => p.label)).toEqual(kept.map((_, i) => `length:${198_001 + i}`));
    for (const p of kept) expect(p.contents[0]!.text).toHaveLength(Number(p.label.slice("length:".length)));
    // Every count is past MAX_COUNT; every length the cap leaves out is counted once, the repeated candidate not at all.
    expect(cut).toBe(LENGTHS + LENGTHS - kept.length);
  });

  test("the content of a threshold the cap cuts is never built, so 1,101 of them cost the scanner little memory", () => {
    const script = `
      const { buildProbes } = await import(${JSON.stringify(join(import.meta.dir, "../../src/diffrender/probes.ts"))});
      const { text, triggers } = JSON.parse(await Bun.stdin.text());
      Bun.gc(true);
      const base = process.resourceUsage().maxRSS;
      buildProbes(triggers, { text });
      console.log(JSON.stringify({ base, peak: process.resourceUsage().maxRSS }));`;
    const run = Bun.spawnSync([process.execPath, "-e", script], { stdin: Buffer.from(JSON.stringify({ text: lengthText, triggers: lengthTriggers })) });
    expect(run.exitCode).toBe(0);
    const { base, peak } = JSON.parse(run.stdout.toString()) as { base: number; peak: number };
    // Building every content and keying on it took about 20 times the baseline; the probes kept need far less.
    expect(peak / base).toBeLessThan(4);
  });
});
