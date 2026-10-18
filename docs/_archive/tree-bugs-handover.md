# Tree bugs S11a-5 and S11a-6a (handover)

The branch `feat/tree-bugs`, cut from main 384b64d02 (v0.300.92). Two
product bugs the A8 tool matrix (S11a) recorded as known failures, fixed,
and taken off `packages/db/src/matrix/a8-known-failures.ts`, so their cells
pass as strict expectations.

## S11a-6a: a Write grant may rename its folder

The owner's rule (2026-10-18): Write on a folder allows its rename. Its
move, its indexing switch, its delete and its grants stay manage (a
Moderator of its home).

**Cause.** A rename rewrites the folder's subtree path, and three checks
asked manage of it, for a rename as for a move:

1. TypeScript: `renameNodeFolder` (`packages/content/src/tree/node-ops.ts`)
   asked `assertItemRight(folder, 'manage')` before its locks. This is the
   answer the matrix saw ("You cannot change this item in your
   workspaces").
2. SQL: `mantle_subtree_rewrite` (0282) asked manage of the folder's home of
   a write-role caller.
3. SQL: the move check (`mantle_nodes_acl_path_trg`, 0279's body) asked
   `mantle_may_manage` of each moved root, and edit of the folder it sits
   in, whether the root changed folder or only its own label.

The write check (`mantle_write_check_trg`, 'self' UPDATE) was not the
refusal: it asks edit of the folder row, which Write gives, and the subtree
rows are rewritten inside the definer (its triggers run WHEN current_user
is the write role, so they do not fire there).

**Fix.** Migration `0305_folder_rename_write` (journal idx 305, `when`
1790197620000, one minute above 0304's 1790197560000):

- `mantle_moved_nodes` gets `old_path`; `mantle_nodes_moved_row_trg` notes
  each moved row's old path, so the statement check tells a rename from a
  move by the row's own old and new path (never a setting a session could
  set).
- `mantle_is_folder_rename(old_owner, old_path, new_owner, new_path, type,
data)`: a folder (branch), the same owner, the same parent path and
  depth, not a system folder (`data.system`). No role may run it; the two
  definers call it.
- The move check asks `mantle_may_edit` of a renamed folder (no manage, no
  edit of the folder it sits in: a rename adds nothing there). Every other
  moved root is asked exactly as before.
- `mantle_subtree_rewrite` asks edit of a rename, manage of a move or of a
  system folder, as before. A rename still carries the rows the caller does
  not read (0282: filing is not editing).
- TypeScript: `renameNodeFolder` asks edit (manage for a system folder).
  The Files rename (`renameFolderById`) had no pre-check; the database
  decides it.

Header comment in the migration; re-runnable (`ADD COLUMN IF NOT EXISTS`,
`CREATE OR REPLACE`); `SET LOCAL lock_timeout = '30s'`.

## S11a-5: a member's move into another workspace's folder

**Cause** (found by S11a, confirmed): after the move, `followShares`
(`packages/content/src/tree/write.ts`) called `mantle_embeds_reached` in
the caller's scope; the function reads `node_embeds`, which no workspace
role reads (access-matrix.ts: `none`). The move had been made and
committed; the caller then got "the database could not run this request".

**Choice.** The share follow-up is the brain's bookkeeping, not the
caller's: the walk crosses `node_embeds` (no scope reads it) and the fold
writes the indexed text of every page reached, pages the caller does not
read or may not edit too (a page names an item only when every holder of
the page holds it). A narrow definer for the walk alone would leave the
fold in the caller's scope, where it would skip the pages the scope does
not read (stale text, which can name an item to a holder that does not
hold it) and be refused on pages it may not edit. So `followShares` runs
the walk and the fold as the named system step `'tree-refold'`
(`packages/db/src/system-step.ts`), as a grant change already folds pages
on the system pool (`server/web/lib/grants.ts`, `page-refold`):

- the start set is read in the caller's scope (the moved items it reads, as
  before);
- `systemStep('tree-refold', { items, need: 'read', only: 'allowed' }, fn)`
  asks read of them in the scope, then walks and folds on the system pool;
- nothing it reads goes back to the caller.

The grants panel's move into a folder (`/api/grants/move`,
`server/web/lib/grants.ts` moveToFolder) calls the same `moveTreeItems`, so
it had the same fault for every login (it runs in the login's scope since
F4); the same fix covers it, and a DB cell runs it in a member's request
scope (the S2a a1 audit found it through grants.db.test.ts).

