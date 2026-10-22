import { expect, test } from "bun:test";
import { specialTokensFrom } from "../../src/hf/tokens.ts";

test("added tokens from both files, special or not, in order and deduplicated", () => {
  const tokenizerJson = {
    added_tokens: [
      { id: 0, content: "<pad>", special: true },
      { id: 5, content: "<tool_call>", special: false },
      { id: 6, content: "<pad>", special: true },
    ],
  };
  const tokenizerConfig = {
    added_tokens_decoder: { "0": { content: "<pad>" }, "7": { content: "<end_of_turn>", special: true } },
  };
  expect(specialTokensFrom(tokenizerJson, tokenizerConfig)).toEqual(["<pad>", "<tool_call>", "<end_of_turn>"]);
});

test("missing or malformed inputs give what they can and never throw", () => {
  expect(specialTokensFrom(undefined, undefined)).toEqual([]);
  expect(specialTokensFrom({ added_tokens: "x" }, { added_tokens_decoder: [1, 2] })).toEqual([]);
  expect(specialTokensFrom({ added_tokens: [null, { content: 5 }, { content: "" }, { content: "<s>" }] }, null)).toEqual(["<s>"]);
  expect(specialTokensFrom(null, { added_tokens_decoder: { "1": null, "2": { content: "</s>" } } })).toEqual(["</s>"]);
});
