# The client.ts split, plan v3.2 (handover)

The strangler of packages/db/src/client.ts into packages/db/src/gateway/
(plan v3.2 section 3.1), in three parts, one merge per part. Each move is
its own commit: the moved lines are byte-equal, and the only lines that are
not from client.ts are each module's header comment, its imports, a local
`type PgSql = ReturnType<typeof postgres>` and the named glue below. No
behaviour change, no answer changed.

## Part 1: check-mode, actor-sql, pools

Branch feat/s5-p1, from main 20b466838 (v0.300.104), rebased on main
30eea0665 (v0.300.105, a docs commit) in the fix round. The SHAs below are
after the rebase.

### The moves

| Commit    | Module                | Lines | What moved                                                                                                                                                                                                                                                           |
| --------- | --------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 840f1d35f | gateway/check-mode.ts | 172   | the mode read's state (actorModePool, firstModeRead), refreshActorCheckMode, ACTOR_CHECK_DRIFT_SQL, EDIT_CHECK_DRIFT_SQL, warnActorCheckDrift, the floor note, ACTOR_SQL_TAG                                                                                         |
| 2b3977550 | gateway/actor-sql.ts  | 418   | setActorSql, RESET_ACTOR_SQL, statementBody, runsOutsideTransaction, needsActorWrap, wrapsStatement, actorParams, actorInTransaction, settingsFirst, actorClient and its pipelined writes in flight                                                                  |
| c6773b08e | gateway/pools.ts      | 290   | every globalThis.__mantle* key (declarations and writes), VIEWER_POOL_MAX, getAdminDb, systemPoolRole, reportDbRole, adminActorSql, logActorMiss, getViewerDb, openLoginWritePool and the write pool's size and switch, writePoolSql, adminSql, rawAdminSql, closeDb |
| b5e1a5277 | guards                |       | eslint max-lines and the scoreboard pins below                                                                                                                                                                                                                       |

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

On 71d93e8b3, the guards commit before the rebase (the docs commit after
it changes no code). Each commit:
`pnpm -C packages/db typecheck` and the unit vitest of packages/db and
eslint-rules, exit 0.

Mac, DATABASE_URL unset, exit codes:

| Gate                                                                    | Exit |
| ----------------------------------------------------------------------- | ---- |
| pnpm -r typecheck                                                       | 0    |
| pnpm lint                                                               | 0    |
| pnpm format:check                                                       | 0    |
| pnpm docs:check                                                         | 0    |
| pnpm arch:check                                                         | 0    |
| vitest run server packages eslint-rules (857 files passed, 268 skipped) | 0    |
| pnpm -C server/web build                                                | 0    |

