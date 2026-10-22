# registry/

Checked-in data that `src/registry/` reads. Nothing in bassae writes here at scan
time; only `scripts/build-registry.ts` rewrites `known-good.json` and `templates/`.

| File | What it is |
|---|---|
| `sources.json` | The repo@commit pins the registry is built from. Edit this, then rebuild. |
| `known-good.json` | One entry per template found at a pin: `family`, `repo`, `revision` (40-hex commit), `path` in the repo, `templateName`, `sha256`. |
| `templates/<sha256>.jinja` | The exact bytes of each distinct template, named by their SHA-256. |
| `precedence.json` | Which source each runtime loads as the default template, with upstream citations (ISC-7.4). |
| `transforms.json` | Content transforms that upstream templates apply on purpose, each citing the lines that do it. |

## Known-good templates (ISC-24, ISC-24.1, ISC-24.2)

`loadRegistry()` reads `known-good.json`, hashes every `templates/<sha256>.jinja`
and throws when one does not hash to its name. It also throws on an unknown
field, a revision that is not a 40-hex commit, a path outside the repo, a
duplicate entry, or a pinned text that is not UTF-8.

A scanned template matches:

- **exact**: its SHA-256 equals an entry's. Status `known-good`.
- **whitespace**: its runs of non-whitespace, in order, equal an entry's. CRLF
  against LF, re-indentation and trailing newlines match. `do not` against
  `donot` does not. Status `known-good-variant`.
- **none**: anything else.

Whitespace means ASCII whitespace only: tab, LF, VT, FF, CR and space. An inserted
U+FEFF, U+00A0, U+200B or U+2028 is a change, never a variant, because those are
how hidden text gets into a template (ISC-21). A template whose bytes are not
UTF-8 never matches as a variant.

When several entries share a text, the match names the entry pinned to the
template's own repo (from its HF cache path), then the one with its template
name, then the first in file order.

### Building

```sh
bun scripts/build-registry.ts
```

For each pin in `sources.json` the script:

1. Asks `https://huggingface.co/api/models/<repo>/revision/<commit>` for the file
   list, and refuses a repo that is gated or private, or a commit that resolves to
   another. No token is ever sent.
2. Downloads each template-bearing file from
   `https://huggingface.co/<repo>/resolve/<commit>/<file>` into a fresh temp dir
   outside the repo, reads it with `readHfModel`, then removes the dir. Entries
   therefore carry exactly the SHA-256 a scan computes.
3. Reads the GGUF files listed under `gguf` with HTTP range requests, up to the end
   of the KV section.
4. Rewrites `known-good.json` and `templates/`, then loads the result to check it.

Template content is only ever fetched from the pinned upstream commit, never
copied from a local model. Local models only suggest which repos are worth
pinning:

```sh
bun scripts/registry-coverage.ts [--verbose]
```

That script is offline. It matches every template under `~/.cache/huggingface/hub`
and `~/.omlx` against the registry and prints the exact / whitespace / none counts.
With `--verbose` it also prints each model's runtime precedence, shadowed
templates and divergences.

## Runtime precedence (ISC-7.4)

`order` lists, per runtime profile, the source kinds it reads in priority order.
`rules` refines that where a runtime does more than "first kind wins":

| Rule | Meaning |
|---|---|
| `defaultNames` | Names in a kind that load as the default, highest first. |
| `failsWhenPresent` | The runtime raises, and loads no template, when every kind in a set is present. |
| `ignoredWhenPresent` | A kind is not read while any of the listed kinds exists. |
| `names` | The only names read from a kind. |
| `builtinWhenHint` | A model hint makes the runtime use a built-in template instead. |
| `cStrings` | GGUF keys and values end at their first NUL, and the first key wins. |
| `fallback` | When the default is absent or one of `whenDefaultIs`, load `name` instead. |

`provenance` cites the upstream tag, commit, file and lines each profile was read
from. `notes` explains each rule. When an upstream release changes its loading
code, re-read those lines at the new tag and update the table and its citation
together.

A template that no runtime loads under any name, in a kind some runtime reads, is
marked `shadowed`. It is still returned and scanned. `checkIntraModel` reports one
MEDIUM `intra_model_divergence` per pair of same-name templates whose bytes differ
(ISC-7.5), up to 32 pairs plus one summary finding.

## Transforms

Each entry in `transforms.json` names a transform an upstream template applies on
purpose, such as dropping past `<think>` blocks, and cites the pinned template
lines that do it. Every cited repo@commit is pinned in `known-good.json`, so the
cited lines can be checked against the bytes in `templates/`.
