// classifyTest on its own (ISC-18, ISC-18.1): each class a condition can have,
// with a small environment that evaluates names against the input schema the
// way the extraction does, so a failure here is the classifier's and not the
// interpreter's. The end-to-end probes are in vocabulary.test.ts.

import { expect, test } from "bun:test";
import { parseTemplate } from "../../src/parse/parse.ts";
import type { Node } from "../../src/parse/support.ts";
import {
  classifyTest,
  clsOf,
  countArith,
  countField,
  elementField,
  keyField,
  lengthOf,
  mapFields,
  memberField,
  memberPath,
  NO_FACTS,
  rootField,
  stronger,
  vocabClass,
  type TestClass,
  type TestEnv,
  type Val,
} from "../../src/rules/triggers.ts";

const SPAN = { start: 0, end: 1, line: 1, col: 1 };
const CONST = (k: string | number | boolean | null): Val => ({ lits: [], data: "none", truth: "none", konst: k });

// A value for each node: literals are constants, names are schema roots unless
// bound, and members, filters, methods and arithmetic follow the schema.
function envWith(bound: Record<string, Val> = {}): TestEnv {
  const value = (n: Node): Val => {
    switch (n?.type) {
      case "StringLiteral":
      case "IntegerLiteral":
      case "FloatLiteral":
        return CONST(n.value as string | number);
      case "Identifier": {
        const name = String(n.value);
        if (name === "true" || name === "false") return CONST(name === "true");
        if (name === "none") return CONST(null);
        if (Object.hasOwn(bound, name)) return bound[name]!;
        const f = rootField(name);
        return { lits: [], data: f.cls, truth: "presence", fields: [f] };
      }
      case "MemberExpression": {
        const o = value(n.object as Node);
        const p = n.property as Node;
        if (p?.type === "SliceExpression") return o;
        const key = !n.computed ? String(p.value) : p.type === "StringLiteral" ? String(p.value) : undefined;
        const fields = o.fields ? mapFields(o.fields, (f) => memberField(f, key)) : undefined;
        return { lits: [], data: fields ? clsOf(fields) : o.data, truth: fields ? "presence" : o.truth, gate: o.gate, fields };
      }
      case "FilterExpression": {
        const o = value(n.operand as Node);
        const f = n.filter as Node;
        const name = String(f.type === "Identifier" ? f.value : (f.callee as Node).value);
        if (name === "length" || name === "count" || name === "wordcount") return lengthOf(o);
        if (name === "tojson" || name === "string") return { lits: [], data: o.fields ? clsOf(o.fields) : o.data, truth: o.truth, gate: o.gate };
        return { lits: [], data: o.data, truth: o.truth, gate: o.gate };
      }
      case "CallExpression": {
        const callee = n.callee as Node;
        const r = value(callee.object as Node);
        return { lits: [], data: r.data, truth: r.data, gate: r.gate };
      }
      case "BinaryExpression": {
        const l = value(n.left as Node);
        const r = value(n.right as Node);
        const op = String((n.operator as { value: string }).value);
        return countArith(l, r, op) ?? { lits: [], data: stronger(l.data, r.data), truth: stronger(l.truth, r.truth), gate: l.gate ?? r.gate };
      }
      case "ArrayLiteral":
      case "TupleLiteral": {
        const els = ((n.value as Node[]) ?? []).map(value);
        return { lits: [], data: "none", truth: "none", konstList: els.every((e) => typeof e.konst === "string") ? els.map((e) => e.konst as string) : undefined };
      }
      default:
        return CONST(null);
    }
  };
  return { value: (n) => value(n) };
}

function classify(expr: string, bound?: Record<string, Val>): TestClass {
  const program = parseTemplate(`{% if ${expr} %}x{% endif %}`).program as Node | undefined;
  const test = ((program?.body as Node[] | undefined)?.[0]?.test as Node | undefined)!;
  expect({ expr, parsed: test !== undefined }).toEqual({ expr, parsed: true });
  return classifyTest(test, envWith(bound), NO_FACTS);
}

function expectAll(cls: TestClass, exprs: string[], bound?: Record<string, Val>): void {
  for (const e of exprs) expect({ e, cls: classify(e, bound) }).toEqual({ e, cls });
}

test("classifyTest: tests on template constants are none", () => {
  expectAll("none", ["'a' == 'a'", "1 < 2", "'x' in ['x', 'y']", "not true"]);
});

