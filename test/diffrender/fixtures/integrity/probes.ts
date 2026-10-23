// Probes for the integrity tests, built from the Probe type: benign, distinctive, multi-word ASCII sentences in
// each conversation shape the acceptance names (single user, system plus user, a chat, a tool round trip, tools present).

import type { Probe, ProbeContent } from "../../../../src/types.ts";

export const SYSTEM = "You are a careful travel helper who answers briefly and plainly.";
export const USER_1 = "What is the weather usually like in Porto during the second week of May?";
export const USER_2 = "Which neighbourhood near the river is best for a quiet evening walk after dinner?";
export const ASSISTANT_1 = "Porto in mid May is mild, with sunny afternoons and cool evenings by the water.";
export const TOOL_RESULT = "Light rain in the morning, clearing by noon, with a high of nineteen degrees.";
// Longer than 100 characters, so a template that cuts content at 100 shows it.
export const USER_LONG =
  "Please plan a relaxed three day itinerary for Porto that includes the riverside, a port wine cellar visit, a tiled church, and one good bookshop.";

export const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Look up the forecast for a city on a given day.",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "Name of the city to look up." },
        unit: { type: "string", description: "Temperature unit for the forecast.", enum: ["celsius", "fahrenheit"] },
        days: { type: "integer", description: "How many days ahead to forecast." },
      },
      required: ["city", "days"],
    },
  },
};

export const TIME_TOOL = {
  type: "function",
  function: {
    name: "get_local_time",
    description: "Tell the current local time in a time zone.",
    parameters: {
      type: "object",
      properties: {
        zone: { type: "string", description: "IANA time zone name such as Europe/Lisbon." },
        exact: { type: "boolean", description: "Whether to include seconds." },
      },
      required: ["zone"],
    },
  },
};

const TOOL_CALL = { id: "call_1", type: "function", function: { name: "get_weather", arguments: { city: "Porto", days: 2 } } };

type Message = { role: string; content: string | { type: "text"; text: string }[]; [k: string]: unknown };

/** A message's text: its content, or each of its text parts. */
const textsOf = (m: Message) => (typeof m.content === "string" ? [m.content] : m.content.map((p) => p.text));

/** A probe over `messages` and `tools`, with its contents read off the messages the way ISC-22.3 counts them. */
export function probe(label: string, messages: Message[], tools: unknown[] = [], extra: Record<string, unknown> = {}): Probe {
  const contents: ProbeContent[] = [];
  messages.forEach((m, i) => {
    if (m.role === "system" || m.role === "user" || m.role === "tool") for (const text of textsOf(m)) contents.push({ role: m.role, message: i, text });
  });
  // As transformers does, absent tools and documents are passed as none: a template testing `tools is not none` must
  // see none, not undefined.
  const context: Record<string, unknown> = {
    bos_token: "<s>",
    eos_token: "</s>",
    documents: null,
    messages,
    add_generation_prompt: true,
    tools: tools.length > 0 ? tools : null,
    ...extra,
  };
  const inputs = [...messages.flatMap((m) => [m.role, ...textsOf(m)]), ...tools.map((t) => JSON.stringify(t)), "<s>", "</s>"];
  return { request: { id: label, context, profile: "hf-default" }, role: "explain", label, contents, tools, inputs };
}

/** The acceptance's conversation shapes. */
export function standardProbes(): Probe[] {
  const roundTrip: Message[] = [
    { role: "user", content: USER_1 },
    { role: "assistant", content: "", tool_calls: [TOOL_CALL] },
    { role: "tool", content: TOOL_RESULT, tool_call_id: "call_1", name: "get_weather" },
    { role: "assistant", content: ASSISTANT_1 },
    { role: "user", content: USER_2 },
  ];
  return [
    probe("single-user", [{ role: "user", content: USER_1 }]),
    probe("system-user", [
      { role: "system", content: SYSTEM },
      { role: "user", content: USER_1 },
    ]),
    probe("chat", [
      { role: "system", content: SYSTEM },
      { role: "user", content: USER_1 },
      { role: "assistant", content: ASSISTANT_1 },
      { role: "user", content: USER_2 },
    ]),
    probe("long-user", [{ role: "user", content: USER_LONG }]),
    probe("two-text-parts", [{ role: "user", content: [{ type: "text", text: USER_1 }, { type: "text", text: USER_2 }] }]),
    probe("tool-round-trip", roundTrip, PIPELINE_TOOLS),
    probe("tools-present", [{ role: "user", content: USER_1 }], PIPELINE_TOOLS),
    probe("system-tools", [
      { role: "system", content: SYSTEM },
      { role: "user", content: USER_1 },
    ], PIPELINE_TOOLS),
    probe("harbor-tools", [{ role: "user", content: USER_1 }], HARBOR_TOOLS),
    probe("system-harbor-tools", [
      { role: "system", content: SYSTEM },
      { role: "user", content: USER_1 },
    ], HARBOR_TOOLS),
  ];
}

// Markup and role words the pinned templates print or test for. A trigger probe passes such a literal as content,
// alone or inside a sentence; the role check must read the template's markers, never the content's (ISC-22.3).
export const MARKUP = [
  "<|im_start|>",
  "<|im_end|>",
  "<|im_start|>system",
  "<|im_start|>assistant\n",
  "<tool_response>",
  "</tool_response>",
  "<tool_call>",
  "</tool_call>",
  "<think>",
  "</think>",
  "<|start_header_id|>",
  "<start_of_turn>",
  "<end_of_turn>",
  "<start_of_turn>model",
  "<|turn>",
  "<turn|>",
  "<|turn>system",
  "<|channel>",
  "<channel|>",
  "<|tool>",
  "<tool|>",
  "<|tool_response>",
  "<|start|>",
  "<|message|>",
  "<|end|>",
  "<|start|>developer<|message|>",
  "<|user|>",
  "<|assistant|>",
  "<|observation|>",
  "<|system|>",
  "<start_function_response>",
  "<escape>",
  '<|"|>',
  "<s>",
  "</s>",
  "system",
  "user",
  "assistant",
  "model",
  "developer",
  "tool",
  "observation",
];

