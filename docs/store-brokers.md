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
   a dropped connection): the row is read again as the system
   (`stageNamedByRow`) and the stage goes only when no row names it; when
   that read fails too, it stays for the sweep. A row never points at a
   removed stage.
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
  statement's check waits at most `APP_DB_CHECK_LOCK_TIMEOUT_MS` (2 s) for
  that lock, then answers busy (`AppSqlBusyError`: the brokers' 429 with
  retry-after, the app retries) instead of queueing behind the seed.
- **Every app write checks its file.** The bump returns `storage_path`; a
  write whose row a restore moved to another file since it read it is
  refused before it touches either file (`AppDbRestoringError`, a busy
  answer: the caller reads the row again).

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
`pnpm -C server/web store:sweep [--apply [--allow-many]]`.

- **What it may remove:** an old revision only. A file the store owns (its
  revision names, one folder deep; never the history folder `_snapshots`,
  the accepted copies, the work files) that no row names, whose item HAS a
  row naming other files, all of them on disk: the revision a flip
  replaced, a stage a crash or a refused flip left.
- **What it never removes, only reports:** a file whose item has no row (a
  deleted item's, a create that never landed, an app's file from before
  A3b; it may be the only copy), every file of an item whose row names a
  file that is missing, and a draft from before A3b
  (`<node>.draft.sqlite`).
- **When it removes nothing:** both sides are compared as real paths (a
  root reached through a symlink, a row's absolute path written under
  another spelling). A row naming a file outside the store's root, a store
  holding files while no row names any (a wrong or empty `DATABASE_URL`),
  and a run that would remove more than 50 files, or more than 10% of the
  store's files once more than 10 would go, stop that store's run: nothing
  removed, the reason logged and in the report; the maintenance run is
  marked failed. `--allow-many` lifts the per-run limit after a dry run.
- A file goes only once it has been unreferenced on two runs a grace period
  (`STORE_SWEEP_GRACE_MS`, an hour) apart and is older than the grace
  period: a stage in flight, a reader that resolved the old revision just
  before a flip, and the revision a running backup's dump names are never
  cut off. The runs it has seen are kept in `.store-sweep.json` at the
  store's root.
- A SQLite file's `-wal`, `-shm` and `-journal` go with it. Idempotent;
  plain files and one read of the rows: no model, no extraction, no notify.
- The maintenance worker mounts both store folders (`docker-compose.yml`,
  pinned by `packages/content/src/invariants.test.ts`).

## Backups

`pg_dump` runs first, then the app databases, then the table workbooks
(`scripts/db-dump.sh`, the scheduled backup in `backup.ts`), while the brain
writes. A flip in between moves a row to a new file after the dump recorded
the old one. So `snapshotAllTableDatabases` and `snapshotAllAppDatabases`
copy EVERY revision of each table and app database on disk (the files of
its node in the folders its row names), each under its own name in its own
folder: the revision the dump names is still on disk (the sweep's grace
period) and so in the archive. After a restore, the revisions the restored
rows do not name are the sweep's.

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
  sweep removes the old ones after the grace period (until then they take
  disk: a commit of a large table holds two copies for a day).
- **The nightly sweep** reports, and never removes, files of items with no
  row and drafts from before A3b; it can stop a store's run (and fail the
  maintenance run) on the guards above.
- **Backups** hold every revision of a table or app database on disk until
  the sweep has removed the old ones.
- **The legacy table migration** (a JSONB table made file-backed) moves the
  table's revision once: an editor open on such a table sees one conflict.
- **An app database write** adds one short transaction (the `write_seq`
  bump, which also reads the file the row names); a statement that then
  fails leaves the revision one higher. A single statement that meets a
  running seed or schema script answers busy after 2 s instead of waiting
  up to 30 s.

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
  the stage at once, one that may have committed keeps a stage a row
  names; the sweep: never a live file, never before the grace period, two
  runs apart, sidecars, never a file whose item has no row or whose row's
  file is missing, never a legacy draft, real paths, the stops).
- `server/web/server/a3b-store-brokers.db.test.ts`: per store, with both
  checks on (also in `pnpm test:edit-on`): a refused caller changes nothing
  on disk (bytes, mtime, file list, less the `-wal` and `-shm` a read of the
  draft opens), an allowed caller writes the row and the disk in step and
  readers follow the row, a crash between stage and flip leaves the old
  revision live and the stage for the sweep, a failed commit takes its stage
  with it while one that committed and then threw keeps it, the sweep
  removes the old revisions and keeps what it must, a backup taken while a
  flip lands restores the dump's revision, a restored draft and the backup
  keep a folded table's folder, a missing legacy draft is no draft, an app
  write whose row a restore moved writes neither file, a single statement
  answers busy behind a seed, and the off cells give today's results.
- `eslint-rules/arch-lints.test.ts`: the pins, the rule, the docs store.
