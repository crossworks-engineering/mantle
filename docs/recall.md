# Recall — navigable memory maps and prompts for agents

> Naming settled by Jason 2026-08-23: **Recall** is this system — the
> memory maps. The conversation-replay agent Remy, which used to carry the
> name, is now **[Replay](./replay.md)** (`replay_window`, groups `replay` /
> `replay-search`; migration 0154).

Built so far: S1 (serving tables + compiler, below) and S2 (the four
serving tools + the tier-1 hook). The flight recorder, internal
auto-match, and the viewer are S3–S5 — see the design page "Recall —
architecture plan v1" on the dev brain (roadmap task `97cf7850`).

## v2: a map is its own item

Everything below describes **v1**, where a map is a page tree whose root
carries the `recall` tag and the serving rows are compiled from it. v2
replaces that authoring layer: a map is one `recall` item in the tree, and
its cards are rows written directly. The serving contract does not change —
the four tools keep their names and shapes, and the additions are extra
fields. Plan: "PLAN: Recall v2, its own content type" on the dev brain
(roadmap task `5d6ce06a`).

Why: in v1 the checks run **after** the commit. A page that breaks its map
publishes anyway, the map keeps serving its last good revision, and the only
sign is a note on every agent read. The dev brain's registry served a
revision from 2026-09-15 that way for a fortnight. In v2 the checks run
inside the write and a failing write is refused, so nothing is ever served
that failed one and there is no stale revision to explain.

What that means in practice:

- **A map is a `recall` node** under the `recall` tree root, filed in folders
  (at most three deep). Cards are rows, not nodes, so they never appear in the
  tree and a card has no access level of its own — a walk can never break
  halfway on an unreadable card.
- **No compile step, no lint lag.** `recall_maps` / `recall_nodes` are the
  source. A native map never carries the stale-revision note.
- **Refusals teach.** A body over `RECALL_BODY_CHAR_BUDGET` says to split the
  card; an option pointing nowhere lists the map's cards and suggests the near
  miss; a stale `version` says to re-read and resend.
- **Slugs are stored, not re-derived.** A retitle keeps the slug, because
  agents and skills remember slugs (`mantle-recall` hard-codes one). Changing
  a slug is explicit and the old one keeps resolving via `former_slugs`.
- **Agents may write cards; three things stay the owner's.** Publishing a map,
  making a card a prompt, and deleting a map. An agent's `prompt: true` records
  a request (`prompt_pending`) and the card never matches until confirmed. This
  is v1's rule carried over: an agent could edit pages inside a tagged tree but
  never add the `recall` or `prompt` tag. What an agent may change is what the
  brain knows, not what the brain tells other agents to do.
- **An agent that changes a confirmed prompt's words sends it back.** When
  an agent's write changes the title, `use_when` or body of a confirmed
  prompt, the card goes back to pending: no vector, no `recall_match` hits,
  until the owner confirms it again. The write result says so
  (`prompt_needs_confirm`) and the revision reads "prompt edited by agent,
  awaits confirm"; restoring it puts back the old words and the confirmed
  state. An agent edit that leaves the words alone (options only) keeps it a
  prompt, and the owner's own edits always do (Jason, 2026-09-30). An agent
  may still delete a prompt card; that is open.
- **Every write is logged** in `recall_revisions` (the last 50 per map), with
  the actor's kind and name (agent slug, `mcp`, or the admin's display name),
  which backs undo and the audit of agent edits. The latter matters
  precisely because an agent's card edit serves immediately.
- **Versions are real.** Every write locks the map row and compares the
  caller's `version`, so two writes from the same version cannot both land:
  the second is refused `version_stale` (409). Agents read the version from
  `recall_open` / `recall_go` and must send it to replace or delete a card.
- **Card writes are field-sticky.** `title` and `body` replace; `use_when`,
  `options` and `prompt` keep the card's value when left out. So a typo fix
  never demotes a prompt or drops an agent's pending request, and a caller
  that did not send `options` does not wipe the card's edges. An agent can
  never turn a confirmed prompt back into knowledge.
- **Restore puts back what that write replaced**: a card's content; a deleted
  card under its old slug, at its old place, with the options other cards had
  to it; the old order for a reorder; the map fields that write changed (the
  slug included). "map created" has nothing to restore. Undoing "card added"
  deletes the card.
- **Slugs are remembered.** A map's or card's former slugs keep resolving,
  and no other map or card may take them. A card slug changes only by an
  explicit owner write (`slug` on the card PUT); options in the map follow.
- **Sizes are capped** besides the body budget: titles 200 characters,
  `use_when` and `enter_when` lines 500, option labels 200, and 30 options
  per card. Every option needs a `use_when` line. A card cannot take the slug
  `reorder` (the reorder route owns it).
- **Following a cross-map option**: an option to another map is served as
  `{ target: X, map: X }`, and `recall_go(map: X, target: X)` lands on that
  map's entry card.
- **Client-marked turns**: every Recall write waits for the owner in a turn
  that read client text, because cards are the owner's guidance to agents and
  keep no client mark of their own.
- **Dead cross-map options are hidden.** An option to a map that is no longer
  published is left out of what agents read, and the owner gets a
  `cross_map_target_gone` warning on the next write.

Surfaces:

| Surface                   | What                                                                                                                                                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recall-write` tool group | `recall_map_create`, `recall_card_put`, `recall_card_delete`, `recall_map_update`. In no default grant inside the app. ALWAYS on the MCP surface (an MCP client holds the owner's token; decided 2026-09-30), where they still run as an agent.                            |
| Owner HTTP                | `POST /api/recall/maps`, `PATCH`/`DELETE /api/recall/maps/:id`, `POST /api/recall/maps/:id/cards`, `GET`/`PUT`/`DELETE /api/recall/maps/:id/cards/:card`, `POST …/cards/reorder`, `POST …/cards/:card/prompt`, `GET …/revisions`, `POST /api/recall/revisions/:id/restore` |
| Client contract           | `@mantle/client-types` (map summary gains `nodeId`, `folder`, `published`, `version`; a card gains `rank`, `promptPending`; an option gains `targetId`, `targetMap`)                                                                                                       |
| Capability flag           | `features.recallV2` in `GET /api/shell`. Absent on an older brain, so a client tests `features?.recallV2`.                                                                                                                                                                 |

### Over MCP

Every Recall act has an MCP tool, so the owner can do from an MCP client
what the editor does. An MCP client holds the owner's token.

| Tool                                                                              | What                                          | Actor                                        |
| --------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------- |
| `recall_index`, `recall_open`, `recall_go`, `recall_match`                        | read published maps                           | reader                                       |
| `recall_map_create`, `recall_card_put`, `recall_card_delete`, `recall_map_update` | draft maps, edit cards, retitle               | agent (also the in-app `recall-write` group) |
| `recall_pending`                                                                  | what waits: unpublished maps, prompt requests | owner (MCP only)                             |
| `recall_map_get`                                                                  | one map whole, published or not               | owner (MCP only)                             |
| `recall_prompt_confirm`                                                           | confirm, drop or demote a prompt              | owner (MCP only)                             |
| `recall_map_publish`                                                              | publish or unpublish a map                    | owner (MCP only)                             |
| `recall_map_delete`                                                               | delete a map (needs `confirm: true`)          | owner (MCP only)                             |
| `recall_cards_reorder`                                                            | order a map's cards                           | owner (MCP only)                             |
| `recall_revisions`, `recall_revision_restore`                                     | the log, and undo                             | owner (MCP only)                             |
| `recall_map_set_slug`, `recall_card_set_slug`                                     | explicit slug changes                         | owner (MCP only)                             |

The owner tools are `mcpOnly`: never in a tool group, so no in-app agent can
hold them. Their descriptions tell the model to call them only when the user
asked for that act in the conversation, and the confirm, publish, reorder and
slug tools take the map `version` the user was shown, so nobody approves text
that changed after it was shown. Their revisions read "owner (mcp)".

The owner UI (jackdaw, behind `features.recallV2`) is the v2 editor. Still to
come: re-authoring the dev brain's maps by hand (R4), retiring the v1
compiler (R5), and team-level sharing (R6; until then a Recall folder cannot
be shared at all). Read tools and write tools run on owner surfaces only.

**Keeping a v1 slug in R4.** While a v1 map exists its slug is taken, so a
native map with the same title gets `-2`. To carry a remembered slug (such as
`mantle-registry-start-here`) over: retire the v1 map first (untag its root
page, which deletes its rows), then set the slug on the native map with
`PATCH /api/recall/maps/:id { slug }`.
**v1 is not migrated by tooling** — it was experimental and is in real use
only on the dev brain, so its maps are re-authored and the v1 code is then
deleted.

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

## Authoring in the owner UI

Every part of a Recall page's shape used to be tribal knowledge: two
owner-only tags that appear nowhere in the UI, the leading `Use when:`
paragraph, and an Options block on the PARENT. The last one is a cliff:
`index-no-options` fires only once a root has children, so a fresh map is
green and adding the second page turns the map red with no hint that the
parent now needs routing. The `/recall` screen closes all three:

- **New → Map / Prompt** on the catalog, and **Add node** inside a map
  (`create-recall-dialog.tsx` in jackdaw). Creating a node WRITES the
  parent's option in the same action, through `withAppendedOption` →
  `recallOptionsMarkdown`, so the cliff above is unreachable by following
  the UI. A new map can seed its first node the same way.
- **A live preflight.** The dialog runs `parseRecallDoc` in the BROWSER.
  It is pure, so the author sees exactly the issues the server-side compile
  would raise, before saving. Doc-level rules only; the tree-level ones
  (`index-no-options`, `target-outside-map`, `orphan-node`) need the whole
  map and are what the create flow structurally prevents.
- **Make this a prompt**, from the page editor's Recall control. Commits
  the `Use when:` paragraph FIRST, then sets the tags. Tagging first would
  make the page a prompt for the instant before its use-when exists,
  recording a `prompt-no-use-when` failure the author never caused.

All of it goes through `POST /api/pages` and `POST /api/pages/:id/commit`,
which are owner-session-auth and have always accepted tags. **This is not a
loosening of the trust model.** `stripOwnerOnlyTags` guards the AGENT tool
surface (`packages/tools/src/builtins-pages.ts`), which is the boundary
that stops injected content becoming a served map. The owner setting the
tag through a form is the same single human act as typing it into the tag
field; do not "fix" the owner route by stripping there.

The map graph's option labels are a custom React Flow edge, not the
built-in `label`: an SVG `<text>` cannot truncate, cannot lift above a
neighbour, and takes raw fills rather than theme tokens, so labels piled up
on any branching map. They now render in `EdgeLabelRenderer` as truncating
chips with hover/focus tooltips, and the dagre layout RESERVES label space
rather than treating every edge as a bare line.

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