The matrix test's `ALLOWED_KNOWN_ONLY` (`a8-tool-cells.matrix.test.ts`)
loses page_move and tree_item_move: their allowed cells pass now.

The move's own rules are untouched (`moveTreeItems` still asks manage of
every item first, the move check still asks manage and edit of the
destination). The same follow-up serves a folder's move and a folder's
delete, which had the same fault for a member.

## Changed answers

Recorded on main first (the full matrix at 384b64d02 on the workstation,
both tool modes): the only failures were the listed known ones. On the
branch:

| Cell / caller                                                            | main                       | branch             |
| ------------------------------------------------------------------------ | -------------------------- | ------------------ |
| `tool:tree_folder_update web-turn turn/writeGrant edit branch @folder`   | refused                    | allowed (the rule) |
| `tool:tree_folder_update mcp-oauth login/writeGrant edit branch @folder` | refused                    | allowed (the rule) |
| `tool:page_move mcp-oauth login/homeModerator move page @folder`         | database error (move made) | allowed, ok        |
| `tool:tree_item_move mcp-oauth login/homeModerator move recall @folder`  | database error (move made) | allowed, ok        |

The same rule changes these recorded answers in the older suites (each
updated, each a Write grant's or editOnly member's rename, refused before,
allowed now; a move stays refused):

- `packages/db/src/edit-check.db.test.ts` M3: the Write grant's
  `mantle_subtree_rewrite` rename moves every row (3), hidden ones too; a
  new line keeps its move (a new parent) refused, "not allowed to move this
  item".
- `server/web/server/precheck-removal.db.test.ts`: `tree_folder_update`
  rename and `folder_rename` lose `now: { editOnly: 'refused' }` (MCP and
  turn).
- `server/web/server/precheck-removal-http.db.test.ts`:
  `PATCH /api/files/folders/:id` rename and `PATCH /api/tree/:kind/folders/:id`
  rename need edit, not manage (the Files route already asked edit in
  TypeScript; the database asked manage).
- `server/web/server/a5-mcp-writes-smoke.db.test.ts`: the Write-only
  member's `folder_rename` is made (it was "folder_rename failed").

Also: `packages/db/src/schema/workspaces.ts` gets `old_path` on
`mantle_moved_nodes` (the schema drift check).

Beyond the matrix, one more answer of the same rule: a caller with edit of
a folder (Write on it) but not of the folder it sits in may rename it now
(a rename asked edit of the parent before, as a move does). The rename
adds nothing to the parent; the owner's rule names only the folder. No
other answer changes: a move, a delete, a system folder's rename, an
indexing switch and a grant change ask what they asked.

## Audit fix round (on v0.300.94)

The audit of fd1a5560f (8/10, fix first):

- M1: rebased on main e6f75059e (S4a); `historyCodeComments` re-measured,
  main's `failOpenSites` kept.
- L1: `followShares` passes its ids as one `uuid[]` parameter (the start
  set and the walk), never a bind per id, which stops at 65,535.
