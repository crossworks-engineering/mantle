# Pipeline templates (made up)

Two templates of an own Reader for the made-up "LX-9 data logger" export
(`.lx9`), one in TypeScript on Bun and one in Python. Both read
`sample.lx9` into two tabs, `Readings` and `Header`. How to install one, and
the rules of an own package: [docs/pipelines.md](../pipelines.md), "Own
pipelines".

- `bun/`: `pipeline.json`, `step.ts` (the entry), `read.ts`, and
  `mantle-pipeline.d.ts`, the contract's types (copy it into your package).
- `python/`: `pipeline.json` and `step.py`. The parser starts `step.py` with
  the job's folder as its one argument. It reads two files there and writes
  one:
  - `request.json`: `{ "api", "step", "file": { "name", "ext", "size",
"sha256" }, "options": { ... } }`.
  - `in.bin`: the file's bytes.
  - `result.json` (written by the step): `{ "status": "ok" | "not_mine" |
"failed", "warnings": [...], "calls": [{ "call": "tool", "tool":
"file_tabs_write", "input": { "tabs": [{ "name", "columns": [{ "name",
"type" }], "rows": [[...]] }], "description" } }] }`.

Both read `.lx9`, and a box has one Reader for each extension: install one
of them at a time.
