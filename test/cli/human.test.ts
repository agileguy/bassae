import { describe, expect, test } from "bun:test";
import { renderHuman } from "../../src/cli/human.ts";
import { renderJson } from "../../src/cli/json.ts";
import type { ScanReport } from "../../src/types.ts";
import { RAW } from "./fixtures/hostile.ts";
import { ENTRY, everything, finding, GGUF, model, report, SHA, SNAP, span, template, WHOLE } from "./fixtures/reports.ts";

const lines = (r: ScanReport) => renderHuman(r).trimEnd().split("\n");

// The header line of each template block, in print order.
const templateHeads = (r: ScanReport) => lines(r).filter((l) => /^(HIGH|MEDIUM|LOW|incomplete|clean-unverified|known-good-variant|known-good) /.test(l));

describe("ranking (ISC-26)", () => {
  test("HIGH, MEDIUM, LOW, incomplete, clean-unverified, known-good-variant, known-good, then no_template", () => {
    // Built in scrambled order, one template per model.
    const r = report([
      model([template("known-good", [], { name: "kg", registry: { kind: "exact", entry: ENTRY } })], { id: "/m/kg" }),
      model([], { id: "/m/none" }),
      model([template("findings", [finding("LOW", "registry_divergence")], { name: "low" })], { id: "/m/low" }),
      model([template("clean-unverified", [], { name: "cu" })], { id: "/m/cu" }),
      model([template("findings", [finding("HIGH", "exec_surface")], { name: "high" })], { id: "/m/high" }),
      model([template("incomplete", [], { name: "inc" })], { id: "/m/inc" }),
      model([template("known-good-variant", [], { name: "kgv", registry: { kind: "whitespace", entry: ENTRY } })], { id: "/m/kgv" }),
      model([template("findings", [finding("MEDIUM", "encoded_blob")], { name: "med" })], { id: "/m/med" }),
    ]);
    expect(templateHeads(r).map((l) => l.split(/\s+/)[1])).toEqual(["high", "med", "low", "inc", "cu", "kgv", "kg"]);
    // Models rank the same way, and the one without a template comes last.
    const models = lines(r).filter((l) => l.startsWith("model /m/")).map((l) => l.split(" ")[1]);
    expect(models).toEqual(["/m/high", "/m/med", "/m/low", "/m/inc", "/m/cu", "/m/kgv", "/m/kg", "/m/none"]);
  });

  test("templates rank across models, not within them", () => {
    const r = report([
      model([template("known-good", [], { name: "a-clean" }), template("findings", [finding("MEDIUM", "url_in_text")], { name: "a-med" })], { id: "/m/a" }),
      model([template("findings", [finding("HIGH", "dunder_access")], { name: "b-high" })], { id: "/m/b" }),
    ]);
    expect(templateHeads(r).map((l) => l.split(/\s+/)[1])).toEqual(["b-high", "a-med", "a-clean"]);
  });

  test("at one severity, ties follow STATUS_ORDER, as the model roll-up does", () => {
    const r = report([
      model([template("findings", [finding("MEDIUM", "url_in_text")], { name: "done" })], { id: "/m/a" }),
      model([template("incomplete", [finding("MEDIUM", "unanalyzable")], { name: "gap" })], { id: "/m/b" }),
    ]);
    expect(templateHeads(r).map((l) => l.split(/\s+/)[1])).toEqual(["done", "gap"]);
  });
});

