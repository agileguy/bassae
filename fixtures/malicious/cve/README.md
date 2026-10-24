# CVE fixtures

One template per published chat-template CVE, each an inert reconstruction of that advisory's own
technique, tagged with its CVE ID. These are not copied from an upstream model: they are the smallest
template that carries the attack, wrapped in a plain `<|im_start|>` chat loop so the renderer has
ordinary work to do around the payload. Scanned through the real command by `test/corpus/recall.test.ts`;
each must raise its rule at the listed severity, and if a rule change stops one from firing the rule has
regressed and the change must stop, not the fixture.

Every payload is inert. Commands are the placeholder `id`, there is no network call and no file write, and
the object walks reach for `__globals__`/`os` the way the advisories do but never execute in
`@huggingface/jinja`, which cannot reach Python objects — the static rules read the attack from the AST
and the raw text, not from running it.

## Sources

| CVE | What it is | Fixed in | Primary sources |
|---|---|---|---|
| CVE-2024-34359 | llama-cpp-python rendered a GGUF `tokenizer.chat_template` with an unsandboxed `jinja2.Environment`, giving SSTI → RCE (CWE-76) | llama-cpp-python 0.2.72 | [NVD](https://nvd.nist.gov/vuln/detail/CVE-2024-34359), [GHSA-56xg-wfcc-g829](https://github.com/abetlen/llama-cpp-python/security/advisories/GHSA-56xg-wfcc-g829) (holds the published PoC this fixture reconstructs) |
| CVE-2024-56326 | Jinja's sandbox caught a direct `str.format`, but a stored reference to a string's `format` method could be called indirectly through a filter, escaping the sandbox (CWE-693, CWE-1336) | Jinja2 3.1.5 | [NVD](https://nvd.nist.gov/vuln/detail/CVE-2024-56326), [GHSA-q2x7-8rv6-6q7h](https://github.com/pallets/jinja/security/advisories/GHSA-q2x7-8rv6-6q7h) |
| CVE-2025-27516 | The 3.1.5 fix still left the `\|attr` filter able to fetch a string's plain `format` method, bypassing the sandbox (CWE-1336) | Jinja2 3.1.6 | [NVD](https://nvd.nist.gov/vuln/detail/CVE-2025-27516), [GHSA-cpwx-vrp4-4pq7](https://github.com/pallets/jinja/security/advisories/GHSA-cpwx-vrp4-4pq7) |
| CVE-2026-5760 | SGLang's `/v1/rerank` endpoint rendered a model's `tokenizer.chat_template` with an unsandboxed `jinja2.Environment()`, giving RCE (CWE-94) | SGLang PR [#23660](https://github.com/sgl-project/sglang/pull/23660) (`ImmutableSandboxedEnvironment`) | [NVD](https://nvd.nist.gov/vuln/detail/CVE-2026-5760), [CERT/CC VU#915947](https://www.kb.cert.org/vuls/id/915947), SGLang PR #23660 |

The CVE fixtures carry no upstream template text, so no upstream revision or license applies to them.

## What each file does

| File | Technique | Rule | Severity |
|---|---|---|---|
| `cve-2024-34359-llama-cpp-python.jinja` | The advisory's own object walk: `().__class__.__base__.__subclasses__()` to the `warning` class, then `_module.__builtins__['__import__']('os').popen('id')` | `dunder_access` | HIGH |
| `cve-2024-56326-jinja-str-format.jinja` | A `str.format` reference stored in a `set` and called indirectly on the `cycler` global, its format-spec string walking `{0.__init__.__globals__[os].popen(id)}` | `dunder_access` | HIGH |
| `cve-2025-27516-jinja-attr-filter.jinja` | `'…'\|attr('format')(cycler)` — the `\|attr` filter fetches the plain `format` method, with the same format-spec walk | `dynamic_attribute` | HIGH |
| `cve-2026-5760-sglang-rerank.jinja` | The object walk from CVE-2024-34359, gated behind `documents` so only the rerank path reaches it; an ordinary chat render (and every probe, which passes `documents=None`) skips the branch | `dunder_access` | HIGH |

## Verified versus reconstructed

- **Verified from primary sources (all four):** that each CVE exists, its vulnerable component, that the
  root cause is an unsandboxed or sandbox-escaping Jinja environment rendering an attacker-controlled chat
  template, and the fixed version. CVE-2024-34359's fixture follows the exact PoC published in its GitHub
  advisory.
- **CVE-2026-5760, reconstructed detail.** The NVD record (status *Analyzed*), CERT/CC VU#915947 and the
  vendor fix (SGLang PR #23660, `jinja2.Environment()` → `ImmutableSandboxedEnvironment` in
  `_get_jinja_env()` of `serving_rerank.py`) confirm the endpoint, the unsandboxed-render root cause and the
  fix. What is **not** pinned to a primary source is the exact template variable the payload hides behind:
  the published PoC renders a Qwen3-reranker template that iterates `messages` and is activated by a trigger
  phrase. This fixture instead gates the payload on `documents`, as a stand-in for "input the rerank path
  supplies that an ordinary chat render never sets," which is the property the corpus needs. The static
  code-exec rule catches the dunder walk from the AST regardless of the gate, so the choice of gate does not
  change the finding.
