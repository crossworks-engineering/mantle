# Plan v3.2 S10 handover: raw write SQL ban in scoped code

One section per round. Plan: section 3.2 and the S10 step; brief: ceo-kit
s10-brief.md.

## Round 1 (feat/s10-r1, from main 16c5e0311, v0.300.108)

### What changed

- The lint `eslint-rules/no-raw-write-sql.mjs`, pinned-count mode per file
  (`RAW_WRITE_PINS`), registered in `eslint.config.mjs` with the other
  ratchets (tests excluded). It counts with the scoreboard's own measure
  (`cleanup-counts.mjs` `rawWriteSqlSites`), so the lint and the pins
  `rawWriteSqlScoped` and `rawSqlNonLiteral` read the same sites.
  - Findings: a tagged template (`sql`, `sqlTag`, an alias or a transaction
    handle holding one) or `.unsafe(text)`, `<tag>.raw(text)`,
    `.execute(text)` with literal text, whose static text starts with
    INSERT, UPDATE, DELETE, MERGE or TRUNCATE after its comments are
    stripped and a leading WITH is walked; text with a data-modifying CTE;
    `.unsafe(x)` or `<tag>.raw(x)` with text that is no literal, unless
    wrapped in `readSql(...)`.
  - Not findings: reads (FOR UPDATE included), definer calls
    (`select "public"."mantle_x"(...)`), drizzle typed writes.
  - Where: `packages/*/src` and `server/`, counted files only (no tests, no
    migrations), test support left out (`isTestSupport`, now exported).
  - `pinnedRule` (arch-counts.mjs) passes the repo path to `count` as a
    second argument (the parser needs it); the other rules ignore it.
- The allowlist `eslint-rules/raw-write-allowlist.mjs`: 5 entries, each
  pinned with its site count and why, capped at 5
  (`RAW_WRITE_ALLOWLIST_CAP`):
  - `packages/db/src/migrate-runner.ts` (2): the migration runner;
  - `server/api/src/bench/haystack.ts` (1), `server/api/src/bench/run.ts`
    (1): test support, the memory benchmark's own scratch databases;
  - `server/api/src/crash-test.ts` (5): test support, the manual
    crash-recovery harness (never shipped);
  - `server/web/lib/snapshot-copies.ts` (3): a systemWork module (the boot
    step, pinned in system-work-allowlist.mjs).
    `system-step.ts` and the SQLite stores (packages/tabledb, the app DB
    runner) hold no site the rule reads, so they have no entry. The F auditor
    reviews the five.
- `eslint-rules/arch-lints.test.ts`: the scoped pins and the allowlist
  counts held exact (a pin only goes down), the scoreboard's per-file sites
  equal to the pins, the cap, a why per entry; RuleTester cells for a write,
  a write CTE, a write after a WITH, non-literal text, the allowlist pin,
  and the non-findings (FOR UPDATE, a definer call, a typed write,
  `readSql`, test support).
- Lanes, each raw write now a typed drizzle write (no definer: no
  migration in this round):
  - packages/content: 23 sites in app-access-log, app-nav, apps,
    contact-share-codes, contacts, node-snapshot-rows, recall-native,
    share-access-log, tree/apps-nav, tree/marks, tree/node-ops,
    tree/notes-auto-filed, tree/write; tree/kinds names its alias with
    `sql.identifier` (the one non-literal).
  - packages/files: auto-filed (2), move-copy (1), ops/files (3).
  - packages/runs: engine (1), sweep (3).
  - packages/embeddings: chunk-windows (3).
  - packages/email: none.
- Docs: docs/actors.md known limits line names the lint; docs/fail-open.md
  `item_marks` row is `typed-write` now.

### Same rows, actor and scope

Each statement keeps its SQL: the SET expressions, WHERE text and
RETURNING columns are the same fragments inside the typed builder. Changed
shapes, each the same rows:

- Insert-select (`chunk-windows.ts` two, `contact-share-codes.ts`):
  drizzle names every column of the table, in order. content_chunk_windows
  has exactly the five the raw text named. share_access_log has seven: the
  select adds `gen_random_uuid()` for `id`, the column's own default.
- `runs/engine.ts` cancelSubtreeItems: the WITH RECURSIVE moved from a
  leading CTE into the `id IN (...)` subquery; same snapshot, same rows.