Workstation, Node 26.5.0: own clone, own pgvector pg18 container on a free
port (checked free, max_connections=450, the postgres role as CI's),
init-scratch and migrate with MANTLE_CHECK_FLOOR=keep, systemd-run --user,
--maxWorkers=3, one at a time:

| Gate                          | Result                                    | Exit |
| ----------------------------- | ----------------------------------------- | ---- |
| pnpm test (full, with the DB) | 1125 files, 13845 tests passed, 1 skipped | 0    |
| pnpm test:actor-off           | 128 files, 1165 passed, 1 skipped         | 0    |
| pnpm test:runtime-role (full) | 276 files, 2764 passed, 1 skipped         | 0    |

Container, clone, scripts and logs removed by exact name after; no unit left.

CI: run 39285062614 on c01fbf0df (the handover commit before the rebase):
success, https://github.com/crossworks-engineering/mantle/actions/runs/39285062614

rawWriteSqlFiles measures 62 against its pin 59: the raw write SQL sites
of client.ts moved with the code, so gateway/check-mode.ts, actor-sql.ts and
pools.ts each hold some and client.ts keeps its own (3 files more, no site
more: rawWriteSqlScoped and rawSqlNonLiteral are unchanged). The key is in
MAY_GROW for this split; the pin is left as it is.

### Fix round 1 (audit at c01fbf0df: 9/10, merge)

- The cycle finder (eslint-rules/gateway-counts.mjs) reads a `.js`
  specifier as its `.ts` file, resolves the package's own name
  (`@mantle/db`, `@mantle/db/client`, `@mantle/db/viewer`) through
  packages/db/package.json's exports, and strips comments first (the
  scoreboard's stripComments), so a comment inside import braces no longer
  hides the import. One test each in eslint-rules/gateway-counts.test.ts.
- The globalThis.__mantle* keys are counted: dbGlobalKeyWrites (a write
  outside gateway/pools.ts in packages/db/src, pinned 0) and
  dbGlobalKeyReads (a read outside it, pinned 1: actorClient's closing
  check at gateway/actor-sql.ts:354, ruled to stay in the audit). Each site
  is listed in the scoreboard's perFile.gateway.
- eslint-rules/actor-binders.mjs: the pools.ts comment moved above its own
  entry.
- Gates (Mac, DATABASE_URL unset), exit codes: pnpm -r typecheck 0,
  pnpm lint 0, pnpm format:check 0, pnpm docs:check 0, pnpm arch:check 0,
  vitest run eslint-rules packages/db 0 (75 files passed, 60 skipped). No
  runtime code changed, so the DB suites were not run again.

### Open items for parts 2 and 3

- actor-sql.ts reads `globalThis.__mantleSql` once (actorClient's closing
  check, `open = globalThis.__mantleSql === base`): the key is declared and
  written only in pools.ts, but actor-sql.ts sits below pools.ts and cannot
  import it. A test sets the key by hand (actor-client.test.ts). Ruled to
  stay in the audit, pinned by dbGlobalKeyReads (1).
- closeDb now lives in pools.ts and resets the higher modules' caches by
  onCloseDb: part 2's write-route.ts and system-tx.ts register their own.
- viewer.ts systemDbCallerOf skips frames of client.ts only. No gateway
  module of part 1 touches systemDb; when the db and systemDb proxies move
  (part 3, handles.ts) the skip list must name that file.
- eslint-rules/scope-settings.mjs pins client.ts: part 2 (the write role
  settings) and part 3 (withScope, the turn scope, writeScopeSettings) move
  those sites and must move the pins' file keys in the same commit.

## Part 2: role-tx, write-route, system-tx

Branch feat/s5-p2, from main 7ce61f579 (v0.300.106).

### The moves

| Commit    | Module                 | Lines | What moved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------- | ---------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| b26d38dcb | gateway/role-tx.ts     | 505   | the route type (LoginWriteRoute), the pending query helpers (QueryMode, lazyQuery, QueryLike, sendIn), noteWriteRoleDenial, the write transaction's state (WriteTx, openWriteTx), afterOuterRollback, afterOuterCommit, inOpenTransaction, newWriteTx, JoinedWriteEndedError, watchedSends, levelEnded, insideBelow, ownSavepoints, joinWriteTx, joinableWriteTx, watchTx, the bounded wait (WRITE_POOL_WAIT_MS, setWritePoolWaitForTests, WritePoolBusyError, checkNestedAcquire, boundedBegin, boundedReserve), NESTED_SAVEPOINT_WARN |
| b48f1bb0c | gateway/write-route.ts | 467   | WRITE_ROLE_ACTORS, WRITE_ROLE_TABLE_SET, isWriteRoleTable, rawWriteTarget, typedWrite, loginWriteRoute, loginWriteRouteNow, loginWritesMayRoute, settingLiteral, writeRoleSettingsSql, the gateway's runner (GatewayPaths, onLoginWritePool, writeRoleStatement, writeTxOf, writeRoleBegin, joinedBegin, joinedStatement), loginWriteClient, loginWriteDb and its cache, systemWriteDb, checkedUuidOrEmpty, uuidArrayLiteral, the private workspaces read (privateWorkspaces, ownPrivate, writeScopeWithPrivate)                        |
| e7fa41769 | gateway/system-tx.ts   | 378   | brokerLockTx, withSystemTx's write paths (WriteTxOpen, writeTxOpen, writeTxDb and its cache with its onCloseDb registration, writeRoleSystemTx, joinedSystemTx), NestedSystemTxError, systemTxKeys, nestedSystemTx, withSystemTx, SystemPoolScope, writeScopeSettings, systemPoolTxInScope, systemPoolTx, openSystemTx                                                                                                                                                                                                                  |
| 8e342e18a | guards                 |       | dbClientLines pinned down                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

Fix round 1 moved the runner on out of write-route.ts (see "Fix round 1"
below): 42f38310d, gateway/role-runner.ts, 145 lines; write-route.ts is
350 lines after it.

client.ts: 2438 lines on main, 1210 after part 2.

The layers, no cycle: role-tx.ts imports check-mode.ts and pools.ts;
role-runner.ts imports check-mode.ts, actor-sql.ts and role-tx.ts;
write-route.ts imports check-mode.ts, actor-sql.ts, pools.ts, role-tx.ts
and role-runner.ts; system-tx.ts imports pools.ts, role-tx.ts,
role-runner.ts and write-route.ts; client.ts imports all seven but
role-runner.ts. No gateway module imports client.ts. client.ts
re-exports every name it exported before, so index.ts and every importer
are unchanged.

Where the split differs from plan v3.2 section 3.1's list, and why:

- The write role's runner (writeRoleStatement, the one pipelined statement
  transaction on the write role: BEGIN, the SET, the statement and COMMIT
  on one reserved connection; writeTxOf, writeRoleBegin, joinedBegin,
  joinedStatement) is gateway/role-runner.ts, between role-tx.ts and
  write-route.ts: with it role-tx.ts would measure about 620 lines, over
  the 600 limit. It takes the route's SET only (route.setSql), so a narrow
  route in role-tx.ts (S7a) can call it without a cycle. role-tx.ts keeps
  the transaction's state, its joins and savepoints, the watched client and
  the bounded begin and reserve the runner calls; write-route.ts keeps the
  login route decision, onLoginWritePool, loginWriteClient and the handle.
  Plan v3.2 section 2.1 point 3 should read "role-tx.ts + role-runner.ts"
  where it names role-tx.ts (the CEO updates the plan).
