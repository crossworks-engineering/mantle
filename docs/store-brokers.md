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
   its delete, after the commit, as before A3b.

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

| Store | Broker | Check and flip | Readers resolve through |
| --- | --- | --- | --- |
| Table workbooks (SQLite) | `packages/content/src/table-broker.ts` (the only importer of `@mantle/tabledb/write`) | `UPDATE tables SET draft_rev = draft_rev + 1, storage_path / draft_path = <stage>` at the revision the stage was built from (`flipTable`); a create: the node's INSERT; a delete: the node's DELETE | `tables.storage_path` (published) and `tables.draft_path` (draft, migration 0283; `draftAbsOf` in `packages/content/src/table-storage.ts`) |
| App databases (SQLite) | `packages/content/src/app-broker.ts` | `UPDATE app_databases SET write_seq = write_seq + 1` (0283); a restore also flips `storage_path` | `app_databases.storage_path` |
| App build artifacts (RustFS) | `packages/tools/src/app-build-stage.ts`, through `setDraftBuild` (`packages/content/src/apps.ts`) | the bundle stored under its content address first, then `UPDATE apps SET draft_build` (D4: a Moderator of the app's home) | `apps.draft_build` |
| Docs collections | the docs worker (`server/web/workers/docs-sync.ts`) | none: it writes no disk | `data.sha256` on the row |
| File bytes (disk and RustFS) | files ops (`packages/files/src/ops/files.ts`) | A3b part 2 | the file's row |
| Snapshot database files | the snapshot modules | A3b part 2 (a table commit's history copy is already a stage of the commit) | the `node_snapshots` row |

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

## The sweep

ONE sweep for every store: `sweepOrphans` (the rule) over the stores'
specs in `packages/content/src/store-sweep.ts` (tables and app databases),
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
- **What it never removes, only reports:** a file whose item has no row (a
  deleted item's, a create that never landed, an app's file from before
  A3b; it may be the only copy), every file of an item whose row names a
  file that is missing, and a draft from before A3b
  (`<node>.draft.sqlite`). A legacy draft stays for ever once its table has
  been committed: the dry run (`pnpm -C server/web store:sweep`) lists each
  one ("kept, a draft from before A3b"); an operator who has checked that
  no row's `draft_path` names it removes it by hand.
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
  `.store-sweep.json` at the store root first.
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

## The lint

`eslint-rules/store-brokers.mjs` (rule `mantle-stores/store-brokers`). Each
store splits its API: readers keep the read entry, and the write API is
`@mantle/tabledb/write`, `@mantle/storage/write`, and the app SQL runner's
writing functions (with `APP_DB_DIR`). A file that reaches a store's write
API without a pin for that store fails lint; `eslint-rules/arch-lints.test.ts`
holds the pins exactly and checks the docs files. The tables store has its
broker alone; the app database and object store lists name the writers
part 2 moves behind their brokers (and the profile logo and photo, which
stay pinned: not one of the six stores).

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

| Write | 1,000 rows main / A3b (ms) | 10,000 rows main / A3b (ms) |
| --- | --- | --- |
| draft save | 20.3 / 20.2 | 91.7 / 99.3 |
| op batch | 14.7 / 15.3 | 68.7 / 69.6 |
| commit | 36.1 / 41.4 | 129.5 / 140.8 |

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
