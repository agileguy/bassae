import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkContent, markerRole } from "../../src/diffrender/integrity.ts";
import { loadTransforms } from "../../src/registry/index.ts";
import { createRenderer, sandboxAvailable } from "../../src/sandbox/index.ts";
import type { IntegrityIssue, Probe } from "../../src/types.ts";
import { ASSISTANT_1, probe, standardProbes, SYSTEM, TOOL_RESULT, USER_1, USER_2, USER_LONG, WEATHER_TOOL } from "./fixtures/integrity/probes.ts";

const transforms = loadTransforms();
const live = (await sandboxAvailable()).available;
const renderer = createRenderer();
const FIXTURES = join(import.meta.dir, "fixtures", "integrity");

const chat = probe("chat", [
  { role: "system", content: SYSTEM },
  { role: "user", content: USER_1 },
  { role: "assistant", content: "Mild." },
  { role: "user", content: USER_2 },
]);
const chatml = (turns: [string, string][]) => turns.map(([role, text]) => `<|im_start|>${role}\n${text}<|im_end|>\n`).join("");
const intact = chatml([
  ["system", SYSTEM],
  ["user", USER_1],
  ["assistant", "Mild."],
  ["user", USER_2],
]);
const issues = (p: Probe, output: string) => checkContent(p, output, transforms);
const indexes = (found: IntegrityIssue[]) => found.map((i) => [i.ruleId, i.index]);

// A system and user turn, then a tool round trip that ends on the tool result: contents 0, 1 and 2.
const toolRound = probe(
  "tool round",
  [
    { role: "system", content: SYSTEM },
    { role: "user", content: USER_1 },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: { city: "Porto" } } }] },
    { role: "tool", content: TOOL_RESULT, tool_call_id: "call_1", name: "get_weather" },
  ],
  [WEATHER_TOOL],
);
// toolRound in ChatML up to its tool result, and the result as Qwen2.5 prints it: in a user turn, inside <tool_response>.
const head = chatml([["system", SYSTEM], ["user", USER_1], ["assistant", ""]]);
const QWEN_TOOL = `<|im_start|>user\n<tool_response>\n${TOOL_RESULT}\n</tool_response><|im_end|>\n`;
// The turn tokens each family's model declares.
const CHATML = new Set(["<|im_start|>", "<|im_end|>"]);
const GPT_OSS = new Set(["<|start|>", "<|end|>", "<|message|>", "<|channel|>", "<|call|>"]);
const GLM = new Set(["[gMASK]", "<sop>", "<|system|>", "<|user|>", "<|assistant|>", "<|observation|>"]);
const NONE = new Set<string>();
const declared = (p: Probe, output: string, tokens: ReadonlySet<string>) => checkContent(p, output, transforms, tokens);

describe("markerRole", () => {
  test("names the role of the last role marker in a range", () => {
    expect(markerRole("<|im_start|>system\nx<|im_end|>\n<|im_start|>user\n", 0, 48)).toBe("user");
    expect(markerRole("<|im_start|>system\n", 0, 19)).toBe("system");
    expect(markerRole("plain text", 0, 10)).toBeUndefined();
  });

  test("reads the markers and aliases the registry templates use", () => {
    expect(markerRole("<|user|>\n", 0, 9)).toBe("user"); // GLM-4.5
    expect(markerRole("<start_of_turn>model\n", 0, 21)).toBe("assistant"); // Gemma
    expect(markerRole("<|start|>developer<|message|># Instructions\n\n", 0, 45)).toBe("system"); // gpt-oss
    expect(markerRole("<start_of_turn>developer\n", 0, 25)).toBe("system"); // functiongemma
    expect(markerRole("<|im_start|>user\n<tool_response>\n", 0, 33)).toBe("tool"); // Qwen
    expect(markerRole("<|observation|>\n<tool_response>\n", 0, 32)).toBe("tool"); // GLM-4.5
    expect(markerRole("<|start|>functions.get_weather to=assistant<|channel|>commentary<|message|>", 0, 75)).toBe("tool"); // gpt-oss
    expect(markerRole("<start_function_response>response:get_weather{value:<escape>", 0, 60)).toBe("tool"); // functiongemma
    expect(markerRole("<|tool_response>response:get_weather{value:<|\"|>", 0, 47)).toBe("tool"); // gemma-4
  });

  test("a role word in prose, a closing tag or a JSON value is not a marker", () => {
    expect(markerRole("<|im_start|>system\nThe user says: ", 0, 33)).toBe("system");
    expect(markerRole("<|im_start|>assistant\nok</tool_response>", 0, 40)).toBe("assistant");
    expect(markerRole('<|im_start|>system\n{"role": "user"}', 0, 35)).toBe("system");
    expect(markerRole("<|im_start|>system\n<tool_call>{}</tool_call><tools>", 0, 50)).toBe("system");
    // gemma-4 closes a block with <name|>: a closer, like </tool_response>.
    const whole = (out: string) => markerRole(out, 0, out.length);
    expect(whole("<|turn>system\nx<tool|>")).toBe("system");
    expect(whole("<|turn>system\nx<tool_response|>")).toBe("system");
    expect(whole("<|turn>system\n<|tool>declaration:f{}<tool|>")).toBe("tool");
    expect(whole("<|user|>\n")).toBe("user");
  });

  test("only looks inside the range", () => {
    const out = "<|im_start|>user\nhello";
    expect(markerRole(out, 17, 22)).toBeUndefined();
  });
});