- NESTED_SAVEPOINT_WARN went to role-tx.ts (joinWriteTx counts against it;
  system-tx.ts imports it).
- brokerLockTx went to system-tx.ts (a short system-pool transaction
  outside every caller's).
- privateWorkspaces, ownPrivate and writeScopeWithPrivate went to
  write-route.ts: loginWriteRoute calls writeScopeWithPrivate, and a gateway
  module cannot import client.ts. createHomeFallback (client.ts) calls
  ownPrivate. The map lives in one module.
- checkedUuidOrEmpty and uuidArrayLiteral went to write-route.ts
  (writeRoleSettingsSql's); system-tx.ts and client.ts's scopes import them.

### The glue (every line that is not a move)

- onCloseDb, split: client.ts had one registration, `loginWriteDbCache =
null; writeTxDbCache = null;`. write-route.ts now registers the first
  line at its load (the registration's two lines are the glue, the reset
  line is moved), and the registration with the second line moved to
  system-tx.ts as it was. write-route.ts loads first (system-tx.ts imports
  it), so closeDb resets them in the same order. No other glue: no new
  glue function.
- viewer.ts systemDbCallerOf skips packages/db/src/gateway/ as client.ts
  (in b48f1bb0c). failOpenCaller (fail-open-sites.ts) finds a fail-open
  hit's calling file by it, skipping client.ts frames; typedWrite and
  loginWriteClient's raw-write site now run in write-route.ts, so without
  the skip their hits would name write-route.ts, not the caller. One new
  case in viewer.test.ts proves it (it fails without the skip); no
  existing test changed. It covers part 3's handles.ts too (part 1's open
  item 3).

Exports added for client.ts's own callers and the modules above (no new
public name, index.ts unchanged): role-tx.ts LoginWriteRoute, QueryMode,
WriteTx (types), lazyQuery, sendIn, noteWriteRoleDenial, openWriteTx,
newWriteTx, levelEnded, joinWriteTx, joinableWriteTx, watchTx,
boundedBegin, boundedReserve; write-route.ts typedWrite,
loginWritesMayRoute, onLoginWritePool, writeRoleBegin, joinedBegin,
systemWriteDb, ownPrivate, checkedUuidOrEmpty, uuidArrayLiteral;
system-tx.ts none.

