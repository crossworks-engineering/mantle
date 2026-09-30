# Recall — navigable memory maps and prompts for agents

> Naming settled by Jason 2026-08-23: **Recall** is this system — the
> memory maps. The conversation-replay agent Remy, which used to carry the
> name, is now **[Replay](./replay.md)** (`replay_window`, groups `replay` /
> `replay-search`; migration 0154).

A map is one `recall` item in the tree, and its cards are rows written
directly (`recall_maps` / `recall_nodes`, `packages/db/src/schema/recall.ts`).
Plan: "PLAN: Recall v2, its own content type" on the dev brain (roadmap task
`5d6ce06a`). The flight recorder, internal auto-match and team sharing (R6)
are still to come.

**Page-built maps are gone (R5, 2026-09-30).** Recall v1 compiled a map from
a page tree whose root carried the `recall` tag, and a page tagged `prompt`
became a prompt. Its checks ran **after** the commit: a page that broke its
map published anyway, the map kept serving its last good revision, and the
only sign was a note on every agent read (the dev brain's registry served a
revision from 2026-09-15 that way for a fortnight). The dev maps were
re-authored by hand as native maps (R4), and R5 removed the compiler, the
page hooks, the editor lint badge, `GET /api/recall/pages/:id`, the compile
report fields, and the v1 screen. Migration 0209 deletes any leftover v1 row
(`node_id` NULL); nothing serves one. `recall` and `prompt` are ordinary page
tags again. Now the checks run inside the write and a failing write is
refused, so nothing is ever served that failed one.

## How a map works

What that means in practice:

- **A map is a `recall` node** under the `recall` tree root, filed in folders
  (at most three deep). Cards are rows, not nodes, so they never appear in the
  tree and a card has no access level of its own — a walk can never break
  halfway on an unreadable card.
- **No compile step, no lint lag.** `recall_maps` / `recall_nodes` are the
  source, so there is no stale revision to explain.
- **Refusals teach.** A body over `RECALL_BODY_CHAR_BUDGET` says to split the
  card; an option pointing nowhere lists the map's cards and suggests the near
  miss; a stale `version` says to re-read and resend.
- **Slugs are stored, not re-derived.** A retitle keeps the slug, because
  agents and skills remember slugs (`mantle-recall` hard-codes one). Changing
  a slug is explicit and the old one keeps resolving via `former_slugs`.
- **Agents may write cards; three things stay the owner's.** Publishing a map,
  making a card a prompt, and deleting a map. An agent's `prompt: true` records
  a request (`prompt_pending`) and the card never matches until confirmed. (v1
  had the same rule: an agent could edit pages inside a tagged tree but never
  add the `recall` or `prompt` tag.) What an agent may change is what the
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
| Owner HTTP reads          | `GET /api/recall/maps` (the catalog, drafts and empty maps included), `GET /api/recall/maps/:id` (cards without bodies, in rank order)                                                                                                                                     |
| Client contract           | `@mantle/client-types` `types/recall.ts` (R5 removed `lastCompileOk`, the map `report`, `RecallLintIssueDTO` and `RecallPageStateDTO`; `nodeId` is never null)                                                                                                             |
| Capability flag           | `features.recallV2` in `GET /api/shell`. Absent on a brain older than v2, so a client tests `features?.recallV2`. It stays true: a client without it would fall back to the retired v1 screen.                                                                             |

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

The owner UI (jackdaw, behind `features.recallV2`) is the editor. Read tools
and write tools run on owner surfaces only. Still to come: team-level sharing
(R6; until then a Recall folder cannot be shared at all).

**Moving a remembered slug onto a map.** A map's slug and former slugs are
taken for every other map. To give a native map a slug another map answers
to, retire or re-slug that map first, then set the slug with
`recall_map_set_slug` or `PATCH /api/recall/maps/:id { slug }`; the native
map's old slug keeps resolving as a former slug. On dev the v1 slugs
(`mantle-registry-start-here`, `mantle-status-workflow`,
`jackdaw-ui-standards`) are freed by untagging their roots while the v1 code
still runs, before the R5 release is rolled (docs/update-prod.md).

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
recorded from S3. Unpublished maps, pending prompts and leftover v1 rows
(`node_id` NULL) are filtered inside the queries, never after them.

**The tier-1 hook**: `MANTLE_MCP_INSTRUCTIONS` (packages/mcp-core) rides
both MCP entry points (stdio + `/api/mcp`) — the ONE surface a client
auto-loads besides the tool list. It tells every connecting agent that
Recall exists, to `recall_match` before a distinct task, and to pass
`intent`. Static by design: the live catalog is one `recall_index` call
away, so a static string can never go stale against it.

**The spec in one sentence: maps you walk, prompts you match, recalls you
watch — inside and outside, from one store.**

## Speed contract

Everything expensive happens on the write. A serving read (`recall_open` /
`recall_go`) is one indexed row — no ProseMirror parsing, no joins, no LLM.
`recall_match` is one ANN probe on a partial HNSW index that only contains
prompt rows — plus one embed of the query line, which is the real latency
variable (a provider call on cache miss; the DB side is sub-millisecond).
A new or changed prompt lands with a NULL vector — servable by slug at once,
matchable seconds later once `embedPendingRecallPrompts` (fire-and-forget
after the write, and refilled from `recall_match`) fills it in.

The caps are shared constants in `@mantle/content-core/recall-compile`
(the name is historical): `RECALL_BODY_CHAR_BUDGET` (6,000 characters per
card body, character-based on purpose) and `RECALL_MAX_MAP_NODES` (100 cards
per map). The editor's counter and the brain's write check read the same
constant.
