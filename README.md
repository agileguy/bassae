# bassae

Finds MLX and GGUF models on disk, extracts every chat template they carry, and flags templates that try to run code, hide instructions, or quietly change what the model sees.

Named after the Temple of Apollo Epikourios at Bassae: Apollo the helper.

## Usage

```bash
bun install
bun src/cli.ts                        # scan the default model locations that exist
bun src/cli.ts ~/models/some-model    # scan given paths
bun src/cli.ts --json ~/models        # the report as JSON (schema/report.schema.json)
bun src/cli.ts --template file.jinja  # scan a bare template
bun src/cli.ts --extract ~/models/m --out ./templates   # write each template's exact bytes
```

With no path, it scans the Hugging Face hub cache (`$HF_HUB_CACHE`, else `$HF_HOME/hub`, else `~/.cache/huggingface/hub`), `~/.lmstudio/models`, `~/.ollama/models` (`$OLLAMA_MODELS`) and `~/.omlx`. It never writes under a scanned path, and it never touches the network unless you pass `--online`. `--online --upstream <repo>@<40-hex revision>` also compares with that upstream template. `--help` lists every option.

Each template gets one status:

| Status | Meaning |
|---|---|
| `known-good` | byte for byte a stock template in the registry |
| `known-good-variant` | a stock template up to whitespace |
| `clean-unverified` | not in the registry, and nothing fired |
| `findings` | at least one finding |
| `incomplete` | something could not be checked: a parse or scanner error, or a spent budget |
| `no_template` | the model carries no chat template |

Exit codes: 2 for any HIGH finding; else 3 for any incomplete template, scanner or parse error, or usage error; else 1 for any MEDIUM; else 0. A crash or a failure to print exits 3, never a milder code.

Rendering runs in a sandbox: `sandbox-exec` on macOS, `bwrap` on Linux. Without one, nothing renders and every template is at best `incomplete`, so the scan never reports clean.

## Status

All four phases are done.

- **Phase 1: the library.** A GGUF header and metadata reader, discovery and the HF/MLX reader, the code-execution rules, and the sandboxed renderer.
- **Phase 2: what a template should look like.** The known-good registry of stock templates, the injection rules, and provenance: diffs within a model folder, against a GGUF's HF sibling, and against the registry, plus HF-cache blob hashes.
- **Phase 3: what a template actually does.** Differential rendering with explain and vary probes under two runtime profiles, integrity checks that every message and tool comes through unchanged in its own turn, the scan pipeline and the `bassae` command.
- **Phase 4: proof it works.** A malicious test corpus, a blind held-out set written after the rules were frozen and scored against them (20 of 21 detected), a verified clean manifest of the known-good models on a machine, and a parity projection that two machines agree on byte for byte.

Known limits are listed in [CHANGELOG.md](CHANGELOG.md).

## Development

```bash
bun install
bun run typecheck
bun test
bun scripts/corpus-scan.ts            # run the rules over the templates of the models on this machine (--no-registry: scan every template as unknown)
bun scripts/build-registry.ts         # rebuild the registry from the pins in registry/sources.json (fetches from huggingface.co)
bun scripts/gguf-parity.ts <file.gguf> # compare the GGUF reader with @huggingface/gguf
```

On Linux, set `BASSAE_REQUIRE_SANDBOX=1` to make the sandbox tests fail rather than skip when `bwrap` can't run.