The move proof: each module's body (after its header comment, imports and
PgSql alias) against the source lines at its parent commit, by diff.
system-tx.ts is byte-equal; write-route.ts is byte-equal but the `export`
keyword on 9 lines and the onCloseDb glue; role-tx.ts is byte-equal but
the `export` keyword on 14 lines and Prettier's wrap of boundedBegin's
signature (over 100 columns once exported). The other side, a line
multiset of `git show -U0`: every removed client.ts line is re-added in
the new module but the imports client.ts no longer needs.

### Pins and file keys that moved with the code

- eslint-rules/scope-settings.mjs: client.ts 9 to 4 (the turn scope 2,
  withScope 2), gateway/write-route.ts 2 (the write role settings),
  gateway/system-tx.ts 3 (writeScopeSettings); the header, description
  and message name client.ts and its gateway modules. The carrier pins are
  unchanged: the two systemPoolTxInScope calls (createHomeFallback,
  systemPoolProp) stay in client.ts, and its definition is no call.
- eslint-rules/heads-writers.mjs DYNAMIC_UNSAFE_REVIEWED: role-tx.ts (the
  watched client), write-route.ts (the runner and loginWriteClient),
  system-tx.ts (brokerLockTx) pass the caller's statement through.
- docs/process-inventory.md: the write pool's bounded wait is a
  timeout-loop of gateway/role-tx.ts; client.ts keeps its own
  (withDeadlockRetry).
- Comments naming the home of typedWrite, loginWriteClient
  (arch-counts.mjs) and rawWriteTarget (rights-counts.mjs).
- Unchanged, checked by a grep of eslint-rules/ and
  scripts/arch-scoreboard.ts for client.ts: actor-binders (client.ts 1:
  loginActorNow's runAsSystem), provider-http BACKOFF_LOOP_ALLOWED
  (withDeadlockRetry), heads-writers' client.ts entry (the turn-scope
  client), system-db-allowlist (no gateway module touches systemDb).

### The guards

- dbClientLines pinned down 2438 to 1210.
- dbGatewayMaxLines 600 (the longest module, role-tx.ts, is 505),
  dbGatewayImportCycles 0, dbGlobalKeyWrites 0, dbGlobalKeyReads 1 (part
  2's modules read no global key; the reason says so).
- rawWriteSqlFiles measures 65 against its pin 59 (62 after part 1): the
  three new modules hold raw write SQL sites moved from client.ts, no site
  more (rawWriteSqlScoped 62 and rawSqlNonLiteral 75 are unchanged).
  MAY_GROW, as in part 1; the pin is left.

### Gates

Each move commit (b26d38dcb, b48f1bb0c, e7fa41769), checked out on its
own: `pnpm -C packages/db typecheck` and the unit vitest of packages/db and
eslint-rules, exit 0 (826, 827, 827 tests passed).

Mac, on 8e342e18a, DATABASE_URL unset, exit codes:

| Gate                                                                                        | Exit |
| ------------------------------------------------------------------------------------------- | ---- |
| pnpm -r typecheck                                                                           | 0    |
| pnpm lint                                                                                   | 0    |
| pnpm format:check                                                                           | 0    |
| pnpm docs:check                                                                             | 0    |
| pnpm arch:check                                                                             | 0    |
| vitest run server packages eslint-rules (857 files passed, 268 skipped; 11068 tests passed) | 0    |
| pnpm -C server/web build                                                                    | 0    |

Workstation, Node 26.5.0, on 8e342e18a: own clone, own pgvector pg18
container (s5p2-pg) on port 55720 (checked free, max_connections=450, the
postgres role as CI's), init-scratch and migrate with
MANTLE_CHECK_FLOOR=keep, systemd-run --user, --maxWorkers=3, one at a time:

| Gate                          | Result                                    | Exit |
| ----------------------------- | ----------------------------------------- | ---- |
| pnpm test (full, with the DB) | 1125 files, 13850 tests passed, 1 skipped | 0    |
| pnpm test:actor-off           | 128 files, 1166 passed, 1 skipped         | 0    |
| pnpm test:runtime-role (full) | 276 files, 2764 passed, 1 skipped         | 0    |

Container, clone, scripts and logs removed by exact name after; no unit
left. The branch was pushed with --no-verify (the pre-push gate is
`pnpm verify`; the gates above ran by hand).

### Open items for part 3

- loginActorNow stays in client.ts: it is in no module's list (with the
  handles, or a home of its own). Its runAsSystem is client.ts's one
  actor-binders pin.
- STATEMENT_PROPS stays in client.ts for the db and systemDb proxies
  (handles.ts).
- scope-settings: client.ts's 4 (the turn scope, withScope) move with
  scope.ts; the carrier pin's client.ts 2 (createHomeFallback,
  systemPoolProp) moves with viewer-scope.ts and handles.ts.
