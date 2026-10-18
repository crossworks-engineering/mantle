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

Recorded on main (the new test overlaid on e10c740a9), then on the branch:

| Cell (warn and on)                                    | main                                                   | branch                                                        |
| ----------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------- |
| app_export, MCP, member reads the app, no data        | refused: createFolder: parent folder 'files' not found | ok: Files root, its private workspace, landedIn               |
| sheet_build, MCP, member                              | refused: the same                                      | ok: Files root, its private workspace, landedIn               |
| app_export and sheet_build, turn of R (a user)        | refused: the same                                      | ok: its private workspace (landedIn: its private create home) |
| app_export and sheet_build, turn of H (Moderator)     | refused: the same                                      | ok: H                                                         |
| app_export and sheet_build, owner, MCP and Admin turn | ok: Auto-filed / Exports                               | ok: the same, and landedIn names Admin (a field more)         |
| process_extraction, turn of R, member reads the note  | ok: fired 1                                            | refused: You cannot change this item in your workspaces.      |
| process_extraction, MCP, Admin user, noEdit place     | ok                                                     | refused: the same words (precheck-removal.db.test.ts)         |

The process_extraction answers are narrower (an edit, not a read). The
export answers are wider for members by the owner's decision: a member may
now make a file in its own create home from what it reads; nothing it does
not read reaches the file (the outsider and with-data cells stay refused,
and no file is made).

Unchanged: an outsider (an app homed where the member reads nothing) is
refused as not found, MCP and turn; a reader asking the app's data is
refused (edit); a login in no workspace lists no tools (sheet_build: Method
not found).

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

See the final report of the session (exit codes, CI run, head SHA).
