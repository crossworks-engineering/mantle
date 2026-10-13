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
   is the statement's own. A flip that does not land (a refusal, another
   write that moved the row first, a failed commit) removes its stage at
   once (`stageThenFlip`).
3. **Sweep.** What no row points at any more (the revision a flip replaced,
   a stage a crash left, a deleted table's files) goes in the one sweep
   (`sweepOrphans`; below).

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
- **An app's seed and schema script** keep their row lock across the run
  (the check inside it, first): a restore takes the same lock, and a copy
  per seed would lose the single statements running meanwhile without the
  restore's drain.

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
  legacy JSONB migration stage new revisions, then flip (`stagedTableWrite`,
  retried when another write moved the table first; with an `ifRev`, that is
  the caller's conflict). A discard flips the draft pointer to none, with no
  disk write; a delete deletes the row, and the files are the sweep's. A
  draft written before 0283 keeps its old name: the migration points
  `draft_path` at it.
- **App databases.** A restore copies the snapshot as a new revision of the
  file, then flips `storage_path` (after its marker and drain, as before);
  the old file is the sweep's. A backup (`snapshotAllAppDatabases`) names
  each copy after the file the row points at, so the restore script puts it
  back where `storage_path` points.
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
`pnpm -C server/web store:sweep [--apply]`.

- It removes a file the store owns (its revision names only: never the
  history folder `_snapshots`, the accepted copies, the work files) that no
  row points at, read after the walk.
- A file goes only once it has been unreferenced on two runs a grace period
  (`STORE_SWEEP_GRACE_MS`, an hour) apart and is older than the grace
  period: a stage in flight, and a reader that resolved the old revision
  just before a flip, are never cut off. The runs it has seen are kept in
  `.store-sweep.json` at the store's root.
- A SQLite file's `-wal`, `-shm` and `-journal` go with it. At most 500
  removals a run. Idempotent; plain files and one read of the rows: no
  model, no extraction, no notify.

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
- **A deleted table's files** go with the sweep instead of right after the
  delete.
- **The legacy table migration** (a JSONB table made file-backed) moves the
  table's revision once: an editor open on such a table sees one conflict.
- **An app database write** adds one statement (the `write_seq` bump); a
  statement that then fails leaves the revision one higher.

## Cost

With both checks off, no statement is added to the six hot paths of the
round-trip test (tree load, item open, search, chat turn start, MCP tool
call, page save): none writes a store. On the store paths: a draft save, a
discard, a commit and a restore send the same statements (the read of the
row moves out of the transaction); an op batch on an existing draft adds one
(the bump and the mirror are two statements); an app database's single
statement adds one.

p95 per write (2026-10-13, the workstation, a disk folder, as the owner, 60
writes each, the second run; main `af5a041a5` against this branch):

| Write | 1,000 rows main / A3b (ms) | 10,000 rows main / A3b (ms) |
| --- | --- | --- |
| draft save | 20.3 / 20.2 | 91.7 / 99.3 |
| op batch | 14.7 / 15.3 | 68.7 / 69.6 |
| commit | 36.1 / 41.4 | 129.5 / 140.8 |

## Tests

- `packages/db/src/store-broker.test.ts`: the helper on plain files (the
  one-row check, stage then flip, the sweep: never a live file, never before
  the grace period, two runs apart, sidecars).
- `server/web/server/a3b-store-brokers.db.test.ts`: per store, with both
  checks on (also in `pnpm test:edit-on`): a refused caller changes nothing
  on disk (bytes, mtime, file list, less the `-wal` and `-shm` a read of the
  draft opens), an allowed caller writes the row and the disk in step and
  readers follow the row, a crash between stage and flip leaves the old
  revision live and the stage for the sweep, a failed commit takes its stage
  with it, the sweep removes the old revisions, and the off cells give
  today's results.
- `eslint-rules/arch-lints.test.ts`: the pins, the rule, the docs store.