- Aliases dropped where drizzle cannot alias the target (`nodes n`,
  `item_marks m`): the columns are qualified by the table name. The
  folder delete's landing path (tree/node-ops.ts) is built from the column
  it is given: `n.path` for its read, `"nodes"."path"` for the typed delete
  and move (the subquery's `nodes b` never shadows the target).
- `item_marks` inserts: the columns the raw text left out are sent as
  `default` (drizzle), the same as leaving them out.
- `runs/sweep.ts`: the uuid shape regex is a bound text parameter, not an
  inline literal; the same match.

### Routes

No write changed its route. The checks, from packages/db/src/gateway:

- `executeWrite(sql)` in a request scope outside a scope transaction goes
  to `systemWriteDb()`, whose `loginWriteClient` routes a single INSERT,
  UPDATE or DELETE by its table (`rawWriteTarget` against
  `WRITE_ROLE_TABLES`); `db.insert/update/delete` there goes to
  `typedWrite`, which routes by the same table set. Outside a request scope,
  or inside a scope transaction, both are `getDb()`. Every converted
  executeWrite was a single statement on one table, so the decision is the
  same table's.
- `tx.execute` to `tx.insert/update/delete`: the same transaction.
- `systemDb.execute` to `systemDb.delete`: the system pool both.
- `db.execute` to a typed write: `runs/sweep.ts` (the sweeper, no request
  scope: `getDb()` both) and `node-snapshot-rows.ts` pruneHistoryRows'
  default handle (its one default caller runs inside `systemStep`, the
  system pool both; the other callers pass their transaction).
- No converted statement ran under `withSystemPoolInWriteScope` (its two
  callers, server/web/lib/workspaces.ts, call definers only).

One telemetry label moves: the `item_marks` writes (tree/marks.ts,
tree/apps-nav.ts, app-nav.ts) were counted by the fail-open sites as
`raw-write` and now as `typed-write` (same table, same system pool). A box
count read by site sees them under the new site from this release on.
The same holds for the request-scope write label the W6a sweep pins: the
app-nav repair in a GET (tree/apps-nav.ts) is noted as `update`, not
`executeWrite` (server/web/server/w6a-route-sweep.db.test.ts, one line).

### Pins

| Pin               | Before           | After |
| ----------------- | ---------------- | ----- |
| rawWriteSqlScoped | 62               | 16    |
| rawSqlNonLiteral  | 75               | 72    |
| rawWriteSqlFiles  | 59 (67 measured) | 42    |
| rawWriteAllowlist | 0                | 5     |

The base's rawWriteSqlFiles pin was 59 while the counter measured 67 on
it (the key may grow, so arch:check let it pass); the drop is 67 to 42.

Per package (literal writes plus non-literal text): content 23+1 to 0,
files 6 to 0, runs 4 to 0, embeddings 3 to 0, email 0 to 0. The allowlist
took 10 literal and 2 non-literal sites.

### Gates

Code head d6e287183 (the fix commit; later commits are this file only).

Mac, DATABASE_URL unset (on 843aec330, the lanes; the fix commit then
re-ran typecheck of packages/content, eslint on its two files, and
`vitest run packages/content`, 0): `pnpm -r typecheck` 0, `pnpm lint` 0,
`pnpm format:check` 0, `pnpm docs:check` 0, `pnpm arch:check` 0,
`pnpm -C server/web build` 0, `vitest run server packages eslint-rules` 0
(857 files passed, 11073 tests). After the handover commit:
format:check 0, docs:check 0, arch:check 0, eslint eslint-rules 0,
`vitest run eslint-rules` 0.

Workstation (own clone ~/s10-r1-clone, own container s10-r1-pg on
127.0.0.1:56510, pgvector pg18, max_connections=450, the `postgres` role
as CI's, init-scratch and migrate with MANTLE_CHECK_FLOOR=keep,
systemd-run --user, --maxWorkers=3, one at a time):

- Run 1 (843aec330): full vitest 1, 17 failed in 8 files. 16 were the
  folder delete (the landing path named `n.path` after the alias was
  dropped: tree-kinds, tree-carry, tree-grants-confirm, tree-bugs,
  precheck-removal, precheck-removal-http, w7a's tree_folder_delete), 1
  the W6a pinned label (`executeWrite` to `update`). Fixed in d6e287183;
  the 8 files re-run: 0 (612 tests). The run was stopped during
  actor-off and started again.
- Run 2 (d6e287183): full vitest 0 (13855 passed), test:actor-off 0
  (1168), test:actor-on 0 (361), test:edit-on 0 (531), test:matrix 0 (8),
  test:runtime-role in full 0 (2764).

CI: run 39346461324 on d6e287183 failed one test,
packages/content/src/recall-native.db.test.ts M7 (the embed refill after
a concurrent edit; recall.ts is untouched, the file's other refills run
fire-and-forget). The same file on the workstation: 0 in run 2 and 0 in
three more runs. The failed job was re-run once: success (attempt 2, all steps green).
The docs-only head after it has its own run (in the report).

### Open items for r2

- Lanes left (scoped, 16 literal sites): packages/tools (no literal
  write; builtins-eval.ts holds one non-literal), packages/mcp-core (none),
  server/web/lib (integrity/landed.ts 2,
  maintenance/actor-misses-reap.ts 1, push/store.ts 1,
  auth/first-owner.ts 1 in the S8c lane), server/api/src/agent/runtime.ts
  1, packages/db (call-audit.ts 1, extract-skip-backfill.ts 1,
  space-carry.ts 4, store-broker.ts 1), server/web/scripts (dedupe-edges.ts
  1, relations-backfill.ts 1, traces-reap.ts 1).
- server/web/scripts are operator backfill and reap scripts: not in the
  allowlist's categories as the plan names them. r2 converts them, or the
  CEO decides they are system work and the F auditor reviews entries (the
  cap is 5 today).
- rawSqlNonLiteral 72: most in packages/db's gateway (set_config text it
  builds), access-matrix.ts and runtime-role.ts (the S7a lane). `readSql`
  does not exist yet as a helper: the lint accepts the wrapper by name.
  r2 or r3 adds it in packages/db for read text the code composes.
- The Telegram moderated-chat definer (named for S10 by the S7a a1
  builder): needs a migration, not done in r1. What r1 found:
  `setChatPairing` (packages/telegram/src/pairing.ts) holds no raw SQL; its
  one write is a typed `update(telegramChats)` that runs inside
  `telegramLoginSystem` (systemWork `'login-telegram'`), after the rule in
  TS (the chat's own login, or `loginModeratesBot`). The read side already
  asks `mantle_tg_moderated_chats` (0293) from server/web/lib/agent-telegram.ts.
  So the lint never sees it: the work is an exit removal, a new definer
  that asks the rule in SQL (the users area or a Moderator of the bot's
  assistant's workspace) and does the block or unpair, with write-role
  `EXECUTE` in the access matrix, then `setChatPairing` calls it in the
  login's scope and its `'login-telegram'` systemWork site goes (S7a's
  narrow role and system-work-allowlist.mjs move with it). For r2, with the
  round's one migration.

## Fix round 1 (feat/s10-r1, rebased on main 7b9b1c424, v0.300.110)

The audit at c3c4bc788 (8/10, fix first) and what each finding became.

### Fixes

1. The restamp's home grant (packages/files/src/ops/files.ts
   restampRacedCreate). A drizzle insert names every column of its table,
   sending the ones left out as `default`; Postgres needs INSERT on each
   named column, and the write role holds INSERT on five columns of
   item_grants only (access-matrix.ts writeColumnsFor). So the converted
   insert was refused (42501) on the write role where the raw text passed.
   The insert is raw text again, naming the four columns it writes, with
   the reason above it; the file is pinned at 1 in RAW_WRITE_PINS with the
   reason. The update and the delete stay typed (an update names only its
   SET columns; a delete names none). Today the stamp path runs only
   inside systemWork (snapshot-copies.ts), so no box ran the refused text;
   the cells prove what the write role does with it.
   - Guard: packages/db/src/write-role-inserts.test.ts (no DB). It derives
     from the access matrix and the drizzle schema the tables where the
     write role's INSERT column list leaves out a column of the table
     (today item_grants only: via_folder_id, bridge, granted_by,
     granted_at; pages, draws and tables have lists that cover every
     column), and fails on any `.insert(<that table>)` in scoped code (bare,
     a renamed import, `schema.<name>`). Every converted insert of round 1
     was checked by it: none left (chunk-windows and share_access_log
     inserts name tables the role does not insert by column).
   - Cells: packages/files/src/restamp-write-role.db.test.ts runs
     restampRacedCreate itself on a drizzle transaction logged in as
     mantle_write_user (session_user checked) in an Admin user's scope.
     With no create home it stamps the row (the typed update and select
     pass). With a create home its raw insert passes the column rights and
     reaches the row rule, which refuses it (42501, "row-level security
     policy for table item_grants", never "permission denied"); the drizzle
     insert of the same grant is refused by the column rights ("permission
     denied for table item_grants").
   - Finding for the CEO: with a create home the restamp cannot run on the
     write role whatever its insert text. It deletes every grant of the
     row first, so the row's read_ws empties and the item_grants insert
     rule (the node must be visible to the scope) refuses the new home.
     Today it runs only in systemWork (snapshot-copies.ts, the system
     pool), so nothing breaks; r3 sends scoped statements to the write role
     and systemWork stays on the system pool, so it still holds. If the
     stamp path ever runs in a scope, it needs a definer (or an update of
     the home row in place) in the round that adds a migration.
2. `.execute(x)` with a string. drizzle's execute runs a string as raw
   text, so `.execute(x)` now counts as non-literal when x is neither
   literal text nor SQL a tag built (cleanup-counts.mjs isSqlBuilder): a
   tagged template, a SQL tag's helper (`sql.join`, `sql.raw`, whose text
   is read where it is called), a ternary of two, a name declared with one
   or typed SQL, SQLWrapper, SQLChunk or `ReturnType<typeof sql>` (the
   innermost declaration in scope), a call of a function of the file that
   answers one or is typed so, or a member a type of the file declares as
   answering one. Measured: packages/db/src/gateway/handles.ts 2 to 4
   (executeWrite passes its `string | SQLWrapper` argument to execute,
   twice: a true pass-through of text); nothing else on the repo. Cells:
   cleanup-counts.test.ts "reads execute of anything but built SQL as
   text", arch-lints.test.ts RuleTester (execute of a name, of an untyped
   parameter, of a parameter that shadows a built name).
3. Several statements in one text. rawWriteKind reads each statement on
   its own (sqlStatements: split on `;` outside quoted strings, quoted
   names and dollar quotes), so `pg.unsafe('select 1; delete from t')`,
   sql`;delete from t` and sql`select ${a}; update t ...` are writes. No
   new site on the repo. Cells: cleanup-counts.test.ts "reads each
   statement of a text on its own" (quotes and dollar quotes split
   nothing), RuleTester cells for each shape.
