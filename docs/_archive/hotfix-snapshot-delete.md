# Hotfix: app_snapshot_delete asks the edit of the app (S11a-2)

Branch feat/hotfix-snapshot-delete, cut from main 8b3099467 (v0.300.85),
rebased onto ab0ce298a (v0.300.86, S3). TypeScript only: no migration, no
roll-order change.

## The bug

The S11a tool matrix (feat/s11a-tool-matrix, known failure S11a-2) found
that `app_snapshot_delete` deleted an app's snapshot for a caller who may
not change the app: a read grant's member, through a turn and through MCP.
The snapshot row really went.

## Root cause

Before R0 the tool's item pre-check (`items: [edit('id')]`, c7acc88ff,
v0.300.82) refused it in every check mode. R0 removed the pre-check because
"the database covers it". For this table it covers it only while the EDIT
check is on:

- `deleteAppSnapshot` (packages/content/src/app-snapshots.ts) asked no
  right.
- `node_snapshots` has no write check (the actor check's 0278 triggers).
  Its only check is the edit check's matrix trigger
  `mantle_edit_check_edit` (access-matrix.ts: `editCheck` delete 'edit' of
  node_id), and the edit check refuses only in `on`: `warn` reports and
  lets the delete run, `off` disables the trigger.
- The delete does run on the write role in the caller's scope (with the
  edit check on, the trigger fires and refuses). It is not a system-pool
  write, not outside the scope, not on the gap list, and no trigger is
  missing.

So with the edit check below on, any login that reads an app deleted its
snapshots, the owner too on an app granted to Admin read only. The S11a
matrix runs the actor check in warn and on with the edit check at its test
default (off), which is why both of its modes showed it.

Proof (server/web/server/hotfix-snapshot-delete.db.test.ts, run with
HFSD_RECORD=1 on main before the fix, both on v0.300.85 and on v0.300.86):
the refused cells (owner on a read-only grant, member read grant, member
read grant with Write on a sibling app) were deleted with actor on and edit
off, actor warn and edit warn, actor warn and edit off; refused only with
actor on and edit on. On c7acc88ff (v0.300.82) the same cells were refused
in all four modes.

No database-side fix: the database is right when the edit check is on. A
defense in depth there means a write check row for node_snapshots (a
trigger change: a migration and a roll-order change), so it is left for the
owner (open items).

## The fix

- packages/content/src/app-snapshots.ts `deleteAppSnapshot`: asks
  `assertItemRight(appId, 'edit')` first, before it reads or refuses the
  entry, whatever the check modes. System work is not checked.
- server/web/app/api/apps/[id]/snapshots/[sid]/route.ts DELETE: its own
  `assertItemRight` folds into the library's (one check per path; same
  answer, the mapper's 404 or 403).
- packages/tools/src/builtins-apps.ts `app_snapshot_delete`: a comment
  only; the library refusal goes through the one mapper.

The member path: `deleteMemberAppSnapshot` and `memberOwnSnapshotIds` have
no caller since W7b folded the `my_app_*` tools into the one MCP surface
(the member uses `app_snapshot_delete`). They are untouched. A member who
took a snapshot (app_snapshot_create asks edit for a manual one) still
deletes it (access matrix N6): pinned in every mode.

## Changed answers

