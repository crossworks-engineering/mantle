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
