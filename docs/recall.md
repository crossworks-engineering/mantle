# Recall — navigable memory maps and prompts for agents

> Naming settled by Jason 2026-08-23: **Recall** is this system — the
> memory maps. The conversation-replay agent Remy, which used to carry the
> name, is now **[Replay](./replay.md)** (`replay_window`, groups `replay` /
> `replay-search`; migration 0154).

Built so far: S1 (serving tables + compiler, below) and S2 (the four
serving tools + the tier-1 hook). The flight recorder, internal
auto-match, and the viewer are S3–S5 — see the design page "Recall —
architecture plan v1" on the dev brain (roadmap task `97cf7850`).

## The serving tools (S2)

Four read-only builtins (`packages/tools/src/builtins-recall.ts`), granted
via the `recall-read` tool group (held by the persona; grantable to any
agent) and registered on the MCP surface for external callers:

- `recall_index()` — the catalog: each map's slug, title, `enter_when`.
- `recall_open(map)` — the map's index node: content + options.
- `recall_go(map, target)` — any node by slug: content + its options.
- `recall_match(need)` — top ≤3 PROMPTS by meaning: pointers only
  (`map`, `target`, `use_when`, score); open the winner with `recall_go`.

All four accept an optional `intent` line — the flight-recorder field,
recorded from S3. A map whose newest edits failed lint serves its last
good rev with an honest note attached.

**The tier-1 hook**: `MANTLE_MCP_INSTRUCTIONS` (packages/mcp-core) rides
both MCP entry points (stdio + `/api/mcp`) — the ONE surface a client
auto-loads besides the tool list. It tells every connecting agent that
Recall exists, to `recall_match` before a distinct task, and to pass
`intent`. Static by design: the live catalog is one `recall_index` call
away, so a static string can never go stale against it.

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
  purpose; the repo has no tokenizer and does not want one. A map is capped
  at 100 members (`RECALL_MAX_MAP_NODES`) — the compiler recompiles the
  whole map per member commit, and past that a "map" is a corpus.
- **The `recall` and `prompt` tags are OWNER GESTURES.** Agent-facing page
  tools strip both (`builtins-pages.ts`, `stripOwnerOnlyTags`): agents may
  draft map and prompt pages freely, but only the owner — in the editor —
  turns a tree into a served map or a page into an auto-matchable prompt. That single human act is what backs the security model's
  "owner-authored only" claim; without it, an injected agent could plant a
  prompt that recall_match would then serve to every caller.
- **Source pages leave general search.** Once a tree is a map, the
  extractor indexes its pages metadata-only (title + tags — the secrets
  posture), so prompt and map text never surfaces via `search_chunks`,
  ambient team-turn retrieval, or node search. The compiled rows are the
  ONLY serving surface for the content. New maps trigger a one-time
  re-ingest of their members to drop already-indexed chunks.

## The owner HTTP API (the UI's read side)

Session-auth routes for the jackdaw surfaces (roadmap tasks `073b322d` /
`91c93428`); DTOs in `@mantle/client-types` (`types/recall.ts`):

- `GET /api/recall/maps` — the catalog + compile state. Unlike
  `recall_index`, it INCLUDES never-compiled maps: a failed compile is
  exactly what the owner must see.
- `GET /api/recall/maps/:id` — one compiled map: nodes + options + the
  last lint report. Node ids are source page ids, so every row is a
  click-through to the editor.
- `GET /api/recall/pages/:id` — this page's place in Recall (or
  `state: null`); backs the editor lint badge. Also finds pages that are
  only NAMED in a failing report (a new page that broke its map has no
  compiled row yet).

Read-only by design: authoring writes go through the normal page
draft/commit path — no separate Recall write surface. The one shared
writer is `recallOptionsMarkdown` (content-core): every author path (the
UI's routing editor, the future `recall_set_options` tools) emits the
`## Options` section through it, so human- and agent-authored options are
byte-identical and always round-trip through `parseRecallDoc`.

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

**Slugs** are kebab-cased titles, deduped against every emitted slug
(`-2`, `-3`, counting up until free) in tree order — root first, then
creation order with id as tie-break. The map's own slug additionally
dedupes against the owner's other maps. The serving write is
delete-then-one-batch-insert, so slug handoffs between renamed pages can
never trip the unique index mid-transaction.

**Embeddings are the one async step.** Prompt rows land with a NULL vector
— servable by slug immediately, matchable seconds later once
`embedPendingRecallPrompts` (fire-and-forget after the write, embedding
cache reused) fills them in. A changed prompt drops its vector and
re-embeds; unchanged prompts keep theirs.

## Speed contract

Everything expensive happens at commit. A serving read (S2's
`recall_open`/`recall_go`) is one indexed row — no ProseMirror parsing, no
joins, no LLM. `recall_match` is one ANN probe on a partial HNSW index
that only contains prompt rows — plus one embed of the query line, which
is the real latency variable (a provider call on cache miss; the DB side
is sub-millisecond).