None against main with both checks on. Against v0.300.82 the outcome of
every cell is the same (refused, nothing changed; allowed, the snapshot
goes). The words of a refusal for an app the caller reads but may not change
are the one mapper's, `You cannot change this item in your workspaces.`, as
main answers with both checks on, where v0.300.82 said `You cannot change
this item in your workspaces (<id>): ask for Write on it, or a Moderator of
its workspace.`. A first cut returned v0.300.82's words byte for byte; R0's
queue-time check (precheck-removal.db.test.ts "queue time") refuses a call
before it is queued in the run's words and says the mapper's, so the two
disagreed. R0's changed answer is kept, so the queue and the run say the
same. An app the caller does not read is the precondition's `app <id> not
found ...`, byte for byte as on v0.300.82.

## The sweep

Every tool whose pre-check R0 removed (98, the `items` lists of c7acc88ff),
run through R0's own proof (precheck-removal.db.test.ts, every placement,
member and owner) with the check modes lowered (a local patch, not
committed):

- actor on, edit off: 246 of 247 pass on main; the one failure is
  `app_snapshot_delete` (member and owner, MCP). No other tool lost its
  refusal: each has a library check or the write check.
- actor warn, edit warn: 17 tools refuse no longer (the known P1 class,
  "below on": the database is their only check and warn lets the write
  run): folder_describe, event_update, formula_update, note_update,
  task_update, page_update, table_update, tree_folder_update,
  recall_card_put, recall_card_delete, recall_card_set_slug,
  recall_cards_reorder, recall_map_publish, recall_map_set_slug,
  recall_map_update, recall_prompt_confirm, recall_revision_restore. Not
  fixed here (open items).
- On this branch (rebased on v0.300.86), actor on and edit off: 247 of 247
  pass, with this hotfix's 6 cells and app-snapshots.db.test.ts (272 tests).
  The first cut (v0.300.82's words) failed only the queue-time words cell.

On v0.300.86 before the fix, this hotfix's test in record mode shows the
same: 18 of the 24 refused cells deleted (all but actor on with edit on), and
in warn the edit check's own miss report names it: `DELETE on
node_snapshots: no edit of the item (refused when the edit check is on)`.

| tool                     | need before R0                                    | refused today (actor on, edit below on) | refused today (actor warn) | fixed |
| ------------------------ | ------------------------------------------------- | --------------------------------------- | -------------------------- | ----- |
| access_set               | manage('node_id')                                 | yes                                     | yes                        | no    |
| app_update               | edit('id')                                        | yes                                     | yes                        | no    |
| app_file_write           | manage('id')                                      | yes                                     | yes                        | no    |
| app_file_delete          | manage('id')                                      | yes                                     | yes                        | no    |
| app_source_set           | manage('id')                                      | yes                                     | yes                        | no    |
| app_build                | manage('id')                                      | yes                                     | yes                        | no    |
| app_tools_set            | manage('id')                                      | yes                                     | yes                        | no    |
| app_db_schema_set        | manage('id')                                      | yes                                     | yes                        | no    |
| app_db_seed              | edit('id')                                        | yes                                     | yes                        | no    |
| app_publish              | manage('id')                                      | yes                                     | yes                        | no    |
| app_delete               | manage('id')                                      | yes                                     | yes                        | no    |
| app_table_export_set     | edit('id')                                        | yes                                     | yes                        | no    |
| app_table_export_remove  | edit('id')                                        | yes                                     | yes                        | no    |
| app_snapshot_create      | edit('id')                                        | yes                                     | yes                        | no    |
| app_snapshot_delete      | edit('id')                                        | no (yes after the fix)                  | no (yes after the fix)     | yes   |
| contact_update           | edit('id')                                        | yes                                     | yes                        | no    |
| contact_delete           | manage('id')                                      | yes                                     | yes                        | no    |
| event_update             | edit('id')                                        | yes                                     | no                         | no    |
| event_delete             | manage('id')                                      | yes                                     | yes                        | no    |
| formula_update           | edit('id')                                        | yes                                     | no                         | no    |
| formula_delete           | manage('id')                                      | yes                                     | yes                        | no    |
| journal_update           | edit('id')                                        | yes                                     | yes                        | no    |
| journal_resolve_gap      | edit('id')                                        | yes                                     | yes                        | no    |
| journal_delete           | manage('id')                                      | yes                                     | yes                        | no    |
| content_supersede        | edit('node_id')                                   | yes                                     | yes                        | no    |
| process_extraction       | read('node_id')                                   | yes                                     | yes                        | no    |
| note_update              | edit('id')                                        | yes                                     | no                         | no    |
| note_delete              | manage('id')                                      | yes                                     | yes                        | no    |
| node_share               | edit('id')                                        | yes                                     | yes                        | no    |
| task_update              | edit('id')                                        | yes                                     | no                         | no    |
| task_delete              | manage('id')                                      | yes                                     | yes                        | no    |
| tree_item_move           | manage('item_ids')                                | yes                                     | yes                        | no    |
| tree_folder_delete       | manage('folder_id')                               | yes                                     | yes                        | no    |
| folder_delete            | manage('folder_id')                               | yes                                     | yes                        | no    |
| file_delete              | manage('file_id')                                 | yes                                     | yes                        | no    |
| file_move                | manage('file_id')                                 | yes                                     | yes                        | no    |
| folder_move              | manage('folder_id')                               | yes                                     | yes                        | no    |
| file_rename              | edit('file_id')                                   | yes                                     | yes                        | no    |
| folder_rename            | edit('folder_id')                                 | yes                                     | yes                        | no    |
| folder_describe          | edit('folder_id')                                 | yes                                     | no                         | no    |
| file_set_indexing        | edit('file_id')                                   | yes                                     | yes                        | no    |
| folder_set_indexing      | manage('folder_id')                               | yes                                     | yes                        | no    |
| page_blocks_apply        | edit('page_id')                                   | yes                                     | yes                        | no    |
| page_block_update        | edit('page_id')                                   | yes                                     | yes                        | no    |
| page_block_insert_after  | edit('page_id')                                   | yes                                     | yes                        | no    |
| page_block_insert_before | edit('page_id')                                   | yes                                     | yes                        | no    |
| page_block_append        | edit('page_id')                                   | yes                                     | yes                        | no    |
| page_block_delete        | edit('page_id')                                   | yes                                     | yes                        | no    |
| page_replace_from_file   | edit('page_id')                                   | yes                                     | yes                        | no    |
| page_update              | edit('id')                                        | yes                                     | no                         | no    |
| page_update_draft        | edit('id')                                        | yes                                     | yes                        | no    |
| page_commit              | edit('id')                                        | yes                                     | yes                        | no    |
| page_discard_draft       | edit('id')                                        | yes                                     | yes                        | no    |
| page_delete              | manage('id')                                      | yes                                     | yes                        | no    |
| page_share               | edit('id')                                        | yes                                     | yes                        | no    |
| page_split               | edit('page_id')                                   | yes                                     | yes                        | no    |
| page_extract_section     | edit('page_id')                                   | yes                                     | yes                        | no    |
| page_move                | manage('id')                                      | yes                                     | yes                        | no    |
| page_mention             | edit('page_id')                                   | yes                                     | yes                        | no    |
| table_column_add         | edit('table_id')                                  | yes                                     | yes                        | no    |
| table_column_update      | edit('table_id')                                  | yes                                     | yes                        | no    |
| table_column_delete      | edit('table_id')                                  | yes                                     | yes                        | no    |
| table_set_aggregate      | edit('table_id')                                  | yes                                     | yes                        | no    |
| table_set_view           | edit('table_id')                                  | yes                                     | yes                        | no    |
| table_snapshot_create    | edit('id')                                        | yes                                     | yes                        | no    |
| table_snapshot_restore   | edit('id')                                        | yes                                     | yes                        | no    |
| table_snapshot_delete    | edit('id')                                        | yes                                     | yes                        | no    |
| table_row_add            | edit('table_id')                                  | yes                                     | yes                        | no    |
| table_rows_add           | edit('table_id')                                  | yes                                     | yes                        | no    |
| table_rows_upsert        | edit('table_id')                                  | yes                                     | yes                        | no    |
| table_row_update         | edit('table_id')                                  | yes                                     | yes                        | no    |
| table_row_delete         | edit('table_id')                                  | yes                                     | yes                        | no    |
| table_cell_set           | edit('table_id')                                  | yes                                     | yes                        | no    |
| table_tab_add            | edit('table_id')                                  | yes                                     | yes                        | no    |
| table_tab_rename         | edit('table_id')                                  | yes                                     | yes                        | no    |
| table_tab_delete         | edit('table_id')                                  | yes                                     | yes                        | no    |
| table_update             | edit('id')                                        | yes                                     | no                         | no    |
| table_delete             | manage('id')                                      | yes                                     | yes                        | no    |
| table_commit             | edit('id')                                        | yes                                     | yes                        | no    |
| recall_prompt_confirm    | recallMap('edit')                                 | yes                                     | no                         | no    |
| recall_map_publish       | recallMap('edit')                                 | yes                                     | no                         | no    |
| recall_map_delete        | recallMap('manage')                               | yes                                     | yes                        | no    |
| recall_cards_reorder     | recallMap('edit')                                 | yes                                     | no                         | no    |
| recall_revision_restore  | recallRevisionTargets(edit of the map)            | yes                                     | no                         | no    |
| recall_map_set_slug      | recallMap('edit')                                 | yes                                     | no                         | no    |
| recall_card_set_slug     | recallMap('edit')                                 | yes                                     | no                         | no    |
| recall_card_put          | recallMap('edit')                                 | yes                                     | no                         | no    |
| recall_card_delete       | recallMap('edit')                                 | yes                                     | no                         | no    |
| recall_map_update        | recallMap('edit')                                 | yes                                     | no                         | no    |
| node_unshare             | closeLinkTargets(link close)                      | yes                                     | yes                        | no    |
| tree_folder_update       | treeFolderUpdateTargets(rename edit, move manage) | yes                                     | no                         | no    |
| page_from_file           | pageFromFileSource(edit)                          | yes                                     | yes                        | no    |
| page_from_note           | pageFromNoteSource(edit)                          | yes                                     | yes                        | no    |
| page_from_notes          | pageFromNotesSources(edit)                        | yes                                     | yes                        | no    |
| page_unshare             | closeLinkTargets(link close)                      | yes                                     | yes                        | no    |
| app_snapshot_restore     | appRestoreTargets(code manage, data edit)         | yes                                     | yes                        | no    |
| app_duplicate            | appCopy(read, edit with data)                     | yes                                     | yes                        | no    |
| app_export               | appCopy(read, edit with data)                     | yes                                     | yes                        | no    |

## Tests

server/web/server/hotfix-snapshot-delete.db.test.ts (in `pnpm test`): each
cell a fresh app with one snapshot, the tool on the login's own MCP surface
and in an assistant turn, in four check modes (actor on with edit off and
on, actor warn with edit warn and off). Refused, the history unchanged and
the recorded answer: the owner on an app granted to Admin read only, a
member outsider, a read grant, a read grant whose Write is on a sibling app.
Allowed: the owner and a second Admin user on an app in Admin, a member's
Write grant and a Moderator of the app's home. The member deletes a snapshot
it took (N6) in every mode. packages/tools/src/builtins-app-history.test.ts:
the store's refusal fails the call, never as a missing snapshot.

## Open items (the owner's)

1. The 17 tools above refuse nothing while the ACTOR check is in warn (P1,
   known). Destructive among them: recall_card_delete,
   recall_revision_restore (and the overwrites page_update, note_update,
   table_update, recall_card_put, recall_map_update). Not fixed here: they
   refuse with the actor check on (the 0301 floor), the class is the known
   P1 finding, and a library check would move other lanes' recorded warn
   lists. The same `assertItemRight` at the top of each library write closes
   it if the owner wants warn to refuse them.
2. A database-side defense for node_snapshots (a write check row, so the
   actor check refuses too): a trigger change, so a migration (0303 or
   later) and a roll-order change. Not done.
3. S11a (feat/s11a-tool-matrix) on its rebase: S11a-2's two read-grant root
   cells now pass (refused); its two Write-grant folder cells still delete,
   as on v0.300.82 (edit of the app: a Write grant may), where the S11a
   oracle says app code is a Moderator's. That is an oracle question, not
   this bug.
4. `deleteMemberAppSnapshot` and `memberOwnSnapshotIds`
   (app-snapshots.ts) have no caller since W7b: dead code.

## Gates

See the gates section appended after the run.
