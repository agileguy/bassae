import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, Template, tokenize } from "@huggingface/jinja";
import { LIBRARY_TOKENIZE, parseTemplate } from "../../src/parse/parse.ts";

test("a template the library accepts parses with no parse error", () => {
  const out = parseTemplate("{% for m in messages %}{{ m.content }}{% endfor %}");
  expect(out.parseError).toBeUndefined();
  expect(out.program).toBeDefined();
  expect(out.unsupported).toHaveLength(0);
});

test("unsupported statement surfaces as a parse error naming the construct", () => {
  const out = parseTemplate("{% with x = 1 %}{{ x }}{% endwith %}");
  expect(out.program).toBeUndefined();
  expect(out.parseError).toContain("with");
});

test("attr and format filters are flagged HIGH unsupported", () => {
  for (const name of ["attr", "format"]) {
    const out = parseTemplate(`{{ x | ${name}('y') }}`);
    const u = out.unsupported.find((c) => c.name === name);
    expect(u?.severity).toBe("HIGH");
  }
});

test("a benign unimplemented filter is MEDIUM, implemented filters are silent", () => {
  const sum = parseTemplate(`{{ prices | sum }}`);
  expect(sum.unsupported.find((c) => c.name === "sum")?.severity).toBe("MEDIUM");

  // The render worker polyfills these (src/sandbox/polyfills.ts).
  const ok = parseTemplate(`{{ d | dictsort }}{{ xs | join(',') }}{{ s | trim }}{{ keys | reject('in', handled) }}{{ names | map('upper') | list }}`);
  expect(ok.unsupported).toHaveLength(0);
});

test("spans correlate to the right occurrence when a name repeats", () => {
  const src = "{{ a }}{{ b }}{{ a }}";
  const out = parseTemplate(src);
  const spans = [...out.spans.values()].filter((s) => src.slice(s.start, s.end) === "a");
  // Two distinct `a` leaves, at the two different offsets.
  expect(spans).toHaveLength(2);
  expect(spans[0]!.start).not.toBe(spans[1]!.start);
});

// Every jinja2 builtin filter is classified exactly once: implemented by the
// library, MEDIUM benign, or HIGH dangerous. Everything else is a non-builtin.
test("jinja2 builtin filters and tests are partitioned without gaps or overlap", async () => {
  const s = await import("../../src/parse/support.ts");
  for (const name of s.JINJA2_BUILTIN_FILTERS) {
    const hits = [s.IMPLEMENTED_FILTERS, s.BENIGN_UNIMPLEMENTED_FILTERS, s.DANGEROUS_FILTERS].filter((set) => set.has(name));
    expect([name, hits.length]).toEqual([name, 1]);
  }
  for (const name of [...s.BENIGN_UNIMPLEMENTED_FILTERS, ...s.DANGEROUS_FILTERS]) expect(s.JINJA2_BUILTIN_FILTERS.has(name)).toBe(true);
  for (const name of s.JINJA2_BUILTIN_TESTS) {
    const hits = [s.IMPLEMENTED_TESTS, s.BENIGN_UNIMPLEMENTED_TESTS].filter((set) => set.has(name));
    expect([name, hits.length]).toEqual([name, 1]);
  }
  for (const name of s.BENIGN_UNIMPLEMENTED_TESTS) expect(s.JINJA2_BUILTIN_TESTS.has(name)).toBe(true);
});

// parseTemplate counts its caps on the library's tokens and parses those same
// tokens, so it must build exactly what `new Template(text)` builds, on every
// fixture, or the error the library raises when it cannot.
test("parsing the library's tokens builds what new Template builds", () => {
  const fixtures = join(import.meta.dir, "../../fixtures");
  const cases: [string, string][] = [
    // Shapes the library's preprocess rewrites: generation tags, trim_blocks, lstrip_blocks.
    ["generation", "{% for m in messages %}{% generation %}{{ m.content }}{% endgeneration %}{% endfor %}"],
    ["generation inside a tag", "{{%generation%}% if a %}x{% endif %}"],
    ["trim_blocks", "{{ x -}\n} {% if a %}\n  y\n{% endif %}\n"],
    ["lstrip_blocks", "  {% if a %}\n\t{%- if b -%} c {% endif %}{% endif %}"],
    ["parse error", "{{ x %}"],
  ];
  for (const rel of ["clean", "jinja2-only", "malicious/codeexec"]) {
    for (const name of readdirSync(join(fixtures, rel))) {
      if (name.endsWith(".jinja")) cases.push([`${rel}/${name}`, readFileSync(join(fixtures, rel, name), "utf8")]);
    }
  }
  expect(cases.length).toBeGreaterThan(15);
  for (const [label, src] of cases) {
    const viaTemplate = attempt(() => new Template(src).parsed);
    const viaTokens = attempt(() => parse(tokenize(src, LIBRARY_TOKENIZE)));
    expect(viaTokens, label).toEqual(viaTemplate);
  }
});

function attempt(build: () => unknown): unknown {
  try {
    return build();
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