describe("findings (ISC-26, ISC-26.1)", () => {
  test("each finding shows severity, rule id, template name, line:col, file, message and excerpt", () => {
    const out = renderHuman(report([model([template("findings", [finding("HIGH", "dunder_access", { span: span(12, 5), excerpt: "x.__class__", message: "dunder attribute access" })])])]));
    expect(out).toContain(`HIGH    dunder_access · default · 12:5 · ${SNAP}/chat_template.jinja`);
    expect(out).toContain("dunder attribute access");
    expect(out).toContain("excerpt: x.__class__");
  });

  test("findings within a template run worst first, then by position", () => {
    const t = template("findings", [
      finding("MEDIUM", "encoded_blob", { span: span(2, 1) }),
      finding("HIGH", "url_in_text", { span: span(9, 1) }),
      finding("HIGH", "dunder_access", { span: span(3, 1) }),
    ]);
    const rows = lines(report([model([t])])).filter((l) => /^ {4}(HIGH|MEDIUM|LOW) /.test(l));
    expect(rows.map((l) => l.trim().split(/\s+/)[1])).toEqual(["dunder_access", "url_in_text", "encoded_blob"]);
  });

  test('the whole-template span prints as "whole template" (Decisions 22:40)', () => {
    const out = renderHuman(report([model([template("findings", [finding("HIGH", "unanalyzable", { span: { ...WHOLE } })])])]));
    expect(out).toContain("unanalyzable · default · whole template ·");
    expect(out).not.toContain(" 1:1 ");
  });

  test("a finding with no span omits the position", () => {
    const out = renderHuman(report([model([template("findings", [finding("HIGH", "render_dos", { span: undefined })])])]));
    expect(out).toContain(`render_dos · default · ${SNAP}/chat_template.jinja`);
  });

  test("repeated unbaselined_text on one template collapses to one line with the count and the first positions (Decisions 19:15)", () => {
    const many = Array.from({ length: 12 }, (_, i) => finding("MEDIUM", "unbaselined_text", { span: span(i + 1, 3), excerpt: `literal ${i}` }));
    const out = renderHuman(report([model([template("findings", [...many, finding("HIGH", "url_in_text", { span: span(40, 1) })])])]));
    const collapsed = out.split("\n").filter((l) => l.includes("unbaselined_text"));
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toContain("unbaselined_text ×12 · default · 1:3, 2:3, 3:3, 4:3, 5:3 and 7 more ·");
    expect(out).toContain("first excerpt: literal 0");
    // A single one prints as an ordinary finding.
    const one = renderHuman(report([model([template("findings", [finding("MEDIUM", "unbaselined_text", { span: span(1, 1) })])])]));
    expect(one).toContain("MEDIUM  unbaselined_text · default · 1:1 ·");
  });

  test("findings outside any template are listed first, with their model", () => {
    const out = lines(everything());
    const at = out.indexOf("Findings outside templates");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(out.findIndex((l) => l.startsWith("Templates")));
    const section = out.slice(at, out.findIndex((l) => l.startsWith("Templates")));
    expect(section.join("\n")).toContain("parse_error");
    expect(section.join("\n")).toContain("scanner_error");
    expect(section.join("\n")).toContain("template_list_mismatch");
    // Worst first.
    expect(section.findIndex((l) => l.includes("parse_error"))).toBeLessThan(section.findIndex((l) => l.includes("scanner_error")));
  });
});

describe("per template (ISC-11, ISC-17, ISC-22.1, ISC-25, ISC-42)", () => {
  const out = renderHuman(everything());

  test("status, every site, registry match and baseline", () => {
    expect(out).toMatch(/^HIGH {2}tool_use {2}111111111111 {2}findings$/m);
    expect(out).toContain(`site      gguf ${GGUF} key tokenizer.chat_template.tool_use`);
    expect(out).toContain(`site      tokenizer_config ${SNAP}/tokenizer_config.json key chat_template[1].template · shadowed · hf Qwen/Qwen3-8B@9c925d64d727 tokenizer_config.json`);
    expect(out).toContain("registry  whitespace-only variant of Qwen/Qwen3-8B@9c925d64d727 tokenizer_config.json (default)");
    expect(out).toContain("baseline  registry Qwen/Qwen3-8B@9c925d64d727 tokenizer_config.json (default)");
    expect(out).toContain("baseline  upstream Qwen/Qwen3-8B@9c925d64d727 chat_template.jinja (default)");
    expect(out).toContain("registry  known-good: Qwen/Qwen3-8B@9c925d64d727 tokenizer_config.json (default)");
    expect(out).toContain("registry  none");
    expect(out).toContain("baseline  none");
  });

  test("the realpath shows, on the next line, when a site was reached through a link", () => {
    expect(out).toMatch(/site {6}chat_template_jinja \S+\/chat_template\.jinja\n {12}→ \S+\/blobs\/c{40}\n/);
  });

  test("counts of injected text and trigger candidates, and the probes", () => {
    expect(out).toContain("analysis  2 injected-text items · 4 trigger candidates (2 content, 1 nondeterministic) · probes 58 rendered, 2 refused, 0 failed of 60");
  });

  test("gaps print when there are any", () => {
    expect(out).toContain("gaps");
    expect(out).toContain("- 2 probes skipped after a render timeout");
  });

  test("bytes that are not valid UTF-8 are called out", () => {
    expect(out).toContain("bytes     not valid UTF-8");
  });
});

