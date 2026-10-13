# Store brokers: the database checks before the disk

Workspaces arch plan v2, phase A3b (sections 6, 11 and 20.3). The actors a
write runs as are in [actors.md](./actors.md); what the database checks is in
[edit-check.md](./edit-check.md).

Six stores keep data on disk, where no trigger sees it. Before A3b a disk
write could run before the Postgres statement the database checks (a table's
draft was written, then `draft_rev` bumped), so a write the database refused
had already changed the file. A3b gives each store ONE broker, the only
writer of its disk, and every broker writes in the same order.

## The broker rule

One helper, `packages/db/src/store-broker.ts`, holds the order; each broker
calls it, none copies it.

1. **One transaction** (`brokerTransaction`) on the store's row lock.
2. **The checked statement first**, as the caller's actor: the revision
   bump or the row write the database checks. On the write role (a login's
   write while the actor check is `warn` or `on`) the row rules and the edit
   check see it. It must match exactly one row (`StoreWrite.one`). No row is
   a refusal, `StoreRefusedError`: shaped as the edit check's own refusal
   (SQLSTATE 42501, detail `no_read`), so the one HTTP mapper answers 404 and
   the tools say "not found", with no new branch anywhere. A trigger's own
   refusal (403, 404) is thrown by the statement itself.
3. **Then the disk.** Every disk step (`replace`, `create`, `remove`,
   `inPlace`, `external`) throws if it comes before the check. Each step first
   records how to undo it in a journal beside the store's file
   (`<file>.broker`, written whole by a rename) with the revision the
   database now holds: the revision is then in both places. A whole-file
   replace keeps the old file aside by a hard link (a pre-image); a removal
   moves the file aside; a new file's undo removes it.
4. **A failure before the commit** (the disk step, or a later statement)
   undoes the disk at once, inside the transaction, the row lock still held,
   and rolls back. **A commit** drops the journal and the pre-images.
5. **A commit that fails after the disk write** (or a process that dies
   there) leaves the journal. The broker's next access, under the same row
   lock, trusts the database (`repairStore`): the journal's revision
   committed, it only tidies; it did not, the disk goes back (the pre-image
   restored, a new file removed, a removed file put back). The journal's
   revision being neither (something newer committed) never rolls the disk
   back over it. A file changed in place (a SQLite file edited where it
   lies) has no pre-image: its store rebuilds it from what the database
   holds when it can, else the write stays (it passed its check) and one
   warning says so.

Repair is bounded by construction: one journal, its own files, then the
journal is gone; no loop, no notify, no extraction. A read finds no journal
with one `existsSync`. A read that does find one repairs as
`system(repair:store-broker)` (`READ_PATH_WRITES`, `packages/db/src/actor.ts`).

Plan 20.3 says a broker holds no transaction across a large disk write. The
brokers that already held their row lock across the write (the tables
registry lock, an app's seed, schema script and restore) keep that lock and
put the check inside it; the app database's single statements (`host.db`,
an MCP write) commit the check on its own first and then run the app's SQL,
holding nothing.

## The stores

