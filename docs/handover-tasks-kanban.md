# Handover: the Tasks Kanban upgrade (2026-08-17)

`/tasks` grew from a personal checklist into a project surface: a Kanban board,
a four-state lifecycle, checklists inside a task, and comments from logins,
team members and agents.

> ## ⚠ SUPERSEDED — 2026-08-17
>
> **The landing sequence below has happened.** mantle is released and pushed
> (`v0.230.67`, contracts published); jackdaw's `file:` pins are gone and its
> branch is merged to `main`. Most of the polish backlog is done too — the
> quick-toggle, the board's Blocked column, the comment thread, plus archiving
> and resizable panes that this document never anticipated.
>
> **The live handover is `docs/handover-ui-consistency.md` in the jackdaw
> repo.** Read that instead. Landmines 2–5 below are still true and are
> restated there; landmine 1 (the version field) is resolved.
>
> Kept for the audit trail and the throwaway-brain recipe at the end, which is
> still the way to get a scratch environment up.

The feature itself is documented where it lives,
[`content.md`](./content.md) §Tasks (data shape, routes, comments, archive)
and [`realtime.md`](./realtime.md) (the two new channels), so this file covers
only **state, landmines, and what is left to do**.

## Current state

| Where | Branch | Head | Notes |
|---|---|---|---|
| mantle | `main` | `style(tasks): prettier formatting on the patch route` | version field says **0.230.66**, but that release commit is **not** HEAD (a style commit landed after it) and **no `v*` tag exists** for it |
| mantle | `claude/tasks-kanban-audit-7c9be4` | merged into main, rebased | worktree branch; safe to delete once the release is out |
| jackdaw | `feat/tasks-kanban` | `fix(tasks): review-pass fixes — drag math, revert scope, conventions` | 3 commits, **unmerged**; working tree carries dev-only edits (below) |

**Working tree in jackdaw is deliberately dirty.** Three `package.json` files
point `@mantle/client-types` at a local `file:` path so the UI could compile
against unreleased contract types:

```
package.json                 pnpm.overrides
client/web/package.json      dependencies
packages/web-ui/package.json dependencies
```

Those, plus `pnpm-lock.yaml` and the generated `client/web/next-env.d.ts`, must
be reverted to the published `@crossworks/client-types@<new version>` before the
branch merges. They are intentionally **not committed**.

## Landmines (read before touching anything)

1. **The version field is ahead of the last release commit.** `merge-branch.sh`
   made the `release: v0.230.66` commit, then a formatting fix landed on main
   after it. Bump again before tagging so the tag's tree matches its version.
2. **Never let a drag re-index.** `updateTask`'s `contentChanged` compares
   **values**, not presence, precisely because the board PATCHes
   `{status, rank}` on every drop with the status usually unchanged. A
   presence test there wipes `summary` + `embedding` and queues an extractor
   LLM pass per drag. There is a live check for this in the verification
   section below, re-run it after any edit to that function.
3. **drizzle renders `${table.column}` in raw `sql` as a bare, unqualified
   column name.** Inside a subquery it therefore binds to the *inner* table.
   The comment-count correlation hit this and silently returned 0 for every
   row. Qualify by hand: `` sql`… where nc.node_id = ${nodes}."id"` ``.
4. **Rank keys must never end in `0`.** `RANK_RE` enforces it at every door.
   A stored `0` makes `rankBetween` emit a key *outside* its own upper bound.
5. **`open` no longer means "not done".** Anything filtering tasks by status
   equality needs the `active` filter (`<> 'done'`) instead, the team-request
   queue was already caught doing this. Grep for `'done'` before adding a
   consumer.

## Landing sequence (needs Jason)

1. **mantle**: bump (see landmine 1), push `main`, push the `v*` tag. The tag
   triggers CI, which publishes the `@crossworks/*` contract packages.
2. **jackdaw**: revert the three `file:` pins to the published version, `pnpm
   install`, `pnpm verify`, commit the pin bump, merge `feat/tasks-kanban`.
3. **Release pair**: client-pair bump + patch mantle release, per
   [`update-prod.md`](./update-prod.md) (`client-pair.tag` names the jackdaw
   client tag a release ships with). Never chain merge && tag.
4. **Deploy dev**, then check `/debug/integrity`, walk a real board, and
   confirm the extractor queue stays quiet while dragging.

## Polish backlog

Ordered by what a user would notice first. Nothing here is a known defect in
the shipped path, these are the deliberate deferrals.

### 1. The quick-toggle is binary over a four-state vocabulary
`client/web/app/(app)/tasks/tasks-client.tsx` → `toggleStatus`.
The list checkbox maps *anything not done* → done, and done → **open**. So
ticking a Blocked task and unticking it to undo lands it on To do, losing the
state with no undo. The detail pane has a proper `Select`; the highest-traffic
control does not. Options: remember the prior status and restore it on untick,
or render the status pill instead of a checkbox for non-open/done rows.

### 2. The board ignores a deep-linked status filter
Switching views now clears `?status=`, but `/tasks?status=blocked&view=board`
still loads every column, so a shared link shows something other than what its
URL says. Either honour it (dim/hide the other columns) or strip it on load.

