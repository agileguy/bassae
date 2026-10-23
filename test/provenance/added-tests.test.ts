// The added-test check of a control-flow-only rewrite (ISC-25, Decisions
// 20:55), read from the trigger rules' own interpreter: every kind of test the
// old evaluator classed, plus content-keyed selection and loops over computed
// text, each MEDIUM through registryDivergence; presence-only rewrites stay
// LOW; whatever cannot be classed fails closed to MEDIUM.

import { describe, expect, test } from "bun:test";
import { registryDivergence } from "../../src/provenance/divergence.ts";
import { makeTemplateFromString } from "../../src/template.ts";
import type { Baseline, ExtractedTemplate, KnownGoodTemplate, Renderer, RenderRequest, RuleResult } from "../../src/types.ts";
import { RENDER_TEMPLATES } from "./recorded.ts";

const { CHATML, RENAMED } = RENDER_TEMPLATES;

const tpl = (text: string): ExtractedTemplate => makeTemplateFromString({ kind: "bare", path: "/models/x/chat_template.jinja", realPath: "/models/x/chat_template.jinja", name: "default" }, text);
const KNOWN: KnownGoodTemplate = {
  entry: { family: "chatml", repo: "acme/tiny-chat", revision: "0123456789abcdef0123456789abcdef01234567", path: "chat_template.jinja", templateName: "default", sha256: "0".repeat(64) },
  text: CHATML,
};
const registry = (text: string): Baseline => ({ kind: "registry", known: { ...KNOWN, text } });
const quiet = (): RuleResult => ({ findings: [], complete: true });

/** Answers every probe the same, counting the batches it is sent. */
function same(): Renderer & { calls: number } {
  const r = {
    calls: 0,
    async renderBatch(_: string, requests: RenderRequest[]) {
      r.calls++;
      return requests.map((q) => ({ id: q.id, ok: true as const, output: "same" }));
    },
  };
  return r;
}

const CONTENT = "{{ message.content }}";
// Names for the literals a rewrite uses, in the baseline too, so the rewrite
// changes control flow only and reaches the added-test check.
const NAMES = "{% set table = {'sudo': true} %}{% set k = 'x' %}{% set f = 'content' %}{% set t = 'ne' %}{% set u = 'upper' %}{% set r = 'user' %}\n";
const wrap = (open: string, close: string) => NAMES + CHATML.replace(CONTENT, `${open}${CONTENT}${close}`);

async function verdict(base: string, evil: string) {
  const renderer = same();
  const [f] = await registryDivergence(tpl(evil), registry(base), quiet, renderer);
  return { f: f!, calls: renderer.calls };
}