test("classifyTest: roles, definedness, truthiness and keys are presence", () => {
  expectAll("presence", ["message.role == 'user'", "message.role in ['user', 'system']", "message.name is defined", "message.id is none", "message.content", "not message.tool_call_id", "'tool_calls' in message", "loop.first"]);
});

test("classifyTest: a value test on content, names, ids and tool text is content", () => {
  expectAll("content", [
    "message.content == 'x'",
    "'x' in message.content",
    "message.name == 'sudo'",
    "message.id.startswith('trig')",
    "message.tool_call_id == 'x'",
    "tool.function.name == 'send_email'",
    "'bank' in tool.description",
    "tool_call.function.arguments.to == 'x'",
    "unknown_kwarg == 'x'",
  ]);
});

test("classifyTest: an equality between two id fields is presence; an id against a constant or another field is content", () => {
  expectAll("presence", ["tool_call.id == message.tool_call_id", "message.tool_call_id != tool_call.id", "message.id == tool_call.id"]);
  expectAll("content", ["message.id == 'x'", "message.tool_call_id == 'call_1'", "tool_call.id == message.content", "message.name == message.tool_call_id", "tool_call.id >= message.tool_call_id"]);
});

test("classifyTest: a field with a vocabulary is presence against it and content against anything else", () => {
  expectAll("presence", ["message.type == 'text'", "message.type|lower == 'IMAGE'", "message.type.upper() == 'IMAGE'", "message.type in ['image', 'video']", "'image' in message.type", "enable_thinking == false", "enable_thinking != none", "add_generation_prompt == 1", "reasoning_effort == 'high'", "tool_choice == 'auto'", "'python' in builtin_tools"]);
  expectAll("content", ["message.type == 'zz'", "message.type in ['image', 'zz']", "enable_thinking == 'xyzzy'", "reasoning_effort == 'xyzzy'", "tool_choice == 'send_email'", "'send_email' in builtin_tools", "message.type == message.role"]);
});

test("classifyTest: a vocabulary matches exactly, case and type included (review round 2, security N9)", () => {
  expectAll("presence", ["message.type|upper == 'IMAGE'", "enable_thinking == true", "enable_thinking|string == 'True'"]);
  expectAll("content", ["message.type == 'IMAGE'", "message.type == ' image'", "message.type|trim == 'IMAGE'", "reasoning_effort == 'High'", "enable_thinking == 'true'", "message.role == 'User'"]);
});

test("classifyTest: a role is presence against the role vocabulary or another role, content otherwise (review round 2, ruling c)", () => {
  expectAll("presence", ["message.role == 'tool'", "message.role != 'developer'", "message.role == loop.previtem.role"]);
  expectAll("content", ["message.role == 'sudo'", "message.role in ['user', 'sudo']", "message.role.startswith('u')", "message.role in 'useradmin'", "message.role == message.name"]);
});

test("classifyTest: any test on an undocumented kwarg or message field is content (review round 2, ruling d)", () => {
  expectAll("content", ["unknown_kwarg is defined", "unknown_kwarg", "not unknown_kwarg", "message.xyzzy is defined", "message.xyzzy"]);
  expectAll("presence", ["preserve_thinking is defined", "add_vision_id", "message.tool_responses", "message.reasoning_content is defined"]);
});

test("classifyTest: a count within 1 of a constant or another count is presence; further away it is content", () => {
  expectAll("presence", [
    "messages|length > 0",
    "messages|length == 1",
    "loop.index0 == 0",
    "loop.index > 1",
    "loop.revindex0 == 0",
    "loop.index0 == messages|length - 1",
    "loop.index0 + 1 < messages|length",
    "(loop.index0 % 2) == 0",
    "loop.index * -1 < 0",
    "loop.index0",
    "messages|length",
    "message.content|length > 0",
  ]);
  expectAll("content", [
    "messages|length > 20",
    "messages|length >= 2 + 1",
    "loop.length > 20",
    "loop.index > 40",
    "message.content|length > 300",
    "message.content|wordcount > 300",
    "messages|length - 40 > 0",
    "loop.index0 % 3 == 0",
    "loop.index * 3 > 7",
    "loop.index0 < messages|length - 40",
    "messages|length - 20",
    "(loop.index0 + 40) % 2 == 0",
  ]);
});