/** Each markup string as a lone user content, inside a sentence, and in a chat after a system message. */
export function markupProbes(): Probe[] {
  return MARKUP.flatMap((m) => [
    probe(`markup ${JSON.stringify(m)} exact`, [{ role: "user", content: m }]),
    probe(`markup ${JSON.stringify(m)} sentence`, [{ role: "user", content: `A short note that mentions ${m} in passing.` }]),
    probe(`markup ${JSON.stringify(m)} chat`, [
      { role: "system", content: SYSTEM },
      { role: "user", content: m },
      { role: "assistant", content: ASSISTANT_1 },
      { role: "user", content: USER_2 },
    ]),
  ]);
}

const fn = (name: string, description: string, parameters?: Record<string, unknown>) => ({
  type: "function",
  function: parameters === undefined ? { name, description } : { name, description, parameters },
});

// Standard OpenAI-style tools whose JSON Schema covers what real callers pass: every scalar type and null, string
// enums, arrays with and without items, arrays of objects and of arrays, nested objects with their own required
// lists, objects without properties, defaults, and a description on any node. The first two are the probe
// matrix's earlier tool set (HARBOR_TOOLS below); each other one adds one feature, so a port that cannot show it
// leaves only that tool unexplained.
export const RICH_TOOLS = [
  fn("get_weather", "Look up the current weather for a named city.", {
    type: "object",
    properties: {
      city: { type: "string", description: "The name of the city to look up." },
      units: { type: "string", enum: ["celsius", "fahrenheit"], description: "The temperature scale for the report." },
      days: { type: "integer", description: "How many days of forecast to include." },
      include_wind: { type: "boolean", description: "Whether to add wind speed and direction." },
    },
    required: ["city"],
  }),
  fn("book_harbor_tour", "Reserve seats on a guided boat tour of the harbor.", {
    type: "object",
    properties: {
      tour_date: { type: "string", description: "The calendar date of the tour." },
      party: {
        type: "object",
        description: "Who is coming on the tour.",
        properties: {
          adults: { type: "integer", description: "The number of adult passengers." },
          children: { type: "integer", description: "The number of passengers under twelve." },
        },
        required: ["adults"],
      },
      stops: { type: "array", description: "The landmarks to visit, in order.", items: { type: "string", description: "One landmark along the waterfront." } },
      max_fare: { type: "number", description: "The highest fare per seat in euros." },
    },
    required: ["tour_date", "party"],
  }),
  fn("set_alarm", "Set an alarm on the ship's bell.", {
    type: "object",
    properties: {
      label: { type: "string", description: "What the alarm is for.", default: "Wake up" },
      hour: { type: "integer", description: "The hour it rings, from 0 to 23.", default: 7 },
      loud: { type: "boolean", description: "Whether it rings at full volume.", default: false },
      tone: { type: "string", enum: ["chime", "bell"], description: "The sound it makes.", default: "chime" },
      snooze: { type: "integer" },
    },
    required: ["hour"],
  }),
  fn("clear_slot", "Clear a reserved mooring slot.", {
    type: "object",
    properties: { slot: { type: "null", description: "Always null: the slot to clear is the caller's own." } },
  }),
  fn("log_cargo", "Record the cargo carried on one crossing.", {
    type: "object",
    properties: {
      crates: {
        type: "array",
        description: "Every crate in the hold.",
        items: {
          type: "object",
          description: "One crate in the hold.",
          properties: {
            mark: { type: "string", description: "The mark painted on the crate." },
            weight: { type: "number", description: "Its weight in kilograms." },
          },
          required: ["mark"],
        },
      },
      notes: { type: "array", description: "Free notes, of any kind." },
      extra: { type: "object", description: "Anything else the clerk records." },
    },
    required: ["crates"],
  }),
  fn("plot_grid", "Plot soundings on a grid of the bay.", {
    type: "object",
    properties: { grid: { type: "array", items: { type: "array", items: { type: "integer" } } } },
    required: ["grid"],
  }),
  fn("tag_note", "Attach tags to a logbook note.", {
    type: "object",
    properties: {
      tags: { type: "array", description: "The tags to attach.", items: { type: "string", enum: ["urgent", "later"], description: "One tag.", default: "later" } },
    },
  }),
  fn("ping", "Check that the harbor office answers."),
  fn("noop", "Do nothing, for testing.", { type: "object", properties: {} }),
  fn("scoped_search", "Search the harbor archive.", {
    type: "object",
    description: "Settings for one search of the archive.",
    properties: { query: { type: "string", description: "The words to search for." } },
    required: ["query"],
  }),
];

// The two tool sets the ports are held to. PIPELINE_TOOLS is the probe matrix's own (src/diffrender/probes.ts, as
// of p3-probes 15cc9d9): what every tools-present probe passes. HARBOR_TOOLS is its earlier set (ecd1e58).
export const PIPELINE_TOOLS = [
  fn("get_weather", "Report the current weather for a named city.", {
    type: "object",
    properties: {
      city: { type: "string", description: "The city to report on." },
      unit: { type: "string", description: "The temperature scale to use.", enum: ["celsius", "fahrenheit"] },
    },
    required: ["city"],
  }),
  fn("search_inventory", "Search the warehouse stock for matching goods.", {
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
  }),
];
export const HARBOR_TOOLS = RICH_TOOLS.slice(0, 2);