describe("a rewrite that adds a content or clock test is MEDIUM (ISC-25)", () => {
  const cases: [string, string, "content" | "nondeterministic", string][] = [
    ["an if on content", wrap("{% if message.content != k %}", "{% endif %}"), "content", "message.content != k"],
    ["an is test on content", wrap("{% if message.content is upper %}", "{% endif %}"), "content", "message.content is upper"],
    ["an and/or operand on content", wrap("{% if message.role or message.content == k %}", "{% endif %}"), "content", "message.content == k"],
    ["a membership test on content", wrap("{% if k not in message.content %}", "{% endif %}"), "content", "k not in message.content"],
    ["a loop filter", NAMES + CHATML.replace("for message in messages", "for message in messages if message.content is upper"), "content", "message.content is upper"],
    ["an inline if", NAMES + CHATML.replace("{{ message.role }}", "{{ (messages|first).role if message.content is upper else message.role }}"), "content", "message.content is upper"],
    ["a select filter", NAMES + CHATML.replace("in messages", "in messages|selectattr(f, t, k)"), "content", "selectattr(f, t, k)"],
    ["a select filter by test name", NAMES + CHATML.replace("in messages", "in messages|selectattr(f, u)"), "content", "selectattr(f, u)"],
    ["a clock test", NAMES + CHATML.replace("{% if add_generation_prompt %}", "{% if add_generation_prompt and date_string is upper %}"), "nondeterministic", "date_string is upper"],
    // Content-keyed selection: the content chooses the entry the test reads.
    ["content-keyed selection", wrap("{% set pick = table[message.content] %}{% if pick %}", "{% endif %}"), "content", "message.content"],
    ["content-keyed .get", wrap("{% if table.get(message.content) %}", "{% endif %}"), "content", "message.content"],
    // A loop over computed text runs as often as the text says.
    ["a loop over computed text", wrap("{% for w in message.content.split() %}", "{% endfor %}"), "content", "message.content.split()"],
    ["a test inside a loop over computed text", wrap("{% for w in message.content.split() %}{% if w == k %}", "{% endif %}{% endfor %}"), "content", "message.content.split()"],
  ];
  for (const [name, evil, cls, excerpt] of cases) {
    test(name, async () => {
      const { f, calls } = await verdict(NAMES + CHATML, evil);
      expect({ severity: f.severity, message: f.message }).toEqual({ severity: "MEDIUM", message: expect.stringContaining(`control flow only, but the rewrite adds a ${cls} test: \`${excerpt}\``) });
      expect(f.detail!.tests).toContainEqual(expect.objectContaining({ class: cls, excerpt }));
      // A fixed probe set never sends the message such a test waits for: nothing is rendered.
      expect(calls).toBe(0);
    });
  }

  test("content-keyed selection lists the test on the pick as well as the key", async () => {
    const { f } = await verdict(NAMES + CHATML, wrap("{% set pick = table[message.content] %}{% if pick %}", "{% endif %}"));
    expect(f.detail!.tests).toEqual([expect.objectContaining({ class: "content", excerpt: "message.content" }), expect.objectContaining({ class: "content", excerpt: "pick" })]);
  });

  test("a test in a loop over computed text is listed after the loop", async () => {
    const { f } = await verdict(NAMES + CHATML, wrap("{% for w in message.content.split() %}{% if w == k %}", "{% endif %}{% endfor %}"));
    expect(f.detail!.tests).toEqual([expect.objectContaining({ excerpt: "message.content.split()" }), expect.objectContaining({ excerpt: "w == k" })]);
  });

  test("an unchanged test the rewrite makes read content counts, on its own line", async () => {
    const base = "{% set ns = namespace(skip=false) %}\n{% for message in messages %}{% if not ns.skip %}{{ message.role }}: {{ message.content }}{% endif %}{% endfor %}";
    const { f } = await verdict(base, base.replace("skip=false", "skip=(messages|last).content.isupper()"));
    expect(f.severity).toBe("MEDIUM");
    expect(f.message).toContain("but the rewrite adds a content test: `ns.skip` (line 2)");
    // The same rewrite through a content-keyed lookup: the lookup is a test too.
    const keyed = "{% set table = {'sudo': true} %}" + base;
    const { f: g } = await verdict(keyed, keyed.replace("skip=false", "skip=table[(messages|last).content]"));
    expect(g.message).toContain("but the rewrite adds a content test: `(messages|last).content` (line 1)");
    expect(g.detail!.tests).toContainEqual(expect.objectContaining({ class: "content", excerpt: "ns.skip" }));
  });
});

describe("a rewrite that adds presence tests only is LOW (ISC-25)", () => {
  for (const [name, evil] of [
    ["a defined test", wrap("{% if message.content is defined %}", "{% endif %}")],
    ["a role against a documented role", wrap("{% if message.role == r %}", "{% endif %}")],
    ["a loop over the tools", wrap("{% for tool in tools %}", "{% endfor %}")],
    ["a namespace flag set from presence", NAMES + CHATML.replace("{% for message in messages %}", "{% set ns = namespace(on=tools is defined) %}{% for message in messages if ns.on %}")],
  ] as const) {
    test(name, async () => {
      const { f, calls } = await verdict(NAMES + CHATML, evil);
      expect({ severity: f.severity, message: f.message }).toEqual({ severity: "LOW", message: expect.stringContaining("control flow only, with identical output") });
      // LOW only once the renderer showed it.
      expect(calls).toBeGreaterThan(0);
    });
  }
});

describe("whatever cannot be classed fails closed to MEDIUM (ISC-25)", () => {
  test("a walk that does not settle", async () => {
    const chain = "{% for m in messages %}" + Array.from({ length: 12 }, (_, i) => `{% set v${i} = v${i + 1} ~ m.content %}`).join("") + "{% endfor %}\n";
    const { f, calls } = await verdict(chain + CHATML, chain + RENAMED);
    expect(f.severity).toBe("MEDIUM");
    expect(f.message).toContain("control flow only, but the tests it changed could not be classified");
    expect(calls).toBe(0);
  });

  test("a rewrite that does not parse", async () => {
    const { f } = await verdict(CHATML, CHATML.replace(CONTENT, `{% if message.content %}${CONTENT}`));
    expect(f.severity).toBe("MEDIUM");
    expect(f.message).toContain("control flow only, but the tests it changed could not be classified");
  });
});
