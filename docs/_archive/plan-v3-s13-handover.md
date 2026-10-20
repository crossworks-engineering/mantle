# Plan v3.2 S13: folders above what a login reads, as structure (handover)

The branch `feat/s13`, cut from main 793d114b2 (v0.300.112). Brain side
only; the jackdaw pair step is listed at the end. The owner's rule
(2026-10-17): a login that can read an item also sees its folder and every
folder above it as structure only (name, id, path, crumbs). It cannot move,
rename, change the access of, or otherwise write those folders without the
right on them, and it sees no other item in them.

## Design

- The row rule of nodes (0242) is not touched: a folder the login does not
  read is still no row it reads, so every write path (treeFolderById,
  folderById, folderByPath, pathOf, renameFolderById, folderOrThrow, the
  grants panel, the move and create routes) still finds no folder and
  answers 404, unchanged.
- One read definer names the folders on the way. Only the tree's read paths
  ask it, and only for a login's own session (`via` cookie or bearer, actor
  `login`: `trailForCaller`, packages/db/src/folder-trail.ts). An API key,
  a linked brain, a public link, a contact share, an assistant's turn, an
  app, a process, an OAuth or stdio MCP client read the folders they read,
  as before (owner rule 9: nothing widens for keys, peers or links).
- `folder_get_by_path`, `folder_list` and `tree_folders` are left as they
  were (the tools read `listFolders`, `listAllFolders`, `listTreeFolders`,
  which did not change).

## Migration