describe("checkContent", () => {
  test("content that arrives verbatim, in order, under its own markers has no issue", () => {
    expect(issues(chat, intact)).toEqual([]);
  });

  test("a probe with no contents has no issue", () => {
    expect(issues(probe("empty", []), "")).toEqual([]);
  });

  test("a dropped content is an issue", () => {
    const out = chatml([
      ["user", USER_1],
      ["assistant", "Mild."],
      ["user", USER_2],
    ]);
    const found = issues(chat, out);
    expect(indexes(found)).toEqual([["content_integrity", 0]]);
    expect(found[0]!.message).toMatch(/system/);
  });

  test("a truncated content is an issue that says how much arrived", () => {
    const p = probe("long", [{ role: "user", content: USER_LONG }]);
    const found = issues(p, chatml([["user", USER_LONG.slice(0, 100)]]));
    expect(indexes(found)).toEqual([["content_integrity", 0]]);
    expect(found[0]!.message).toMatch(/100/);
  });

  test("a reordered content is an issue", () => {
    const out = chatml([
      ["system", SYSTEM],
      ["user", USER_2],
      ["assistant", "Mild."],
      ["user", USER_1],
    ]);
    const found = issues(chat, out);
    expect(found.map((i) => i.index)).toContain(2);
    expect(found.find((i) => i.index === 2)!.message).toMatch(/order/);
  });

  test("a rewritten content is an issue", () => {
    const out = chatml([
      ["system", SYSTEM],
      ["user", USER_1.replace("Porto", "Lisbon")],
      ["assistant", "Mild."],
      ["user", USER_2],
    ]);
    expect(indexes(issues(chat, out))).toEqual([["content_integrity", 1]]);
  });

  test("user content under a system marker is an issue, and so is system content under a user marker", () => {
    const userUnderSystem = chatml([
      ["system", SYSTEM],
      ["system", USER_1],
      ["assistant", "Mild."],
      ["user", USER_2],
    ]);
    const found = issues(chat, userUnderSystem);
    expect(indexes(found)).toEqual([["content_integrity", 1]]);
    expect(found[0]!.message).toMatch(/system/);
    const systemUnderUser = chatml([
      ["user", SYSTEM],
      ["user", USER_1],
      ["assistant", "Mild."],
      ["user", USER_2],
    ]);
    expect(indexes(issues(chat, systemUnderUser))).toEqual([["content_integrity", 0]]);
  });

  test("user content echoed under a system marker before its own turn is an issue", () => {
    const out = `<|im_start|>system\n${SYSTEM}\nThe user asked: ${USER_1}<|im_end|>\n` + chatml([["user", USER_1], ["assistant", "Mild."], ["user", USER_2]]);
    expect(issues(chat, out).map((i) => i.index)).toContain(1);
  });

  test("tool content must sit under a tool marker or alias", () => {
    const p = probe("tool", [
      { role: "user", content: USER_1 },
      { role: "tool", content: "Light rain in the morning." },
    ]);
    expect(issues(p, chatml([["user", USER_1]]) + "<|im_start|>user\n<tool_response>\nLight rain in the morning.\n</tool_response>")).toEqual([]);
    expect(issues(p, chatml([["user", USER_1]]) + "<|im_start|>user\nLight rain in the morning.")).toHaveLength(1);
  });

  test("trimmed content passes only while trim-content is on the allowlist", () => {
    const p = probe("padded", [{ role: "user", content: `  ${USER_1}\n` }]);
    const out = chatml([["user", USER_1]]);
    expect(checkContent(p, out, transforms)).toEqual([]);
    expect(checkContent(p, out, transforms.filter((t) => t.id !== "trim-content"))).toHaveLength(1);
  });

  test("a system content folded into the first user turn passes only while that fold is on the allowlist", () => {
    const p = probe("fold", [
      { role: "system", content: SYSTEM },
      { role: "user", content: USER_1 },
    ]);
    const out = `<s><start_of_turn>user\n${SYSTEM}\n\n${USER_1}<end_of_turn>\n<start_of_turn>model\n`;
    expect(checkContent(p, out, transforms)).toEqual([]);
    // Without the fold the system content sits under the user marker; the user content after it is under its own.
    expect(indexes(checkContent(p, out, []))).toEqual([["content_integrity", 0]]);
  });

  test("two text parts of one message, printed side by side, both sit under that message's marker", () => {
    const p = probe("parts", [{ role: "user", content: [{ type: "text", text: USER_1 }, { type: "text", text: USER_2 }] }]);
    expect(issues(p, chatml([["user", `${USER_1}${USER_2}`]]))).toEqual([]);
    expect(issues(p, chatml([["user", `${USER_1}\n\n${USER_2}`]]))).toEqual([]);
  });

  test("a content of another role printed straight after a user content, with no marker between, is an issue", () => {
    const p = probe("no marker", [
      { role: "user", content: USER_1 },
      { role: "system", content: SYSTEM },
    ]);
    expect(indexes(issues(p, chatml([["user", `${USER_1}\n${SYSTEM}`]])))).toEqual([["content_integrity", 1]]);
  });

  test("content that is only whitespace has nothing to locate and is not checked", () => {
    const p = probe("blank", [
      { role: "user", content: "   " },
      { role: "user", content: USER_1 },
    ]);
    expect(issues(p, chatml([["user", ""], ["user", USER_1]]))).toEqual([]);
  });
});

