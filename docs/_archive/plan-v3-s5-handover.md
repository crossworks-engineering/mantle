# The client.ts split, plan v3.2 (handover)

The strangler of packages/db/src/client.ts into packages/db/src/gateway/
(plan v3.2 section 3.1), in three parts, one merge per part. Each move is
its own commit: the moved lines are byte-equal, and the only lines that are
not from client.ts are each module's header comment, its imports, a local
`type PgSql = ReturnType<typeof postgres>` and the named glue below. No
behaviour change, no answer changed.

## Part 1: check-mode, actor-sql, pools

Branch feat/s5-p1, from main 20b466838 (v0.300.104).

### The moves

| Commit | Module | Lines | What moved |
| --- | --- | --- | --- |
| d76f69a5d | gateway/check-mode.ts | 172 | the mode read's state (actorModePool, firstModeRead), refreshActorCheckMode, ACTOR_CHECK_DRIFT_SQL, EDIT_CHECK_DRIFT_SQL, warnActorCheckDrift, the floor note, ACTOR_SQL_TAG |
| 4df59c37f | gateway/actor-sql.ts | 418 | setActorSql, RESET_ACTOR_SQL, statementBody, runsOutsideTransaction, needsActorWrap, wrapsStatement, actorParams, actorInTransaction, settingsFirst, actorClient and its pipelined writes in flight |
| 3a1c28f76 | gateway/pools.ts | 290 | every globalThis.__mantle* key (declarations and writes), VIEWER_POOL_MAX, getAdminDb, systemPoolRole, reportDbRole, adminActorSql, logActorMiss, getViewerDb, openLoginWritePool and the write pool's size and switch, writePoolSql, adminSql, rawAdminSql, closeDb |
| 71d93e8b3 | guards | | eslint max-lines and the scoreboard pins below |

client.ts: 3210 lines on main, 2438 after part 1.

The layers, no cycle: check-mode.ts imports no gateway module; actor-sql.ts
imports check-mode.ts; pools.ts imports both; client.ts imports all three.
No gateway module imports client.ts. client.ts re-exports every name it
exported before, so index.ts and every importer are unchanged.

### The glue (every line that is not a move)

An importer cannot assign another module's binding, and a lower module
cannot import a higher one, so five small functions carry state across:

- `firstModeReadNow()` (check-mode.ts): the three readers of firstModeRead
  left in client.ts (actorClient, now in actor-sql.ts, and loginWriteRouteNow).
- `forgetActorCheckModePool()` (check-mode.ts): closeDb's two resets
  (actorModePool, firstModeRead).
- `actorPipelinesDone()` (actor-sql.ts): closeDb's wait for the pipelined
  writes, the same loop.
- `turnScopedDbOnce(make)` (pools.ts): getTurnScopedDb's body, so the
  globalThis.__mantleTurnDb cache stays in pools.ts; client.ts passes
  `(base) => drizzle(turnScopedClient(base), { schema })`.
- `onCloseDb(reset)` (pools.ts): closeDb ran `loginWriteDbCache = null;
  writeTxDbCache = null;` between the actor client's reset and the mode
  read's; it now runs the resets registered there, and client.ts registers
  those two lines once at load. The same order.

Exports added for client.ts's own callers (no new public name):
statementBody, MORE_STATEMENTS, actorParams, settingsFirst (actor-sql.ts),
ACTOR_SQL_TAG (check-mode.ts), getAdminDb, getViewerDb, loginWritePoolOpen,
writePoolSql, adminSql, rawAdminSql (pools.ts). index.ts is unchanged.

The move proof: for each move commit, every added line of the new module is
a removed line of client.ts but the header comment, the imports, the
PgSql alias and the glue above (a line-multiset diff of `git show -U0`).

### Pins and file keys that moved with the code

- eslint-rules/actor-binders.mjs: client.ts 3 to 1, gateway/pools.ts 2
  (getAdminDb's runWithoutActor, logActorMiss's runAsSystem).
