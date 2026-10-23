import { afterAll, expect, test } from "bun:test";
import { loadRegistry, loadTransforms } from "../../src/registry/index.ts";
import { makeTree, removeTrees } from "../helpers/tree.ts";

afterAll(removeTrees);

const registry = loadRegistry();
const transforms = loadTransforms();

// Text that must sit inside each transform's cited lines of the pinned upstream template.
const EVIDENCE: Record<string, string[]> = {
  "strip-past-think": [".split('</think>')[-1].lstrip('\\n')", "loop.index0 > ns.last_query_index"],
  "strip-gemma-thinking-channel": ["macro strip_thinking(text)", "part.split('<|channel>')[0]", "ns.result | trim"],
  "trim-content": ["message['content'] | trim", "item['text'] | trim"],
  "fold-system-into-first-user": ["set first_user_prefix = messages[0]['content'] + '", "set loop_messages = messages[1:]", "(first_user_prefix if loop.first else \"\")"],
  "drop-past-analysis": ["future_final_message.found", "CoT is dropped during all previous turns"],
  "gpt-oss-typescript-tools": ["macro render_tool_namespace(namespace_name, tools)", "\"type \"+ tool.name + \" = \"", "render_tool_namespace(\"functions\", tools)"],
  "gemma4-tool-declarations": ["macro format_function_declaration(tool_data)", "{{- '<|tool>' -}}", "format_function_declaration(tool) | trim"],
  "functiongemma-tool-declarations": ["macro format_function_declaration(tool_data)", "<start_function_declaration>", "format_function_declaration(tool) | trim"],
  "qwen-xml-tool-list": ["macro render_item_list(item_list, tag_name='required')", "\\n<function>\\n<name>", "render_item_list(tool.parameters.required, 'required')"],
};

test("the allowlist strips past <think> blocks, among others", () => {
  expect(transforms.map((t) => t.id)).toContain("strip-past-think");
  expect(Object.keys(EVIDENCE).sort()).toEqual(transforms.map((t) => t.id).sort());
});

test("each transform cites lines of a template pinned in the registry, and the cited lines show it", () => {
  for (const t of transforms) {
    const [, repo, revision, path, rest] = /^([^@]+)@([0-9a-f]{40}):(\S+)(.*)$/.exec(t.source)!;
    const known = registry.entries.find((k) => k.entry.repo === repo && k.entry.revision === revision && k.entry.path === path && k.entry.templateName === "default");
    expect(known).toBeDefined();
    const lines = known!.text.split("\n");
    const cited = [...rest!.slice(rest!.indexOf("line")).matchAll(/(\d+)(?:-(\d+))?/g)]
      .flatMap(([, a, b]) => lines.slice(Number(a) - 1, Number(b ?? a)))
      .join("\n");
    expect(cited.length).toBeGreaterThan(0);
    for (const e of EVIDENCE[t.id]!) expect(cited).toContain(e);
  }
});

test("loadTransforms reads a transforms.json and rejects an uncited or repeated transform", () => {
  const dir = (transforms: unknown) => makeTree({ "transforms.json": JSON.stringify({ transforms }) });
  const ok = { id: "x", description: "d", source: `o/r@${"a".repeat(40)}:chat_template.jinja lines 1-2` };
  expect(loadTransforms(dir([ok]))).toEqual([ok]);
  expect(() => loadTransforms(dir([{ ...ok, source: "o/r@main:chat_template.jinja" }]))).toThrow(/40-hex/);
  expect(() => loadTransforms(dir([{ ...ok, source: "" }]))).toThrow();
  expect(() => loadTransforms(dir([ok, ok]))).toThrow(/duplicate/);
  expect(() => loadTransforms(dir([{ id: "x" }]))).toThrow();
});
