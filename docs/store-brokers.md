# Store brokers: the database checks before the disk

Workspaces arch plan v2, phase A3b (sections 6, 11 and 20.3; the owner's
decision of 2026-10-13: section 20.3 for every whole-file write). The actors
a write runs as are in [actors.md](./actors.md); what the database checks is
in [edit-check.md](./edit-check.md).

Six stores keep data on disk, where no trigger sees it. Before A3b a disk
write could run before the Postgres statement the database checks (a
table's draft was written, then `draft_rev` bumped), so a write the database
refused had already changed the file. A3b gives each store ONE broker, the
only writer of its disk.

## The broker rule (plan 20.3)

One helper, `packages/db/src/store-broker.ts`; each broker calls it.

1. **Stage.** The new bytes go to a NEW revision name
   (`<node>.r-<token>.sqlite`; `revisionToken`), a file no row points at.
   No reader sees it: readers find a store's file through its row, in one
   place per store.
2. **Flip.** ONE short transaction runs the statement the database checks,
   as the caller's actor (on the write role for a login's write: the row
   rules and the edit check see it), and points the row at the stage. It
   must match exactly one row (`oneRow`). No row is a refusal,
   `StoreRefusedError`: shaped as the edit check's own refusal (SQLSTATE
   42501, detail `no_read`), so the one HTTP mapper answers 404 and the
   tools say "not found", with no new branch. A trigger's refusal (403, 404)
   is the statement's own. The flip's body runs in `inFlipTransaction`, and
   nothing runs after its commit inside it (a commit's detail, the history
   prune and the extractor run after `stageThenFlip` returns).
   A flip KNOWN not to have landed (a refusal, another write that moved the
   row first, anything thrown inside its transaction) removes its stage at
   once. Any other error may have committed (a lost COMMIT acknowledgement,
   a dropped connection, a failed COMMIT): the stage is kept, whether a row
   names it or not; one no row names is an unreferenced revision the sweep
   removes. A row never points at a removed stage. A table created inside
   an outer transaction (a personal space, a login's open write
   transaction) registers its stage for removal on that transaction's
   rollback (`afterOuterRollback`).
3. **Sweep.** The revision a flip replaced, and a stage a crash left, go in
   the one sweep (`sweepOrphans`; below). A deleted table's files go with
   its delete, after the commit, as before A3b. A deleted snapshot's file
   goes in the sweep by its tombstone (below).

**A store whose disk path IS its row** (the files tree, A3b part 2): a file
lives at its folder's path and its name, which the host sees and the files
watcher mirrors, so there is no pointer to flip and new bytes cannot wait
under a revision name. The disk follows the row INSIDE the flip
(`flipThenPlace`): the one short transaction runs the checked statement
first (exactly one row), then a rename as its LAST step (atomic, no bytes
copied: staged bytes over their name, a file or a folder to its new path),
then commits. The bytes were staged beside their name before the
transaction (a name the watcher ignores). A flip known not to have landed
puts the disk back (the rename back; an overwrite's old bytes, kept under a
staging name by a hard link until the flip settles); after any other error
the database is asked where the row is, and the disk is put back only when
it never landed (left as it is, logged, when the row cannot be read). An
overwrite's old bytes go back only inside one short transaction that holds
the row's lock (`SELECT ... FOR UPDATE`), while the row does not name the
new bytes and the file still holds them: a write that landed after this
one's transaction let the row go is never undone, and the old bytes are
then left to the staged-leftover sweep (fix round 1, M1). That transaction
runs on a fresh system connection, never joined to the caller's open
transaction, with a 2 s lock wait (`brokerLockTx`); once it has decided,
its own COMMIT failing changes nothing; a lock it cannot take in time puts
the old bytes back only while the file holds the new ones (fix round 2, N1
and N3). Inside an outer
transaction the disk goes back if that one rolls back
(`afterOuterRollback`; rollback hooks run newest first, so two renames of
one file go back last first), and the old bytes stay until it commits
(`afterOuterCommit`). The files watcher waits 2 s before it believes an
unlink (a flip that is put back puts the file back within milliseconds;
deleting its row meanwhile and making it again would lose its id, grants
and passages). A crash between the rename and the COMMIT (a
microsecond window, after the check passed) leaves the new bytes in place
and the old ones under a staging name: the watcher adopts the bytes on disk,
as it adopts any edit made there, and the staged-leftover sweep
(`files-staged-reap`) removes the old ones after an hour.

