# Clean chat-template fixtures

Stock chat templates from permissively-licensed models, used by the
false-positive guard in `test/rules/codeexec.test.ts` (T9). Each must scan with
**zero HIGH findings and no `dunder_access`** — if a rule change makes one of
these HIGH, the rule is too aggressive and the change must stop, not the fixture.

All three are Apache-2.0. They are verbatim copies of the `chat_template` from
the source model, extracted from `tokenizer_config.json` (or `chat_template.jinja`
where present) with no edits.

| File | Source repo | Revision | Field | License |
|---|---|---|---|---|
| `qwen2.5-0.5b-instruct.jinja` | [`Qwen/Qwen2.5-0.5B-Instruct`](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct) | `7ae557604adf67be50417f59c2c2f167def9a775` | `tokenizer_config.json` → `chat_template` | Apache-2.0 |
| `qwen3-0.6b.jinja` | [`mlx-community/Qwen3-0.6B-4bit`](https://huggingface.co/mlx-community/Qwen3-0.6B-4bit) | `73e3e38d981303bc594367cd910ea6eb48349da8` | `tokenizer_config.json` → `chat_template` | Apache-2.0 |
| `qwen3-coder-30b.jinja` | [`mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit`](https://huggingface.co/mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit) | `6e302ea604ad9ab206367e2c501d1571023e7b6d` | `chat_template.jinja` | Apache-2.0 |

`qwen3-coder-30b.jinja` carries two MEDIUM `unanalyzable` findings (filters the
library does not implement); that is expected. The guard asserts only on HIGH and
`dunder_access`.
