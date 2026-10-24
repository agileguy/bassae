# Render-time fixtures

Attack templates for the differential-rendering rules (ISC-22 to ISC-22.4, ISC-43) and the date-bomb,
content-drop and always-on cases ISC-32 names. Each is the stock Qwen2.5 template with one inserted change,
so the rest of the template is a known baseline and the inserted change is the only thing that can trip a
rule. Scanned through the real command by `test/corpus/recall.test.ts`; each must raise its rule at the
listed severity, and if a rule change stops one from firing the rule has regressed and the change must stop,
not the fixture.

The stock text is the same file as `fixtures/clean/qwen2.5-0.5b-instruct.jinja`. Scanned bare with
`--template`, these files match no registry entry, so every non-scaffolding literal is also reported as
`unbaselined_text` MEDIUM; the finding each fixture stands for is listed below, and the scan may raise others.

Every payload is inert: the hidden instructions are prose, every host would be under `example.com`, and the
render_dos loop computes nothing but a counter.

| File | Source repo | Revision | Field | License |
|---|---|---|---|---|
| `date-bomb.jinja` | [`Qwen/Qwen2.5-0.5B-Instruct`](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct) | `7ae557604adf67be50417f59c2c2f167def9a775` | `tokenizer_config.json` → `chat_template`, modified | Apache-2.0 |
| `content-drop.jinja` | [`Qwen/Qwen2.5-0.5B-Instruct`](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct) | `7ae557604adf67be50417f59c2c2f167def9a775` | `tokenizer_config.json` → `chat_template`, modified | Apache-2.0 |
| `always-on-injection.jinja` | [`Qwen/Qwen2.5-0.5B-Instruct`](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct) | `7ae557604adf67be50417f59c2c2f167def9a775` | `tokenizer_config.json` → `chat_template`, modified | Apache-2.0 |
| `tool-integrity.jinja` | [`Qwen/Qwen2.5-0.5B-Instruct`](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct) | `7ae557604adf67be50417f59c2c2f167def9a775` | `tokenizer_config.json` → `chat_template`, modified | Apache-2.0 |
| `render-dos.jinja` | [`Qwen/Qwen2.5-0.5B-Instruct`](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct) | `7ae557604adf67be50417f59c2c2f167def9a775` | `tokenizer_config.json` → `chat_template`, modified | Apache-2.0 |
| `env-profile-divergence.jinja` | [`Qwen/Qwen2.5-0.5B-Instruct`](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct) | `7ae557604adf67be50417f59c2c2f167def9a775` | `tokenizer_config.json` → `chat_template`, modified | Apache-2.0 |
| `render-divergence.jinja` | [`Qwen/Qwen2.5-0.5B-Instruct`](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct) | `7ae557604adf67be50417f59c2c2f167def9a775` | `tokenizer_config.json` → `chat_template`, modified | Apache-2.0 |

## What each file inserts

| File | Inserted change | Rule | Severity |
|---|---|---|---|
| `date-bomb.jinja` | A system turn emitted only when `strftime_now('%Y') > '2026'` | `nondeterministic_trigger` | HIGH |
| `content-drop.jinja` | The system turn emits a fixed attacker prompt instead of `messages[0]['content']`, silently dropping the caller's real system message | `content_integrity` | HIGH |
| `always-on-injection.jinja` | One unconditional hidden system instruction, always emitted before the generation prompt | `unbaselined_text` | MEDIUM |
| `tool-integrity.jinja` | The tool list renders only each tool's `function.name`, dropping its description and parameters, so a tool no longer renders JSON-equivalent to its input | `tool_integrity` | HIGH |
| `render-dos.jinja` | An unconditional, unbounded `range(10000000000)` loop that blows the render time/memory/output cap | `render_dos` | HIGH |
| `env-profile-divergence.jinja` | A payload gated on `cycler is defined`, which the two environment profiles disagree on, so the output differs between them (also `engine_fingerprint` HIGH statically, since `is defined` on an engine global is ISC-15.1) | `env_profile_divergence` | HIGH |
| `render-divergence.jinja` | A `namespace` counter incremented once per message, with a payload gated on `ns.seen > 40`. The static rules read a namespace-counter threshold as presence (Decisions 2026-10-22 20:15, 23:40), so it is not a static HIGH; the fixed `count:50` vary probe sends 50 messages, reaches the payload, and differential rendering catches the text no ordinary-use probe prints | `render_divergence` | HIGH |

The last fixture answers ISC-32's ask for "a render_divergence fixture the static trigger rules do not
already flag HIGH": its only findings are `render_divergence` HIGH and `unbaselined_text` MEDIUM — no
`content_trigger` or `nondeterministic_trigger`.