No transaction is held across a disk write. The exceptions write in place,
where a copy per write would cost a whole file:

- **An app's SQL** (a statement through `host.db` or MCP): the check (the
  `write_seq` bump) commits first, then the statement runs in place. A
  statement that then fails leaves the revision one higher; an in-place
  write cannot be undone (the owner's decision).
- **A table's op batch on an existing draft:** one short transaction whose
  first statement is the check (the `draft_rev` bump, which takes the row
  lock), then the batch on the draft in place, then the JSONB mirror. A copy
  per batch was measured on the workstation's disk (2026-10-13): 41 ms p95
  at 100,000 rows and 1.7 s p95 at 500,000, against 9 ms and 36 ms in place.
  A table's FIRST op batch copies the published workbook into a new draft
  revision anyway, so it is staged and flipped.
- **An app's seed and schema script** (the owner's decision of 2026-10-13)
  keep their row lock across the run, up to `APP_SCHEMA_TIMEOUT_MS` (30 s):
  a transaction held across a disk write, the one exception to 20.3. The
  check is inside it, first, and the bump returns the file the row names
  now. A restore takes the same lock, and a copy per seed would lose the
  single statements running meanwhile without the restore's drain. A single
  statement's check does not queue behind the seed: each try waits at most
  `APP_DB_CHECK_LOCK_TIMEOUT_MS` (200 ms) for the lock, then gives its
  pooled connection back and pauses `APP_DB_CHECK_RETRY_PAUSE_MS` (500 ms)
  outside any transaction, for up to `APP_DB_CHECK_RETRY_MS` (10 s) in all:
  it lands after a seed of up to about 10 s, and a few app writes waiting
  never hold the write pool the other logins' writes need. Past that it
  answers busy (`AppSqlBusyError`:
  the brokers' 429 with reason `busy`). Nothing retries a busy answer for
  the app: the kit hands it to the app's code as an error, so the server
  does the waiting.
- **Every app write checks its file.** The bump returns `storage_path`; a
  write whose row a restore moved to another file since it read it is
  refused before it touches either file (`AppDbRestoringError`, the same
  busy answer: a new try reads the row again).

## The stores

| Store                        | Broker                                                                                                           | Check and flip                                                                                                                                                                                                                                                 | Readers resolve through                                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Table workbooks (SQLite)     | `packages/content/src/table-broker.ts` (the only importer of `@mantle/tabledb/write`)                            | `UPDATE tables SET draft_rev = draft_rev + 1, storage_path / draft_path = <stage>` at the revision the stage was built from (`flipTable`); a create: the node's INSERT; a delete: the node's DELETE                                                            | `tables.storage_path` (published) and `tables.draft_path` (draft, migration 0283; `draftAbsOf` in `packages/content/src/table-storage.ts`) |
| App databases (SQLite)       | `packages/content/src/app-broker.ts`                                                                             | `UPDATE app_databases SET write_seq = write_seq + 1` (0283); a restore also flips `storage_path`                                                                                                                                                               | `app_databases.storage_path`                                                                                                               |
| App build artifacts (RustFS) | `packages/tools/src/app-build-stage.ts`, through `setDraftBuild` (`packages/content/src/apps.ts`)                | the bundle stored under its content address first, then `UPDATE apps SET draft_build` (D4: a Moderator of the app's home)                                                                                                                                      | `apps.draft_build`                                                                                                                         |
| Docs collections             | the docs worker (`server/web/workers/docs-sync.ts`)                                                              | none: it writes no disk                                                                                                                                                                                                                                        | `data.sha256` on the row                                                                                                                   |
| File bytes (disk)            | files ops (`packages/files/src/ops/files.ts`, `folders.ts`, `move-copy.ts`, through `disk.ts`)                   | the node's UPDATE (or DELETE) as the caller, exactly one row, then the rename on disk as the transaction's last step (`flipThenPlace`)                                                                                                                         | the node's folder path and `data.filename`                                                                                                 |
| File bytes (RustFS)          | `packages/files/src/file-broker.ts` (`stageFileObject`; email attachments, OneDrive and SharePoint files)        | the object under its content address first, then the row's INSERT                                                                                                                                                                                              | `email_attachments.storage_key`, the node's `data.sha256`                                                                                  |
| Snapshot database files      | `packages/content/src/snapshot-broker.ts` (with `app-snapshots.ts`, `table-snapshots.ts`, `member-snapshots.ts`) | the copy under a new name first, then one short transaction: the `node_snapshots` INSERT (the edit check) with `db_path` and `db_bytes`, or the `accepted_snapshots` row's `table_path`; a delete removes the row only (its trigger records a tombstone, 0284) | `node_snapshots.db_path`, `accepted_snapshots.table_path`                                                                                  |

- **Tables.** A draft save, a commit (both shapes, with the history copy of
  the version it replaces), a history restore, a first op batch and the
  legacy JSONB migration stage new revisions, then flip
  (`stageThenFlipTable`, `stagedTableWrite`; retried when another write
  moved the table first; with an `ifRev`, that is the caller's conflict). A
  restored draft lands beside the row's published file (a table folded in
  from a member's space keeps its folder). A discard flips the draft pointer
  to none, with no disk write; a delete deletes the row, then removes every
  revision of the table in its folders once the delete commits. A draft
  written before 0283 keeps its old name: the migration points `draft_path`
  at it whether or not the file is there, and every reader and writer
  treats a named draft that is not on disk as no draft (an op batch then
  makes a new one).
- **App databases.** A restore copies the snapshot as a new revision of the
  file, then flips `storage_path` (after its marker and drain, as before);
  the old file is the sweep's. A backup (`snapshotAllAppDatabases`) copies
  every revision of the app's file under its own name (below).
- **App builds.** The bundle is the stage: content-addressed, named in no
  row until the flip. A refused or stale build leaves an object nothing
  points at. Bundles are shared by every app (and every email attachment or
  file) with the same bytes, so the sweep never removes an object.
- **Docs.** The docs feature reads markdown and writes only rows; the lint
  holds its files to no file-writing import.
- **Files** (A3b part 2). An overwrite stages the new bytes beside the file,
  then flips (the node's update, exactly one row) and renames the stage over
  the file last; it used to write the file in place before the row, so an
  overwrite the database refused had already changed the bytes. A rename, a
  file move, a folder rename and a folder move change the rows first (a
  folder's through `mantle_subtree_rewrite`, whose 409 on rows the caller
  cannot read still comes before anything moves) and rename on disk last;
  they used to move the disk first and move it back on a failure, so a move
  the database refused had moved the file (and the watcher could read the
  old path's unlink before the row moved). A file or folder delete is the
  checked DELETE (exactly one row: a delete the row rules left at none is
  refused, 404) and removes the bytes once it has committed (inside an
  outer transaction, once that one has: `afterOuterCommit`), and only the
  bytes it saw (the same inode): a file made again under the name in the
  same outer transaction stays. A deleted folder's directory moves aside at
  once (`.<uuid>.kept-<time>.tmp`), goes at the commit and comes back on a
  rollback, so a folder made again under its name gets its own (fix round
  2, N2). A
  create was already staged and placed inside its insert (W8b). A folded
  member file's bytes stay in its space (named by its id): its rename and
  move change the row only. Email attachments' bytes are stored before the
  email's transaction (they used to be stored inside it), a drive file's
  before its node's INSERT (already so); both through the files broker.
- **Snapshots** (A3b part 2). An app snapshot, a table snapshot and an
  accepted table's workbook copy are copied first, under a new name (the
  snapshot's id; an accepted copy's revision token), outside any
  transaction: they used to be copied inside the history lock's or the
  registry lock's transaction, held across the whole copy, and an accepted
  copy was copied over its one name in place. Then one short transaction
  (the history lock, the registry row lock) checks the item's file is the
  one copied (a restore or a commit moved meanwhile: taken again, twice at
  most) and writes the row naming the copy with its size. A table commit's
  history copy was already a stage of the commit (part 1). A delete, a
  prune, a purge (an app's trash, a deleted table's history) removes rows
  only: the row's trigger records its file in `store_tombstones` (0284), in
  the same transaction, and the sweep removes it (below). They used to
  remove the files after the rows, outside any transaction, so a crash
  between left a file no row named, and a backup that dumped the row before
  the delete could miss its file.

## The sweep

ONE sweep for every store: `sweepOrphans` (the rule) over the stores'
specs in `packages/content/src/store-sweep.ts` (tables, app databases, and
the snapshot store's three folders: `APP_DB_DIR/_snapshots`,
`TABLE_DB_DIR/_snapshots`, `TABLE_DB_DIR/accepted-snapshots`, each with its
own memory, held by its store root's restore hold),
run nightly by the maintenance worker (task `store-sweep`) and by
`pnpm -C server/web store:sweep [--apply [--allow-many]]`. The stores'
file names (`revisionNode`), which registry columns name them
(`STORE_FILE_COLUMNS`, read by `storeRows`) and the one remover of a SQLite
file with every sidecar (`removeSqliteFile`) are the helper's, shared by
the brokers, the backups and the sweep.

- **What it may remove:** an old revision only. A file the store owns (its
  revision names, one folder deep; never the history folder `_snapshots`,
  the accepted copies, the work files) that no row names, whose item HAS a
  row naming other files, all of them on disk: the revision a flip
  replaced, a stage a crash, a refused flip or a failed commit left.
- **A tombstoned file** (the snapshot store, A3b part 2): a file a deleted
  or re-pointed row named, recorded by the row's trigger
  (`store_tombstones`, 0284), goes a day after its row went
  (`STORE_TOMBSTONE_GRACE_MS`, 24 h, measured on the database's clock:
  longer than any backup, so a backup whose dump still names the row finds
  the file), while
  no row names it (a restore that brought the row back keeps it), within
  the run's budget and under the same holds and stops; its folder goes when
  it empties, and the tombstone once its file is gone. Tombstones live with
  the rows, so a restore brings back exactly the tombstones of the rows it
  does not bring back. A path named again and dropped again starts its day
  over. A snapshot folder holding files that no row and no tombstone names
  (files from before 0284 whose rows are all gone) is reported, never a
  hard stop: nothing there can go without a row or a tombstone.
- **What it never removes, only reports:** a file whose item has no row (a
  deleted item's, a create that never landed, an app's file from before
  A3b; it may be the only copy), every file of an item whose row names a
  file that is missing, and a draft from before A3b
  (`<node>.draft.sqlite`). A legacy draft stays for ever once its table has
  been committed: the dry run (`pnpm -C server/web store:sweep`) lists each
  one ("kept, a draft from before A3b"); an operator who has checked that
  no row's `draft_path` names it removes it by hand, or with the leftovers
  command below.
- **Leftovers, by an operator only** (A3b part 2 fix round 1): what a run
  only reports (an item's file with no row and no tombstone, a legacy
  draft; never a file of an item whose row's file is missing) is listed by
  `pnpm -C server/web store:sweep --report-orphans <list-file>`
  (`<store part>`, a tab, the path under its root, one per line). After
  review, with the lines that must stay deleted, `store:sweep
--remove-orphans <list-file>` says what would go, and with `--apply`
  removes it: each only while the stores still report it as a leftover and
  once it is an hour old; never while a restore's hold is on any store,
  and never in a store whose rows name no file at all (a wrong or empty
  database: fix round 2, N4). The nightly sweep never does this.
- **How much per run:** at most the larger of 500 files and half the files
  the store holds, the oldest marked first. The rest are carried to the
  next run and reported (`deferred`), never a failure: a busy day (every
  commit leaves two old files, an app table export's sync two per sync) is
  removed over the following nights.
- **Held after a restore (not a failure):** `scripts/db-restore.sh` and
  `scripts/app-dbs-restore.sh` write `.store-sweep-hold` at each store root,
  and remove the sweep's memory (`.store-sweep.json`) there, BEFORE they
  restore anything (the root is made if missing, so the hold lands before
  any file does). Restored rows may name OLDER revisions than the files on
  disk, which would read as old revisions to remove. While the hold is
  younger than a week the store is HELD: nothing removed or marked, the
  report says `HELD until <date>`, and the maintenance run is done. Read
  its dry run first (`pnpm -C server/web store:sweep --allow-many`, with no
  `--apply`: a dry run without `--allow-many` only says HELD), then run it
  with `--apply --allow-many`, or remove the hold. ANY
  other restore (a manual `pg_restore`, an untar of a table or app archive)
  must do the same by hand: `touch .store-sweep-hold` and remove
  `.store-sweep.json` at the store root first (and in its `_snapshots` and
  `accepted-snapshots` folders, which keep their own: A3b part 2).
- **Hard stops (a failure):** the run removes and marks nothing, logs the
  reason and fails the maintenance run.
  - A row naming a file outside the store's root, both sides compared as
    real paths (a root reached through a symlink, a row's absolute path
    written under another spelling).
  - A store holding files while no row names any (a wrong or empty
    `DATABASE_URL`).
  - A row whose current file (the first column of `STORE_FILE_COLUMNS`) is
    an OLDER revision than the one it named on the last run: revision
    tokens sort by time, and only a restore moves a row back (one that put
    down no hold). Unless `--allow-many`: read its dry run
    (`store:sweep --allow-many`), then `--apply --allow-many`.
- A file goes only once it has been unreferenced on two runs a grace period
  (`STORE_SWEEP_GRACE_MS`, an hour) apart and is older than the grace
  period: a stage in flight, a reader that resolved the old revision just
  before a flip, and the revision a running backup's dump names are never
  cut off. A mark takes the time the rows were read, not the run's start.
  The marks, and each item's current revision for the stop above, are kept
  in `.store-sweep.json` at the store's root. With the nightly run, an old revision goes on the second
  night after it was replaced: up to about two days.
- A SQLite file's `-wal`, `-shm` and `-journal` go with it. Idempotent;
  plain files and one read of the rows: no model, no extraction, no notify.
- The maintenance worker mounts both store folders (`docker-compose.yml`,
  pinned by `packages/content/src/invariants.test.ts`).

## Backups

`pg_dump` runs first, then the app databases, then the table workbooks
(`scripts/db-dump.sh`, the scheduled backup in `backup.ts`), while the brain
writes. A flip in between moves a row to a new file after the dump recorded
the old one. So `snapshotAllTableDatabases` and `snapshotAllAppDatabases`
copy the revisions of each table and app database on disk (the files of
its node in the folders its row names), each under its own name in its own
folder: the files the rows name now, and every other revision the sweep
had NOT marked unreferenced before the dump started (`markedBefore`; the
dump's start goes to the backup scripts as an argument). A flip never
points a row back at an old revision, except a restore, so a file marked
before the dump was unreferenced when the dump ran; the revision the dump
names is still on disk (the sweep's grace period) and is in the archive.
While a restore's hold is in place a backup leaves nothing out (the
restore pointed rows back at revisions the old memory may have marked; the
restore scripts also remove that memory). The rows' files come from the
same spec as the sweep's (`storeRows`). Without the dump's start every
revision goes. After a restore, the revisions the restored rows do not
name are the sweep's, once the restore's hold is lifted.

The snapshot store (A3b part 2): the history folders are hard-linked whole
(`linkHistoryTree`, the sweep's memory left out), so a backup holds every
snapshot file on disk, the ones whose rows were deleted after the dump
began among them (the sweep keeps a tombstoned file a day). Every
accepted copy of a table goes too (`revisionFiles`), the one the dump names
and the ones a newer copy replaced since.

## The lint

`eslint-rules/store-brokers.mjs` (rule `mantle-stores/store-brokers`). Each
store splits its API: readers keep the read entry, and the write API is
`@mantle/tabledb/write`, `@mantle/storage/write`, and the app SQL runner's
writing functions (with `APP_DB_DIR`). A file that reaches a store's write
API without a pin for that store fails lint; `eslint-rules/arch-lints.test.ts`
holds the pins exactly and checks the docs files. The tables store has its
broker alone. The object store's writers are the files broker
(`file-broker.ts`) and the app build broker (and the profile logo and
photo: not one of the six stores); the app database's are the app broker,
the snapshot broker (`snapshot-broker.ts`, which copies snapshot and
accepted files), and the package import's temp file. The files tree's disk
writes are the files ops' (through `disk.ts`), which the lint does not pin
(an owner question, A3b part 2).

## Off boxes

A box whose actor check is `off` writes on the system pool as before; the
checked statement there matches its row and refuses nothing. What changes,
for every box:

- **File names.** A table's workbooks and an app restore's database file
  take a new name with each revision; the row names the current one. The
  sweep removes the old ones (until then they take disk: a commit of a
  large table holds two copies for up to about two days).
- **The nightly sweep** reports, and never removes, files of items with no
  row and drafts from before A3b; a busy day's old revisions are removed
  over the next nights (a per-run budget, never a failure); it holds a
  store for a week after a restore (a done run that says HELD), and stops
  (failing the maintenance run) on the hard stops above.
- **Backups** also hold the revisions replaced since the last sweep run
  (not yet marked), until the sweep has removed them.
- **A busy app statement** waits out a seed or schema script for up to
  about 10 s instead of up to 30 s, then answers busy.
- **The legacy table migration** (a JSONB table made file-backed) moves the
  table's revision once: an editor open on such a table sees one conflict.
- **An app database write** adds one short transaction (the `write_seq`
  bump, which also reads the file the row names); a statement that then
  fails leaves the revision one higher.
- **Files** (A3b part 2). An overwrite holds the new bytes beside the old
  until the flip (a staging name the watcher ignores), and the old ones,
  hard-linked, until it settles. A rename or move the database refuses
  answers its refusal with nothing moved; the watcher no longer sees a
  refused move's unlink and add. A delete a row rule left at none answers
  not found and keeps the bytes.
- **Snapshots** (A3b part 2). A deleted, pruned or purged snapshot's file
  stays on disk for 24 h after its row went, until the first nightly sweep
  past that (the budgets count rows, so they free at once). A purge no
  longer removes files under an app's or table's history folder that no
  row ever named: the sweep reports them. A snapshot whose file a restore
  or commit replaced while it was copied is copied again. Email
  attachments' bytes are stored before the email's transaction: a sync
  whose rows never land leaves objects nothing names (shared by content,
  never swept).

## Cost

With both checks off, no statement is added to the six hot paths of the
round-trip test (tree load, item open, search, chat turn start, MCP tool
call, page save): none writes a store. On the store paths: a draft save, a
discard, a commit and a restore send the same statements (the read of the
row moves out of the transaction); an op batch on an existing draft adds one
(the bump and the mirror are two statements); an app database's single
statement adds one short transaction (its lock wait set, then the bump).

p95 per write (2026-10-13, the workstation, a disk folder, as the owner, 60
writes each, the second run; main `af5a041a5` against this branch):

| Write      | 1,000 rows main / A3b (ms) | 10,000 rows main / A3b (ms) |
| ---------- | -------------------------- | --------------------------- |
| draft save | 20.3 / 20.2                | 91.7 / 99.3                 |
| op batch   | 14.7 / 15.3                | 68.7 / 69.6                 |
| commit     | 36.1 / 41.4                | 129.5 / 140.8               |

p95 per write, A3b part 2 (2026-10-13, the workstation, a disk folder, as
the system on the owner's brain, 60 writes each (20 for the 32 MB ones),
the second round of a run; two runs each, main `de0699c37` against this
branch):

| Write                        | main (ms)  | A3b part 2 (ms) |
| ---------------------------- | ---------- | --------------- |
| file upload, 4 KB            | 6.5, 5.0   | 4.6, 5.1        |
| file upload, 32 MB           | 34.6, 35.7 | 34.1, 34.8      |
| file overwrite, 4 KB         | 4.7, 4.5   | 5.0, 5.1        |
| file overwrite, 32 MB        | 62.9, 64.1 | 66.1, 64.6      |
| file rename                  | 2.6, 2.8   | 3.4, 3.6        |
| app snapshot (10,000 rows)   | 6.2, 5.5   | 7.7, 7.1        |
| table snapshot (10,000 rows) | 8.3, 8.4   | 8.1, 8.1        |

An overwrite adds a hard link and a rename; a rename takes the file's head
and a checked statement; an app snapshot adds the history lock's second
short transaction (the copy is outside it now).

## Tests

- `packages/db/src/store-broker.test.ts`: the helper on plain files (the
  one-row check; stage then flip: a refusal or a rolled-back flip removes
  the stage at once, one that may have committed keeps it; the file names
  and the sidecar remover; the sweep: never a live file, never before the
  grace period, two runs apart, sidecars, never a file whose item has no
  row or whose row's file is missing, never a legacy draft, real paths, a
  busy day carried over runs, the restore hold, the hard stops (an older
  revision among them), marks at the rows' read time; what a backup may
  leave out, and nothing while a hold is in place).
- `server/web/server/a3b-store-brokers.db.test.ts`: per store, with both
  checks on (also in `pnpm test:edit-on`): a refused caller changes nothing
  on disk (bytes, mtime, file list, less the `-wal` and `-shm` a read of the
  draft opens), an allowed caller writes the row and the disk in step and
  readers follow the row, a crash between stage and flip leaves the old
  revision live and the stage for the sweep, a failed commit keeps its
  stage for the sweep as one that committed and then threw keeps it, a
  table created in an outer transaction that rolls back leaves no stage,
  the sweep removes the old revisions and keeps what it must, a restore's
  hold holds it, a backup during a hold keeps a revision a restore pointed
  a row back at, app writes waiting out a seed leave the write pool to
  another login's write, a backup taken while a flip lands restores the dump's
  revision, a restored draft and the backup keep a folded table's folder, a
  missing legacy draft is no draft, an app write whose row a restore moved
  writes neither file, a single statement waits out a 5 s seed and answers
  busy behind a 15 s one, and the off cells give today's results.
- `eslint-rules/arch-lints.test.ts`: the pins, the rule, the docs store.
- `packages/db/src/store-broker.test.ts` (A3b part 2): flip then place (a
  refusal never touches the disk; place runs once on a retry; a failed
  commit the database says never landed puts the disk back; a lost
  acknowledgement keeps it), and the tombstone rule (a tombstoned file goes
  a day after its row, by the database's age, never while a row names it,
  never one outside the root; the store root's hold; no stop while a
  tombstone names a file, nor for a snapshot folder with neither).
- `server/web/server/a3b2-store-brokers.db.test.ts` (A3b part 2), both
  checks on (also in `pnpm test:edit-on`): per store a refused caller changes nothing on disk (files: an
  overwrite, a rename, a file move, a folder rename and move, a delete;
  snapshots: an app snapshot, a table snapshot, a delete), an allowed
  caller writes row and disk in step, a folder move with hidden rows still
  answers 409 with nothing moved, a failed commit puts the files tree back
  and keeps a snapshot's stage (reported, never removed), a crash between
  stage and flip leaves the old bytes live and the stage for the
  staged-leftover sweep, a tombstoned file stays two hours on and goes a
  day on and a named one stays, an accepted copy's old revision goes by its
  tombstone, a backup holds every file a dumped row names, the off cells
  give today's results; and (fix round 1) a failed overwrite never puts
  its old bytes over a write that landed after it, two renames inside an
  outer transaction that rolls back go back last first, a delete inside
  one keeps its bytes, and the leftovers are listed and removed only by
  the deliberate command.