- L2: `followShares` is best effort: after the write it follows has
  committed, a failure is logged (one helper, `bestEffortFailed`, with the
  notify's line, so `consoleCalls` does not move) and the move is never
  reported failed for it (the grants panel's move counted it as failed).
- L3: the rename test reads the OLD row's system flag:
  `mantle_moved_nodes.old_system`, set by the row trigger from OLD;
  `mantle_is_folder_rename` takes it and the new data (a system folder
  before or after: manage). 0305 edited in place, `when` unchanged.
- L4 (accepted, a known limit): a Write member's rename into a name a
  sibling it does not read already holds is refused as a name clash, so
  the sibling's name shows.
- L5: DB cells for a Moderator's folder move and folder delete that change
  who holds a page: ok, and the page's text refolded (its link to an item
  held by H alone reads "Private item" once T holds the page, and its own
  words again once only H does).
- Nits: the `folder_rename` comment in `packages/mcp-core/src/mcp-defs.ts`;
  `tree-refold` in the system step table of
  `docs/_archive/actors-history.md`; the CI line below.

## Tests

`server/web/server/tree-bugs.db.test.ts` (warn and on, the actor and the
edit check together):

- a Write member renames a notes folder (MCP and a turn) and a Files folder
  (`folder_rename`); a row inside it the member does not read moves along;
- refused, nothing changed: the outsider, the read grant's member and a
  member with Write on a sibling item (MCP and a turn); the Write member's
  move and delete; an Admin-only folder; a system folder; a caller that does
  not read the folder gets a random uuid's answer byte for byte;
- in SQL on the write role: the subtree rewrite refuses a move and a system
  folder's rename to the Write member, and a rename to the read grant's
  member; it allows the Write member's rename; the move check refuses the
  Write member's direct move;
- the grants panel's move, in the request scope of a member: the read
  grant's member moves nothing; the Moderator of H and T moves a note into
  a folder homed in T (`{ moved: 1, failed: [] }`);
- a Moderator of H and T moves a page (`page_move`) and a note
  (`tree_item_move`) from H into a folder homed in T: ok, moved, T now holds it (its home stays H);
  the outsider, the read grant's member, the sibling Write member and the
  Write member (no manage) are refused.

## Renumber proof

Numbers are claimed at merge. If another lane lands 0305 first: rename the
file to the next free number, set its journal entry's `idx`, `tag` and a
`when` one minute above main's last, and change `FIX_MIGRATION` in
`server/web/server/tree-bugs.db.test.ts` (the test checks the entry exists
and its `when` is above the one before it). Nothing else names the number:
the code comments say "migration 0305" in `node-ops.ts`,
`a8-known-failures.ts` and this file (text only).

## Gates

On head d89d97a2f (rebased on main e6f75059e, v0.300.94, with the audit
round), Mac (no database, DATABASE_URL unset): `pnpm -r typecheck` 0,
`pnpm lint` 0, `pnpm format:check` 0, `pnpm docs:check` 0,
`pnpm arch:check` 0, `pnpm -C server/web build` 0,
`pnpm exec vitest run server packages eslint-rules` 0 (851 files passed,
261 skipped; 11041 tests passed).

Workstation, the same head, a fresh pgvector pg18 container
(`MANTLE_CHECK_FLOOR=keep`):

- `pnpm test:matrix` (`--config vitest.matrix.config.ts`): exit 0, 4
  files, 8 tests. A8 grid 9404 run, 0 fail. Surfaces: off 8 fail (8
  known), warn 8 (8 known), on 0. Tool cells: warn 26 fail (26 known; 30
  on main), on 4 (4 known; 8 on main). 0 unexpected in both modes. Main
  was recorded first (384b64d02): the branch's fail list is main's less
  the four cells of the two bugs (two ways in each), nothing new.
- `server/web/server/tree-bugs.db.test.ts`: exit 0, 17 tests.
- The related and the older suites whose answers moved
  (`a6-grant-sweep`, `grants`, `write-role`, `a3a-folders`,
  `packages/content/src/tree/`, `edit-check`, `schema-drift`,
  `a5-mcp-writes-smoke`, `precheck-removal-http`, `precheck-removal`,
  `pages/level-text`): exit 0, 21 files, 753 passed, 1 skipped.

Pins (`scripts/arch-scoreboard.pins.json`, each with its reason):
`asSystemExits` 58 to 59, `asSystemFull` 58 to 59 and
`asSystemFull_brain-bookkeeping` 10 to 11 (the `tree-refold` step);
`historyCodeComments` 2340 to 2339 (down, on v0.300.94).

CI: the run of this branch's head (see the CEO's reply; the first push's
run was https://github.com/crossworks-engineering/mantle/actions/runs/39141017190).