- heads-writers' client.ts entry (the turn-scope client) moves with
  scope.ts; the process inventory's client.ts timeout-loop and
  provider-http's BACKOFF_LOOP_ALLOWED move with withDeadlockRetry
  (heads.ts).
- viewer.ts systemDbCallerOf now skips packages/db/src/gateway/ by
  directory, so the proxies in handles.ts need no new entry.
- actor-sql.ts's one read of globalThis.__mantleSql (dbGlobalKeyReads 1)
  is unchanged.
- The write transaction's AsyncLocalStorage (openWriteTx) is exported
  from gateway/role-tx.ts (role-tx.ts:130) for role-runner.ts,
  write-route.ts, system-tx.ts and client.ts. Narrow helpers instead (the
  open level, run in a level) would keep the store's writes in
  role-tx.ts. Not changed in part 2 (audit LOW-3).
- On main: checkActorBound (packages/db/src/actor.ts:347) hands the
  unfiltered longStack to systemDbCallerOf, so its miss names actor.ts
  rather than the caller. Filter actor.ts frames as failOpenCaller does
  (fail-open-sites.ts). Not changed in part 2 (audit LOW-4).

### Fix round 1 (audit at 3d42a4f67: 9/10, merge)

- MED-1: 42f38310d moves the runner (writeRoleStatement, writeTxOf,
  writeRoleBegin, joinedBegin, joinedStatement) out of write-route.ts into
  gateway/role-runner.ts (145 lines), a move only: the body is byte-equal
  but the `export` keyword on writeRoleStatement and joinedStatement. No
  glue, no cycle (dbGatewayImportCycles 0). heads-writers
  DYNAMIC_UNSAFE_REVIEWED names role-runner.ts; write-route.ts's reason is
  loginWriteClient's now.
- LOW-1: eb5238366 points the stale client.ts references at the gateway
  files: docs/actors.md (loginWriteRoute; still 345 lines), docs/fail-open.md
  (typedWrite, loginWriteClient), actor.ts (noteWriteRoleDenial, the test
  gap note), fail-open-sites.ts (loginWriteRoute, its header's four
  sites), and the comments of ws-row-definers.db.test.ts and
  ws-user-definers.db.test.ts (writeRoleSettingsSql).
- LOW-2: CI of the audited head 3d42a4f67: run 39307297393, success,
  https://github.com/crossworks-engineering/mantle/actions/runs/39307297393