- eslint-rules/heads-writers.mjs DYNAMIC_UNSAFE_REVIEWED: gateway/actor-sql.ts
  (the actor client and settingsFirst pass the caller's statement through);
  client.ts stays (the turn-scope client).
- docs/process-inventory.md: the box mode read's interval and its first
  read's retry sleep are gateway/check-mode.ts's.
- packages/db/src/connection-ceiling.test.ts: CLIENT_TS names
  gateway/pools.ts (the two postgres() calls, VIEWER_POOL_MAX,
  openLoginWritePool). Its value only.
- eslint-rules/viewer-shim-sweep.test.ts: the gateway modules join client.ts
  as the scope functions' home, and the pools test reads client.ts with them.
  A path change, no rule changed.
- scope-settings.mjs: untouched, no scope setting name or carrier moved in
  part 1.

### The guards

- eslint-rules/gateway-counts.mjs: GATEWAY_MAX_LINES 600, set as max-lines
  on packages/db/src/gateway/ in eslint.config.mjs.
- dbGatewayMaxLines, pinned 600: the limit, or the longest module when one
  is over it (a file that turns the lint off still fails); a module over it
  is also listed as a problem, which fails --check.
- dbGatewayImportCycles, pinned 0: the gateway modules on an import cycle
  among the files of packages/db/src (Tarjan over the relative imports,
  re-exports and type imports). Proven: a type import of ../client in
  check-mode.ts fails arch:check with all three modules listed; a 610-line
  file in gateway/ fails eslint max-lines. eslint-rules/gateway-counts.test.ts
  covers the finder.
- dbClientLines pinned down 3210 to 2438.

No dependency was added (no madge, no eslint-plugin-import): the cycle
check is the scoreboard's own.

### Gates

On 71d93e8b3 (the docs commit after it changes no code). Each commit:
`pnpm -C packages/db typecheck` and the unit vitest of packages/db and
eslint-rules, exit 0.

Mac, DATABASE_URL unset, exit codes:

| Gate | Exit |
| --- | --- |
| pnpm -r typecheck | 0 |
| pnpm lint | 0 |
| pnpm format:check | 0 |
| pnpm docs:check | 0 |
| pnpm arch:check | 0 |
| vitest run server packages eslint-rules (857 files passed, 268 skipped) | 0 |
| pnpm -C server/web build | 0 |

Workstation, Node 26.5.0: own clone, own pgvector pg18 container on a free
port (checked free, max_connections=450, the postgres role as CI's),
init-scratch and migrate with MANTLE_CHECK_FLOOR=keep, systemd-run --user,
--maxWorkers=3, one at a time:

| Gate | Result | Exit |
| --- | --- | --- |
| pnpm test (full, with the DB) | 1125 files, 13845 tests passed, 1 skipped | 0 |
| pnpm test:actor-off | 128 files, 1165 passed, 1 skipped | 0 |
| pnpm test:runtime-role (full) | 276 files, 2764 passed, 1 skipped | 0 |

Container, clone, scripts and logs removed by exact name after; no unit left.

### Open items for parts 2 and 3

- actor-sql.ts reads `globalThis.__mantleSql` once (actorClient's closing
  check, `open = globalThis.__mantleSql === base`): the key is declared and
  written only in pools.ts, but actor-sql.ts sits below pools.ts and cannot
  import it. A test sets the key by hand (actor-client.test.ts), so the
  check stays as it is.
- closeDb now lives in pools.ts and resets the higher modules' caches by
  onCloseDb: part 2's write-route.ts and system-tx.ts register their own.
- viewer.ts systemDbCallerOf skips frames of client.ts only. No gateway
  module of part 1 touches systemDb; when the db and systemDb proxies move
  (part 3, handles.ts) the skip list must name that file.
- eslint-rules/scope-settings.mjs pins client.ts: part 2 (the write role
  settings) and part 3 (withScope, the turn scope, writeScopeSettings) move
  those sites and must move the pins' file keys in the same commit.