| Store | Broker | The checked statement | Revision |
| --- | --- | --- | --- |
| Table workbooks (SQLite) | `packages/content/src/table-broker.ts` | `UPDATE tables SET draft_rev = draft_rev + 1` (also the registry lock); a create: the node's INSERT; a delete: the node's DELETE | `tables.draft_rev` |
| App databases (SQLite) | `packages/content/src/app-broker.ts` | `UPDATE app_databases SET write_seq = write_seq + 1` | `app_databases.write_seq` (0283) |
| App build artifacts (RustFS) | `packages/tools/src/app-build-stage.ts`, through `setDraftBuild` (`packages/content/src/apps.ts`) | `UPDATE apps SET draft_build` (D4: a Moderator of the app's home) | the BuildRef's sha256 |
| Docs collections | the docs worker (`server/web/workers/docs-sync.ts`, `system(worker:docs-sync)`) | none: it writes no disk | `data.sha256` on the row |
| File bytes (disk and RustFS) | files ops (`packages/files/src/ops/files.ts`) | A3b part 2 | `data.sha256` on the file's row |
| Snapshot database files | the snapshot modules | A3b part 2 (a table commit's kept copy is already a step of the table's write) | the `node_snapshots` row |

- **Tables.** Every write of a table's files is one `withTableWrite`: the
  bump is the lock and the check in one statement, so the draft save, the op
  batch, the discard, both commits, a history restore and the legacy
  migration sweep add no statement for it (the op batch keeps one more: its
  JSONB mirror is computed from the file after the ops, see Cost). A stale
  `ifRev` is a conflict with nothing written; a commit with no draft rolls
  back and moves no revision. A create checks the node's INSERT; a delete
  checks that exactly one node was deleted and moves the files aside until
  the commit (they used to go after it, best effort). The draft's in-place
  op batch is rebuilt, on a repair, from the JSONB mirror the database holds
  for a single-tab draft inside the window; a multi-tab or larger draft keeps
  the batch. `getTable` repairs on read.
- **App databases.** A seed, a schema script and a restore bump the revision
  inside their transaction (it takes the row lock they took before), then
  write; a restore's swap keeps the live file aside and puts it back if the
  commit does not land. A single statement commits its check on its own
  first. `ensureAppDatabase` (every app read and write) repairs on read. The
  restore still writes its `.restoring` marker before the drain and removes
  it after, refused or not: a coordination file, not the store's data.
- **App builds.** The bundle is stored after the app row's checked write,
  inside its transaction: a build the database refuses stores nothing. The
  object store is content-addressed and shared across apps, so a commit that
  fails leaves an object nothing points at, which the next identical build
  reuses: nothing to repair, and nothing is ever deleted (an object may be
  another app's).
- **Docs.** The docs feature reads markdown and writes only rows; the lint
  holds its files to no file-writing import.

## The lint

`eslint-rules/store-brokers.mjs` (rule `mantle-stores/store-brokers`). Each
store splits its API: readers keep the read entry, and the write API is
`@mantle/tabledb/write`, `@mantle/storage/write`, and the app SQL runner's
writing functions (with `APP_DB_DIR`). A file that reaches a store's write
API without a pin for that store fails lint; `eslint-rules/arch-lints.test.ts`
holds the pins exactly (a file may only leave a list) and checks the docs
files. Today the tables store has its broker alone; the app database and
object store lists name the writers A3b part 2 moves behind their brokers.

## Off boxes

A box whose actor check is `off` (and so its edit check) writes on the system
pool as before; the checked statement there matches its row and refuses
nothing. What changes, for every box:

- **Order.** The check comes before the disk. A table write that fails now
  leaves the files as they were (before, a failed commit could leave a new
  draft or published file behind).
- **A deleted table's files** are moved aside inside the delete and dropped
  when it commits, instead of removed after it.
- **The legacy table sweep** (a JSONB table made file-backed) bumps the
  table's revision: an editor open on such a table sees one conflict, once.
- **An app database write** adds one statement (the `write_seq` bump); a
  statement that then fails leaves the revision one higher.
- **Journals.** A `<file>.broker` file sits beside a store's file only while
  a write runs, or after a commit that failed until the next access.

## Cost

With both checks off, no statement is added to the six hot paths of the
round-trip test (tree load, item open, search, chat turn start, MCP tool
call, page save): none writes a store. On the store paths:

- a table's draft save, discard, commits and restore: the same statements
  (the lock is the check);
- a table's op batch: one more UPDATE (the mirror, after the ops);
- an app database's single statement: one more (the bump, committed first);
- an app's seed, schema script and restore: one more (the bump, inside).

## Tests

- `packages/db/src/store-broker.test.ts`: the helper on plain files (the
  order, the undo inside the transaction, the journal a failed commit
  leaves, the repair each way, in-place writes, a newer revision, retries).
- `server/web/server/a3b-store-brokers.db.test.ts`: per store, with both
  checks on (also in `pnpm test:edit-on`): a refused caller changes nothing
  on disk (bytes, mtime, file list), an allowed caller writes the database
  and the disk in step, a commit that fails (a deferred trigger) is repaired
  on the next access, and the off cells give today's results.
- `eslint-rules/arch-lints.test.ts`: the pins, the rule, the docs store.