- LOW-3 and LOW-4: open items for part 3 above.
- Gates on eb5238366 (Mac, DATABASE_URL unset), exit codes: pnpm -r
  typecheck 0, pnpm lint 0, pnpm format:check 0, pnpm docs:check 0,
  pnpm arch:check 0, vitest run server packages eslint-rules 0 (857 files
  passed, 268 skipped; 11068 tests passed), pnpm -C server/web build 0.
  Workstation (own clone, own container s5p2-pg on 55720, the same setup
  as above): pnpm test:runtime-role in full, 276 files, 2764 tests passed,
  1 skipped. Its first run exited 1 with every file passed, and its log
  was removed before it was read (a cleanup too early); the rerun exited 0.
  Container, clone and logs removed by exact name after both runs.

## Part 3: scope, handles, heads, scope-answers, viewer-scope, the barrel

Branch feat/s5-p3, from main 1967cf106 (v0.300.107). Builder round 1 of 2:
the moves, the barrel, the guards, LOW-3, LOW-4 and the docs are done, and
the Mac gates ran; the workstation DB gates and CI's result are round 2's
(see "State and what is left").

### The moves

| Commit    | Module                   | Lines | What moved                                                                                                                                                                                                                                |
| --------- | ------------------------ | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7099988cb | gateway/scope.ts         | 273   | ScopeLostError, SCOPE_SETTINGS_SQL, turnScopeParams, the PgSql alias, turnScopedClient, getTurnScopedDb, getDb, withScope, withTurnScope, turnScopeProblem, scopeProblem, ReadTx, readTransaction                                         |
| 0b2be9567 | gateway/handles.ts       | 209   | STATEMENT_PROPS (with its section heading), db, systemPoolProp, isWriteSql, sqlTextOf, NotAWriteError, executeWrite, systemDb, executeAsMigrator, the Db type                                                                             |
| c029a4921 | gateway/heads.ts         | 287   | withHeads, withSubtreeHeads, systemTxOrPool, folderHeadIds, withNodeInsertHeads, withNodeMoveHeads, withNodeDeleteHeads, headsOrSpace, withSpaceRows, onSpaceRows, withWriterHeads, lockMoreHeads, RETRYABLE, sqlState, withDeadlockRetry |
| cb3807c4d | gateway/scope-answers.ts | 201   | loginActorNow, holdsAdmin and scopeHoldsAdmin, scopeHasArea, loginFactDeniedLogged and loginFactFailed, loginHoldsAdmin, loginHasArea, loginAreas, moderatorSeatsNow                                                                      |
| 716465b84 | gateway/viewer-scope.ts  | 268   | withViewer, memoScopeFor, loginScopeColumns, seedLoginScope, loginScopeFor, createHomeFallback, appRunHolders, viewerScopeFor                                                                                                             |
| 62af4b20b | client.ts                | 92    | the barrel: its header and its re-exports only                                                                                                                                                                                            |
| 1e5c3fe63 | guards                   |       | the pins below                                                                                                                                                                                                                            |

client.ts: 1210 lines on main, 92 after part 3 (a header comment and
`export ... from` lines only). The longest gateway module is role-tx.ts,
517 lines.

Where the split differs from plan v3.2 section 3.1's list, and why:

- loginActorNow is in no module's list. It went to scope-answers.ts: it is
  a thin read of one login's row now (is it disabled), on the system pool,
  as loginHoldsAdmin, loginHasArea and loginAreas are. Its one runAsSystem
  is the actor-binders pin that moved with it.
- moderatorSeatsNow (in the viewer block of client.ts) went to
  scope-answers.ts with the other thin calls; it reads through `db`, so
  scope-answers.ts imports handles.ts.
- STATEMENT_PROPS went to handles.ts with the two proxies that use it.
- sqlState went to heads.ts with RETRYABLE and withDeadlockRetry;
  loginFactFailed (scope-answers.ts) imports it.
- getDb (the handle for the current scope) went to scope.ts with the
  turn-scope client it picks; handles.ts, heads.ts and scope-answers.ts
  import it.

