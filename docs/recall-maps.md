# Recall maps — navigable memory maps and prompts for agents

> ⚠ **Naming collision, unresolved:** "Recall" already names the
> memory-recall agent Remy ([`recall.md`](./recall.md) — `find_window` /
> `recall_window`, replaying past conversation). This system arrived as
> "Recall" too (Jason's pick, 2026-08-23) before the clash surfaced.
> Nothing technical collides (tables `recall_maps`/`recall_nodes`, tags
> `recall`/`prompt` are all new), but the S2 tool names and the final
> product name need Jason's call — task `97cf7850` tracks it.

S1 (this document's scope): the serving tables and the compiler. The MCP
tools, the flight recorder, internal auto-match, and the viewer are S2–S5 —
see the design page "Recall — architecture plan v1" on the dev brain
(roadmap task `97cf7850`).

**The spec in one sentence: maps you walk, prompts you match, recalls you
watch — inside and outside, from one store.**

## The model

- A **map** is a page tree whose ROOT page carries the `recall` tag. Every
  page in the tree compiles into a serving row. The root is the map's
  **index**.
- A **prompt** is a page tagged `prompt` — the actual prompt text, embedded
  (768-dim, the standard embedder) so `recall_match` (S2) can find it by
  meaning. A page tagged `recall` + `prompt` with no sub-pages is a
  standalone prompt.
- Pages are the AUTHORING layer; `recall_maps` / `recall_nodes` are the
  compiled SERVING layer (`packages/db/src/schema/recall.ts`, migration
  `0153`). Rows are a build artifact — the `app_build` source→artifact
  pattern applied to knowledge. Never edit them directly.

## Authoring conventions

- **Options** — a node's next steps — live in a trailing `## Options`
  section: one bullet list of
  `- [label](page:<id>) — use when …`
  A mention chip (`[label](mention:node:<id>)`) or a child-page card works
  identically as the target. Options are affordances ("use when …"), never
  commands.
- **Use when** — a prompt opens with a `Use when: …` paragraph (within its
  first three blocks); that line is what the matcher shows callers. The map
  ROOT's use-when line becomes the catalog's `enter_when`.
- **Budget** — a node body (rendered markdown, Options excluded) is capped
  at 6,000 characters (`RECALL_BODY_CHAR_BUDGET`). Character-based on
  purpose; the repo has no tokenizer and does not want one.

## The compiler

`packages/content-core/src/recall-compile.ts` is the pure parse/lint core;
`packages/content/src/recall.ts` walks the tree and owns the rows. It runs
from four hooks in `pages.ts` — commit, update (title/tags/doc), delete,
move — always for the WHOLE map, and never throws into the page write.

**Lint blocks the COMPILE, never the commit.** A page with lint errors
still publishes as a normal page; the map keeps serving its last good rev
and the report lands in `recall_maps.last_compile_report`
(`last_compile_ok = false`). Errors: missing option target or use-when,
malformed Options section, body over budget, prompt without use-when,
index without options, option target outside the map's tree. Warnings
(never block): orphan nodes, a prompt-tagged root with sub-pages.

**Slugs** are kebab-cased titles, deduped `-2`, `-3` in tree order
(root first, then creation order). The map's slug is its root's.

**Embeddings are the one async step.** Prompt rows land with a NULL vector
— servable by slug immediately, matchable seconds later once
`embedPendingRecallPrompts` (fire-and-forget after the write, embedding
cache reused) fills them in. A changed prompt drops its vector and
re-embeds; unchanged prompts keep theirs.

## Speed contract

Everything expensive happens at commit. A serving read (S2's
`recall_open`/`recall_go`) is one indexed row — no ProseMirror parsing, no
joins, no LLM. `recall_match` is one ANN probe on a partial ivfflat index
that only contains prompt rows.