`0311_folder_trail_definer`, journal idx 311, `when` 1790197980000 (60000
above 0310's 1790197920000). Re-runnable (CREATE OR REPLACE), `SET LOCAL
lock_timeout = '30s'` first, only adds one function: no table, row,
trigger, policy, grant on a table or earlier function changes.

`mantle_folder_trail(owner uuid, under text, paths text[], folder uuid)`
returns `(id uuid, path text, title text)`: the branch rows of `owner`
(nlevel > 1) at or above a row the scope reads (the 0242 rule as 0291's
definers read it: `read_ws && mantle_scope_ws()`, a per-login row only for
`mantle_scope_login_id()`), of the ones named: the direct children of
`under`, the exact `paths`, the row `folder`. Never a subtree in one call.
Nothing with no scope, a scope with no login (a link, an assistant's turn
with none) or another brain (`owner <> mantle_brain_id()`). SECURITY
DEFINER, `search_path = public, pg_temp`, PUBLIC revoked, EXECUTE for
`mantle_view_user` (the write and runtime roles follow it) and
`demo_reader` when it exists. A folder the scope reads itself counts (it is
a row at that folder); otherwise one EXISTS probe on the path's GiST index
per named folder.

Renumber proof (plan rule 3): `packages/db/src/folder-trail-0311.db.test.ts`
checks the `when` is above every `when` before it, that a database just
before 0311 applies 0311 and only it, and that the revert's ledger line
names 0311's own `when`. If another lane (S7a a3) claims 0311 first:
rename the file and the journal tag to the next free number, take a `when`
60000 above main's last, update `TAG` in that test, the revert file's name
and its `DELETE ... WHERE "created_at" = <when>` line, and the
docs/update-prod.md rollback line.

Rollback: `packages/db/rollback/0311_folder_trail_definer.revert.sql` drops
the function and takes 0311 off the ledger (optional: the older image works
with it in place). docs/update-prod.md, the rollback list, has the line.

## What changed (TS)

- `packages/db/src/folder-trail.ts` (new): `trailForCaller`,
  `folderTrailSql` (the definer as a FROM item, null for any other caller),
  `folderTrail`. Exported from `@mantle/db`.
- `packages/content/src/tree/read.ts`:
  - `selectFolders(..., trailUnder?)`: with a trail, the trail children of
    `trailUnder` matching the same `where` join the folder list (no look,
    rank or system mark: `data` null), the trail folder at `trailUnder`
    serves as their parent id, and each listed folder's `folderCount`
    counts the folders on the way under it too (what opening it shows, so
    a folder whose only way down is another such folder still unfolds in
    jackdaw's `folderHasChildren`). `itemCount` and `itemsElsewhere` stay
    what the reader reads. Without a trail the statement is byte for byte
    the one before.
  - `loadTreeFolder`: the children with `trailUnder = path`; a folder id
    that `treeFolderById` does not find is opened by `trailFolderById`
    (the definer by id, then `selectFolders` on its parent's trail). Its
    page has only the items the login reads.
  - `treeCrumbsFor`: unions the trail of the chain paths, so crumbs (the
    tree page, search, marks) have no gap.
  - `treeFolderById`, `listTreeFolders`, `searchTree`'s folder matches:
    unchanged.
- `packages/files/src/ops/folders.ts`: `listFoldersWithTrail` and
  `listAllFoldersWithTrail` (the rail: the paths of the rows the login reads
  under `files`, their folder chains, the definer by exact paths). A trail
  row: id, path, title, slug from the path's last label, description `''`,
  no look or indexing, `createdAt`/`updatedAt` `''`, counts what the login
  reads. `listFolders`/`listAllFolders` unchanged (the tools).
- `server/web/app/api/files/folders/route.ts` GET: the trail variants, each
  row `capped()` (`mayEdit`, `mayManage`; none on a trail folder).
- `packages/files/src/ops/files.ts` `upsertFile`: a missing parent is
  accepted only for `overwrite` of an existing file of exactly that name,
  not folded, that the caller reads and may change, in a folder the
  definer names (`overwritesEditableFile`). A new file there is still
  refused (400 "parent folder not found"). `restampRacedCreate` untouched.

## Changed answers

- A member's (or Admin user's) `GET /api/tree/:kind` root and folder pages
  now list the folders on the way to what it reads (were absent), with
  `name`, `id`, `path`, `parentId`, `depth`; `icon`/`color` null, `system`
  false, no chips, `mayEdit`/`mayManage` false.
- `GET /api/tree/:kind?folder=<a folder on the way>`: 200 with its page
  (was 404). A folder above nothing it reads: 404, as before.
- `folderCount` of a folder listed for a login's session counts the
  subfolders on the way too (was only the ones it reads).
- Crumbs (`/api/tree/:kind` page, `/search`, marks) name every folder of
  the chain (had gaps where the login did not read a folder).
- `GET /api/files/folders?tree=true` and `?parent=`: the folders on the way
  join the list; every row carries `mayEdit`/`mayManage` (new fields).
- `PATCH /api/files/files/:id` with `content` on a file the login may
  change in a folder it does not read: 200 (was 400 "parent folder not
  found").
- Unchanged: every write on such a folder (tree rename, move, look,
  delete, create inside, item move into it, grants panel read and change,
  the Files folder GET, rename, description, indexing, look, delete): 404.
  A new file in it: refused. The owner's views: the same folders and
  counts. Keys, peers, links, turns, tools: no trail. The A8 oracles
  (`oracle:answers` a1, a1-folders, a3a, a3a-detail, a8): 0 lines differ
  against main.

## Tests

- `packages/db/src/folder-trail-0311.db.test.ts`: the leak cells (only the
  folders at or above what the member reads, by children, exact paths and
  id; never a hidden sibling, an empty hidden folder, the folder above
  another login's private row, the kind root; id, path, title only; the
  other login's own trail; nothing unscoped, with no login, or for another
  brain), the row rule unchanged (one SELECT rule; trail folders still no
  row), the catalog, the renumber proof, the rollback.
- `packages/db/src/folder-trail.test.ts`: only cookie and bearer sessions of
  a login get a trail; no definer is asked for any other way in.
- `server/web/server/s13-folder-trail-sweep.db.test.ts` (createApp, a member
  cookie): the tree root, the folder on the way, the item folder with full
  crumbs, 404 on hidden siblings, search crumbs, every write 404 with
  nothing changed, the Files list and rail, the Files folder routes 404,
  the content edit 200 and the new file refused, the owner as before. In
  the actor-off run (`*sweep*`), the full run (warn) and the actor-on run
  (added to vitest.actor-on.config.ts with the definer test).

## Pins

- `historyCodeComments` 2338 to 2337 (one counted comment line fewer in the
  files touched). S13 joined `HISTORY_HEADING_CODES`
  (eslint-rules/cleanup-counts.mjs) with this file's heading; the one code
  comment that named it (the S11a-1 entry of
  packages/db/src/matrix/a8-known-failures.ts) now states its status
  without the code.
- No other pin moved: `rawSqlNonLiteral` stays 71 (the alias is written by
  each caller, no `sql.raw`), the docs/actors.md line count stays 345.

## Gates

Head of the gates: c0bb5481f (the commits after it change only this file).

Mac (DATABASE_URL unset): `pnpm -r typecheck` 0, `pnpm lint` 0 (one warning
on main's contact-sharing-routes test, not this branch), `pnpm format:check`
0, `pnpm docs:check` 0, `pnpm arch:check` 0, `pnpm -C server/web build` 0,
`pnpm exec vitest run server packages eslint-rules --maxWorkers=3` 0 (860
files passed, 271 skipped).

Workstation, own throwaway clone (~/s13-work/mantle) and own container
(s13-pg, pgvector pg18, max_connections=450, port 56413 checked free, the
database made as CI makes it: `init-scratch`, then `migrate` with
`MANTLE_CHECK_FLOOR=keep`), systemd-run --user, one at a time,
`--maxWorkers=3`:

- full DB vitest: run 1 exit 1 with every test passing (1130 files, 13869
  tests) and one unhandled `CONNECTION_CLOSED` from
  w7e-member-scope.db.test.ts (the known teardown flake); run 2 exit 0
  (1130 files passed, 13869 tests).
- `pnpm test:actor-off` 0 (132 files, 1203 tests).
- `pnpm test:actor-on` 0 (32 files, 392 tests; the S13 sweep and the 0311
  definer test included).
- `pnpm test:edit-on` 0 (44 files, 562 tests).
- `pnpm test:matrix` 0 (4 files, 8 tests).
- `pnpm test:runtime-role` 0 (280 files, 2802 tests).

An earlier pass on a database migrated without `MANTLE_CHECK_FLOOR=keep`
failed 38 files on "actor check: INSERT on nodes with no actor" (the floor
raised the checks for every raw fixture write): the setup's fault, not the
branch's; the container was made again as CI makes it. That pass also
showed the one intended changed answer the pre-check removal cells pinned
(the content edit's 400), updated in c0bb5481f.

A8 oracles (`pnpm -C packages/db oracle:answers <name> --against` the
answers recorded on main): a1, a1-folders, a3a, a3a-detail, a8 each 0 lines
differ.

## Perf

A throwaway brain in the s13 container: 202,223 nodes (2,220 folders under
`notes`, 20 top, 10 middle, 10 leaf each; 200,000 notes in the leaves), a
member scope that reads 50 notes, all in one top folder. As the workspace
role, `\timing`:

- the children of the root (20 named, 19 above nothing the member reads):
  about 95 ms; each hidden top folder's EXISTS probe scans its whole subtree
  (about 10,000 rows) on the path index before it can say no.
- the children of one top folder: 6 ms; a chain of three crumbs: 2 ms;
  unscoped (the owner, no scope): under 1 ms (the gate answers at once).
- the count shape of a page (the trail of each of the 20 root children,
  lateral): about 130 ms.
- the rail's scan of the paths the member reads under the root: 2 ms.

So a member's root page on a brain this size pays about 225 ms more, a
deeper page a few ms; an Admin user, whose scope reads the folders, pays
the shortcut only (a folder the scope reads is answered without a probe).
The cost is in the probe of a large hidden subtree. A cheaper shape, left
for review: probe from the rows the scope reads (the read_ws GIN index)
upwards when the scope is small, for example a lazily materialised set of
the read paths under the named folders, used only when a named folder is
not read itself.

## Jackdaw follow-up (the pair step)

- Tree rows: a folder from the trail carries `mayEdit: false`,
  `mayManage: false` (chips): gate `new-inside.ts`, the `tree-rows.tsx`
  droppable and its menu, and `folder-picker.tsx` on `itemAccess(folder)
  .edit`, so no create, drop, rename, look, move, delete or Grant Access is
  offered there (the brain answers 404 to each anyway).
- Files rail (`folder-tree-rail.tsx`): its menu (look, rename, delete) and
  upload drop on `FolderRow.mayEdit` / `mayManage`, which
  `/api/files/folders` now carries; add the two fields to `FolderRow` in
  `files-shared.ts`. A trail row has `description` `''` and
  `createdAt`/`updatedAt` `''` (never shown for folders today).
- `files-panes.tsx` "N folders" reads `childFolderCount`, which on the Files
  list stays what the login reads (the rail builds the tree from paths).
- No contract package change (no `pathOnly` flag on `TreeFolder`): no pair
  bump is forced; the jackdaw change is gating only, about 40 to 60 lines
  and tests.

## Open items

- Perf (see Perf): about 95 ms per hidden top folder set on the root page
  and about 130 ms for the counts, on a 200,000-row brain with a small
  member scope. Not a break; worth the GIN-first shape before a large
  brain's members use the trees heavily.

- A trail folder shows the default look (no icon or colour) and no
  description: structure only, by the rule. If the owner wants the look
  too, the definer would answer `data->'icon'` and `data->'color'`.
- The tools (`folder_list`, `folder_get_by_path`, `tree_folders`) give no
  trail, as the brief asked for the first cut.
- The A8 known failure S11a-1 (`file_create` by a turn or an OAuth MCP
  client answers "parent folder ... not found" for the path of a folder the
  caller does not read, where a free path is made) stays: the trail is for
  a login's own session, and the tools are unchanged.