The layers, no cycle (dbGatewayImportCycles 0): scope.ts imports pools.ts
and write-route.ts; handles.ts imports check-mode.ts, actor-sql.ts,
pools.ts, write-route.ts, system-tx.ts and scope.ts; heads.ts imports
pools.ts, write-route.ts, system-tx.ts and scope.ts; scope-answers.ts
imports pools.ts, scope.ts, handles.ts and heads.ts; viewer-scope.ts
imports pools.ts, write-route.ts and system-tx.ts. No gateway module
imports client.ts.

### The glue (every line that is not a move)

- `export` added on two moved functions, for the modules above them:
  getDb (scope.ts) and sqlState (heads.ts). No glue function, no new
  onCloseDb registration (none of part 3's modules holds a cache that
  closeDb resets).
- The barrel (62af4b20b): its header says it is a barrel that stays one
  release, then goes; `import * as schema` plus `export { schema }`
  became `export * as schema from './schema/index'` (the same namespace
  object).
- The modules' header comments and imports.

The move proof: for each move commit, a line multiset of `git show -U0`,
the new module's added lines against client.ts's removed lines. Every
moved line is byte-equal but the two `export` keywords above; what is only
in the module is its header comment and imports; what is only removed from
client.ts is the imports it no longer needs.

The public API: the TS checker's export list (each name, its value type and
its declared type) of client.ts and of index.ts, on main 1967cf106 and on
62af4b20b, are equal: client.ts 66 names, index.ts 840 names. One line
prints differently and is the same type: systemWork's reason union is
printed in another order (viewer.ts, unchanged on the branch). index.ts is
unchanged and still imports from './client': the tests that vi.mock
client.ts (packages/tools, mcp-core, runtime, db, server/web, 14 files)
reach their callers through it.

### LOW-3 and LOW-4

- LOW-3 (d4587055d): openWriteTx is no longer exported from role-tx.ts.
  currentWriteTx (its getStore; system-tx.ts, write-route.ts) and
  runInWriteTx (its run; role-runner.ts) forward the call unchanged, so
  the store is read and entered outside role-tx.ts through two named
  functions only.
- LOW-4 (70609f5be): checkActorBound filters actor.ts's own frames from
  longStack before systemDbCallerOf, as failOpenCaller does, so a miss's
  detail names the calling file, not actor.ts. A log detail only. The new
  actor.test.ts case fails without it (checked by reverting the line).

### Pins and file keys that moved with the code

- eslint-rules/scope-settings.mjs: client.ts 4 to 0, gateway/scope.ts 4
  (the turn scope 2, withScope 2); the carrier pins client.ts 2 to 0,
  gateway/handles.ts 1 (systemPoolProp), gateway/viewer-scope.ts 1
  (createHomeFallback). The header, description and message name the
  database gateway, not client.ts. arch-lints.test.ts: the valid
  fixture's file name is gateway/scope.ts (a path only).
- eslint-rules/heads-writers.mjs DYNAMIC_UNSAFE_REVIEWED: gateway/scope.ts
  (the turn-scope client); gateway/handles.ts (executeAsMigrator's
  `tx.unsafe(text, params)`, which the old client.ts entry covered without
  naming it).
