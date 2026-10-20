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
  `item_marks m`): the columns are qualified by the table name.
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

### Pins

| Pin               | Before | After |
| ----------------- | ------ | ----- |
| rawWriteSqlScoped | 62     | 16    |
| rawSqlNonLiteral  | 75     | 72    |
| rawWriteSqlFiles  | 59     | 42    |
| rawWriteAllowlist | 0      | 5     |

Per package (literal writes plus non-literal text): content 23+1 to 0,
files 6 to 0, runs 4 to 0, embeddings 3 to 0, email 0 to 0. The allowlist
took 10 literal and 2 non-literal sites.

### Gates

GATES_PLACEHOLDER

### Open items for r2

- Lanes left (scoped, 16 literal sites): packages/tools,
  packages/mcp-core (none today), server/web/lib (integrity/landed.ts 2,
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
  builder): needs a migration, not done in r1. For r2.
