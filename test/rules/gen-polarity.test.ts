// genPolarity: which branch of an `if` runs only when add_generation_prompt is
// set. `body` means the body implies the flag, `alternate` that the else does,
// undefined that neither does.

import { expect, test } from "bun:test";
import { parseTemplate } from "../../src/parse/parse.ts";
import type { Node } from "../../src/parse/support.ts";
import { genPolarity } from "../../src/rules/triggers.ts";

function testOf(expr: string): Node {
  const program = parseTemplate(`{% if ${expr} %}{% endif %}`).program!;
  return ((program.body as Node[])[0]!.test as Node);
}
function polarity(expr: string, isFlag?: (n: Node) => boolean): string | undefined {
  return genPolarity(testOf(expr), isFlag);
}

const CASES: [string, string][] = [
  ["add_generation_prompt", "body"],
  ["not add_generation_prompt", "alternate"],
  ["not not add_generation_prompt", "body"],
  ["add_generation_prompt is true", "body"],
  ["add_generation_prompt is not true", "alternate"],
  ["add_generation_prompt is false", "alternate"],
  ["add_generation_prompt == true", "body"],
  ["add_generation_prompt == True", "body"],
  ["add_generation_prompt != true", "alternate"],
  ["add_generation_prompt == false", "alternate"],
  ["true == add_generation_prompt", "body"],
  ["add_generation_prompt == 1", "body"],
  ["add_generation_prompt != 0", "body"],
  ["add_generation_prompt == 0", "alternate"],
  ["add_generation_prompt == 2", "neither"],
  ["add_generation_prompt == 'true'", "neither"],
  ["add_generation_prompt|default(false)", "body"],
  ["add_generation_prompt|int", "body"],
  ["add_generation_prompt|string", "neither"],
  // The body of `a and b` runs only when both hold: either implying the flag is enough.
  ["add_generation_prompt and loop.last", "body"],
  ["loop.last and add_generation_prompt", "body"],
  ["not add_generation_prompt and loop.last", "neither"],
  ["not add_generation_prompt and not add_generation_prompt", "alternate"],
  // The body of `a or b` runs when either holds: both must imply the flag.
  ["add_generation_prompt or loop.last", "neither"],
  ["add_generation_prompt or add_generation_prompt", "body"],
  ["not add_generation_prompt or loop.last", "alternate"],
  ["not (add_generation_prompt or loop.last)", "neither"],
  ["not (not add_generation_prompt or loop.last)", "body"],
  ["generation_prompt", "neither"],
  ["messages", "neither"],
  // The flag as text: `True` in jinja2, `true` in the JS engine and `tojson`
  // (review round 2, security N4). A test that one engine's spelling fails
  // implies nothing about its else.
  ["add_generation_prompt|string == 'True'", "body"],
  ["add_generation_prompt|string == 'true'", "body"],
  ["add_generation_prompt|string != 'True'", "alternate"],
  ["add_generation_prompt|string == 'False'", "neither"],
  ["add_generation_prompt|string == 'TRUE'", "neither"],
  ["add_generation_prompt|lower == 'true'", "body"],
  ["add_generation_prompt|lower == 'false'", "alternate"],
  ["add_generation_prompt|string|upper == 'TRUE'", "body"],
  ["add_generation_prompt|tojson == 'true'", "body"],
  ["'True' == add_generation_prompt|string", "body"],
  ["add_generation_prompt|int|string == '1'", "body"],
  // Membership in a list of constants.
  ["add_generation_prompt in [true]", "body"],
  ["add_generation_prompt in (1, true)", "body"],
  ["add_generation_prompt in [false]", "alternate"],
  ["add_generation_prompt not in [true]", "alternate"],
  ["add_generation_prompt in [true, false]", "neither"],
  ["add_generation_prompt in ['true']", "neither"],
  // Ordering against a number.
  ["add_generation_prompt > 0", "body"],
  ["add_generation_prompt >= 1", "body"],
  ["0 < add_generation_prompt", "body"],
  ["add_generation_prompt < 1", "alternate"],
  ["add_generation_prompt <= 0", "alternate"],
  ["add_generation_prompt > 1", "neither"],
  ["add_generation_prompt >= 0", "neither"],
];

test.each(CASES)("genPolarity(%s) is %s", (expr, want) => {
  expect(polarity(expr) ?? "neither").toBe(want);
});

test("genPolarity asks the caller which other expressions are the flag", () => {
  const isG = (n: Node): boolean => n.type === "Identifier" && n.value === "g";
  expect(polarity("g", isG)).toBe("body");
  expect(polarity("not g", isG)).toBe("alternate");
  expect(polarity("g == 1 and x", isG)).toBe("body");
  expect(polarity("add_generation_prompt", isG)).toBeUndefined();
});
