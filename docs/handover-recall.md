# Handover — Recall (memory maps for agents), S1+S2 built and audited

*Written 2026-08-24 for a fresh session. Everything here is verifiable; where
it matters, the proof is named.*

**The spec in one sentence: maps you walk, prompts you match, recalls you
watch — inside and outside, from one store.**

## 0. Where you are

- **Branch:** `feat/recall-s1`, worktree
  `/Users/jasonschoeman/Projects/mantle/.claude/worktrees/recall-s1`, pushed
  to origin. UNMERGED — Jason gates merge + release, and has not yet said
  "ship it to dev".
- **State:** `pnpm verify` fully green (4,209 tests). Commits, in order:
  `fed7c640` S1 (tables + compiler + lint) · `3a0abf73` the Replay rename ·
  `56cb3017` S2 (four tools + tier-1 hook) · `63ef6121` audit hardening
  (nine findings) · `09a59fdc` prompt-tag guard.
- **The registry of record:** dev-brain task `97cf7850-6c0f-444f-8450-ff4ac1c0ea5b`
  — the WHOLE design history lives in its body + comments (four voice notes,
  six settled decisions, the audit record, S7 scope). Architecture plan:
  dev-brain page `bb38c72f-d537-4e4d-a6bc-9db4616c10fa` ("Recall —
  architecture plan v1"). Feature doc in-repo: `docs/recall.md` (current),
  `docs/replay.md` (the renamed old feature).

## 1. What Recall is, in one paragraph

Owner-authored memory for agents, served fast. A **map** is a page tree whose
ROOT the owner tags `recall`; every node ends in an `## Options` list
(`[label](page:<id>) — use when …`) and agents WALK it by structure. A
**prompt** is a page the owner tags `prompt` ("skills, but the actual
prompt"); prompts are embedded and agents MATCH them by meaning
(`recall_match`) — that similarity match is the "automatic, unlike skills"
mechanism. Pages are the authoring layer; commit COMPILES them into serving
tables so every read is one indexed row. Two audiences, one store: internal
agents (persona holds the `recall-read` group) and any MCP caller (tools +
`MANTLE_MCP_INSTRUCTIONS`, the tier-1 hook — the only surface a client
auto-loads).

## 2. What is built (S1 + S2 + hardening)

- **Migration 0153**: `recall_maps` + `recall_nodes`, partial **HNSW** index
  over prompt embeddings (NOT ivfflat — 0060 retired it; empty-table ivfflat
  warns "low recall"). **Migration 0154**: the Replay rename converged on
  live rows, per-owner guarded on BOTH group renames and agent rewrites.
- **Compiler**: pure core `packages/content-core/src/recall-compile.ts`
  (13 tests, built on the real markdown→doc pipeline); DB half
  `packages/content/src/recall.ts`; hooks in `pages.ts` on create / commit /
  update / move / delete, all no-throw. Whole-map recompile per member
  commit; cap 100 members; bodies capped 6,000 CHARS (repo has no tokenizer
  — deliberate). Lint errors block the COMPILE never the commit; the map
  serves its last good rev; report on `recall_maps.last_compile_report`.
  Serving write is delete-then-one-batch-insert (slug handoffs cannot trip
  the unique index); embeddings carry forward for unchanged prompts and
  refill fire-and-forget (`embedPendingRecallPrompts`; no sweep until S3).
- **Four tools** (`packages/tools/src/builtins-recall.ts`, group
  `recall-read`, persona-granted, MCP-registered): `recall_index`,
  `recall_open`, `recall_go`, `recall_match` (pointers only, ≤3). All take
  optional `intent` — accepted, deliberately DROPPED until S3 records it.
- **Trust model, enforced**: `recall` and `prompt` tags are OWNER GESTURES —
  `stripOwnerOnlyTags` in `builtins-pages.ts` strips them from every
  agent/MCP page tool. Agents draft; the owner activates in the editor.
  Recall-tree pages are indexed METADATA-ONLY by the extractor (secrets
  posture) so prompt text cannot leak into search or team-turn retrieval; a
  newborn map re-ingests its members once to drop old chunks.

## 3. The Replay rename (done, easy to trip over)

"Recall" used to be Remy's conversation-replay feature. Jason renamed that
feature **Replay** (option 2): tool `recall_window` → `replay_window`, groups
`recall`/`recall-search` → `replay`/`replay-search`, `builtins-replay.*`,
`docs/replay.md`. `recall_eval` is UNTOUCHED (names the retrieval metric).
The stage-label search bucket gained the `replay` prefix. Grep for the old
names before assuming anything about "recall" in older docs — historical
handover/audit docs were deliberately left unswept.

## 4. The audit (read this before "improving" anything)

Three parallel reviewers + live scratch-DB tests on the dev box found nine
real defects; all fixed in `63ef6121`. The ones that shape the code you'll
read: `recall_match` originally used SQL aliases with drizzle-qualified
columns — **an alias hides the table name in Postgres; every call threw**.
Never alias tables in drizzle raw SQL here. Compile-transaction aborts were
SILENT (rollback reverts the report write too) — that's why the write path
is delete-then-batch-insert and slugs dedupe against emitted values and
per-owner map slugs. Scratch-DB recipe that proved it (reuse for anything
similar): `ssh dev`, `docker exec mantle_pg psql` — create db, `CREATE
EXTENSION vector`, pipe in `0153`, insert fixtures, run the rendered SQL,
drop the db. Accepted watch-items: embed double-fire under rapid commits
(bounded), match latency dominated by the query-embed provider call on cache
miss.

## 5. What is NOT built, as tasks (all tagged `mantle-roadmap` + `recall`)

| id | what | note |
|---|---|---|
| `0e3caddc` | `recall_report` tool (compile state + lint for agents) | HIGH — Jason leaned yes on pulling it into this branch pre-ship (~1h, same shape as the other four) |
| — (in `97cf7850`) | **S3** recorder: `recall_walks`, fire-and-forget, session grouping, ~90-day sweep; start recording `intent` | |
| — (in `97cf7850`) | **S4** internal auto-match in prompt-build (inject beside task-skills; per-agent toggle + score floor) | |
| — (in `97cf7850`) | **S6** dogfood: registry map on dev + cold-session acceptance test | the next real milestone |
| — (in `97cf7850`, latest comments) | **S7** authoring toolset: `recall_report`, `recall_add_node`, `recall_set_options`, `recall_update_node`, `recall_propose_map/prompt` via the existing pending-approval machinery | agents build, owner blesses |
| `073b322d` | UI: maps catalog + editor lint badge (mantle `/api/recall/*` routes + contract bump + jackdaw) | Recall has NO UI today; the page editor + tag field are the authoring surface |
| `813c4e1e` | UI: `/recall` viewer — graph, walk replay, heat (S5) | depends on S3 |

## 6. The next action, verbatim

Awaiting Jason's **"ship it to dev"**. Then: (1) optionally build
`recall_report` on the branch first; (2) merge to mantle main, cut the
release (Jason gates; releases are cut but NOT pushed/rolled without him);
(3) roll the DEV brain only — migrations 0153/0154 apply on roll; (4) author
map #1 via MCP: the Mantle registry (docs 1/2/2a/3 from the dev brain, page
tree + one or two prompt pages); (5) Jason's two tag clicks in the editor
(`recall` on the root, `prompt` on prompts) — the first live owner gesture;
(6) the acceptance test: a COLD Claude Code session, MCP connection only,
told to work on the fleet — it must reach the right knowledge via the map
faster than grep/search, recall_match must surface the right prompt, and a
deliberately broken link must hold the last good rev with the report
visible. If it flies, shrink the git-synced `mantle-recall` skill to a stub
that enters the map.

## 7. Unrelated work completed this same session (context, all shipped)

Jackdaw (the client repo): **v0.6.11** — Pages content centering
(`MeasurePane` rebuilt: centered measure, 2× drag, persisted width; preview,
focus mode, team readers) and **v0.6.12** — leaf page cards show their
updated stamp (`updatedAgo`). Both merged, released, and **rolled to the
whole fleet including Shahin's box** (client tag pinned in each box's
`~/mantle/.env`, dev uses `~/stack-rehearsal`, NATREF `/opt/mantle`). Fully
recorded in the working-memory page + Feature Tracker on the dev brain.

## 8. Session hygiene notes

- Mantle worktrees: `scripts/new-worktree.sh`; this one is `recall-s1`.
  Next migration number: **0155** (`meta/_journal.json` `when` must exceed
  the 0154 entry's).
- `pnpm verify` before pushing, always. Prettier will complain about your
  new files; run it on them.
- Contract order for anything touching jackdaw: land mantle → publish
  packages → bump the pin in jackdaw.
- Run `/mantle-recall` at session start (fleet access, brain ids) and
  `/mantle-status` for live state; the dev brain task `97cf7850` is the
  single source of truth for Recall decisions — append comments there as
  you go, and keep the working-memory page (`79e7cebc`) a MAP, not a log.
