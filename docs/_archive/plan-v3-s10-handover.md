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

### Gates

Rebased on main 7b9b1c424 (v0.300.110): one conflict, in
scripts/arch-scoreboard.pins.json (main's loginTypeKindOrRole 0 and its
note kept, this branch's raw write keys taken).

Mac, DATABASE_URL unset, on 892fe5141 (the fixes): `pnpm -r typecheck` 0,
`pnpm lint` 0, `pnpm format:check` 0, `pnpm docs:check` 0,
`pnpm arch:check` 0, `pnpm -C server/web build` 0,
`vitest run server packages eslint-rules` 0. After the cell commit:
typecheck of packages/files 0, eslint on the two new test files 0,
`vitest run packages/files packages/db/src/write-role-inserts.test.ts
eslint-rules` 0, format:check 0, docs:check 0, arch:check 0.

Workstation (own clone ~/s10-fr1/clone, own container s10-fr1-pg on
127.0.0.1:56520, pgvector pg18, max_connections=450, the `postgres` role
as CI's, init-scratch and migrate with MANTLE_CHECK_FLOOR=keep,
systemd-run --user, --maxWorkers=3, one at a time), on 0dc7fb965: full
vitest 0 (13884 passed, 1 skipped), test:actor-off 0 (1180),
test:actor-on 0 (371), test:edit-on 0 (541), test:matrix 0 (8),
test:runtime-role in full 0 (2781; the restamp cells ran in it and in
the full run). The cell file took three tries before the full run (its
create workspace had to be a private one, then the row rule finding
above); no flake. Cleaned up: container (with its volume) and the
folder, by name.

CI: run 39360799210 on 0dc7fb965: success. The handover commit after it
has its own run (in the report).

## Round 2a (feat/s10-r2a, from main 2f5a75ad5, v0.300.111)

The CEO split round 2: r2a takes the sites outside the other lanes
(packages/db, server/web/lib/auth, lib/workspaces.ts, assistant-chat.ts,
workspace-turn.ts and the app routes are not in it). No migration, no
definer: each raw write is a typed drizzle write.

### Sites

| File:line (on main)                                | Kind                    | Became                                                  |
| -------------------------------------------------- | ----------------------- | ------------------------------------------------------- |
| server/web/lib/integrity/landed.ts:221             | write (executeWrite)    | `db.delete(traces)`                                     |
| server/web/lib/integrity/landed.ts:244             | write (tx.execute)      | `tx.delete(nodes)`, the same heads transaction          |
| server/web/lib/maintenance/actor-misses-reap.ts:36 | write (db.execute)      | `db.delete(actorCheckMisses)` with the same id subquery |
| server/web/lib/push/store.ts:265                   | write (tx.execute)      | `tx.delete(pushSubscriptions)`, the same transaction    |
| server/api/src/agent/runtime.ts:506                | write (db.execute)      | `db.update(telegramMessages)`                           |
| server/web/scripts/dedupe-edges.ts:66, 98          | non-literal (`unsafe`)  | the partition list written into both statements         |
| server/web/scripts/dedupe-edges.ts:92              | write (postgres.js tag) | `drizzle(sql).delete(entityEdges)`, the same client     |
| server/web/scripts/relations-backfill.ts:92        | non-literal (`unsafe`)  | one tagged template with optional fragments (a read)    |
| server/web/scripts/relations-backfill.ts:118       | write (postgres.js tag) | `drizzle(sql).update(nodes)`, the same client           |
| server/web/scripts/traces-reap.ts:63               | write (postgres.js tag) | `drizzle(sql).update(traces)`, the same client          |

packages/tools/src/builtins-eval.ts:95 (its one non-literal site) is a
read: `sql.raw` of a tag array literal inside a select. Not a write, so not
in r2a.

### Same rows, actor and scope

Each statement keeps its WHERE text; the SQL drizzle renders was checked
with `drizzle.mock()`:

- The id-subquery deletes (actor_check_misses, push_subscriptions,
  entity_edges): the subquery reads the unaliased table inside its own
  parentheses; the qualified `"<table>"."id"` stands outside them and names
  the target. `returning` names the same column.
- The Telegram heal: the alias `m` is gone; the subquery's
  `telegram_messages r` hides the table's name inside it, so
  `"telegram_messages"."id"` there names the row being updated (as `m.id`
  did). `processed` is a bound `true`, `processed_at` the same coalesce.
- traces-reap: `status` and `error` bound, `finished_at = now()`,
  `duration_ms = null`, the same WHERE text.
- relations-backfill's read: the same conditions in the same order; the
  optional clauses are postgres.js fragments (an empty fragment when
  absent), the array and the date bound as before.
- No table here has a drizzle `$onUpdate` a typed update would add (none in
  packages/db/src/schema). No insert: the column-grant guard
  (packages/db/src/write-role-inserts.test.ts) has nothing to read.
- The scripts build `drizzle(sql)` on their own postgres.js client after
  their reads: drizzle sets that client's date parsers and serializers to
  pass text through, which would change a read that returns a timestamp
  (traces-reap's `started_at`) or binds a Date (relations-backfill's
  `--since`). The writes bind no date.

### Routes

No write changed its pool:

- landed.ts traces delete: `executeWrite` in the owner's POST request went
  to `systemWriteDb()`, whose `loginWriteClient` sent `public.traces` (not
  a write-role table) to the system pool; `db.delete(traces)` goes to
  `typedWrite`, which sends a table outside the write role's set to the
  system pool. With no login write pool open both are the system pool.
- landed.ts nodes delete, push/store.ts: `tx.execute` to `tx.<verb>`, the
  same transaction.
- actor-misses-reap.ts (the maintenance worker and its script) and
  runtime.ts drainPending (the agent's start, no request): no request
  scope, so `db.execute` and `db.<verb>` are both `getDb()`.
- The three scripts: the same postgres.js client (`DATABASE_URL`), the same
  connection count.

Labels that change, both for the landed.ts traces delete only:

- the request-scope write label (`noteRequestSystemWrite`): `executeWrite`
  to `delete`. Only GET routes are pinned in
  server/web/server/w6a-route-sweep.db.test.ts; this is a POST.
- the fail-open site (`noteScopedSystemWrite`) for `public.traces`:
  `raw-write` to `typed-write`. scripts/arch-scoreboard-box.sh counts both
  sites apart, so a box that ran the integrity delete sees its count under
  `typed-write` from this release on. docs/fail-open.md says so in one
  line under its table.

### Pins

| Pin               | Before | After |
| ----------------- | ------ | ----- |
| rawWriteSqlScoped | 17     | 9     |
| rawSqlNonLiteral  | 74     | 71    |
| rawWriteSqlFiles  | 43     | 36    |

RAW_WRITE_PINS lost seven entries: landed.ts 2, actor-misses-reap.ts 1,
push/store.ts 1, runtime.ts 1, dedupe-edges.ts 3, relations-backfill.ts 2,
traces-reap.ts 1. historyCodeComments measures 2337 (pinned 2338: one
comment in landed.ts lost its step code); left for D2's key, arch:check
passes.

The actor-misses-reap unit test's database double builds the typed delete
with `drizzle.mock()` and checks its text.

### Gates

Code head d5e8a7c4d (the conversions). The commit after it changes a
comment of dedupe-edges.ts and this file only.

Mac, DATABASE_URL unset, on d5e8a7c4d: `pnpm -r typecheck` 0, `pnpm lint` 0,
`pnpm format:check` 0, `pnpm docs:check` 0, `pnpm arch:check` 0,
`pnpm -C server/web build` 0, `vitest run server packages eslint-rules` 0
(858 files passed, 11085 tests). After the comment and handover commit:
format:check 0, docs:check 0, arch:check 0, eslint on dedupe-edges.ts 0,
server/web tsc 0.

Workstation (own clone ~/s10-r2a/clone, own container s10-r2a-pg on
127.0.0.1:56530, pgvector pg18, max_connections=450, the `postgres` role as
CI's, init-scratch and migrate with MANTLE_CHECK_FLOOR=keep, systemd-run
--user, --maxWorkers=3, one at a time), on d5e8a7c4d: full vitest 0 (13884
passed, 1 skipped), test:actor-off 0 (1180), test:actor-on 0 (371),
test:edit-on 0 (541), test:runtime-role in full 0 (2781), test:matrix 0
(8). No flake, no rerun. Cleaned up: the container (with its volume), the
folder and the unit, by name.

CI: run 39370506188 on d5e8a7c4d: success. The docs heads after it have
their own run (in the report).

### Open items for r2b

- Literal write sites left (9): packages/db call-audit.ts 1,
  extract-skip-backfill.ts 1, space-carry.ts 4, store-broker.ts 1 (the S7a
  lane); server/web/lib/auth/first-owner.ts 1 (the S8c lane);
  packages/files/src/ops/files.ts 1 (the restamp's home grant, raw on
  purpose until a definer).
- Non-literal sites left (71): packages/db (the gateway's own statements,
  access-matrix.ts, runtime-role.ts and the rest, the S7a lane);
  server/web/lib/integrity/audit.ts 5, maintenance/ocr-rescan.ts 1, three
  server/web scripts (backfill-conversation 2, extract-backfill 1,
  extract-images-backfill 2), packages/search/src/entities.ts 1 and
  packages/tools/src/builtins-eval.ts 1 (a read). `readSql` does not exist
  yet.
- The Telegram moderated-chat definer (a migration), as round 1 found.

## Round 2b (feat/s10-r2b, from main 975bee317, v0.300.114)

The rest of round 2 outside the other lanes. No migration, no definer.

### Sites

| File:line (on main)                               | Kind                     | Became                                                                  |
| ------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------- |
| packages/db/src/call-audit.ts:320                 | write (systemDb.execute) | `systemDb.insert(auditLog).select(...)`                                 |
| packages/db/src/extract-skip-backfill.ts:85       | write (systemDb.execute) | `systemDb.update(nodes)`                                                |
| packages/db/src/space-carry.ts:98                 | write (q.execute)        | `q.delete(nodes)`, the same transaction                                 |
| packages/db/src/space-carry.ts:116                | write (WITH ... UPDATE)  | `q.update(nodes).from(<the ranked rows as a subquery>)`                 |
| packages/db/src/space-carry.ts:143, 148           | write (q.execute)        | `q.update(nodes)`, the same transaction                                 |
| packages/db/src/store-broker.ts:380               | write (db.execute)       | `db.delete(storeTombstones)`                                            |
| server/web/lib/auth/first-owner.ts:49             | write (db.execute)       | `db.insert(authUsers).select(...)`, the same WHERE NOT EXISTS           |
| server/web/lib/integrity/audit.ts:250-307 (5)     | non-literal (read)       | `sql.raw(readSql(<the shared catalog text>))`                           |
| server/web/lib/maintenance/ocr-rescan.ts:232      | non-literal (in a SET)   | the key array bound: `array[$1, ...]::text[]`                           |
| server/web/scripts/backfill-conversation.ts:301   | non-literal (DDL)        | `sql.identifier(SUMMARIZE_TRIGGER)`                                     |
| server/web/scripts/backfill-conversation.ts:323   | non-literal (DDL)        | the same                                                                |
| server/web/scripts/extract-backfill.ts:92         | non-literal (read)       | one tagged template with optional fragments                             |
| server/web/scripts/extract-images-backfill.ts:161 | non-literal (read)       | a tagged template; the pattern and the limit bound                      |
| server/web/scripts/extract-images-backfill.ts:265 | non-literal (read)       | a tagged template with an optional limit                                |
| packages/search/src/entities.ts:411               | non-literal (read)       | `client.unsafe(readSql(queryText)).simple()` (the simple protocol kept) |

`readSql` is new: packages/db/src/read-sql.ts, exported from @mantle/db. It
answers the text itself when it is one statement that reads and throws
`NotReadSqlError` otherwise (isWriteSql: a write verb, DDL, a write clause
anywhere, a row lock, a sequence or advisory lock call; or a `;` with more
after it outside quotes, comments and dollar quotes). Strict on purpose: a
read that needs FOR UPDATE stays literal text. read-sql.test.ts: each of
the five shared catalog texts passes unchanged, writes and two statements
throw. The entities read keeps its inlined values (the simple protocol
takes no parameters; each value is checked before, as it was).

The packages/db sites sit outside packages/db/src/gateway and narrow-route,
as asked. Nothing needed packages/files, packages/content/src/tree or the
Telegram moderated-chat definer: carrySpaceRows keeps its signature
(`Pick<Db, 'execute'>`, the type packages/content tree/node-ops.ts gives its
transaction) and checks at run time that it was handed a drizzle
transaction before its first write.

### Same rows, actor and scope

- The insert-selects (audit_log, auth.users): drizzle names every column of
  the table, so the select gives each a value in the table's order. The
  columns the raw text left out take their column defaults' values:
  audit_log `id` gen_random_uuid(), `created_at` now(); auth.users
  `created_at` now(), `display_name`, `last_login_at`, `contact_id`,
  `disabled_at` null, `session_epoch` 0. The column-grant guard
  (write-role-inserts.test.ts) has nothing to read: neither table is one
  the write role inserts by column (audit_log is the system pool's, and the
  narrow role's grants are table-wide).
- space-carry: the target cannot take an alias, so each fragment takes the
  row it reads (`"nodes"."path"` for the target, `n.path` in the subquery
  that reads nodes as n); the `nodes b` subqueries hide the table's name,
  so `"nodes"."owner_id"` there is the row the delete reads, as `n.owner_id`
  was. The file rename's leading WITH moved into the update's FROM as a
  subquery: the same snapshot, the same ranked rows.
- extract-skip-backfill, store-broker: the same SET and WHERE fragments.
- ocr-rescan: the keys were inlined literals, now bound text; the same array.
- The scripts' reads: the same conditions in the same order; the pattern,
  the dates and the limits bound where they were inlined (the regex is the
  same string).

Probe (workstation, a fresh migrated scratch database per run): one script
ran the converted functions themselves from main's clone and from the
branch's, with the same seed, and printed the rows they left (ids replaced
by titles): createFirstOwner (the row's columns, a second call answering
`exists`); carrySpaceRows as a lift (merge of a member folder, a file name
clash renamed `a-2.txt` and `b-2`), a rename that clamps deeper folders, and
a Files move (the `space_files` mirror); backfillTerminalSkips dry and
applied (the stamp's reason, the telegram rule); forgetTombstones. The two
outputs are byte-equal (`diff` exit 0). call-audit's insert: the
a5-call-audit cells read the row's columns and pass on the branch.

### Routes and labels

No write changed its route:

- call-audit, extract-skip-backfill: `systemDb.execute` and `systemDb.insert`
  / `update` take the same handle (the narrow route in a turn or request
  scope while its switch is on, else the system pool).
- space-carry, ocr-rescan: `tx.execute` to `tx.<verb>`, the same transaction.
- store-broker forgetTombstones: its one caller is the store sweep (the cron
  worker and the CLI), outside any request scope: `db.execute` and
  `db.delete` are both `getDb()`.
- first-owner: the signup row binds a system actor and opens no request
  scope, and scripts/onboard.ts runs outside one: `db.execute` and
  `db.insert` are both `getDb()`. Inside a request scope (no caller does
  it) the typed insert would go to the system pool by typedWrite and note
  `typed-write` for auth.users, where the raw text ran in the scope.
- The three round 2a scripts (dedupe-edges, relations-backfill, traces-reap)
  now give drizzle a client of its own (a second connection to the same
  DATABASE_URL, closed after the write): drizzle sets its client's date
  parsers to pass text through, so a read on the shared client after it
  (relations-backfill's pg_notify loop; none returned or bound a date
  there, so nothing changed before either) can no longer be touched. Each
  write is one autocommit statement as before.

Labels: none changes. No converted write passes typedWrite or
loginWriteClient on a path a caller reaches, so the fail-open sites
(scripts/arch-scoreboard-box.sh) and the request-scope write label count
the same. A narrow-route denial's detail quotes the statement's text, which
for the audit row is now drizzle's (`insert into "audit_log" ("id", ...`).

### Round 2a audit lows

- historyCodeComments: measured 2335 on main and on the branch; the pin was
  already 2335 (main lowered it with round 2a); its note now leads with the
  measure.
- Cells: server/api/src/agent/telegram-heal.db.test.ts (the heal is now
  `healRepliedTelegramMessages`, which drainPending calls; a scratch
  database, as the heal reads every row): replied rows flip, a set
  processed_at is kept, an unreplied, an already processed and an
  inbound-answered row stay; the raw text, run first and rolled back, picks
  the same rows. server/web/lib/push/device-cap.db.test.ts: twelve devices
  plus a new one drop the three oldest (two share a created_at at the cap's
  edge, so the id decides), the raw text picks the same, another login's
  device stays.
- The scripts' drizzle client: above.
- docs/fail-open.md: `public.traces` is a row of the S4b table (the
  integrity screen's delete in an Admin user's scope, proposed reason
  `'integrity-repair'`).

### Pins

| Pin                 | Before | After |
| ------------------- | ------ | ----- |
| rawWriteSqlScoped   | 9      | 1     |
| rawSqlNonLiteral    | 75     | 63    |
| rawWriteSqlFiles    | 36     | 26    |
| historyCodeComments | 2335   | 2335  |

RAW_WRITE_PINS lost eleven entries (call-audit 1, extract-skip-backfill 1,
space-carry 4, store-broker 1, first-owner 1, integrity/audit 5,
ocr-rescan 1, backfill-conversation 2, extract-backfill 1,
extract-images-backfill 2, entities 1). The one literal write left is the
restamp's home grant (packages/files/src/ops/files.ts, raw on purpose).

### Gates

Code head 8b2c48c54 (the conversions and cells). The commits after it
change this file only.

Mac, DATABASE_URL unset, on 8b2c48c54: `pnpm -r typecheck` 0, `pnpm lint` 0
(one warning, an unused disable in contact-sharing-routes.db.test.ts, on
main too), `pnpm format:check` 0, `pnpm docs:check` 0, `pnpm arch:check` 0,
`pnpm -C server/web build` 0, `vitest run server packages eslint-rules` 0
(860 files passed, 11098 tests). After the handover commit: format:check
0, docs:check 0, arch:check 0.

Workstation (own clones ~/s10-r2b/clone and ~/s10-r2b/main for the probe,
own container s10-r2b-pg on 127.0.0.1:56546, pgvector pg18,
max_connections=450, the `postgres` role as CI's, init-scratch and migrate
with MANTLE_CHECK_FLOOR=keep, systemd-run --user, --maxWorkers=3, one at a
time), on 8b2c48c54: full vitest 0 (13927 passed, 1 skipped),
test:actor-off 0 (1195), test:actor-on 0 (380), test:edit-on 0 (550),
test:matrix 0 (8), test:runtime-role in full 1 then 0 on its one rerun
(2811 passed both times; the first run's exit was an unhandled
CONNECTION_CLOSED from a pool closing at the teardown of
w7e-member-scope.db.test.ts, a file this round does not touch). The probe
(above) diff exit 0.

CI: run 39407726636 on 8b2c48c54: success.

### Open items for r3

- rawWriteSqlScoped 1: the restamp's home grant
  (packages/files/src/ops/files.ts, the S13 lane), raw until a definer.
- rawSqlNonLiteral 63: packages/db's gateway and narrow route (their own
  pass-through statements, pinned), access-matrix.ts, runtime-role.ts,
  scope-readable.ts and the other packages/db files (the S7a lane), and
  packages/tools/src/builtins-eval.ts (a read). Each can take readSql where
  its text only reads; inside packages/db that needs readSqlNames widened
  to a relative import of ./read-sql.
- readSql refuses FOR UPDATE and advisory locks as isWriteSql does; the
  lint does not count them. A read that needs one stays literal text.
- The Telegram moderated-chat definer (a migration), as round 1 found.
- r3 (when the scoped pin is 0): rawWriteTarget and its test go.

### Fix round 1 (the round 2b audit at e4c188952)

Rebased on main 178662f6a (v0.300.116). The pins conflict kept main's
historyCodeComments (2334, its note as main has it) and the branch's three
S10 pins; measured on the rebased head: rawWriteSqlScoped 1,
rawSqlNonLiteral 63, rawWriteSqlFiles 26, historyCodeComments 2334.

#### readSql (the blocker)

One reader for the shape of SQL text, packages/db/src/sql-text.ts (no
imports, erasable syntax only), used by readSql and by the lint
(eslint-rules/cleanup-counts.mjs imports the .ts file; Node 26 runs it as
it is). sqlCode blanks comments, string and dollar-quote bodies and quoted
names to the same length, as the PostgreSQL lexer reads them where a
mistake could hide code: nested block comments, a `--` inside a string, a
`$` inside a name (`a$q$` opens no dollar quote), E'' backslashes. It flags
an unterminated comment, string or quote, and `ambiguous` text (a backslash
before a quote in a plain string, which standard_conforming_strings
decides; a U&"" name). sqlStatements cuts at the code's `;`, withParts walks
a leading WITH, firstWord reads a statement's verb.

readSql (packages/db/src/read-sql.ts) answers the text unchanged only when
its code is exactly one statement that starts with SELECT, WITH, VALUES or
TABLE, whose every CTE body starts with SELECT, VALUES, WITH or TABLE (a
nested WITH read the same way), with no INSERT, UPDATE, DELETE or MERGE
where a statement may start (the start or after `(`), no INTO, no row lock,
and no call of a function on WRITE_FUNCTIONS (set_config, setseed, the
advisory locks, nextval, setval, pg_notify, lo__, lowrite, dblink_, the
backend, WAL, replication, stat reset and file functions, query_to_xml*,
cursor_to_xml*, ts_stat), matched as a call (quoted or schema-qualified
too) so a value or a longer name never matches. Everything else throws:
a second statement, COPY, GRANT, REVOKE, SET, RESET, EXPLAIN, CALL, DO,
LOCK, NOTIFY, DDL, unterminated or ambiguous text, a WITH it cannot walk
(SEARCH or CYCLE). Its top comment now says what it guarantees (the text's
shape) and what not (what a function the text calls does; the role is the
bound there).

The lint's literal check (rawWriteKind) reads with the same sqlCode,
sqlStatements and withParts: a write CTE after a `'--'` string is now found
there too. Its findings on the repo did not move (the four pins above).

Tests (packages/db/src/read-sql.test.ts, 68): each refused shape throws,
among them every shape the audit named: `with x as (update nodes n set
...)`, `update only`, the `'--'` string before a delete CTE, SELECT INTO,
a MERGE CTE, COPY FROM, GRANT, REVOKE, SET ROLE, set_config, the advisory
locks (lock, try, xact, unlock), nextval, setval, pg_notify, lo_import,
lo_unlink, dblink, dblink_exec, query_to_xml, EXPLAIN ANALYZE MERGE, and
next to them a `$` name hiding a statement, a nested comment hiding one, a
backslash before a quote, a U&"" name, unterminated text, no statement.
Each passes unchanged: the five shared catalog texts, reads with quotes,
comments, nested comments, WITH (materialized, nested), VALUES, TABLE, a
parenthesised union, E'' strings, definer and catalog calls (currval,
pg_has_role). eslint-rules/cleanup-counts.test.ts: the lint finds each
write the reader shows (the audit's shapes) and readSql refuses the same
texts; a value that spells a write is neither.

#### The lows

- Stale comments: eslint-rules/no-raw-write-sql.mjs (readSql exists, what
  it does at run time) and eslint-rules/cleanup-counts.mjs readSqlNames
  and rawWriteAllowed.
- Positional insert-selects: auditRowSelect (packages/db/src/call-audit.ts)
  and firstOwnerSelect (server/web/lib/auth/first-owner.ts) are exported
  builders now; call-audit-select.test.ts and first-owner-select.test.ts
  render the typed insert with drizzle.mock (no database) and hold each
  column to its value by insertSelectPairs (sql-text.ts, exported as
  @mantle/db/sql-text): the count equals the table's columns and each pair
  is pinned, so a column added, dropped or moved fails the test.
- The graph walk's verbs: a verb sits in a string literal, which sqlCode
  blanks, so no verb is read as code. graphPathSql (packages/search/src/
  entities.ts) builds the text; graph-path-sql.test.ts runs readSql on it
  with every option and each verb, the extractor's and ones that spell
  nextval, setval, pg_notify, set_config, delete, into and the rest.

No route, label or written row changed: the conversions are as round 2b
left them; the builders are the same text moved into functions.

#### Gates

Code head f473f3c49 (rebased on main 0d24af602, v0.300.117; main's new
commits touch no file of the branch). The first pass ran on 563f6fc7a, the
same code on v0.300.116.

Mac, DATABASE_URL unset, on f473f3c49: `pnpm -r typecheck` 0, `pnpm lint`
0 (the one warning main has), `pnpm format:check` 0, `pnpm docs:check` 0,
`pnpm arch:check` 0, `pnpm -C server/web build` 0, `vitest run server
packages eslint-rules` 0 (865 files passed, 11199 tests). The same seven
were 0 on 563f6fc7a.

Workstation (own clone ~/s10-r2bf/clone, own container s10-r2bf-pg on
127.0.0.1:56561, pgvector pg18, max_connections=450, the `postgres` role as
CI's, init-scratch and migrate with MANTLE_CHECK_FLOOR=keep, systemd-run
--user, --maxWorkers=3, one at a time):

- on 563f6fc7a: full vitest 1, then 1 on its one rerun (both 1139 files
  and 14015 tests passed; each exit an unhandled CONNECTION_CLOSED from a
  pool closing at teardown, of w7e-member-scope.db.test.ts and then
  turn-create-home.db.test.ts, files this round does not touch);
  test:actor-off 0 (1260); test:runtime-role 0 (2811).
- on f473f3c49: full vitest 0 (1140 files, 14028 tests); test:actor-off 0
  (1260); test:runtime-role 1 (2811 tests passed; the afterAll of
  role-readers-catalog.db.test.ts, a scratch database drop, timed out at
  10 s), then 0 on its one rerun (283 files, 2811 tests).

CI: run 39424146598 on 563f6fc7a: attempt 1 failure (all 14015 tests
passed; the same teardown CONNECTION_CLOSED, from
turn-create-home.db.test.ts, which another lane's run hit the same day),
its rerun cancelled by the push of f473f3c49. Run 39431352786 on
f473f3c49: attempt 1 failure (all 14028 tests passed; the same
CONNECTION_CLOSED from turn-create-home.db.test.ts), attempt 2 (the failed job rerun once) success.

Then rebased on main 520659a30 (v0.300.118; no conflict: main touched
cleanup-counts.mjs and packages/db/src/index.ts on other lines), code head
cdc84b5bd. Mac, DATABASE_URL unset, on cdc84b5bd: typecheck 0, lint 0,
format:check 0, docs:check 0, arch:check 0 (the four pins as above),
server/web build 0, vitest 0 (867 files passed, 11205 tests). The
workstation suites were not run again on this base.

#### Open items

- sqlCode in packages/db/src/gateway/narrow-route.ts does the same job as
  sql-text.ts sqlCode (blank comments and literals) without nested
  comments or a `$` inside a name; the gateway is outside this lane. One
  reader for the narrow route's checks is a later step.
- readSql reads shape, not functions: a function the database defines may
  write (see its top comment). The roles stay the bound.
- From round 2b: rawWriteSqlScoped 1 (the restamp's home grant),
  rawSqlNonLiteral 63, the Telegram moderated-chat definer, r3.

### Fix round 2 (the re-audit at f77e3800f)

Rebased on main a5bbb2373 (v0.300.119, the postgres.js teardown patch)
with no conflict: main touched no file of the branch, the pins file
included. Measured on the rebased head and again on the code head:
rawWriteSqlScoped 1, rawSqlNonLiteral 63, rawWriteSqlFiles 26,
historyCodeComments 2334, each its pin. No pin moved.

#### A `--` comment that a carriage return ends (HIGH)

Postgres ends a `--` comment at the first `\n` or `\r` (scan.l:
non_newline is `[^\n\r]`); sqlCode (packages/db/src/sql-text.ts) ended it
at `\n` only, so in `select 1 --x\r; delete from t where a = 1` it blanked
the delete and readSql let it through, and the lint read no write. sqlCode
now ends the comment at the first of the two; the lint reads with the same
sqlCode, so both moved together. The other places sql-text reads a line
end: `blanks` keeps only `\n` (a `\r` in a blanked comment or literal turns
into a space, still whitespace), a quoted name's `\r` turns into `_`
inside the name, and insertSelectPairs splits on `\s`. None hides code.

Cells: read-sql.test.ts refuses a delete statement, an update statement
and a delete CTE after a comment a `\r` ends; sqlCode cuts two statements
for `\n`, `\r` and `\r\n` alike, and a read with code after the `\r`
passes unchanged. cleanup-counts.test.ts: the lint finds the delete and the
delete CTE after a `\r` (and readSql refuses the same texts); a delete
inside a comment ended by `\r\n` is still none.

Two more readers outside this lane have the same gap (`--[^\n]*` or
`indexOf('\n')`): packages/db/src/gateway/narrow-route.ts sqlCode (its
transaction-control, role-change and session-SET refusals could be hidden
behind `--x\r`; the S7a lane folds it onto sql-text after this merges) and
gateway/handles.ts isWriteSql (fails closed there: executeWrite refuses a
text it reads as no write). eslint-rules/rights-counts.mjs
stripSqlComments reads the checked-in migrations the same way.

#### Write functions, and the read-only backstop (MED)

WRITE_FUNCTIONS (packages/db/src/read-sql.ts) gains `ts_rewrite` (runs
its text argument), `pg_(?:clear|restore|set)_\w+_stats` (the pg18 stats
writers, relation and attribute; `set` for the names of the pg18 betas),
`brin_\w+`, `gin_clean_pending_list`, `pg_stat_\w*reset\w*` (was
`pg_stat_reset\w*`: now pg_stat_statements_reset too),
`pg_log_standby_snapshot` and `pg_backup_\w+`. read-sql.test.ts refuses
each by name (ts_rewrite also schema-qualified), and the as-a-call cell
reads six of them as a call, never as a value or a longer name.

The backstop: text readSql let through now runs in a READ ONLY
transaction, so Postgres refuses a write a function off the list makes.
Its two callers, both covered:

- graphPath (packages/search/src/entities.ts): `simpleReadOnly(text)`
  opens `db.$client.begin`, starts `set transaction read only` and then
  the walk on the simple protocol, both sent in one write (the order
  matters: the system pool's client starts the read behind its actor SET
  as soon as it is built, so the SET TRANSACTION is started first; the
  first workstation run, with the two built in one array, let a writer
  through and the cell caught it). Same pool as before: `db.$client`
  outside a scope (the system pool), the turn scope's client in a turn.
  Cost: a BEGIN and a COMMIT round trip around the walk, the read-only SET
  pipelined with it.
- the corpus audit (server/web/lib/integrity/audit.ts runCorpusAudit,
  the five checks with readSql catalog text and the rest): every check in
  one `readOnlyTransaction` (new, packages/db/src/read-only-tx.ts,
  exported from @mantle/db): readTransaction (the reads' handle: the
  scope's pool in a turn or request scope even where `db.transaction` is a
  write, else the system pool, the pool `db.execute` took there) with
  `set transaction read only` as its first statement. One connection for
  the run instead of one per query; a failing check throws as before.

No caller needs a write (measured): graph-path-read-only.db.test.ts finds
a two-hop path outside a scope and runs the walk in a turn scope;
audit-read-only.db.test.ts runs the whole audit on the anchor (pg-boss's
schema made first, as the queue checks read it) and finds the five
readSql checks among its rows. The refusal: each file makes a test-only
function that inserts an entity and one that calls nextval on
heads_check_misses_id_seq (neither name on the list; readSql answers
`select f()` unchanged), and Postgres refuses each with 25006 in the
read-only transaction (graphPath's outside a scope, and the insert in a
turn scope too; the audit's helper), leaving no row; the insert outside it
writes (the cell has teeth). A cell reads
`current_setting('transaction_read_only')` as `on` inside
readOnlyTransaction. Both files pass in the default run (actor check
warn, where the system pool's client sets the actor in a transaction) and
under test:runtime-role. They make no table or sequence of their own: the
first version did, and a full run failed another file
(packages/content/src/read-only-writes.db.test.ts, `cache lookup failed
for relation`) whose read-only role setup runs GRANT SELECT ON ALL TABLES
while a scratch table was dropped. packages/db/src/narrow-route.db.test.ts
and packages/search/src/scope.db.test.ts still make and drop tables in
public, the same race.

What READ ONLY does and does not stop, measured on pg18 (a probe in a
throwaway container): it refuses INSERT, UPDATE, DELETE, MERGE, DDL
(CREATE TEMP TABLE too), nextval and setval, row locks, and the same done
inside a function, ts_rewrite's query text among them (a nextval there
was refused). It does not stop set_config (with is_local false the
setting outlived the transaction), advisory locks (a session lock was
still held after the COMMIT), pg_notify, pg_restore_relation_stats and
pg_clear_relation_stats (reltuples rewritten in pg_class inside a read-only
transaction), brin_summarize_new_values, or the server and file
functions. Those stay on WRITE_FUNCTIONS, the only bound for them; the
list stays open-ended for anything of that kind it misses.

Route and labels: no write route changed (both paths only read). The
audit's statements leave the `db` proxy for readTransaction's handle: the
same pool, but the proxy's per-statement notes (noteOwnRuleSystemRead,
for member own-rule routes; the audit route is owner only) and its
TypeScript actor check on `db.execute` are not passed per statement any
more, as for every readTransaction caller.

#### A WITH the lint could not walk (LOW)

CTE_HEAD (sql-text.ts) read `as\s+(`, so `with x as(select 1) delete from
t` and a second CTE written `b as(...)` left the WITH unwalked: readSql
refused them (right) but rawWriteKind found nothing. Now `as\s*` and
`materialized\s*` (the lint's WRITE_CTE too), and withParts marks a WITH
whose statement starts with SEARCH or CYCLE as not walked (it read the
clause as the statement before; readSql refused it there for its first
word). When a WITH is not walked, rawWriteKind (eslint-rules/
cleanup-counts.mjs) counts any insert, update, delete, merge or truncate
in what is left as a write (FOR UPDATE and FOR NO KEY UPDATE left out);
withParts now also returns that text when parentheses never close (it
returned ''). Cells: cleanup-counts.test.ts finds `with x as(select 1)
delete from t`, `with a as (select 1), b as(select 2) insert ...`, `with
x as materialized(select 1) update ...`, and a SEARCH (depth and breadth)
or CYCLE clause before a delete, an update or an insert, readSql refusing
each; a SEARCH clause before a select and a CYCLE clause before a FOR
UPDATE read are none. read-sql.test.ts: withParts walks the no-space
heads, does not walk SEARCH or CYCLE, and readSql refuses the shapes.
The repo's findings did not move (the four pins above).

#### Gates

Code head b85564c39 (rebased on main a5bbb2373, v0.300.119). The
commits after it change this file only.

Mac, DATABASE_URL unset: on dfdb80073 (the code of b85564c39 but the two
DB cells' first version, which skip here) `pnpm -r typecheck` 0, `pnpm
lint` 0 (the one warning main has), `pnpm format:check` 0, `pnpm
docs:check` 0, `pnpm arch:check` 0 (the four pins as above), `pnpm -C
server/web build` 0, `vitest run server packages eslint-rules` 0 (867
files passed, 11231 tests). On b85564c39: typecheck 0, lint 0, format:check
0, docs:check 0, arch:check 0, vitest 0 (867 files, 11231 tests).

Workstation (own clone ~/s10r2c/clone, own container s10r2c-pg on
127.0.0.1:56571, pgvector pg18, max_connections=450, the `postgres` role
as CI's, init-scratch and migrate with MANTLE_CHECK_FLOOR=keep,
systemd-run --user, --maxWorkers=3, one at a time):

- on 8a1e227d8 (the cells' first version): full vitest 1 (14092 of 14093
  passed: a2a-round-trips.db.test.ts counted one more round trip with the
  edit check on, the pipelined actor RESET that runs after the caller's
  answer; the file passed three times alone), then its one rerun 1 (all
  14092 passed; read-only-writes.db.test.ts failed its setup on the
  scratch table drop, above, which the cells then stopped making);
  test:actor-off 0 (1315); test:runtime-role 0 (2845).
- on b85564c39: full vitest 0 (1145 files, 14092 passed, 1 skipped);
  test:actor-off 0 (135 files, 1315); test:runtime-role 0 (287 files,
  2845).
- The pg18 probe of what READ ONLY stops (above), in the same container.

CI: run 39473067928 on 36a4525b5 (code head b85564c39 plus this
section before this line): success. The runs on dfdb80073 and b85564c39
were cancelled by the next push.

#### Open items

- narrow-route.ts sqlCode and handles.ts isWriteSql end a `--` comment at
  `\n` only (above); the narrow route's refusals are the ones that matter.
  The S7a lane folds narrow-route onto sql-text.
- WRITE_FUNCTIONS stays a deny list for what READ ONLY does not stop
  (session settings, locks, notify, stats and maintenance calls, server
  functions): a new built-in of that kind needs a line there.
- From round 2b: rawWriteSqlScoped 1 (the restamp's home grant),
  rawSqlNonLiteral 63, the Telegram moderated-chat definer, r3.

### Fix round 3 (the re-audit at d55e3c67e)

Rebased on main 6421c4e5a (v0.300.120) with no conflict: main touched no
file of the branch, the pins file included. Measured on the rebased head
and on the code head: rawWriteSqlScoped 1, rawSqlNonLiteral 63,
rawWriteSqlFiles 26, historyCodeComments 2334, each its pin. No pin moved.

#### Read only before the read on the narrow route (MED)

Under asSystem with a reason the narrow system route takes ('admin-area',
'audit-log') and MANTLE_NARROW_SYSTEM on, simpleReadOnly
(packages/search/src/entities.ts) ran its read with transaction_read_only
off: the narrow route's client starts each statement a microtask late
(its watchedQuery, gateway/narrow-route.ts), so the SET TRANSACTION READ
ONLY, started first, reached the wire after the role SET and the read,
and Postgres let the transaction turn read only after the read had run.
simpleReadOnly now awaits `set transaction read only` and then sends the
read: no client wrapper's send order decides it. Cost: one round trip
more per graph walk. readOnlyTransaction (packages/db/src/read-only-tx.ts)
already awaited its SET (drizzle's `tx.execute`) and passed the same cells
before and after; its comment now says why it is awaited. narrow-route.ts
is not touched (the S7a lane owns the reorder).

Cells, both on a real pg18, for each of the two reasons:
graph-path-read-only.db.test.ts reads `current_setting('transaction_read_only')`
as `on` and `current_user` as mantle_system_narrow (when the switch is not
set off) inside simpleReadOnly's read, and a definer that inserts (owned
by the superuser, so the narrow role's rights are no bound) is refused
with 25006 and leaves no row; audit-read-only.db.test.ts does the same
inside readOnlyTransaction. On the code before the fix (9abf325b7, the
cells alone) the two simpleReadOnly cells failed: `expected 'off' to be
'on'`; the readOnlyTransaction ones passed.

#### The callers' wiring (LOW)

test-support gains recordSystemPoolSends (postgres.js calls its `debug`
option as it writes each statement to the wire, with the connection's
id; the hook is set on the system pool's options and taken off after) and
sentReadOnly (on that statement's connection, a `set transaction read
only` was sent before it with no BEGIN, COMMIT or ROLLBACK between). Cells:
graphPath's walk is sent read only, and the entity names it reads after
are not (the record tells the two apart); every statement runCorpusAudit
sends, apart from BEGIN, COMMIT and the tagged actor and narrow-route
statements, is sent read only, and there are at least as many as checks.
Teeth, measured on the workstation: with graphPath sending its walk on
`db.$client.unsafe(...).simple()` and runCorpusAudit calling
`runChecks(db, ...)`, exactly those two cells failed; restored, they pass.

#### Setters READ ONLY does not stop (LOW)

Probed on pg18 (the throwaway container, as the superuser, the worst
case for a system pool on a box with MANTLE_DB_RUNTIME_ROLE off): each
call inside `begin; set transaction read only; ...; commit`, then its
effect read in the same session. Every volatile function of pg_catalog,
the five extensions infra/postgres/init/01-extensions.sql creates
(uuid-ossp, ltree, pg_trgm, pgcrypto, vector), pg-boss's schema and the
migrations' own was listed and read; these were run:

- not stopped, and lasting past the COMMIT, so added to WRITE_FUNCTIONS:
  `set_limit` (pg_trgm: show_limit 0.9 after the COMMIT, the session's
  threshold), `pg_nextoid` (advances the cluster's OID counter),
  `pg_stop_making_pinned_objects` (the OID counter again; refused here
  only because the counter is past it), `job_table_run` and
  `job_table_run_async` (pg-boss, `job_table_run\w*`: job_table_run
  EXECUTEs its text argument, which readSql blanks as a string; `set
work_mem = '77MB'` and a set_config with is_local false through it
  outlived the COMMIT; mantle_runtime and mantle_system_narrow hold
  EXECUTE on it and USAGE on the pgboss schema; the async one inserts and
  READ ONLY refused it, 25006, listed with it by the pattern),
  `mantle_operator_actor` (the migrations' own: sets mantle.actor and
  mantle.write_mode for the session, outliving the COMMIT; no mantle role
  may execute it, so only a superuser pool could).
- not stopped and already listed: pg_import_system_collations (810
  collations written to pg_collation inside READ ONLY),
  pg_replication_origin_create, pg_create_physical_replication_slot,
  pg_logical_emit_message (WAL written). The probe's slot, origin and
  collations were dropped after.
- stopped or with nothing that lasts, not listed: pgboss.create_queue
  (25006 in READ ONLY), mantle_set_actor (transaction-local settings,
  gone at the COMMIT), pg_export_snapshot (ends with the transaction),
  pg_stat_force_next_flush and pg_stat_clear_snapshot (the backend's own
  stats snapshot), pg_extension_config_dump (refused outside CREATE
  EXTENSION), loread (needs a descriptor lo_open gives, listed),
  plpgsql_validator (checks a function's body).
- pg_current_xact_id assigns a transaction id inside READ ONLY (1233
  here); no write follows from it. A note, no fix (read-only-tx.ts).

The extensions have no other setter: pgcrypto's, uuid-ossp's and
pgvector's functions compute, ltree's are immutable. read-sql.test.ts
refuses each new name (set_limit also schema-qualified,
mantle_operator_actor also quoted), and the as-a-call cell reads
set_limit, pg_nextoid, job_table_run and mantle_operator_actor as a call,
never as a value or a longer name. read-only-tx.ts's top comment lists
what READ ONLY was measured not to stop.

#### A dollar quote after a number, a parameter or a quote (LOW)

PostgreSQL opens a dollar quote at a `$` that does not continue a name:
after a numeric constant the lexer ends cleanly (`1e+5`, `.5`), a `$n`
parameter, or a closed dollar quote (measured on pg18 in the round 3
re-audit; `1$q$`, `1_000$q$`, `1e5$q$`, `0x1F$q$` are trailing-junk
errors there, so the whole text fails to parse). sqlCode (packages/db/src/sql-text.ts) decided from
the character before (any name character, digits and `$` among them,
opened nothing). It now tracks where the current run of name characters
starts and opens a quote unless that run starts with a letter, `_` or a
high character (the lexer's ident_start). The same word decides E'':
the `e` must be a word of its own (after a closed dollar quote it now
is). The texts this changes are not valid SQL (a string constant cannot
follow a number, a parameter or another dollar quote), so the reader was
never let through by them on a real server; it now reads them as the
lexer does. The lint reads with the same sqlCode; its findings on the
repo did not move. Cells (read-sql.test.ts): after `1`, `1.5`, `1e5`,
`1_000`, `$1`, `$a$x$a$`, `$$` and a quoted name, `$q$; delete from
t$q$` is one statement with the delete blanked; inside `a$q$`, `a1$q$`,
`_9$q$` and `é1$q$` no quote opens (two statements); `$a$x$a$e'\''` is
an E'' string, `ae'\''` a plain one (ambiguous). Both cells failed on the
reader before.

#### The lint's writes that run (LOW)

rawWriteKind (eslint-rules/cleanup-counts.mjs) reads past an EXPLAIN
whose option list or old words hold ANALYZE (not `analyze false`, `off`
or `0`) and past `PREPARE name [(types)] AS`, and reads the statement
there as any other (a WITH walked, a write CTE counted). A plain EXPLAIN,
EXPLAIN VERBOSE and `EXPLAIN (ANALYZE FALSE)` only plan and count
nothing. Cells (cleanup-counts.test.ts): nine writes behind EXPLAIN
ANALYZE (both spellings, option lists, a write CTE, after a read) or
PREPARE (quoted name, types, a WITH) are found and readSql refuses each;
seven plain EXPLAINs, a read under ANALYZE and prepared reads are none.
Still not counted by the lint, where readSql refuses each and the roles
bound them: SELECT INTO and CREATE TABLE AS (they make a table), COPY
FROM, CALL and DO (what a procedure or a block does is not in the text).
The repo's findings did not move.

#### The savepoint comment (LOW)

read-only-tx.ts said the rest of a scope's transaction stays read only
after readOnlyTransaction's savepoint. Postgres restores the access mode
when the savepoint is released (xact.c, prevXactReadOnly), so it does
not; the comment now says that.

#### Gates

Code head 21a757444 (rebased on main 6421c4e5a, v0.300.120). The commits
after it change this file only.

Mac, DATABASE_URL unset, on 21a757444: `pnpm -r typecheck` 0, `pnpm lint`
0 (the one warning main has), `pnpm format:check` 0, `pnpm docs:check` 0,
`pnpm arch:check` 0 (the four pins as above), `pnpm -C server/web build`
0, `vitest run server packages eslint-rules` 0 (867 files passed, 11242
tests). On 1101242bc the same were 0 but lint 1 (no-useless-assignment in
the audit wiring cell's count, fixed in 21a757444).

Workstation (own clone ~/s10r2d/clone, own container s10r2d-pg on
127.0.0.1:56581, pgvector pg18, max_connections=450, the `postgres` role
as CI's, init-scratch and migrate with MANTLE_CHECK_FLOOR=keep,
systemd-run --user, --maxWorkers=3, one at a time):

- on 9abf325b7 (the new cells, no fix): the two cell files 1, the two
  simpleReadOnly narrow-route cells failing (`expected 'off' to be
'on'`), the other 12 passing.
- on 1101242bc: the two cell files 0 (14); with graphPath and
  runCorpusAudit unwired by hand, the two wiring cells failed and only
  they (restored after); full vitest, switch on, 0 (1145 files, 14076
  passed, 39 skipped).
- on 21a757444: full vitest with MANTLE_NARROW_SYSTEM=0, 0 (1145 files,
  14076 passed, 39 skipped); test:actor-off 0 (135 files, 1325);
  test:runtime-role 0 (288 files, 2856); the two cell files, switch on,
  0 (14).
- The pg18 probe of the setters (above), in the same container.

#### Open items

- narrow-route.ts: its client starts a statement a microtask late
  (watchedQuery), so a caller that pipelines a SET TRANSACTION with its
  first statement loses the order. Both read-only callers now await
  theirs; the S7a lane fixes the reorder in the gateway.
- WRITE_FUNCTIONS stays a deny list for what READ ONLY does not stop; a
  new function of that kind (a built-in, an extension's, pg-boss's or
  the migrations' own) needs a line there.
- The lint does not count SELECT INTO, CREATE TABLE AS, COPY FROM, CALL
  and DO (above).
- From round 2b: rawWriteSqlScoped 1 (the restamp's home grant),
  rawSqlNonLiteral 63, the Telegram moderated-chat definer, r3.

### Re-audit of fix round 3 (at 1db72cbc6): merge

No HIGH or MED in this lane. READ ONLY was measured in force for every
readSql text on every route reached (no scope, every asSystem turn
reason, systemWork, read and Admin turns, the system pool in a write
scope), with the narrow switch on and off and the runtime role on.

Fixed before the merge:

- The lint read `explain(analyze) delete ...` (no space before the
  option list) as no write. EXPLAIN_HEAD now takes `explain\s*` before
  an option list; cells for both spellings and for `explainanalyze`.
- The dollar-quote section above now says which texts after a number
  pg18 actually reads as a quote.

Left open, with a lane:

- MED, narrow-route lane: the narrow route does not see a role change
  inside a string that a PUBLIC-executable function runs as SQL
  (pgboss.job_table_run, security invoker; mantle_runtime and the
  narrow role have USAGE on pgboss), and ROLE_SET_CONFIG only reads a
  literal 'role'. Revoke EXECUTE on pgboss routines from PUBLIC in the
  runtime grants (pg-boss runs as the migrator), and refuse a
  set_config whose name is not a literal on the narrow route.
- LOW: simpleReadOnly throws inside withScope and withSystemTx
  (db.$client is undefined on a drizzle transaction). Fails closed,
  as before; graph_path does not run there.
- LOW: @mantle/db/test-support has no lint fence against product
  imports, unlike @mantle/content/test-support.

## Round 3 (feat/s10-r3, from main dd0d1d85f, v0.300.123)

The last round: the last scoped raw write, the Telegram moderated-chat
write, then the plan's end (section 3.2 point 3). One migration,
`0313_file_home_chat_definers` (`when` 1790198100000, 60000 above 0312's;
the renumber proof is file-home-chat-0313.db.test.ts: above every earlier
`when`, and the revert takes that `when` off the ledger).

### 1. The restamp's home (rawWriteSqlScoped 1 to 0)

packages/files/src/ops/files.ts restampRacedCreate replaced every grant of
a raced snapshot copy's row with one home by a raw insert (a drizzle insert
names every column, and the write role holds INSERT on four of
item_grants). It now calls a definer, `mantle_file_restamp_home(node, ws)`:
the delete and the insert of the same four columns, as before.

- Its own check: only the snapshot copies' system work. The one SQL
  system-work allowlist (`mantle_ws_system_work`, 0307) takes a third
  pair, `('system:snapshot-copies', 'mantle_file_restamp_home')`: no acting
  login, no scope, not read only, that actor exactly. No second allowlist.
  And only on a file of this brain that already carries a copy's stamp
  (`data.snapshot_of`; the stamp goes on first, as before). Refused
  otherwise (42501), nothing moves.
- TypeScript: `snapshot-copies` moved from `AS_SYSTEM_OTHER_REASONS` to
  `WORKSPACE_SYSTEM_REASONS` (viewer.ts), so systemWork refuses it inside a
  request or an exit too, and its actor goes with every statement in every
  check mode (actor-sql.ts `isWorkspaceSystemActor`; the definer reads it
  with the actor check off). `AS_SYSTEM_ROUTE` and the route seed
  (as-system-routes.mjs) lost the entry; the systemWork pin of
  snapshot-copies.ts is unchanged. arch-lints.test.ts's reason check skips a
  maintenance task's `slug:` (registry.ts names the task
  `snapshot-copies`).
- EXECUTE: the runtime role only (`RUNTIME_SYSTEM_FUNCTIONS`: the system
  pool's login with the runtime role on), never the write, workspace or
  narrow role (`NARROW_DENIED_FUNCTIONS`).
- Route: unchanged (the system pool, in the copy's system work).
- Cells (packages/files/src/restamp-write-role.db.test.ts): on the write
  role in an Admin user's scope the stamp alone passes and the home is
  refused ("permission denied for function"), grants untouched; as the
  superuser the definer refuses no actor, `system:test`, the two other
  allowlisted actors, `system:admin-area`, `system:operator:repair`, a
  login actor, and the right actor read only, in a scope or with a scope
  login set, each 42501 with the row untouched; the right actor on an
  unstamped file or a stamped note: 42501; as the system work it replaces
  every grant (a login-made one too) with one home, Write off, granted_by,
  via_folder_id null, bridge false; and restampRacedCreate itself under
  @mantle/db's `systemWork('snapshot-copies')` (the app's own pools) stamps
  and homes the row, `mantle.actor` read as `system:snapshot-copies`, in the
  default run and under test:actor-off and test:runtime-role.
  server/web/server/w6b-fix2.db.test.ts L-4 (the watcher race end to end)
  now makes its copy as the real caller does (`systemWork('snapshot-copies')`
  for `asSystem('test')`); same assertions.

### 2. The Telegram moderated-chat write

setChatPairing (packages/telegram pairing.ts) read the chat, decided own
chat or `loginModeratesBot` in TypeScript and updated telegram_chats, all
on `asSystem('login-telegram')` (the narrow route with the switch on, else
the system pool). Now one definer, `mantle_tg_chat_set(owner, login, chat,
action, account)`, in the caller's own transaction:

- The rule, moved: the chat of `owner` (on `account` when given) whose own
  login is `login`, or whose bot's assistant's workspace (no workspace: the
  Admin workspace) has `login` as an enabled Moderator and is live, or for
  an Admin user with the users area (`mantle_area_rule`, as
  `loginHasArea`). Anyone else, and a chat that is not there, answer no row
  (the caller's 404, as before). `block` sets denied, `unpair` pending;
  both clear the login and the pairing. An action other than these: 22023.
- In a scope, or with an acting login set, `login` must be the scope's own
  (42501). With no scope (the assistants area's route on its exit) it reads
  the login it is given, as 0293's Telegram readers and
  `mantle_access_key_revoke` do; only system routes run without a scope.
- Answers the chat and its bot's assistant's name, so setChatPairing no
  longer needs the exit; a login id that is no uuid answers not found
  before any statement (as `loginModeratesBot` refused it).
- EXECUTE, measured per role: the write role (`WRITE_ROLE_FUNCTIONS`; the
  any-login routes' block and unpair run there in the login's scope:
  s6-c3-any-login-writes.db.test.ts through the full pipeline, warn and
  on), the narrow role (`NARROW_SYSTEM_FUNCTIONS`: the assistants area's
  route, `POST /api/agents/:id/telegram/chats`; measured by a new row of
  narrow-area-routes.db.test.ts through createApp with the switch on: the
  dump shows `fn:mantle_tg_chat_set` 3 uses, no denial; with the grant
  taken out of the clone's runtime-role.ts the row fails, "permission
  denied for function mantle_tg_chat_set", a narrow denial and a 500), and
  the runtime role through the write role's list. Not the workspace role,
  not PUBLIC.
- Cells for who may and may not (packages/db/src/file-home-chat-0313.db.test.ts,
  on the write role in the login's own scope, session_user
  mantle_write_user): may: the chat's own login (unpair and block), a
  Moderator of the bot's workspace, an Admin user with the users area, the
  anchor. May not (no row, row unchanged): a login in no workspace of the
  bot, an Admin user whose users area is off, a disabled Moderator, a user
  of the workspace on another login's chat, a Moderator on a bot with no
  assistant, the wrong `account`, another owner's chat. Refused: a login
  other than the scope's (42501), an unknown action (22023). On the narrow
  role with no scope: an outsider gets no row, an Admin user with the users
  area unpairs. The catalog: both definers SECURITY DEFINER with
  `search_path=public, pg_temp`, EXECUTE per role as above.
- Answers byte-equal: w7d-telegram.db.test.ts (the routes' handlers per
  role), s6-c3-any-login-writes.db.test.ts (the full pipeline),
  a4-guard-sweep.test.ts and a10-body-sweep.test.ts (every route and body as
  recorded on main). The body sweep's database stand-in answers the
  definer's transaction with no chat, as its reads answer no row (main read
  the chat first and found none: 404 then and now).
- The rows written are the same but for `updated_at`: the definer's `now()`
  (the transaction's start) for the process clock; no answer carries it.
- Pins: asSystemExits 55 to 54, asSystemNarrow 21 to 20 (pairing.ts's
  holder keeps the preview and the pairing).

### 3. The plan's end: no table read from a raw write's text

`rawWriteTarget` and its test in `loginWriteClient` are gone
(packages/db/src/gateway/write-route.ts), with its unit cells
(actor-client.test.ts) and its export (client.ts barrel); `MORE_STATEMENTS`
is no longer exported. Every scoped statement goes to the gateway's one
decision (`loginWriteRoute`: the actor and the write scope, never the
text); on the write role Postgres refuses a table the role holds no right
on (42501, noted as a write-role gap: in production a `write-role-gap` miss
row naming the caller, in tests a failure of the test, vitest.setup.ts).

- typedWrite is not touched: it routes by the drizzle table object (no
  text), and its system-pool tables are S4b's (`typed-write`).
- The `raw-write` fail-open site has no caller (failOpenSites 6 to 5). The
  name stays in `FAIL_OPEN_SITES` and the box script's list so a row an N-1
  image writes still counts; docs/fail-open.md says so.
- Cell: fail-open.db.test.ts, a login's scoped `executeWrite` of an update
  of provider_alerts: refused 42501 "permission denied for table
  provider_alerts", the gap noted, no fail-open row and no hit (it ran on
  the system pool before, counted).

Measured, so that no scoped write now meets a table the write role cannot
write:

- Main (dd0d1d85f), the full DB suite with `MANTLE_FAIL_OPEN_DUMP`: 156
  hits, every one `typed-write` (item_marks, pending_tool_calls,
  assistant_messages), no `raw-write` hit: no tested scoped raw write went
  to the system pool by its table.
- The branch, every full suite (below): no write-role gap in any (the
  setup fails a test on one), no narrow denial.
- By reading: the removed branch sent a statement to the system pool only
  for a single INSERT, UPDATE or DELETE on a non-write-role table sent
  through loginWriteClient's `unsafe`. Its callers are executeWrite (every
  product call is a `SELECT pg_notify(...)`, which that test never matched)
  and the gateway's drizzle handle (typedWrite gives it write-role tables
  only; a transaction's `begin` already went to the write role).

Scoped writes now refused by the write role (table, caller): none.

Changed routes (system pool to write role or back), each with its cell:

| Write                                                                                                            | Before                                                                     | Now                                                        | Cell                                                              |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------- |
| a login's block or unpair (`POST /api/telegram/chats/:id/block`, `/unpair`, `DELETE /api/telegram/my-chats/:id`) | asSystem('login-telegram'): narrow route (switch on), else the system pool | the write role in the login's scope, by mantle_tg_chat_set | s6-c3-any-login-writes.db.test.ts, file-home-chat-0313.db.test.ts |
| the assistants area's block or unpair (`POST /api/agents/:id/telegram/chats`)                                    | narrow route (switch on), else the system pool                             | the same routes, by mantle_tg_chat_set                     | narrow-area-routes.db.test.ts                                     |
| the restamp's home                                                                                               | the system pool (systemWork)                                               | the same, by mantle_file_restamp_home                      | restamp-write-role.db.test.ts                                     |
| a scoped raw single write to a non-write-role table                                                              | the system pool, counted `raw-write`                                       | the write role, refused                                    | fail-open.db.test.ts (no product caller, measured above)          |

No change to what a member, client, key, peer or public link may do.

### Pins

| Pin                 | Before | After | Why                                                        |
| ------------------- | ------ | ----- | ---------------------------------------------------------- |
| rawWriteSqlScoped   | 1      | 0     | the restamp's home is a definer call                       |
| rawWriteSqlFiles    | 26     | 25    | ops/files.ts                                               |
| rawWriteTargetRegex | (new)  | 0     | rawWriteTarget gone (1 on main, measured by the new count) |
| failOpenSites       | 6      | 5     | the raw write site has no caller                           |
| asSystemExits       | 55     | 54    | setChatPairing left telegramLoginSystem                    |
| asSystemNarrow      | 21     | 20    | the same use ('login-telegram' routes narrow)              |
| actorsMdLines       | 345    | 344   | the raw write limit line went                              |
| actorsHistoryRefs   | 74     | 71    | the asSystemExits note gives its current reason only       |

`rawWriteTargetRegex` (eslint-rules/cleanup-counts.mjs
`rawWriteTargetRegexSites`): a regex literal, or `RegExp` of literal text,
in packages/*/src and server/ that names INSERT INTO, DELETE FROM or
UPDATE and captures a name: a route decided on a write's text again.
Cells (cleanup-counts.test.ts): main's rawWriteTarget regex, `\w+`, a
negated class through `new RegExp`, a `String.raw` one are found; the
gateway's isWriteSql test, the WITH test, a read and a comment are not.
`rawSqlNonLiteral` stays 63 (not this round's).

### Rollback

- `packages/db/rollback/0313_file_home_chat_definers.revert.sql`, as the
  superuser, one transaction (its header has the command), while the newer
  image is still up, then pin N-1: drops both definers, puts
  `mantle_ws_system_work` back to 0307's body byte for byte, takes 0313 off
  the ledger.
- Without the revert, N-1 runs with 0313 in place: it calls neither
  definer, and the extra allowlist pair names only the restamp definer.
  N-1's boot grants its own lists: the write and narrow roles lose
  EXECUTE on mantle_tg_chat_set, the runtime role on the restamp
  definer (rule 2: N-1 as shipped).
- The routes go back with the image: N-1's setChatPairing runs on its
  exit again, and its loginWriteClient sends a raw write to a
  non-write-role table to the system pool again (counted `raw-write`; the
  box script still prints that site).
- No row to undo: 0313 changes no table.
- The drill (below) and the cell (file-home-chat-0313.db.test.ts: a
  database just before 0313 applies it and only it; the revert leaves the
  allowlist's body equal to before and both definers gone; forward again
  equal to after).

### Gates

Code head 52b6b7682 (the commits after it change this file only).

Workstation, own clone ~/s10r3/clone (main from GitHub plus bundles of the
branch), own container s10r3-pg (pgvector pg18, 127.0.0.1:56610 checked
free, max_connections=450, role postgres as CI), init-scratch 0 and
migrate 0 with MANTLE_CHECK_FLOOR=keep, DATABASE_URL for those two only,
systemd-run --user, --maxWorkers=3, one at a time, switch on unless said:

| Gate                                                       | Exit | Counts                                                  |
| ---------------------------------------------------------- | ---- | ------------------------------------------------------- |
| main dd0d1d85f, full DB vitest, MANTLE_FAIL_OPEN_DUMP      | 0    | 1150 files; 14177 passed, 1 skipped; 0 `raw-write` hits |
| a8e7f0b8b, the round's cells (9 files)                     | 1    | 5 cells: their fixtures (fixed in be5c13584)            |
| be5c13584, full DB vitest                                  | 1    | 7 cells in 5 files (below)                              |
| 52b6b7682, the fixed and the flaky files (8)               | 0    | 95 passed, 1 skipped                                    |
| 52b6b7682, the narrow row without its grant (teeth)        | 1    | "permission denied for function mantle_tg_chat_set"     |
| 52b6b7682, full DB vitest, dumps                           | 0    | 1151 files; 14191 passed, 1 skipped; 885 s              |
| 52b6b7682, full DB vitest, MANTLE_NARROW_SYSTEM=0          | 0    | 1151 files; 14191 passed, 1 skipped                     |
| test:actor-off                                             | 0    | 139 files; 1388 passed, 1 skipped                       |
| test:actor-on                                              | 0    | 33 files; 405 passed, 1 skipped                         |
| test:edit-on                                               | 0    | 45 files; 575 passed                                    |
| test:matrix                                                | 0    | 4 files; 8 passed                                       |
| test:runtime-role in full                                  | 0    | 291 files; 2888 passed, 1 skipped                       |
| the N-1 drill (own container s10r3-rb-pg, 127.0.0.1:56611) | 0    | every step 0 (below)                                    |

The run on be5c13584 failed: w6b-fix2 L-4 (its copy as `asSystem('test')`,
which the restamp definer refuses: now the copies' own system work),
a10-body-sweep (its stand-in had no transaction), write-role.db.test.ts
(the reviewed list of the write role's definers lacked the new one), and the
known flakes chat-archive.db.test.ts (3 cells) and
conversation-trace.db.test.ts (1 cell), content-search misses; both passed on
the rerun of those files and in every later full run. Every run from
52b6b7682 passed first time. In every full run: no write-role gap, no
narrow denial, no `narrow system route:` refusal; the switch-on dump has
1174 lines, every one a use (`fn:mantle_tg_chat_set` 3, from
narrow-area-routes.db.test.ts); the fail-open dump 156 hits, every one
`typed-write`, as on main.

The N-1 drill, main dd0d1d85f and the branch 52b6b7682, each step's state
as definers / the md5 of mantle_ws_system_work's body / the 0313 ledger row
/ EXECUTE on mantle_tg_chat_set for the write and narrow roles / EXECUTE
on mantle_file_restamp_home for the runtime role:

| Step                         | Exit | State                                  |
| ---------------------------- | ---- | -------------------------------------- |
| init and migrate with main   | 0, 0 | 0 / c96949b3 / 0 / - / -               |
| migrate with the branch (N)  | 0    | 2 / 8a2ebe6a / 1 / true true / true    |
| migrate with main (N-1 boot) | 0    | 2 / 8a2ebe6a / 1 / false false / false |
| the revert                   | 0    | 0 / c96949b3 / 0 / - / -               |
| migrate with main            | 0    | 0 / c96949b3 / 0 / - / -               |
| migrate with the branch      | 0    | 2 / 8a2ebe6a / 1 / true true / true    |

N-1's boot on the N database takes the new grants back (its own lists) and
leaves the definers, unused; the revert puts the allowlist's body back to
0307's (the same md5 as before 0313).

### Open items, for the CEO before the merge

1. The fleet's own count of the routed-away raw writes: the suites and the
   code reading find no scoped raw write to a table the write role cannot
   write, but a box sees paths no test reaches. Before the merge, read
   `fail_open_misses:raw-write` on each box (scripts/arch-scoreboard-box.sh,
   numbers only; it counts the `fail-open:raw-write` rows an image up to
   this release writes). Anything above 0 is a scoped raw write the write
   role would refuse after the roll: read that box's `detail` (the caller
   or the table) first. After the roll, a refusal shows as a
   `write-role-gap` miss row naming the caller.
2. mantle_tg_chat_set with no scope reads the login it is given (the 0293
   Telegram readers' and mantle_access_key_revoke's shape). Only the
   narrow role and the system pool run without a scope (the assistants
   area's route), so this is what that route did before; a stricter shape
   (an acting login from the request on the narrow route) needs the
   request exit to carry its login, which is outside this lane.
3. `snapshot-copies` is a workspace system reason now: its statements carry
   their actor with the actor check off too (one SET with each), at boot
   and in `pnpm maintain snapshot-copies` only.
4. From earlier rounds, not this one's: rawSqlNonLiteral 63 (packages/db's
   own statements, the S7a lane), the lint's verbs (SELECT INTO, COPY
   FROM, CALL, DO: the write role now refuses them in scoped code at run
   time, which is the bound plan 3.2 point 3 names).