4. readSql. `readSql(...)` takes the place of non-literal text only when
   readSql is imported from `@mantle/db` (a renamed import too), and a
   literal inside it is still read. @mantle/db exports no readSql yet, so
   no file can pass that way today (typecheck refuses the import); until
   it exists every `readSql(...)` counts as non-literal text. Cells: no
   import, an import from elsewhere, a write literal and a multi-statement
   literal inside it are findings; a composed text through the
   @mantle/db import is not. When readSql lands in packages/db, its own
   files import it by a relative path: widen readSqlNames then.
5. The hand-run harnesses. server/api/src/bench/haystack.ts,
   bench/run.ts and crash-test.ts are classified by path:
   cleanup-counts.mjs HAND_RUN_HARNESSES (exact paths, each with why,
   capped at 3), left out by the lint and the scoreboard as test support
   is. arch-lints.test.ts checks the cap, each why, that each file exists,
   is not linted and is in no pin list, and that no counted file imports
   one. The allowlist keeps migrate-runner.ts and snapshot-copies.ts; its
   cap is 2.
6. docs/fail-open.md: the `item_marks` line says what is, with no step
   name.
7. This file: the round 1 table gives rawWriteSqlFiles' base as pinned 59,
   measured 67.

### Pins

| Pin               | Round 1 | Fix round 1 | Why                                           |
| ----------------- | ------- | ----------- | --------------------------------------------- |
| rawWriteSqlScoped | 16      | 17          | files.ts restamp insert raw again             |
| rawSqlNonLiteral  | 72      | 74          | execute of a string (handles.ts executeWrite) |
| rawWriteSqlFiles  | 42      | 43          | files.ts                                      |
| rawWriteAllowlist | 5       | 2           | the three harnesses are classified by path    |

Per file: packages/files/src/ops/files.ts 0 to 1,
packages/db/src/gateway/handles.ts 2 to 4. historyCodeComments unchanged.

### Note for F: outside the plan's verb list

The lint reads the verbs the plan names (INSERT, UPDATE, DELETE, MERGE,
TRUNCATE, a data-modifying CTE). These write and are not read by it: a DO
block, COPY FROM, SELECT INTO, a select of a writing function that is not
a definer, and a text method reached by a computed key (`pg[m](x)`). None
is in scoped code today. After r3 every scoped statement runs on the write
role, which fails closed on any table it has no right on, so these are
caught at run time there, not by the lint.