test("classifyTest: a count against a template value whose constant is unknown is a threshold", () => {
  expect(classify("loop.index0 > k", { k: CONST(1) })).toBe("presence");
  expect(classify("loop.index0 > k", { k: { lits: [], data: "none", truth: "none" } })).toBe("content");
});

test("classifyTest: the length of schema is not a count", () => {
  expectAll("presence", ["tool.parameters.required|length > 5", "tool.function.parameters.type|length > 1"]);
});

test("classifyTest: serializing conversation data reads every field of it", () => {
  expectAll("content", ["'x' in messages|tojson", "'x' in messages|string", "'x' in documents|tojson", "'x' in tools|tojson", "'x' in tool_calls|tojson"]);
  expectAll("presence", ["'object' in tool.parameters|tojson"]);
});

test("classifyTest: the gate that chose a value is part of every test on it", () => {
  const gated: Val = { lits: [], data: "none", truth: "none", konst: 0, gate: { test: "content", span: SPAN } };
  expectAll("content", ["k", "loop.index0 > k", "message.role == k", "message.type == k"], { k: gated });
});

test("lengthOf, countArith and vocabClass: counts carry their shift and threshold class", () => {
  const messages: Val = { lits: [], data: "content", truth: "presence", fields: [rootField("messages")] };
  const schema: Val = { lits: [], data: "presence", truth: "presence", fields: [memberField(rootField("tool"), "parameters")] };
  expect(lengthOf(messages).fields).toEqual([countField(0, "content")]);
  expect(lengthOf(schema).fields).toBeUndefined();
  expect(countArith(lengthOf(messages), CONST(40), "-")?.fields).toEqual([countField(-40, "content")]);
  const scaled = countArith(lengthOf(messages), CONST(3), "*");
  expect([scaled?.data, scaled?.fields]).toEqual(["content", undefined]);
  expect(countArith(CONST(1), CONST(2), "+")).toBeUndefined();
  expect(countArith(lengthOf(messages), CONST(1), "~")).toBeUndefined();
  // Offsets saturate, so a loop that keeps adding converges.
  expect(countField(9, "content")).toBe(countField(1000, "content"));
  const type = memberField(elementField(rootField("messages")), "type");
  expect(vocabClass([type], "image")).toBe("presence");
  expect(vocabClass([type], "IMAGE")).toBe("content");
  expect(vocabClass([type], "IMAGE", ["upper"])).toBe("presence");
  expect(vocabClass([type], "IMAGE", ["trim"])).toBe("content");
  expect(vocabClass([type], "IMAGE", ["lower"])).toBe("presence");
  expect(vocabClass([type], "IMAGE", ["lower", "string"])).toBe("presence");
  expect(vocabClass([type], "IMAGE", ["string"])).toBe("content");
  expect(vocabClass([type], null)).toBe("presence");
  expect(vocabClass([type], "zz")).toBe("content");
  expect(vocabClass([memberField(elementField(rootField("messages")), "name")], "x")).toBeUndefined();
});

test("memberPath: a dotted attribute is read part by part, a part of digits indexing a list (review round 2, runtime N7)", () => {
  const tool = elementField(rootField("tools"));
  // Looked up whole it falls to the record's other fields, undocumented since review round 3 (runtime S3-2).
  expect(memberField(tool, "function.name").undocumented).toBe(true);
  expect(memberPath(tool, "function.name").cls).toBe("content");
  expect(memberPath(tool, "function.name")).toBe(memberField(memberField(tool, "function"), "name"));
  const message = elementField(rootField("messages"));
  expect(memberPath(message, "tool_calls.0.function.name")).toBe(memberField(memberField(elementField(memberField(message, "tool_calls")), "function"), "name"));
  expect(memberPath(message, undefined)).toBe(memberField(message, undefined));
});

test("keyField: an undocumented record's keys are content, a documented one's presence (review round 2, ruling d)", () => {
  expect(keyField(rootField("xyzzy")).cls).toBe("content");
  expect(keyField(memberField(elementField(rootField("messages")), "xyzzy")).cls).toBe("content");
  expect(keyField(elementField(rootField("messages"))).cls).toBe("presence");
  expect(keyField(memberField(memberField(elementField(memberField(elementField(rootField("messages")), "tool_calls")), "function"), "arguments")).cls).toBe("presence");
});