describe("turns", () => {
  test("a tool content in a system turn is an issue, whatever tag wraps it", () => {
    const wraps = [(t: string) => t, (t: string) => `<tool>${t}</tool>`, (t: string) => `<tool_response>\n${t}\n</tool_response>`, (t: string) => `<|observation|>\n${t}`];
    for (const wrap of wraps) {
      for (const tokens of [CHATML, NONE]) {
        const found = declared(toolRound, `${head}<|im_start|>system\n${wrap(TOOL_RESULT)}<|im_end|>\n`, tokens);
        expect(indexes(found)).toEqual([["content_integrity", 2]]);
        expect(found[0]!.message).toMatch(/in a system turn, more privileged than its own tool role/);
      }
    }
  });

  test("an inner tag narrows a user or model turn to tool, and narrows a turn to nothing else", () => {
    expect(declared(toolRound, head + QWEN_TOOL, CHATML)).toEqual([]);
    const gemma4 = `<|turn>system\n${SYSTEM}<turn|>\n<|turn>user\n${USER_1}<turn|>\n<|turn>model\n<|tool_call>call:get_weather{}<tool_call|><|tool_response>response:get_weather{value:<|"|>${TOOL_RESULT}<|"|>}<tool_response|>`;
    expect(declared(toolRound, gemma4, new Set(["<|turn>", "<turn|>", "<|tool_call>", "<tool_call|>", "<|tool_response>", "<tool_response|>"]))).toEqual([]);
    const functiongemma = `<start_of_turn>developer\n${SYSTEM}<end_of_turn>\n<start_of_turn>user\n${USER_1}<end_of_turn>\n<start_of_turn>model\n<start_function_call>call:get_weather{}<end_function_call><start_function_response>response:get_weather{value:<escape>${TOOL_RESULT}<escape>}<end_function_response>`;
    expect(declared(toolRound, functiongemma, new Set(["<start_of_turn>", "<end_of_turn>", "<start_function_response>"]))).toEqual([]);
    // A user tag inside a model turn does not make its text a user's.
    const p = probe("user tag", [{ role: "user", content: USER_1 }]);
    expect(indexes(declared(p, `<|im_start|>assistant\n<user>${USER_1}<|im_end|>`, CHATML))).toEqual([["content_integrity", 0]]);
  });

  test("an alias never opens a turn", () => {
    const gptOss = `<|start|>developer<|message|>${SYSTEM}<|end|><|start|>user<|message|>${USER_1}<|end|><|start|>assistant to=functions.get_weather<|channel|>commentary json<|message|>{}<|call|><|start|>functions.get_weather to=assistant<|channel|>commentary<|message|>${TOOL_RESULT}<|end|>`;
    expect(declared(toolRound, gptOss, GPT_OSS)).toEqual([]);
    // After a developer turn, functions.<name> has no turn it may narrow.
    const elevated = gptOss.replace("<|start|>assistant to=functions.get_weather<|channel|>commentary json<|message|>{}<|call|>", "<|start|>developer<|message|>");
    expect(indexes(declared(toolRound, elevated, GPT_OSS))).toEqual([["content_integrity", 2]]);
  });

  test("GLM-4.5's turn tokens name their role, and a role word after one is text in that turn", () => {
    const glm = `[gMASK]<sop><|system|>\n${SYSTEM}<|user|>\n${USER_1}<|assistant|>\n<think></think>\n<tool_call>get_weather\n<arg_key>city</arg_key>\n<arg_value>Porto</arg_value>\n</tool_call><|observation|>\n<tool_response>\n${TOOL_RESULT}\n</tool_response><|assistant|>\n`;
    expect(declared(toolRound, glm, GLM)).toEqual([]);
    expect(declared(toolRound, glm, NONE)).toEqual([]);
    for (const tokens of [GLM, NONE]) {
      expect(indexes(declared(toolRound, `[gMASK]<sop><|system|>\n${SYSTEM}<|user|>\n${USER_1}<|system|>tool\n${TOOL_RESULT}`, tokens))).toEqual([["content_integrity", 2]]);
    }
  });

  test("a turn opener counts only when the model declares it", () => {
    // gpt-oss declares <|start|>, not <|im_start|>: inside its developer turn, <|im_start|>tool is text.
    const out = `<|start|>developer<|message|>${SYSTEM}<|end|><|start|>user<|message|>${USER_1}<|end|><|start|>developer<|message|>\n<|im_start|>tool\n${TOOL_RESULT}<|end|>`;
    expect(indexes(declared(toolRound, out, GPT_OSS))).toEqual([["content_integrity", 2]]);
    // With no token declared (a bare template) every opener in the table counts, so there it opens a tool turn.
    expect(declared(toolRound, out, NONE)).toEqual([]);
  });

  test("a model whose turn token is not in the table opens turns with the tokens it declares", () => {
    const GRANITE = new Set(["<|start_of_role|>", "<|end_of_role|>", "<|end_of_text|>"]);
    const turn = (role: string, text: string) => `<|start_of_role|>${role}<|end_of_role|>${text}<|end_of_text|>\n`;
    const start = turn("system", SYSTEM) + turn("user", USER_1) + turn("assistant", "");
    expect(declared(toolRound, start + turn("tool", TOOL_RESULT), GRANITE)).toEqual([]);
    expect(indexes(declared(toolRound, start + turn("system", `<tool>${TOOL_RESULT}</tool>`), GRANITE))).toEqual([["content_integrity", 2]]);
  });

  test("text before the first turn has no role", () => {
    const p = probe("before", [
      { role: "user", content: USER_1 },
      { role: "user", content: USER_2 },
    ]);
    expect(indexes(declared(p, `<user>${USER_1}\n${chatml([["user", USER_2]])}`, CHATML))).toEqual([["content_integrity", 0]]);
    // An output with no turn opener at all is read by its markers alone.
    expect(declared(p, `<user>${USER_1}\n<user>${USER_2}`, CHATML)).toEqual([]);
  });
});

