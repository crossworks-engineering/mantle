# Member export: handover (2026-10-18)

Branch `feat/member-export`, cut from main at e10c740a9 (v0.300.87). Two
owner decisions of 2026-10-18.

## 1. Members export what they see

Before: `app_export`, `sheet_build` and `export_node` each asked
`ensureAutoFiledFolder(owner, 'exports')` and wrote there. Auto-filed is
Admin only, so a member's call failed ("createFolder: parent folder 'files'
not found"), its Home Moderator's too (the S11a matrix's known failure
S11a-3), and so did any scope that does not hold Admin (an Admin user in a
workspace assistant's turn).

Now: one gateway, `saveExport` in `packages/files/src/export-home.ts`, used
by all three tools (the three copies of "folder, then upsertFile" are gone).

- `exportFolder`: a scope that holds Admin (and the system) gets Auto-filed /
  Exports / month as before, when the caller may change that folder
  (`callerMayEditFolder`, `packages/files/src/ops/files.ts`, mantle_may_edit
  in its scope). Anyone else gets the Files root, so the new file takes the
  create home a new item takes there (the database's mantle_default_home:
  the call's workspace when the caller moderates it, else its private
  workspace). The rule is the create-home rule, not a copy of it.
- The reply carries `landedIn` ({ id, name }), read in the caller's scope
  by `landedIn` in `packages/db/src/create-home.ts`. That function moved
  there from `packages/mcp-core/src/create-home.ts` (one copy: MCP's
  withLanding and the exports both call it). A turn of a workspace the
  member only reads cannot read the member's private workspace; there the
  reply names the call's private create home (`PRIVATE_LANDING_NAME`), the
  one place outside the turn's scope the file can land.
- What the export holds: `app_export` reads the app in the caller's scope
  (`writeAppPackage` asks `assertMayCopyApp` first: read for the code, edit
  for the data unless the app's MCP switch is on; `getApp` reads no draft
  outside a draft-reading scope). `sheet_build` reads nothing from the
  brain: the workbook is its input. `export_node` is scope admin.
- Docs: `docs/actors.md` section 6 (two rows of the table; two paragraphs
  reflowed to stay at 350 lines), `docs/folder-tree.md` "Auto-filed",
  `docs/workspaces.md` (where a new item lands), `docs/app-authoring-guide.md`.

## 2. process_extraction needs edit

Before: `itemArgs` least read, and the handler read the node in the scope,
so a reader could re-run an item's extraction (model money).

Now: `itemArgs: [{ param: 'node_id' }]` (least change, the queue-time
check asks edit), the handler asks `assertItemRight(nodeId, 'edit')` after
its scoped read (the one mapper's words, as the queue-time check), and a
sweep in a workspace scope signals only items the scope may edit
(`mayEditSql`). System sweeps are unchanged.

## Changed answers

Recorded on main (the new test overlaid on e10c740a9), then on the branch.
On main each member test stopped at its MCP cell, so the turn cells were
not reached there; they ran the same folder step (marked "same step").

| Cell (warn and on)                                    | main                                                   | branch                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| app_export, MCP, member reads the app, no data        | refused: createFolder: parent folder 'files' not found | ok: Files root, its private workspace, landedIn                                  |
| sheet_build, MCP, member                              | refused: the same                                      | ok: Files root, its private workspace, landedIn                                  |
| app_export and sheet_build, turn of R (a user)        | same step: refused                                     | ok: its private workspace (landedIn: its private create home)                    |
| app_export and sheet_build, turn of H (Moderator)     | same step: refused                                     | ok: H                                                                            |
| app_export and sheet_build, owner, MCP and Admin turn | ok: Auto-filed / Exports                               | ok: the same, and landedIn names Admin (a field more)                            |
| process_extraction, turn of R, member reads the note  | ok: fired 1                                            | refused: You cannot change this item in your workspaces.                         |
| process_extraction, MCP, Admin user, noEdit place     | ok                                                     | refused: the same words (precheck-removal.db.test.ts)                            |
| process_extraction sweep, any workspace scope         | signals every eligible item the scope reads            | signals only the eligible items the scope may edit (the owner's Admin scope too) |

The process_extraction answers are narrower (an edit, not a read). The
export answers are wider for members by the owner's decision: a member may
now make a file in its own create home from what it reads; nothing it does
not read reaches the file (the outsider and with-data cells stay refused,
and no file is made).

Unchanged: an outsider (an app homed where the member reads nothing) is
refused as not found, MCP and turn; a reader asking the app's data is
refused (edit); a login in no workspace lists no tools (sheet_build: Method
not found).

## Fix round 1 (audit at 64ed94267: 8/10, one MED, five LOWs)

- M1, a taken name: the Files root is one folder for every workspace, and
  the name check spans them all, so a member's export named like another
  member's file was refused "already exists in this folder" (and so showed
  the name was taken in a workspace it cannot read), and the same export
  twice always failed. Now `saveExport` never goes over a file: it passes
  over a taken name (`fileNameTaken`, existence only) to the next free one
  (`q1.xlsx`, `q1-2.xlsx` .. `q1-20.xlsx`, then one with a time stamp,
  `exportNames`), the same whoever holds it; a create that takes the name in
  between moves it to the next one while a spooled package is still there;
  the one refusal when none is free names only the caller's own filename
  (`export: no free name for ...`). A spooled package is removed on every
  failure path. The suffix shows that a name is taken, as file_create's
  refusal already did for any member; it shows nothing of whose or where.
- L1, tool text: app_export, export_node, sheet_build and the export tool
  group say Auto-filed / Exports for an Admin user, else the top of Files;
  app_export says a member gets no draft.
- L2, the sweep: asserts ok, and a sweep in a turn of H signals an eligible
  item the member may change there.
- L3, exportFolder's branches: the owner in a turn of M (Moderator) and of U
  (a user), and an Admin user that is not its Moderator (cells below).
- L4: a landedIn read that fails after the file is made returns landedIn
  null; the export stands.
- L5: the sweep row above, and the owner rows below.

Recorded on 64ed94267 (the new cells overlaid, commit e4fb86993 on the
workstation only), then on the fix:

| Cell (warn and on)                                                           | 64ed94267                                                      | fix round 1                                  |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------- |
| sheet_build, member2 exports a name member's file holds                      | refused: 'name' already exists in this folder                  | ok: `name-2`, its private workspace; no leak |
| sheet_build and app_export, one member, same name twice                      | not reached (the row above stops it); the audit: ConflictError | ok: `name-2` (and on); the first not changed |
| owner or Admin Moderator, same name twice in one month, Auto-filed / Exports | refused: 'name' already exists in this folder                  | ok: `name-2`; the first not changed          |
| sheet_build, owner, turn of M (it moderates M)                               | ok: M, at the Files root                                       | the same                                     |
| sheet_build, owner, turn of U (a user of U, no Moderator)                    | refused: its create home is Admin                              | the same (nothing made)                      |
| sheet_build, MCP, Admin user that is not its Moderator                       | on: refused; warn: Admin, a miss noted                         | the same                                     |

The last two are the database's create check, unchanged: an Admin user has
no private workspace (its create home is Admin), so where it may not create
in Admin its export is refused, as any create there is. Open for the owner:
whether such a call should fall back to a workspace the turn may write.

## Tests

- `server/web/server/member-export.db.test.ts`: the cells above, each mode
  (`warn`, `on`: both checks, box and process), the files store and the file
  count unchanged on a refusal, the file's path, home and the member's read
  of it, the package's code (no draft, no data) and the sheet's text. The
  extractor's signal is stubbed (`resignalNode`): no model runs.
- `server/web/server/precheck-removal.db.test.ts`: app_export (read) now
  for both logins; process_extraction's need is edit.
- `packages/tools/src/item-write-gate.test.ts`: process_extraction's entry
  is edit. Unit tests of the three tools stub `saveExport`.

## On rebase

S11a (`feat/s11a-tool-matrix`) is not on main. When it lands, drop S11a-3
from `packages/db/src/matrix/a8-known-failures.ts` (`S11A_3`,
`MEMBER_EXPORT_REFUSED`: `tool:app_export <way>/homeModerator read app
@folder`, both ways, both modes) and its handover line about sheet_build:
those cells pass now. S11a's process_extraction declaration (`matrix`)
should say edit.

## Gates

On 785c2c4f1 (the code as pushed; later commits are this file only).

Mac: `pnpm -r typecheck` 0, `pnpm lint` 0 (one warning, not this
branch's), `pnpm format:check` 0, `pnpm docs:check` 0, `pnpm arch:check` 0
(no pin moved; the spec stays at 350 lines), `pnpm -C server/web build` 0,
unit `vitest run server packages eslint-rules` (no DATABASE_URL) 0 (10920
passed).

Workstation, own clone and pgvector pg18 container (port 56371,
max_connections=450, migrate with MANTLE_CHECK_FLOOR=keep), one at a time,
each on a fresh database: full vitest with DB 0 (13510 passed),
`test:actor-off` 0 (1076), `test:actor-on` 0 (349), `test:edit-on` 0 (515),
`test:matrix` 0 (7), `test:runtime-role` 1 then 0: the first run passed
every test (2603) and logged one unhandled `CONNECTION_CLOSED` from
`w7e-member-scope.db.test.ts`, the flake the S3 handover names; the rerun
was clean (2603 passed, no error).

No new pins, no migration.

### Fix round 1 gates

Code at ec35f773e (later commits are this file only).

Mac: `pnpm -r typecheck` 0, `pnpm lint` 0, `pnpm format:check` 0,
`pnpm docs:check` 0, `pnpm arch:check` 0, `pnpm -C server/web build` 0,
unit `vitest run server packages eslint-rules` (no DATABASE_URL) 0 (10929
passed). The MCP surface snapshots moved for the new tool text only
(descriptions and their hashes).

Workstation, own clone and pgvector pg18 container (port 56391,
MANTLE_CHECK_FLOOR=keep): full vitest with DB on dd3bfc327: 13520 passed,
5 failed, all unit cells fixed in ec35f773e (the snapshots, the word budget,
a clock race in the new unit test). On ec35f773e: those files with
`member-export.db.test.ts` and `precheck-removal.db.test.ts` 0 (291
passed), `test:actor-on` 0 (349), `test:edit-on` 0 (515).
`member-export.db.test.ts` on 64ed94267 with the new cells: 2 failed (the
recording above), 18 passed.

## Fix round 2 (re-audit at b89748224: 9/10)

Rebased onto main ff5f17ec6 (v0.300.89) with no conflict.

- L-a, tool text: Auto-filed / Exports goes to a caller that may change it
  in its scope (the owner or an Admin Moderator), not to every Admin user;
  export_node, sheet_build, app_export and the export tool group say so,
  and sheet_build names the `-2` suffix as the other two do.
- L-b: a spooled package that loses a name race after it was staged (its
  bytes are gone, so it cannot take the next name) now says "export: the
  name was taken while saving; try again" (`exportRaceError`), not "no free
  name"; unit cell in `export-home.test.ts`.
- L-c: the owner row in the fix round 1 table, recorded on 64ed94267 (the
  new cell overlaid, commit 16bea1ffa on the workstation only): refused
  "already exists", now `-2`.
