# bassae

Finds MLX and GGUF models on disk, extracts every chat template they carry, and flags templates that try to run code, hide instructions, or quietly change what the model sees.

Named after the Temple of Apollo Epikourios at Bassae: Apollo the helper.

## Status

Under construction. Not ready to use: there is no command-line tool yet.

Phase 1 of 4 is done. It is the library underneath the scanner:

- **GGUF reader** (`src/gguf/`). It reads only the header and metadata, checks every length and count, and extracts each chat template, comparing key names byte for byte.
- **Discovery and HF/MLX reader** (`src/discover.ts`, `src/hf/`). It finds GGUF files by their magic bytes and model folders by where their templates live, and reads every documented template source.
- **Code-execution rules** (`src/parse/`, `src/rules/`). They cover dunder access, format traversal, dunders built from pieces, dynamic attributes, gadget chains and exec surfaces. A template the parser can't read, or that is too big or deep to parse safely, is HIGH and still gets a raw-text scan.
- **Sandboxed renderer** (`src/sandbox/`). Each template renders in its own child process, under `sandbox-exec` on macOS or `bwrap` on Linux, with no network, no writes, and time and memory caps. If no sandbox is available, it fails closed.

## Development

```bash
bun install
bun run typecheck
bun test
bun scripts/corpus-scan.ts            # run the rules over the templates of the models on this machine
bun scripts/gguf-parity.ts <file.gguf> # compare the GGUF reader with @huggingface/gguf
```

On Linux, set `BASSAE_REQUIRE_SANDBOX=1` to make the sandbox tests fail rather than skip when `bwrap` can't run.