### 3. The mobile companion still thinks tasks are binary
Separate repo. Its model flattens `in_progress`/`blocked` to "not done" and its
toggle rewrites them, same shape as item 1 but remote.
[`mobile-companion-backend.md`](./mobile-companion-backend.md) carries the
updated contract note; the app needs a status picker.

### 4. `rank` is hand-copied across the repo split
`client/web/lib/rank.ts` duplicates `packages/content/src/rank.ts` byte for
byte because the server copy lives in `@mantle/content` (which imports the DB).
The pure helper belongs in `@mantle/content-core` (browser-safe, already a
jackdaw dependency); then the client imports it and the copy dies. Today the
**untested** copy is the one that generates keys, `rank.test.ts` only guards
the server side.

### 5. Two comment threads, one anatomy
`app/(app)/tasks/task-comments.tsx` (owner) and
`components/team-workspace/team-task-comments.tsx` (member) duplicate the role
chip, the post row, the empty state and the composer; only the transport, the
chip labels and the delete affordance differ. Extract a presentational
`CommentThread` into `packages/web-ui` (precedent: `forum-meta.tsx`) with two
thin wrappers. The member surface is the one nobody opens in local dev, so it
is the one that will silently drift.

### 6. Three parallel status maps
`app/(app)/tasks/task-meta.ts` holds `STATUS_LABEL`, `STATUS_BADGE` and
`STATUS_DOT` as separate `Record<TaskStatus, string>`. One
`Record<TaskStatus, {label, badge, dot}>` makes a fifth status a single
compile-checked edit instead of three that can each be forgotten.

### 7. `countTasks` runs even where nothing reads it
`server/web/app/api/tasks/route.ts` and the `task_list` tool always run the
count in parallel with the page. Skip it when the page obviously fits
(`rows.length < pageSize && page === 1` ⇒ `total = offset + rows.length`);
the board never renders `total` at all.

### 8. `rank` sorts from JSONB
`data->>'rank'` is a bare JSONB expression sitting ahead of `due_at` (which
*has* an expression index) in the ORDER BY. A real column, or at least
`CREATE INDEX … ON nodes ((data->>'rank')) WHERE type='task'`, matches the
altitude the rest of this schema works at.

### 9. Comment counts refresh via the realtime echo
`task-comments.tsx` no longer invalidates the whole `['tasks']` tree per
comment (that refetched a 500-row board to move a badge from 2 to 3). The
count now repaints when the debounced `comments_changed` echo arrives. Exact
would be a `setQueryData` bump on the one row; today a client with a dead SSE
connection sees the count lag until its next refetch.

### 10. Test coverage for the parts that broke
Both drag bugs found in review (neighbours read from the unsorted list;
self-drop treated as append) were caught by reading, not by a test. Extract
the drop math into a pure `computeDrop(columns, activeId, overId)` and unit
test it. The comment routes (owner/member/moderation/cascade) were verified
live only, no route tests exist.

## Deliberately not built

- **Assignees.** Single brain, every login is a full admin; comments carry the
  attribution. Revisit only if the team model grows tiers.
- **Projects as a node type.** Tags do the grouping and the board filters by
  them. A `project` node is a bigger decision than this feature needed.
- **Comment editing UI.** `PATCH /api/comments/[id]` exists and is
  author-bound; nothing calls it yet.

## Verification already done (don't redo it)

- `pnpm verify` green in both repos; migrations replay clean from `0001` to
  `0150` on a scratch pgvector container.
- Live API pass on a throwaway brain: four statuses, checklist round-trip,
  rank persistence, owner + member + agent comments, the share gate (a member
  cannot comment on an unshared node), owner moderation, and FK cascade on
  task delete.
- Live UI pass in a browser against that brain: board renders and drags
  (persisted with rank), checklist ticks, comments post, and a change made
  through the API repaints the open board with no reload.
- Eight-angle code review over both diffs: ten findings, all fixed, all
  re-verified live. The four that mattered: the drag re-index leak, the drag
  neighbour/self-drop math, the team-request queue dropping moved requests,
  and the zero-tail rank key.

### Re-running the throwaway brain

The pattern (no live data at risk, and it is how the audit ran):

1. On the Linux workstation, add a git worktree at the branch under test and
   `pnpm install`.
2. Start a scratch Postgres: the `pgvector/pgvector:pg18` image with
   `infra/postgres/init` bind-mounted to `/docker-entrypoint-initdb.d` (the
   `auth` schema comes from those init scripts, **not** from a migration, a
   plain container fails the replay), then run the migrator against it.
3. Copy the box's `.env.local`, repoint `DATABASE_URL` at the scratch DB, and
   add `MANTLE_API_CORS_ORIGINS` for the client origin.
4. Run the brain on a spare port; run the jackdaw client detached against it
   (`docs/db-less-dev.md` in that repo).
5. Sign up a throwaway login, then stamp `onboardedAt` into `profiles.
   preferences` to skip the wizard, tasks need none of what it provisions.

Tear down the container, the worktree and the temp branch when finished.
