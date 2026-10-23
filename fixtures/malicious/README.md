# Malicious corpus

Templates and models that must be caught (ISC-32, ISC-33). Each class folder holds its fixtures, a README saying
where each came from and what it does, and an `expected.json` listing the findings each must raise:

```json
{ "fixtures": [{ "path": "codeexec/dunder_dot.jinja", "expect": [{ "ruleId": "dunder_access", "severity": "HIGH" }], "tags": [] }] }
```

- `path` is relative to this folder. A `.jinja` file is scanned with `--template`; anything else (a model folder,
  a GGUF, an HF cache) is scanned as a path.
- `expect` lists findings the scan must raise, at exactly that severity. Others may fire too.
- `tags` names the attacks of ISC-32 a fixture stands for, such as `CVE-2024-34359` or `date-bomb`.

`test/corpus/recall.test.ts` scans the whole corpus once through the real command and checks every entry. It also
checks that every fixture on disk is listed, that every rule able to raise HIGH is expected at HIGH somewhere,
and that every attack ISC-32 names has a tagged fixture.

If a change to the rules stops a fixture from firing, the rule has regressed: fix the rule, never the fixture.

Every payload is inert. Commands are placeholders such as `id`, and every host is under `example.com`, `.net` or `.org`.