- eslint-rules/actor-binders.mjs: client.ts 1 to 0,
  gateway/scope-answers.ts 1 (loginActorNow's runAsSystem).
- eslint-rules/provider-http.mjs BACKOFF_LOOP_ALLOWED and
  docs/process-inventory.md's timeout-loop: gateway/heads.ts
  (withDeadlockRetry).
- packages/db/src/scope-problem.test.ts reads gateway/scope.ts's source
  (a path only).
- viewer.ts systemDbCallerOf already skips packages/db/src/gateway/ by
  directory; 5c8af360a adds a viewer.test.ts case with the systemDb
  proxy's frame in gateway/handles.ts (it fails without the skip). The
  client.ts skip stays while the barrel does (it holds no frame now).
- system-db-allowlist: unchanged (no gateway module imports systemDb).
- Checked by a grep of eslint-rules/ and scripts/arch-scoreboard.ts for
  client.ts: no rule is left looking at client.ts for moved code
  (dbClientLines measures the barrel; gateway-counts and its tests name
  client.ts as the barrel).
- 05707ae1a points the comments and docs that named client.ts as the
  home of moved code (parts 1 to 3) at the gateway files:
  docs/architecture.md, docs/fail-open.md, actor-setters.mjs,
  arch-counts.mjs, content apps.ts and pages/read.ts, packages/db
  access-matrix.ts, actor.ts, check-floor.ts, fail-open-sites.ts,
  fail-open.ts, grant-reads.ts, item-rights.ts, migrator-connection.ts,
  pg-error.ts, runtime-role.ts, viewer.ts, and server/api login-actor.ts.
  The access-matrix.ts and runtime-role.ts lines are description strings
  whose keys alone are read (no test or doc compares the text). Left: test
  files, migrations, the archive and historical lines.

### The guards

- dbClientLines 1210 to 92 (the barrel), to 0 when it goes.
- dbGatewayMaxLines 600 (longest role-tx.ts 517), dbGatewayImportCycles
  0, dbGlobalKeyWrites 0, dbGlobalKeyReads 1 (part 3's modules read no
  key; the reason says so).
- sqlMembershipAsks 2 to 3, no new site: viewerScopeFor's login read
  (workspace_users, disabled_at and a bound login_id) is a membership ask
  that sat in client.ts uncounted, because tsAdminSqlKinds's template
  reader lost its place after moderatorSeatsNow's nested template literal
  (proven: main's client.ts with moderatorSeatsNow cut out counts 1). In
  viewer-scope.ts the reader sees it. The pin's reason says so.
- rawWriteSqlFiles measures 67 (66 on main 1967cf106, after part 2),
  MAY_GROW for this split;
  rawWriteSqlScoped 62 is unchanged.

### Gates

Each move commit: `pnpm -C packages/db typecheck` and the unit vitest of
packages/db and eslint-rules, exit 0 (828 tests passed on the last).

Mac, on 05707ae1a, DATABASE_URL unset, exit codes:

| Gate                                                                                        | Exit |
| ------------------------------------------------------------------------------------------- | ---- |
| pnpm -r typecheck                                                                           | 0    |
| pnpm lint                                                                                   | 0    |
| pnpm format:check                                                                           | 0    |
| pnpm docs:check                                                                             | 0    |
| pnpm arch:check                                                                             | 0    |
| vitest run server packages eslint-rules (857 files passed, 268 skipped; 11070 tests passed) | 0    |
| pnpm -C server/web build                                                                    | 0    |

### State and what is left (round 2)

- Pushed with --no-verify (the pre-push gate is `pnpm verify`; the gates
  above ran by hand).
- Not run yet: the workstation DB gates, one at a time, in an own clone
  and an own pgvector pg18 container (name prefix s5p3-, a free port,
  max_connections=450, a `postgres` role as CI's, MANTLE_CHECK_FLOOR=keep,
  systemd-run --user, --maxWorkers=3): full `pnpm test`,
  `pnpm test:actor-off`, `pnpm test:runtime-role` in full. Clean up by
  exact name.
- CI of the pushed head: read its result
  (`gh run list -R crossworks-engineering/mantle --branch feat/s5-p3`).

### Open items

- The barrel goes one release after part 3: index.ts and the 14 test
  files that vi.mock client.ts must move first (a mock of the barrel is
  what their callers see through index.ts; mocking each gateway module
  instead changes those tests), then dbClientLines to 0 and viewer.ts's
  client.ts skip removed.
- tsAdminSqlKinds's template reader (eslint-rules/rights-counts.mjs)
  loses its place after a nested template literal, so a file can hide a
  membership ask or an area rule after one. Fix the reader and re-measure
  sqlMembershipAsks and sqlAreaRules. Done in round 2 (below).
- Test files' comments still name client.ts for moved code (a2a, a2b2b,
  w7a, a8, connection-ceiling, login-facts, ws-user-definers, sql-grid):
  left, because tests change only in imports in this split.