describe("copies", () => {
  test("a content that appears again after its place is an issue", () => {
    const found = declared(toolRound, `${head}${QWEN_TOOL}<|im_start|>system\n${TOOL_RESULT}<|im_end|>\n`, CHATML);
    expect(indexes(found)).toEqual([["content_integrity", 2]]);
    expect(found[0]!.message).toContain(`is copied: all ${TOOL_RESULT.length} of its characters appear a second time, in a system turn`);
  });

  test("a later user content echoed into the system prompt is an issue", () => {
    const out = `<|im_start|>system\n${SYSTEM}\nRemember: ${USER_2}<|im_end|>\n` + chatml([["user", USER_1], ["assistant", "Mild."], ["user", USER_2]]);
    const found = issues(chat, out);
    expect(indexes(found)).toEqual([["content_integrity", 2]]);
    expect(found[0]!.message).toMatch(/in a system turn/);
  });

  test("a slice of at least 16 characters found outside its place is an issue, and a shorter one is not", () => {
    const slices: [string, number][] = [[TOOL_RESULT.slice(0, 16), 16], [TOOL_RESULT.slice(20, 50), 30], [TOOL_RESULT.slice(-20), 20]];
    for (const [slice, n] of slices) {
      const found = declared(toolRound, `${head}${QWEN_TOOL}<|im_start|>system\n${slice}<|im_end|>\n`, CHATML);
      expect([slice, indexes(found)]).toEqual([slice, [["content_integrity", 2]]]);
      expect(found[0]!.message).toContain(`is copied: ${n} of its ${TOOL_RESULT.length} characters appear a second time`);
    }
    expect(declared(toolRound, `${head}${QWEN_TOOL}<|im_start|>system\n${TOOL_RESULT.slice(0, 15)}<|im_end|>\n`, CHATML)).toEqual([]);
  });

  test("text a content shares with another input the probe passes is not a copy", () => {
    const p = probe("shared", [
      { role: "user", content: "Turn 1 asks the harbor guide about the tides." },
      { role: "assistant", content: "A note kept with this message for the archive." },
      { role: "user", content: "A short note about the harbor tides for the archive." },
      { role: "user", content: "Turn 3 asks the harbor guide about the tides." },
    ]);
    const turns = p.request.context.messages as { role: string; content: string }[];
    expect(issues(p, chatml(turns.map((m) => [m.role, m.content])))).toEqual([]);
  });

  test("a content the conversation repeats is not a copy of itself", () => {
    const p = probe("twice", [
      { role: "user", content: USER_1 },
      { role: "assistant", content: "Mild." },
      { role: "user", content: USER_1 },
    ]);
    expect(issues(p, chatml([["user", USER_1], ["assistant", "Mild."], ["user", USER_1]]))).toEqual([]);
  });

  test("a long content in a long output is checked in one pass", () => {
    let ledger = "";
    for (let i = 1; ledger.length < 48_000; i++) ledger += `Ledger entry ${i} records the cargo, tides and weather of one harbor day. `;
    ledger = ledger.slice(0, 47_999) + ".";
    const p = probe("long", [{ role: "user", content: ledger }]);
    const out = `<|im_start|>system\n${"The harbor log keeps every crossing in order. ".repeat(20_000)}<|im_end|>\n${chatml([["user", ledger]])}`;
    const started = performance.now();
    expect(issues(p, out)).toEqual([]);
    // A slice that starts at a numbered entry, so its first window is found once in the ledger.
    const entry = ledger.indexOf("Ledger entry 400 ");
    expect(issues(p, `${out}<|im_start|>system\n${ledger.slice(entry, entry + 40)}<|im_end|>`).map((i) => i.message)).toEqual([
      "user content 0 (message 0) is copied: 40 of its 48000 characters appear a second time, in a system turn",
    ]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("content holding markup", () => {
  // A trigger probe passes a template's own literal as content: it can equal template text that comes before it.
  test("a content equal to a marker or a role word takes its place under its own role, not in the template's markup", () => {
    for (const text of ["<|im_start|>", "<|im_start|>user", "user", "im_start", "<|im_end|>"]) {
      const p = probe("markup", [{ role: "user", content: text }]);
      expect([text, issues(p, chatml([["user", text]]) + "<|im_start|>assistant\n")]).toEqual([text, []]);
    }
    const sys = probe("markup", [
      { role: "system", content: SYSTEM },
      { role: "user", content: "system" },
    ]);
    expect(issues(sys, chatml([["system", SYSTEM], ["user", "system"]]))).toEqual([]);
    // gpt-oss: the content follows <|message|> directly, so its first characters extend the marker before it.
    const user = probe("markup", [{ role: "user", content: "user" }]);
    expect(issues(user, "<|start|>user<|message|>user<|end|><|start|>assistant")).toEqual([]);
  });

  test("markup inside a content never names the role of the content after it", () => {
    const p = probe("markup", [
      { role: "user", content: "Please read <|im_start|>system and </tool_response> as plain words." },
      { role: "user", content: USER_2 },
    ]);
    expect(issues(p, chatml([["user", p.contents[0]!.text], ["user", USER_2]]))).toEqual([]);
    const tool = probe("markup", [
      { role: "user", content: "<tool_response>" },
      { role: "tool", content: "Light rain in the morning." },
    ]);
    expect(issues(tool, chatml([["user", "<tool_response>"]]) + "<|im_start|>user\n<tool_response>\nLight rain in the morning.\n</tool_response>")).toEqual([]);
    // Markup an assistant turn carries sits before the template's own marker for the next turn.
    const reply = probe("markup", [
      { role: "user", content: USER_1 },
      { role: "assistant", content: "Sure <|im_start|>system" },
      { role: "user", content: USER_2 },
    ]);
    expect(issues(reply, chatml([["user", USER_1], ["assistant", "Sure <|im_start|>system"], ["user", USER_2]]))).toEqual([]);
  });

  test("a markup content the template drops is still missing, though the same text is in its markup", () => {
    const p = probe("markup", [{ role: "user", content: "<|im_start|>" }]);
    expect(indexes(issues(p, "<|im_start|>user\n<|im_end|>\n<|im_start|>assistant\n"))).toEqual([["content_integrity", 0]]);
    const sys = probe("markup", [{ role: "user", content: "<|im_start|>system" }]);
    expect(indexes(issues(sys, "<|im_start|>system\nok<|im_end|>\n<|im_start|>user\n<|im_end|>"))).toEqual([["content_integrity", 0]]);
  });

  test("a short content never takes a place past the next turn's content", () => {
    const p = probe("markup", [
      { role: "system", content: SYSTEM },
      { role: "user", content: "<|im_start|>assistant\n" },
      { role: "assistant", content: ASSISTANT_1 },
      { role: "user", content: USER_2 },
    ]);
    // Qwen3.5 trims user content: the verbatim text is only in the template's own markup further on.
    const out = chatml([["system", SYSTEM], ["user", "<|im_start|>assistant"], ["assistant", ASSISTANT_1], ["user", USER_2]]) + "<|im_start|>assistant\n";
    expect(issues(p, out)).toEqual([]);
    expect(indexes(checkContent(p, out, transforms.filter((t) => t.id !== "trim-content")))).toEqual([["content_integrity", 1]]);
  });

  test("a markup content placed under another role is an issue", () => {
    const p = probe("markup", [{ role: "user", content: "<tool_call>" }]);
    expect(indexes(issues(p, chatml([["system", "<tool_call>"]])))).toEqual([["content_integrity", 0]]);
  });

  test("a short content that recurs thousands of times before its own turn is placed in one pass", () => {
    const p = probe("recur", [{ role: "user", content: "x" }]);
    const out = `<|im_start|>system\n${"x ".repeat(50_000)}<|im_end|>\n<|im_start|>user\nx<|im_end|>`;
    const started = performance.now();
    expect(issues(p, out)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
    const turns: [string, string][] = Array.from({ length: 400 }, (_, i) => ["user", i % 2 ? "x" : "user"]);
    expect(issues(probe("many", turns.map(([role, content]) => ({ role, content }))), chatml(turns))).toEqual([]);
  });
});

describe("malicious fixtures, rendered by the sandboxed renderer", () => {
  async function render(fixture: string, p: Probe): Promise<string> {
    const template = await Bun.file(join(FIXTURES, fixture)).text();
    const [r] = await renderer.renderBatch(template, [p.request]);
    if (!r!.ok) throw new Error(`${fixture}: ${r!.failure}: ${r!.message}`);
    return r!.output;
  }

  test.if(live)("the clean base gives no content issue on any standard probe", async () => {
    for (const p of standardProbes()) expect([p.label, issues(p, await render("chatml-clean.jinja", p))]).toEqual([p.label, []]);
  });

  test.if(live)("dropping the system content", async () => {
    expect(indexes(issues(chat, await render("drop-system.jinja", chat)))).toEqual([["content_integrity", 0]]);
  });

  test.if(live)("truncating user content to 100 characters", async () => {
    const p = probe("long", [{ role: "user", content: USER_LONG }]);
    expect(indexes(issues(p, await render("truncate-user.jinja", p)))).toEqual([["content_integrity", 0]]);
  });

  test.if(live)("reordering two user turns", async () => {
    const found = issues(chat, await render("reorder-users.jinja", chat));
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((i) => i.ruleId === "content_integrity" && (i.index === 1 || i.index === 2))).toBe(true);
  });

  test.if(live)("rewriting content with |replace", async () => {
    expect(indexes(issues(chat, await render("replace-content.jinja", chat)))).toEqual([["content_integrity", 1]]);
  });

  test.if(live)("rendering user content under a system marker", async () => {
    expect(indexes(issues(chat, await render("user-under-system.jinja", chat)))).toEqual([
      ["content_integrity", 1],
      ["content_integrity", 2],
    ]);
  });
});
