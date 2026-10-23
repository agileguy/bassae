# Changelog

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