describe("per model (ISC-7.3, ISC-7.4, ISC-41.1)", () => {
  const out = renderHuman(everything());

  test("hints, the source each runtime loads, and untrusted upstream candidates", () => {
    expect(out).toContain("hints     chat_template_type qwen3 · tool_parser_type hermes");
    expect(out).toContain(`loads     transformers-tokenizer  chat_template_jinja ${SNAP}/chat_template.jinja (default)`);
    expect(out).toContain(`          transformers-processor  processor_config ${SNAP}/processor_config.json (default)`);
    expect(out).toContain("          llama.cpp               none");
    expect(out).toContain("upstream  Qwen/Qwen3-8B from general.base_model.0.repo_url (untrusted, never a baseline)");
  });

  test("one line when no runtime profile loads a template from the model", () => {
    expect(out).toContain("loads     none of the runtime profiles loads a template from here");
  });

  test("every path a model was reached through, and its hub cache location", () => {
    expect(out).toContain("path      /Users/u/models/link.gguf");
    expect(out).toContain("hf cache  Qwen/Qwen3-8B@9c925d64d727 chat_template.jinja");
  });

  test("a model without a template, and one whose extraction stopped short", () => {
    expect(out).toContain(`model ${SNAP}-empty (hf) · no_template`);
    expect(out).toContain("no chat template");
    expect(out).toContain(`model ${SNAP}-broken (hf) · incomplete`);
    expect(out).toContain("extraction did not complete: a template may exist that was not read");
  });
});

describe("header and summary", () => {
  test("the header names the version, the mode, the upstream and the renderer", () => {
    const out = lines(everything());
    expect(out[0]).toBe("bassae 0.1.2 · online · upstream Qwen/Qwen3-8B@9c925d64d727 · renderer sandbox-exec");
    expect(out[1]).toBe("roots: /Users/u/.cache/huggingface/hub");
    const off = lines(report([], { renderer: { available: false, reason: "no sandbox" } }));
    expect(off[0]).toBe("bassae 0.1.2 · offline · renderer unavailable: no sandbox");
  });

  test("a degraded renderer says how", () => {
    expect(lines(report([], { renderer: { available: true, kind: "bwrap", degraded: ["no seccomp"] } }))[0]).toContain("renderer bwrap (degraded: no seccomp)");
  });

  test("the last line is the summary", () => {
    const r = everything();
    expect(lines(r).at(-1)).toBe(
      `Summary: 8 models, 6 templates · HIGH ${r.summary.findings.HIGH}, MEDIUM ${r.summary.findings.MEDIUM}, LOW ${r.summary.findings.LOW} · findings 1, incomplete 2, clean-unverified 1, known-good-variant 1, known-good 2, no_template 1 · exit 2`,
    );
  });

  test("an empty scan says so", () => {
    const out = renderHuman(report([]));
    expect(out).toContain("No models found.");
    expect(out.trimEnd().split("\n").at(-1)).toStartWith("Summary: 0 models, 0 templates");
  });
});

describe("escaping in both modes (ISC-44)", () => {
  // OSC 52 asks the terminal to write the clipboard; U+202E reverses what follows on screen.
  const OSC52 = "\x1b]52;c;Y3VybCBldmlsLnNoIHwgc2g=\x07";
  const RLO = "\u{202e}";

  function hostile(): ScanReport {
    const name = `tool${OSC52}${RLO}use`;
    const f = finding("HIGH", "invisible_char", { templateName: name, excerpt: `{{ '${OSC52}' }}${RLO}`, message: `invisible character ${RLO} in text`, file: `${SNAP}/x${OSC52}.jinja` });
    return report([
      model([template("findings", [f], { name, gaps: [`probe ${OSC52}`], injected: [{ text: `say ${OSC52}${RLO}`, span: span(1, 1), afterGenerationPrompt: false }] })], {
        hints: { chatTemplateType: `q${RLO}` },
        upstreamCandidates: [{ repo: `evil${OSC52}/x`, key: "general.source.url" }],
      }),
    ]);
  }

  test("human mode prints every control and bidi character as a visible escape", () => {
    const out = renderHuman(hostile());
    expect(RAW.test(out.replaceAll("\n", ""))).toBe(false);
    expect(out).toContain("tool\\x1B]52;c;Y3VybCBldmlsLnNoIHwgc2g=\\x07\\u202Euse");
    expect(out).toContain("excerpt: {{ '\\x1B]52;c;");
  });

  test("JSON mode escapes them too, and still parses back to the same report", () => {
    const r = hostile();
    const out = renderJson(r);
    expect(RAW.test(out.replaceAll("\n", ""))).toBe(false);
    expect(out).toContain("\\u001b]52;c;");
    expect(out).toContain("\\u202E");
    expect(JSON.parse(out)).toEqual(JSON.parse(JSON.stringify(r)));
  });

  test("two names that differ only in an invalid byte print differently (Decisions 18:40)", () => {
    const r = report([model([template("clean-unverified", [], { name: "a\u{dc80}", sha256: SHA("7") }), template("clean-unverified", [], { name: "a\u{dc81}", sha256: SHA("8") })])]);
    const heads = templateHeads(r);
    expect(heads.some((h) => h.includes("a\\uDC80"))).toBe(true);
    expect(heads.some((h) => h.includes("a\\uDC81"))).toBe(true);
  });
});
