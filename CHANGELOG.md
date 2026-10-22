# Changelog

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
