import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkContent, markerRole } from "../../src/diffrender/integrity.ts";
import { loadTransforms } from "../../src/registry/index.ts";
import { createRenderer, sandboxAvailable } from "../../src/sandbox/index.ts";
import type { IntegrityIssue, Probe } from "../../src/types.ts";
import { ASSISTANT_1, probe, standardProbes, SYSTEM, USER_1, USER_2, USER_LONG } from "./fixtures/integrity/probes.ts";

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
