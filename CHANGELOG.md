# Changelog

## 0.1.3 (2026-10-23)

Phase 3: differential rendering, integrity checks and the `bassae` command (#3).

### Added
- The `bassae` command (`src/cli.ts`, `src/cli/`):
  - scans the given paths, or the default model locations that exist: the Hugging Face hub cache, `~/.lmstudio/models`, `~/.ollama/models` and `~/.omlx`;
  - `--json` prints a report that validates against `schema/report.schema.json`;
  - `--template <file>` scans a bare template, and `--extract <model> --out <dir>` writes each template's exact bytes;
  - `--online --upstream <repo>@<revision>` compares with a pinned upstream template. Nothing else touches the network;
  - human output escapes control, bidi and invisible characters, and the scan never writes under a scanned path;
  - exit codes: 2 for any HIGH; else 3 for any incomplete template, scanner or parse error, or usage error; else 1 for any MEDIUM; else 0. A failure to print, an uncaught error or a failure to load is 3, never a milder code. A reader that goes away early (EPIPE) keeps the report's code.
- Differential rendering (`src/diffrender/`):
  - trigger candidates come from the same interpreter walk the findings use, each with its input path, class and span;
  - 32 explain probes cover the conversation shapes, and vary probes each change one thing: the date, a 50-message chat, very long content, or one trigger candidate;
  - every probe renders under `hf-default` and `jinja2-globals`, capped at 160 probes per template;
  - `render_divergence` is residue word pairs that only a vary probe prints, `env_profile_divergence` is the two profiles disagreeing, and `render_dos` is a breach of a time, memory or output cap.
- Integrity checks (`src/diffrender/integrity.ts`, `tools.ts`, `transforms.ts`):
  - every content must appear verbatim, in order, inside a turn of its own role or a less privileged one, and any further copy that no allowlisted transform explains is HIGH;
  - tools must render JSON-equal, or through one of 9 allowlisted ports that print the cited stock template byte for byte. Each port's losses are listed in `registry/transforms.json`.
- The scan pipeline (`src/scan/`, `src/status.ts`): discovery, model loading, provenance, per-template analysis in a pool of sandboxed renderers, and model findings attached to their templates, capped at 100 per rule per template plus a summary. Each template gets one status: `known-good`, `known-good-variant`, `clean-unverified`, `findings`, `incomplete` or `no_template`.
- The render worker polyfills the jinja2 builtins stock templates use (`src/sandbox/polyfills.ts`), and ends itself once earlier renders have grown its memory by a quarter of the cap, so each render is charged only for its own memory.

### Known limits
- Vary probes change one factor at a time, so only the static rules catch a trigger gated on a combination of inputs.
- A payload gated on a documented value (presence-gated) is MEDIUM `unbaselined_text`, not HIGH. Sending those values as vary probes gave false HIGH on stock templates.
- The probe vocabulary is fixed and public, so a template could tell a probe from real use. Seeding it from the template's hash is planned for Phase 4.
- A refusal is never a gap, so a template that refuses exactly the probes is caught only by the static content-test rules.
- Residue pairs break at every removed input. A payload that puts role names or other one-word inputs between the words it reorders is not seen as reordered.
- Negation in a slice `!=` comparison is lost, so the probe sends the matching value. Booleans are never trigger candidates.
- For gemma and qwen, text between tool declarations is not credited to either tool. The static rules still see it.
- A content that is a bare role word can match later markup in the content check.
- A conditionally hostile template can breach two caps, but `render_dos` stops at the first.
- The render timeout is wall-clock (2 s), so a heavily swapping host can turn a fast render into a false HIGH `render_dos`.
- Worker recycling is not reported. A template that forces a fresh worker for every probe can scan up to 31x slower.
- A GGUF with about 6000 keys holding a NUL can push the report past the 2 GB string limit. The command then exits 3 with an internal error rather than 2 with a report.
- On macOS the deny-network e2e test can't nest `sandbox-exec`, so that scan reports `incomplete` there. Linux CI runs it.

## 0.1.2 (2026-10-23)

Phase 2: the known-good registry, the injection rules and provenance (#2).

### Added
- Known-good registry (`registry/`, `src/registry/`):
  - stock chat templates from upstream model repos, each citing repo, revision and path;
  - an exact SHA-256 match is `known-good`, and a whitespace-only difference is `known-good-variant`, with no finding;
  - a transform allowlist, and a precedence table naming the template source each runtime loads;
  - checked in, rebuilt only by `scripts/build-registry.ts`, and never written by a scan.
- Injection rules (`src/rules/injection.ts`, `injected.ts`, `triggers.ts`, `textscan.ts`):
  - every literal the template prints that isn't scaffolding is listed with its span;
  - injected text missing from the matched registry template is MEDIUM, even when unconditional;
  - injected text printed after the generation prompt (a prefilled assistant turn) is HIGH;
  - a declared special token that reads as prose doesn't count as scaffolding;
  - a branch that prints injected text under a test on message content, an undocumented kwarg or an undocumented field is HIGH. Tests that only check whether something is there, or compare a role with the documented role names, are exempt;
  - any use of `random`, or a `strftime_now()` result inside a test, is HIGH;
  - URLs, email addresses and domains are HIGH, and base64-like or hex-like text of 32 or more characters is MEDIUM, even when split across literals or joined with `~` or `|join`;
  - invisible and deceptive characters anywhere in a template are HIGH.
- Provenance (`src/provenance/`):
  - two template sources in one model folder that differ are a MEDIUM `intra_model_divergence` finding with a diff, and the shadowed one is still scanned;
  - a GGUF next to an HF source is diffed against it, labeled `local comparison`;
  - a template that diverges from its registry entry gets the severity of the highest rule that fires on the changed lines. Changed literal text with no rule firing is MEDIUM. A control-flow-only rewrite is LOW only when its rendered output matches the stock template's;
  - HF-cache blobs whose git blob hash doesn't match are a HIGH `local_tamper` finding;
  - fetching a pinned upstream template (`repo@revision`) as a baseline, for the `--online --upstream` flag the Phase 3 CLI adds. Upstream names read from GGUF metadata are listed as untrusted and never used as a baseline on their own.
- `scripts/registry-coverage.ts`, and a `--no-registry` mode for `scripts/corpus-scan.ts`.

### Known limits
- A sentence split into single-word declared control tokens passes as scaffolding.
- Some count comparisons read as presence: two different counts within 1 of each other, a dict literal keyed by numbers, and a count joined with constants through arithmetic, `|int`, `|string`, `range()` bounds or `.get` defaults. The differential render planned for Phase 3 is the backstop.
- `is sameas` and `is eq` tests are reported as incomplete, not judged.
- A URL joined across a one-armed `if` that is skipped (`evil{% if tools %}/{% endif %}.com`) is MEDIUM, not HIGH: only the taken arm is scanned. Scanning every skip pushes a stock template past the render budget.
- Not yet detected: a bare `evil.zip` or `evil.mov`, `data:` and `javascript:` URIs, hex IPv4, bare IPv6, and domains defanged as spaced hex or "dot com".
- The `--online` redirect allowlist trusts `*.huggingface.co` and `*.hf.co`.
- A tampered HF-cache blob planted together with a matching metadata record is consistent with itself, so the hash check can't catch it.

## 0.1.1 (2026-10-22)

Phase 1: readers, code-execution rules and the sandboxed renderer (#1).

### Added
- GGUF reader:
  - reads the header and metadata only, with BigInt-checked arithmetic and a cap on every length and count;
  - extracts every `tokenizer.chat_template*` key, compared byte for byte;
  - flags NUL-bearing and duplicate keys.
- Model discovery:
  - finds GGUF files by magic bytes and HF/MLX model folders by template source;
  - follows each directory symlink once;
  - maps HF-cache paths to repo and revision.
- HF/MLX reader for every documented chat template source, special tokens and mlx-lm hints.
- Code-execution rules:
  - dunder access, format traversal and dunders built from pieces;
  - dynamic attribute access on template-made objects;
  - gadget traversal, exec surfaces and engine fingerprinting.
  - Every finding has a line and column, and every excerpt is cut at a whole character.
- Unanalyzable templates are HIGH, and a raw-text scan still runs on them:
  - templates the parser rejects;
  - templates over the size, whitespace, token, bracket or block-depth caps.
  - These caps are integer counts, so results don't depend on the platform's stack size.
- Sandboxed renderer:
  - one child process per template, under `sandbox-exec` (macOS) or `bwrap` (Linux);
  - no network and no writes;
  - time, memory and output caps;
  - workers are cleaned up on exit and on signals;
  - fails closed when no sandbox is available.
- CI on ubuntu-latest with Bun 1.3.12, where the sandbox tests are required to run.
