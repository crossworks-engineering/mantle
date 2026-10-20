# The narrow system role, plan v3.2 (handover)

The narrow system role of plan v3.2 section 2.1, in three parts, one merge
per part. Each part's section: what changed, the changed answers, the pins,
the gates with their exit codes, the rollback. The spec is
docs/runtime-role.md, "The narrow system role".

## Part a1: the role, its membership and its matrix grants

Branch feat/s7a-a1, from main at 1967cf106 (v0.300.107). No migration:
roles, memberships and grants are made by migrate on every run, before and
after the migrations (`beforeMigrations` runs `ensureRuntimeRoles`,
`afterMigrations` runs `applyRuntimeGrants`), as for the other runtime
roles. Nothing runs on the role yet: no route takes it, no flag reads it.
packages/db/src/client.ts and packages/db/src/index.ts are untouched (the
client.ts split's part 3 is in flight).

### What changed

- packages/db/src/runtime-role.ts
  - `NARROW_ROLE = 'mantle_system_narrow'`, in `RUNTIME_ROLES` (so
    `ensureRuntimeRoles` makes it every run, `takeBackMemberships` watches
    its memberships both ways, scratch databases and the restore make it).
  - Its attributes (`roleAttrs`): `NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB
NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD NULL`, whatever the
    runtime role's login.
  - `wantedMemberships()`: the runtime role in it, `INHERIT FALSE, SET
TRUE`, next to `mantle_system`. Nothing else; it is a member of
    nothing. The superuser takes it as any role.
  - `RUNTIME_LOCK_SQL`: the runtime role holding its rights (a membership
    with `INHERIT`) breaks the lock, as for `mantle_owner` and
    `mantle_system`.
  - `NARROW_DENIED_FUNCTIONS`: what narrow work never calls, each with why
    (the four owner bodies with no Admin check, `mantle_embed_host`,
    `mantle_role_drift`). `narrowFunctionAllowlist` = the runtime role's
    allowlist (`runtimeFunctionAllowlist`, which takes an `except` list
    now) less those.
  - `narrowWriteTables`, `narrowReadOnlyTables`, and `applyNarrowGrants`,
    run inside `applyRuntimeGrants`' transaction: revoke everything on the
    app's tables, sequences and routines, then `SELECT, INSERT, UPDATE,
DELETE` on the `'all'` tables, `SELECT` on the `'read'` ones, `USAGE,
SELECT` on the sequences the `'all'` tables draw from (owned by a
    column or named in a default), `EXECUTE` on the narrow allowlist,
    `USAGE` on `public`, `auth` and `pgboss`, `SELECT` on pg-boss's
    tables. No default privileges: a new table is closed to it until the
    next migrate grants what the matrix says.
- packages/db/src/access-matrix.ts: `TableAccess.narrow?: 'none' | 'read'
| 'all'` and `narrowFor(t)`, derived per section 2.1 point 2: the runtime
  role's `'none'` and `'read'` carried over, `content` `'read'`, `system`
  and `admin` `'all'`. A hand value may only narrow (wider than the runtime
  role's throws). No row sets one yet. A new content table is read only by
  the derivation.
- scripts/db-restore.sh: the restore makes the role before `pg_restore`
  (the dump's grants name it); docs/access-levels.md "eleven roles".
- Docs: docs/runtime-role.md (the roles table, a section "The narrow system
  role", the tests), docs/access-levels.md, docs/update-prod.md, the known
  limit in docs/actors.md section 15 (same line count).

### Fold-ins

- S6 c1 audit LOW-4 (the system door to the `*_rows` bodies is not limited
  by actor): closed for the narrow role here. The narrow role holds no
  `EXECUTE` on `mantle_contact_sharing_rows`,
  `mantle_contact_shares_revoke_rows`, `mantle_share_with_contacts_rows`,
  `mantle_entity_merge_rows`. Which reasons may reach them: only full
  system work, the maintenance runner's entities sweep and the two CLIs
  (entities-dedupe.ts, entities-title-cleanup.ts), on the system pool
  outside any exit, and tests; no narrow reason. An Admin user's act goes
  through the definer that checks first (`mantle_entity_merge`,
  `mantle_contact_sharing_set`, `mantle_contact_shares_revoke_all`,
  `mantle_share_with_contacts`), which the narrow role keeps. Cells:
  runtime-role.test.ts "its EXECUTE list is the runtime allowlist less a
  reasoned list" (the four are in `NARROW_DENIED_FUNCTIONS`);
  runtime-role.db.test.ts "the narrow role runs the runtime allowlist less
  NARROW_DENIED_FUNCTIONS" (live list) and "as the narrow role ..." (a call
  of `mantle_entity_merge_rows` refused, 42501, from the runtime role's
  session and from the superuser's). The runtime role's own door is
  unchanged (full system work keeps it).
- S6 c3 deferred item (the Telegram moderated-chat definer): named for
  S10. It needs a new definer, so a migration, and a1 has none; a3's
  migration is the report-only trigger and rule 3 keeps one migration per
  roll. The branch runs today by the named exit `'login-telegram'`, which
  a2 measures for the narrow route (section 2.1 point 4), so the narrow
  role contains it either way; the definer (the users area asked in SQL,
  with write-role `EXECUTE` in the matrix) belongs with S10's raw write
  ban, which rewrites `setChatPairing`'s writes.
- S2b LOW-3 / S2c L5 (the archive path never sets `mantle.write_mode`): a2,
  where the route is picked.

### Changed answers

None for any member, client, key, peer or public link, nor for the system
pool (it runs as before; the role is unused). Catalog answers about which
roles may run a function gain the narrow role, and three catalog tests say
so:

- packages/db/src/login-facts.db.test.ts: the narrow role may run
  `mantle_area_rule`, `mantle_login_areas`, `mantle_login_is_admin`, not
  `mantle_role_drift` nor `mantle_login_area`.
- packages/db/src/ws-user-definers.db.test.ts: `mantle_bridge_login` is
  the runtime role's and the narrow role's (the users area adds a login).
- packages/db/src/ws-row-definers.db.test.ts: the narrow role is among the
  roles that may run the row definers and the archive.

### Pins

- runtime-role.test.ts: the derivation for every matrix row; a hand value
  never widens; no content table written and no runtime-closed table
  opened; the counts `{ all: 106, read: 32, none: 3 }` (`all` only goes
  down); the denied list a subset of `RUNTIME_SYSTEM_FUNCTIONS` with a
  reason each, the four bodies in it.
- runtime-role.db.test.ts: the attributes (from `pg_authid`), owns
  nothing, the one membership (runtime, `SET` only), no default
  privileges; the live grants of every table of `public` and `auth` equal
  `narrowFor` (none for a table the matrix does not list), no column
  grant, sequences `USAGE, SELECT` or nothing; the functions taken from
  `PUBLIC` it may run are exactly the runtime role's less
  `NARROW_DENIED_FUNCTIONS`; taken with `set_config('role', ..., true)`
  from the runtime role's session and from the superuser's: reads past the
  row rules (nodes, workspaces counts equal the superuser's), writes a
  system table, refused (42501) on a content insert, update and delete, a
  runtime-read table, a runtime-closed table, `TRUNCATE`, `ALTER TABLE`, a
  check setter, a denied body, the box count; `mantle_owner_role()` says
  no; `SET ROLE mantle_owner` refused from the runtime role's session. And
  migrate takes back a hand grant (`INHERIT` on the membership, a table
  right, a denied function) and every membership held in it or by it.
- Scoreboard: no pin moved (`pnpm arch:check` exit 0, nothing lower). The
  section 2.1 point 7 pins (systemWholeOnFull, asSystemNarrow and
  asSystemFull by reason, systemDbUses by file, requestSystemExits) move
  in a2.

### Gates

Mac, Node 26, DATABASE_URL unset:

| Gate                                                                                  | Exit |
| ------------------------------------------------------------------------------------- | ---- |
| pnpm -r typecheck (on 846b1d262)                                                      | 0    |
| pnpm lint (on 846b1d262)                                                              | 0    |
| pnpm format:check (on ad241c15d)                                                      | 0    |
| pnpm docs:check (on ad241c15d)                                                        | 0    |
| pnpm arch:check (on ad241c15d, no pin moved)                                          | 0    |
| pnpm boot:smoke (on 846b1d262)                                                        | 0    |
| vitest run server packages eslint-rules, first run (846b1d262)                        | 1    |
| vitest run server packages eslint-rules, on ad241c15d (857 files passed, 268 skipped) | 0    |
| pnpm -C server/web build (on 846b1d262)                                               | 0    |
| bash scripts/test-deploy-scripts.sh (db-restore.sh changed; 518 passed)               | 0    |

The first unit run failed two files: ops-docs.test.ts (access-levels.md
said "ten roles"; the restore makes eleven now: fixed in ad241c15d, the
words list gains "eleven") and deploy-scripts.test.ts (spawnSync
ETIMEDOUT under load; the harness itself passed 518 of 518 alone, and the
file passed on the rerun). The commits after 846b1d262 change tests and
docs only.

Workstation, Node 26.5.0: own clone, own pgvector pg18 container `s7a-pg`
on 127.0.0.1:56371 (checked free, max_connections=450, the `postgres` role
as CI's), init-scratch and migrate with MANTLE_CHECK_FLOOR=keep,
systemd-run --user, --maxWorkers=3, one at a time:

| Gate                                                                                   | Result                                                                              | Exit |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---- |
| focused DB run (runtime-role, login-facts, the definer catalogs, access-matrix), first | the new INSERT probe hit a generated column (428C9, a probe bug)                    | 1    |
| the same, runtime-role.db.test.ts after the fix (bd2c751a1)                            | 25 passed                                                                           | 0    |
| pnpm test (full, with the DB), on ad241c15d                                            | 1125 files, 13859 passed, 1 skipped                                                 | 0    |
| pnpm test:actor-off                                                                    | 128 files, 1175 passed, 1 skipped                                                   | 0    |
| pnpm test:actor-on                                                                     | 29 files, 361 passed, 1 skipped                                                     | 0    |
| pnpm test:edit-on                                                                      | 41 files, 531 passed                                                                | 0    |
| pnpm test:matrix                                                                       | 4 files, 8 passed; every failing cell a known one (8, 8, 0, 26, 4), the grid 0 fail | 0    |
| pnpm test:runtime-role (full config)                                                   | 276 files, 2768 passed, 1 skipped                                                   | 0    |

A first full run on bd2c751a1 was stopped (its unit, by exact name) to run
on ad241c15d instead; no result taken from it. No flake, no rerun. The
container, the clone and the units are removed by exact name after.

CI: run 39334475570 on ad241c15d: success,
https://github.com/crossworks-engineering/mantle/actions/runs/39334475570
(the runs on 846b1d262 and bd2c751a1 were cancelled by the next push).

### Rollback

One image back (main before the merge) lands on N-1's rights, as audited:
its migrate does not know the role, and its
`takeBackMemberships` reads memberships of its own three roles, so the
runtime role's membership in `mantle_system_narrow` is taken back with one
warning line. The role stays (NOLOGIN, no member, its grants unused). To
drop it by hand as the superuser, in the brain's database:
`DROP OWNED BY mantle_system_narrow; DROP ROLE mantle_system_narrow;`
(`DROP OWNED` revokes its grants; it owns nothing). A dump taken on this
release names the role in its grants: restore it with this release's
db-restore.sh, or create the role first (`CREATE ROLE mantle_system_narrow
NOLOGIN`). Without it `pg_restore` prints one error per grant to the role:
the rows are restored in full, but the N-1 db-restore.sh then exits 3 (the
a1 audit's LOW-1), so create the role first.

### Open items

- Owner question, not blocking: the derivation (section 2.1 point 2) makes
  every `admin` table `'all'`, the credential tables too (`secrets`,
  `api_keys`, `access_keys`, `email_accounts`, `oauth_*`, `mobile_tokens`,
  `member_invites`, `pairing_codes`, `telegram_accounts`). Safer option
  for later: a2 measures which narrow reasons touch them and sets
  `narrow: 'read'` or `'none'` on the rest (the field only narrows). a1
  follows the plan as written.
- A foreign key's cascade runs as the table's owner, so a narrow delete
  that cascades into a content table is not stopped by the grants; a3's
  observe trigger still sees the actor `system:<reason>`.
- `SET ROLE` is checked against the session's login: a statement that
  resets the role leaves the narrow role. It contains the app's own
  statements, not injected SQL (docs/runtime-role.md).
- `NARROW_ROLE` and the helpers are not exported from `@mantle/db`'s
  barrel (index.ts, left alone while the split's part 3 builds); a2 works
  inside packages/db.
- a2: the route (gateway/role-tx.ts, role-runner.ts), `AS_SYSTEM_ROUTE`,
  the request exits' pick, the flag, the archive path's write_mode.

## Part a2: the narrow route

Branch feat/s7a-a2, from main at 0d8f745a2 (v0.300.109). Not ready to
merge: round 1 built the route and measured it; the full DB suite with the
switch on still fails 30 tests in 23 files (below), each a measurement
result for round 2. No migration.

### What changed

- First commit (5f0dd70b7), the a1 audit's MED-1 and LOW-1:
  `narrowFor` compares a hand value with the derived value (a content table
  may not be reopened to narrow writes), runtime-role.test.ts expects the
  throw; the a1 rollback says to create the role first.
- packages/db/src/viewer.ts: `SystemRoute`, `AS_SYSTEM_ROUTE`
  (`Record<AsSystemReason, 'narrow' | 'full'>`, each full reason with its
  why), `REQUEST_SYSTEM_ROUTE` (`area`, `login-self`: narrow),
  `systemRouteNow()`. `asSystem` runs its work under the reason's route,
  `systemWork` under 'full', `noteRequestSystem` records the exit's route
  in the request slot. The pick holds only while the actor the exit bound
  is the one bound.
- packages/db/src/gateway/narrow-route.ts (new; it sits below pools.ts, so
  role-runner.ts, which imports role-tx.ts and so pools.ts, would make an
  import cycle, pinned 0): `narrowStatement` (BEGIN, the one SET with
  `set_config('role', 'mantle_system_narrow', true)` and the actor, write
  mode and check mode, the statement, the hold check, COMMIT, pipelined on
  one reserved connection), `narrowBegin` (the SET with the first
  statement, the hold check before COMMIT), `narrowRouteClient`,
  `NarrowRoleLeftError`, `NarrowRouteRefusedError`; denials noted (miss row
  `narrow-denied`; in tests recorded, and vitest.setup.ts fails the test).
  `lazyQuery`, `sendIn`, `QueryMode` moved from role-tx.ts to actor-sql.ts
  (role-tx.ts re-exports them).
- gateway/pools.ts: the system pool's client is `narrowRouteClient` over
  the actor client; `getNarrowDb()`; the switch read once at pool open and
  logged in production with the pool's login line. gateway/handles.ts:
  `systemDb` inside a turn or request scope runs on the narrow route.
- packages/db/src/runtime-role.ts: `narrowSystemOn()` (feature
  `narrowSystem`, `MANTLE_NARROW_SYSTEM`, default on outside production),
  `setNarrowSystemForTests`. packages/config: the feature and env name;
  docker-compose.yml passes it; .env.example, docs/configuration.md.
- gateway/system-tx.ts: the system-pool write scope sets
  `mantle.write_mode` from the actor in every check mode (the archive
  path's read-only refusal, S2b LOW-3 / S2c L5). Cell:
  narrow-route.db.test.ts, the last case.
- access-matrix.ts: `NARROW_CREDENTIAL_TABLES` (every credential and
  rights table with its narrow value and why) and `CREDENTIAL_NAME`; nine
  rows narrowed: `contact_share_codes`, `private_workspaces`,
  `former_user_workspaces`, `space_item_homes` to 'read';
  `archive_mcp_login_tokens`, `archive_client_signin_codes`,
  `archive_client_signin_code_skips`, `archive_client_signin_sender_folders`,
  `archive_peer_roles` to 'none'. The others stay 'all', each with the
  narrow writer named (mostly the area routes: users, keys, connectors,
  assistants, settings; login-self for password, pairing, push, OAuth
  authorize). `spaces` and `auth.users` stay 'all': the users area adds a
  login (its space by trigger) and removes one (the FK cascades into
  content tables run as the owner: a3 counts them).
- Counters: arch-counts.mjs `gapRerunCount` treats the narrow role as the
  route's own role; `roleResetCount` (new pin `roleResets`, 0).
  heads-writers.mjs reviews narrow-route.ts for dynamic SQL.
- Tests: packages/db/src/narrow-route.db.test.ts (new, 7 cases, green on
  the workstation); runtime-role.test.ts (the credential list, the counts
  `{ all: 97, read: 36, none: 8 }`); runtime-role.db.test.ts pins schema
  USAGE (public, auth, pgboss; CREATE none) and pg-boss SELECT only;
  admin-counts.test.ts and as-system-exits.test.ts read the map from
  viewer.ts; actor-binders.mjs viewer.ts 9 to 7.
- Docs: docs/runtime-role.md "The narrow route".

### The routes, and the measurement (full DB suite, switch on)

Uses on the narrow route by actor (MANTLE_NARROW_DUMP, one run):
agent-workspace 7166, http:admin-area 740, admin-area 487, http:login-self
181, login-telegram 168, connector-binding 81, audit-log 6, connector-call
2, heartbeat-own-row 2, pending-approval 2; systemDb in scopes (login and
assistant actors) about 9000 with no denial.

Denials (each fails its test):

| Actor                  | Table                  | Tests                                                                   |
| ---------------------- | ---------------------- | ----------------------------------------------------------------------- |
| system:http:login-self | profiles (10)          | a2b2b-write-gateway, w7-int-fix2, w7-int-fix3                           |
| system:http:admin-area | profiles (9)           | mcp-oauth-grants, w7e-member-scope, ws-onboarding-attach                |
| system:http:admin-area | nodes (7)              | w6a-fix-sweep, w6b-fix3, w6b-fix4, w6b-fix5                             |
| system:admin-area      | profiles (7)           | execute-item, w7a-area-system-sweep, w7a-fix2, w7a-fix4, w7a-tool-sweep |
| system:admin-area      | nodes (4)              | w7a-fix2, w7a-tool-sweep                                                |
| system:http:admin-area | space_items (3)        | access-keys, device-tokens, session-epoch                               |
| assistant:none         | schema viewer_test (1) | viewer.db.test (a test's own schema via systemDb in a scope)            |

Failing without a denial (not yet read): a2a-round-trips (likely the
round trips the narrow route adds to systemDb in a scope),
w6b-member-writes, w7a-fix3, turn-create-home.

### Left for round 2

1. Each denial: profiles is a `content` table (the write role's
   own-login rule), so a hand 'all' throws (MED-1). Find the writers (the
   login's own preferences on login-self; the settings area and the
   systemWhole tools writing the brain's preferences; the area routes and
   tools that write nodes, likely the Secrets root and folder roots made on
   the system pool, and space_items on a session end) and either move the
   write into the caller's scope or a definer, or route the exit full with
   its why. Re-measure; never widen for a member, client, key, peer or
   link. If admin-area must go full, systemWholeOnFull goes back up: say so.
2. The four failures without a denial; viewer.db.test's own schema.
3. systemDbUses per file marked narrow or full (not done): today systemDb
   runs narrow inside any scope, full outside.
4. Gates: full DB vitest green, then test:actor-off, test:actor-on,
   test:edit-on, test:matrix, test:runtime-role (full), all with the switch
   on (the default in tests); CI green.
5. Rollback section: off by default in production, so the release is
   byte-equal there; N-1 has no route.

### Gates (round 1)

Mac, Node 26, DATABASE_URL unset, on 9f05ef055 unless said: pnpm -r
typecheck 0 and pnpm lint 0 (both on e5f892645), pnpm format:check
0, pnpm docs:check 0, pnpm arch:check 0, pnpm boot:smoke 0, pnpm -C
server/web build 0, vitest run server packages eslint-rules 0 (857 files
passed, 269 skipped). A first unit run on a1e9ca957 failed 6 tests (the
count tests still expected the seed, the binder pin, the docs table row,
and realtime.needs-you, whose mock of @mantle/config met runtime-role.ts
loaded by vitest.setup.ts: the collectors moved to actor.ts).

Workstation, own clone ~/s7a-a2-ws, own container s7a-a2-pg on
127.0.0.1:56372 (checked free, max_connections=450), init-scratch and
migrate with MANTLE_CHECK_FLOOR=keep, systemd-run --user, --maxWorkers=3:
narrow-route.db.test.ts + runtime-role.db.test.ts + runtime-role.test.ts
exit 1 then (after the cells unwrap drizzle's error) narrow-route green;
full DB vitest on 9f05ef055 exit 1 (23 files, 30 tests failed, 13841
passed): the table above. Not run yet: test:actor-off, test:actor-on,
test:edit-on, test:matrix, test:runtime-role.

### Round 2

Branch feat/s7a-a2 from round 1's eae808293; origin/main had not moved
(0d8f745a2), no rebase. No migration.

#### How each refusal was resolved

No hand grant: profiles, nodes and space_items stay narrow 'read' (content
tables, `narrowFor` throws on a wider hand value). Neither (a) nor (b)
fitted: the login-self and area exits run with no scope to carry to the
write role (entering one is session.ts work, S8c's), and no definer writes
these rows. So (c), at the grain of the writer, not the exit: the work runs
on the full route, keeping its actor, at a spot named in
`FULL_ROUTE_SPOTS` (packages/db/src/viewer.ts, `onFullSystemRoute`), each
with its why and a TODO naming S7b; the exits stay narrow, so
systemWholeOnFull stays 0 and requestSystemExits area and login-self stay
narrow. Outside a narrow exit (and with the switch off) a spot runs its work
as it is.

| Actor                  | Table       | Writer                                                      | Kind | Spot / file                                                    |
| ---------------------- | ----------- | ----------------------------------------------------------- | ---- | -------------------------------------------------------------- |
| system:http:login-self | profiles    | the login's own preferences (upsert, the default row)       | c    | profile-row: packages/content/src/profile-preferences.ts       |
| system:http:admin-area | profiles    | the settings area's brain row, onboarding, the box switch   | c    | profile-row: the same six writes (`profileWrite`)              |
| system:admin-area      | profiles    | a tool's preferences read making the default row            | c    | profile-row: `loadProfilePreferences`                          |
| system:http:admin-area | nodes       | a peer's item (create; delete found by reading)             | c    | peer-item: packages/content/src/peers/registry.ts              |
| system:admin-area      | nodes       | secret_create's Secrets root                                | c    | secrets-root: packages/tools/src/builtins-secrets.ts           |
| system:http:admin-area | nodes       | the integrity screen's landed delete (and its file delete)  | c    | integrity-delete: server/web/lib/integrity/landed.ts           |
| system:http:admin-area | space_items | a promotion's personal-space settle (SELECT ... FOR UPDATE) | c    | promotion-space: server/web/lib/login-update.ts (that tx only) |
| assistant:none         | viewer_test | the test's own schema through systemDb in a scope           | test | viewer.db.test.ts grants its schema to the narrow role         |

The refused statements were found by noting the statement's text with each
denial in tests (narrow-route.ts `refusedQueryOf`).

#### The four failures without a refusal

- w6b-member-writes, w7a-fix3, turn-create-home: the afterAll hook timed out
  in closeDb. A narrow statement still in flight (fire and forget) held its
  reserved connection when the pool's end began, and postgres.js never
  finishes ending a pool whose connection comes back after that. Fixed: the
  narrow route's statements and transactions are tracked in the set closeDb
  waits on (actor-sql.ts `trackPipeline`, as the actor client's pipelines).
  Flag off the same file passed, flag on it hung: narrow-induced, a route
  fix, not a test change.
- a2a-round-trips: the route tagged its BEGIN, SET, hold check and COMMIT
  with the actor's tag, so with the check off the test saw the actor sent.
  The route's statements now carry their own tag `/* mantle:narrow */`
  (check-mode.ts `NARROW_SQL_TAG`), and the test counts them as the path's
  in every mode (they are sent the same in off, warn and on). Answers are
  equal; the test's rule for the actor is unchanged. The route's cost, check
  off, switch off to on: page save 15/20 to 19/22 (statements/round trips),
  member page save 19/26 to 23/28, chat turn start 104/144 to 148/166; tree
  load, item open, search, MCP tool call unchanged.
- Found on the way: w7a-area-system-sweep left two unhandled CONNECTION_CLOSED
  rejections with the switch on (round 1 had them too). Its trap throws while
  the narrow pipeline is built, after BEGIN went out: the sent statements
  were never awaited and the connection went back with an open transaction.
  narrowStatement now settles what it sent and ends that connection
  (lease.end) instead of handing it back.

#### Routes, final

AS_SYSTEM_ROUTE is unchanged from round 1: narrow `admin-area`,
`agent-workspace`, `connector-binding`, `connector-call`,
`heartbeat-own-row`, `login-telegram`, `audit-log`, `pending-approval`; full
`app-data`, `rule-in-query`, `keyword-candidates`, `app-trash`,
`page-refold`, `brain-bookkeeping`, and `login-notice`, `snapshot-copies`,
`space-taken-authors`, `test` (system work or no caller). Request exits:
`area` narrow, `login-self` narrow. Full-route spots: five (above).

systemDb files (eslint-rules/system-db-allowlist.mjs `SYSTEM_DB_ROUTE`): full
`extract-parked.ts` (push worker), `extract-skip-backfill.ts` (maintenance
script), `llm-guard.ts` (extract worker); every other of the 20 files narrow
(reached in a turn or request scope). A file with uses and no mark fails
arch:check.

#### Pins

systemWholeOnFull 0 (unchanged), asSystemNarrow 21, asSystemFull 34
(unchanged). New: systemDbUses_narrow 66, systemDbUses_full 4 (systemDbUses
70), requestSystemExits_narrow 3, fullRouteSpots 5, fullRouteSpotCalls 7
(both down only).

#### Changed answers

Switch off: none expected (a spot reads the route only while it is on; the
tag, the tracking and the build-time end are on the narrow route only); the
full DB suite with MANTLE_NARROW_SYSTEM=0 below. Switch on: none against main
in the suites (every refusal resolved at a spot); the statements differ by
the route's own (above).

#### Open items

- a3: the actor check trigger counts a content write by system:<narrow
  reason>; the five spots write content as such actors on the full route, so
  the count should read `current_user = 'mantle_system_narrow'` (or the spots
  will report on every peer create).
- Area routes no suite drives may still write content on the narrow route
  (plan 2.1 risk 6): a 500 for an Admin user in dev with the switch on. Read,
  not measured: POST /api/secrets (createSecret in server/web/lib/secrets.ts
  makes the Secrets root and a secret item), /api/email and /api/attachments
  (mail items), /api/calendar, /api/docs/collections. a3's telemetry and the
  area-route rows in the guard sweeps are the plan's limits; S7b decides.
- The route's cost in round trips (above) before S7b turns it on by default.

#### Rollback (part a2)

- Switch: `MANTLE_NARROW_SYSTEM` is off by default in production, so a box
  that rolls this release runs every statement as before: byte-equal answers
  and the same statements (the full DB suite with MANTLE_NARROW_SYSTEM=0 is
  the proof). Turning it off on a box where it was set on: unset it (or set
  `0`) and restart; read once when the system pool opens.
- Image N-1: the narrow route's code is gone (narrow-route.ts, the route
  maps, the spots, the counters); the role `mantle_system_narrow` stays,
  made and granted at migrate by part a1 (ensureRuntimeRoles) and unused.
  No migration in a2, so nothing to revert in SQL. An N-1 restore of an N
  dump needs the role first (part a1's note: `CREATE ROLE
mantle_system_narrow NOLOGIN`).
- Miss rows with check `narrow-denied` written on a box with the switch on
  stay in actor_check_misses; N-1 ignores the check name.

#### Gates (round 2)

Mac, Node 26, DATABASE_URL unset, on d0fac18d9: pnpm -r typecheck 0, pnpm
lint 0, pnpm format:check 0, pnpm docs:check 0, pnpm arch:check 0, pnpm
boot:smoke 0 (14 services), pnpm -C server/web build 0, vitest run server
packages eslint-rules 0 (857 files passed, 269 skipped). A first unit run
on 7d13319b7 failed two mocks of @mantle/db that lacked onFullSystemRoute,
and format:check one file: fixed in d0fac18d9.

Workstation, own clone ~/s7a-a2-ws/repo reset to d0fac18d9, own container
s7a-a2-pg (pgvector pg18, 127.0.0.1:56372 checked free, max_connections=450,
role postgres as CI), init-scratch and migrate with MANTLE_CHECK_FLOOR=keep,
systemd-run --user, --maxWorkers=3, one at a time, switch on (the tests'
default) unless said: full DB vitest 0 (1126 files, 13872 passed, 1
skipped, no unhandled error, no narrow denial), test:actor-off 0 (1186
passed), test:actor-on 0 (361), test:edit-on 0 (531), test:matrix 0 (8),
test:runtime-role in full 0 (277 files, 2776 passed); full DB vitest with
MANTLE_NARROW_SYSTEM=0 exit 1: one cell, narrow-route.db.test.ts "is on by
default", asserted the default while the run set the switch off (13871
passed, nothing else changed: the switch-off proof). That cell now asserts
the default only when the run leaves the switch unset (6fceb43fe), and the
file passes with the switch off and on (8 and 8).

Earlier in the round: the 23 failing files alone after each fix (30, 9, 0
failures), a2a-round-trips with MANTLE_RT_REPORT switch on and off, the
sweep file switch on and off (the unhandled rejections on only).

CI: run 39359479088 on d0fac18d9 green.

### Fix round 1

Branch feat/s7a-a2 rebased onto main 2f5a75ad5 (v0.300.111: S8c c1, S10
round 1). Conflicts only in scripts/arch-scoreboard.pins.json (resolved key
by key; rawSqlNonLiteral 74 on main, raised here, see Pins); S10's converted
raw writes in packages/content, files, runs, embeddings merged without a
conflict and kept. No migration.

#### HIGH-1: the Admin area routes that wrote content on the narrow route

Each now reaches its content write at a named full-route spot (viewer.ts
`FULL_ROUTE_SPOTS`, its why and the S7b TODO on the list); no content table
was granted to the narrow role. Each is a row of
server/web/server/narrow-area-routes.db.test.ts (new), driven through the
real app (createApp, a signed session cookie) with the switch on: a row
fails on a recorded narrow denial (vitest.setup.ts), a 500, a database
error's text in the answer, or when the write it exists for did not happen.
All nine rows fail on the round 2 sources (the same test file, the route
files checked out at fa145826c: 9 of 9 failed) and pass now.

| Route                                                | Fix kind                | File                                                    | Sweep row         |
| ---------------------------------------------------- | ----------------------- | ------------------------------------------------------- | ----------------- |
| POST /api/secrets, PATCH and DELETE /api/secrets/:id | spot secret-item        | server/web/lib/secrets.ts (secretWrite)                 | secrets           |
| POST /api/backups, POST /api/backups/run             | spot profile-row        | packages/content/src/backup.ts (profileWrite, exported) | backups           |
| POST /api/embedding/rebuild, /api/ai-workers/reembed | spot reembed            | packages/embeddings/src/reembed.ts (runReembed)         | embedding rebuild |
| POST, PATCH /api/docs/collections, POST .../all      | spot docs-collection    | packages/files/src/docs.ts (reconcile, purge)           | docs collections  |
| POST /api/email/discover/contacts                    | spot sender-contact     | packages/email/src/discover.ts                          | email discover    |
| DELETE /api/calendar/:id                             | spot calendar-events    | packages/calendar/src/manage.ts                         | calendar          |
| DELETE /api/agents/:id?conversation=delete           | spot agent-conversation | server/web/lib/agents.ts (deleteAgent, delete only)     | assistants        |
| POST /api/dev-tools/execute-tool                     | spot console-tool       | the execute-tool route                                  | API console       |
| PATCH /api/pending/:id approve (no login, no origin) | spot pending-call       | packages/tools/src/pending.ts (asActor)                 | pending           |

The two "likely" routes were proven: the API console and the pending
approval both failed with the switch on before the fix (a builtin note
create, as system:http:admin-area).

Raw database text in answers, a separate bug that main has too (the
error sweep's recorded answers on main hold `Failed query: ...` for the
docs collections): the three docs collections routes, the email discover
contact (`addContactFromSender`) and the reembed answer (`reembedIndex`)
now answer `publicErrorMessage`. The error sweep names the docs change
`ok-false-public` (6 cells, a10-error-sweep-changes.txt).

LOW-5: `FULL_ROUTE_SPOT_FILES` (eslint-rules/as-system-routes.mjs) lists
each file outside packages/db that may name `onFullSystemRoute` and the
spots it may run. An unlisted file, an aliased import, any other binding of
the function, a non-literal spot, an unlisted spot, and a listed spot the
file does not hold fail arch:check (as-system-exits.test.ts has the cases).

#### MED-1: denials inside a narrow transaction

`narrowBegin` (gateway/narrow-route.ts) wraps the transaction's client
(`narrowTxClient`): each `unsafe` statement and each savepoint has its error
seen and a denial noted where it is met (once per error through its
wrappers). The hold check's failure throws NarrowRoleLeftError only when it
is its own refusal (22012); otherwise the caller gets the first statement
error of the transaction (the real 42501 when the work caught it without a
savepoint). `narrowStatement` reads the code too. Cells
(narrow-route.db.test.ts): "notes a denial a savepoint caught, and gives
the real error when the work caught it". Limit: a tagged-template
statement's result stays postgres.js's own (it may be a fragment), so its
denial is seen only when it ends the transaction.

#### MED-2: what a narrow transaction may send

`narrowSendable` runs on every statement of a narrow transaction (the
`unsafe` calls, tagged templates, a savepoint's handle) as well as on single
statements, and refuses: transaction control, a role change in any form
(SET [SESSION|LOCAL] ROLE, RESET ROLE, RESET ALL, SET SESSION
AUTHORIZATION, set_config('role' | 'session_authorization', ...)), and a
session-level setting (SET without LOCAL, RESET, set_config(..., false)).
LOW-2: the text is read with literals, quoted identifiers, dollar-quoted
bodies and comments blanked (`sqlCode`). Cells: "refuses a role change, a
session setting and transaction control, by text, alone and in a
transaction" covers P1 (role-changing multi-statement text), P2 (in a
transaction, and in a savepoint), P6 (a session SET refused, nothing leaks
to the pool's next statement), P11 (a refused COMMIT never ends the
transaction: what follows runs as the narrow role), and literals not read
as statements. P3 (a plpgsql function that changes the role) cannot be
refused by text: a known limit for S7b. The hold check rolls such a
transaction back (cell: `public.narrow_probe_leave()`, NarrowRoleLeftError,
the probe row gone); the narrow role creates no function (no CREATE on any
schema) and runs only the functions it is granted (MED-4). A function that
leaves the role and takes it back before returning would pass the hold
check: none exists today (the role counters, below, read 0 in the
migrations), and a new one is a counted line.

Counters: `roleResets` and `gapTables` now read the migrations' SQL too
(arch-counts.mjs `migrationSqlTexts`): both 0 there.

#### MED-3: the full-route spot marks itself (a2 part), and the a3 predicate

`onFullSystemRoute` runs its work under `runOnFullRouteSpot` (actor.ts); the
actor's SET then carries `set_config('mantle.route', 'full', ...)`
(`setActorSql`'s fourth value, `fullRouteSpotNow`), and a session-level
pipelined write resets it with the actor. The mark holds only while the
spot's actor is the one bound.

Recommendation for a3's trigger (report only): count a write to a content
table as `narrow-content-write` when the actor is `system:<reason>` with
the reason routed narrow (AS_SYSTEM_ROUTE or a request exit's
REQUEST_SYSTEM_ROUTE), AND `current_user = session_user` (the full route:
on the narrow route the write was refused, in a definer current_user is the
owner), AND `coalesce(current_setting('mantle.route', true), '') <> 'full'`
(not a declared spot). Count FK cascades apart, by a trigger on deletes of
auth.users, spaces and agents by narrow-reason actors (the cascaded rows
run as the table owner). Cells to write in a3, with the runtime role on: a
narrow write at a spot is not counted; the same write outside a spot with
the switch off is; a definer's write is not; a delete of a login by
system:http:admin-area counts its cascade once.

#### MED-4: the narrow role's EXECUTE

`NARROW_DENIED_FUNCTIONS` (runtime-role.ts) 6 to 11: the content-writing
definers mantle_grant_change, mantle_grant_move_home,
mantle_subtree_rewrite, mantle_recall_retarget and mantle_app_trash_act.
The measurement: the narrow route counts, in tests, each `mantle_*`
function its statements call by name (`fn:<name>` uses in
MANTLE_NARROW_DUMP); the switch-on full run of this round writes them to
full1.narrow.jsonl. Measured (the switch-on full DB suite on efe332bde,
no denial): narrow statements call by name only `mantle_brain_id` (21
calls) and `mantle_ws_set_moderator` (1). Left (in the open items below):
trim the rest of the granted functions to that set plus the functions the
narrow-writable tables' column defaults and checks call (a default runs
with the inserting role's rights, so it needs EXECUTE; read them from
pg_attrdef and pg_constraint first), then pin the list as an allowlist.

#### LOW items

- LOW-1: covered by MED-2.
- LOW-3: compose unchanged; the switch goes on on the dev box by hand
  after the merge.
- LOW-4: the SYSTEM_DB_ROUTE marks are declarations only (the scope
  decides the route at run time): said in the rule
  (system-db-allowlist.mjs) and docs/runtime-role.md.

#### Changed answers

Switch off:

- gateway/system-tx.ts writeScopeSettings (round 1 of a2): one more
  `set_config('mantle.write_mode', ...)` in the SET of every systemPoolTx
  (no new statement, no round trip). A read-only actor on a box with the
  actor check off is now refused by mantle_ws_archive's read-only check,
  where main let it through (the check never knew the mode on that path).
- At a full-route spot inside a narrow exit the actor's SET carries
  `mantle.route` (only when the check is on, so a SET is sent anyway):
  the same statements, the same answers.
- The docs collections, email discover contact and reembed answers: a
  database error's text is gone (the public message instead); all else
  equal.

Switch on: none against main in the suites; the nine routes above answer as
main does (before this round they answered 500 or `{ ok: false }` with the
database's text).

The viewer.ts onFullSystemRoute comment said the route is read only while
the switch is on; corrected: systemRouteNow reads the exit's pick whatever
the switch, and the pool (pools.ts) sends nothing on the narrow route while
it is off.

#### Round trips, for the default-on release

The narrow route adds a BEGIN, the SET, the hold check and a COMMIT to a
single systemDb statement in a scope (chat turn start 104/144 to 148/166
statements/round trips, round 2). The audit's recommendation for S7b:
measure a dedicated narrow pool whose connections take the role at
connection time (no per-statement BEGIN/SET/COMMIT; the hold check per
transaction stays), or keep the turn-stream and tracing writes on the full
route (named, with their why). Decide on the numbers with the switch on.

#### Pins (fix round 1)

fullRouteSpots 5 to 13, fullRouteSpotCalls 7 to 15 (both new in a2, down
only from here), rawSqlNonLiteral 74 (main) to 78, rawWriteSqlFiles 43 to
44 (narrow-route.ts, may grow), routeErrorTextAllowed 31 to 28,
std_errorIdiom_allowed 116 to 115. Unchanged: systemWholeOnFull 0,
asSystemNarrow 21, asSystemFull 34, requestSystemExits_narrow 3, roleResets
0, gapTables 0.

#### Gates (fix round 1)

Mac, Node 26, DATABASE_URL unset, on 0660bf5ee (the handover commit after the
code): pnpm -r typecheck 0, pnpm lint 0, pnpm format:check 0, pnpm
docs:check 0, pnpm arch:check 1 then 0 (the handover's round-trip heading
named a step code; renamed), pnpm boot:smoke 0, pnpm -C server/web build 0,
vitest run server packages eslint-rules 1 then 0 (the same heading check in
eslint-rules; 857 files passed, 272 skipped, the one failure fixed and
eslint-rules rerun: 0).

Workstation, own clone ~/s7a-a2-r3/repo, own container s7a-a2r3-pg
(pgvector pg18, 127.0.0.1:56373 checked free, max_connections=450, role
postgres as CI), init-scratch and migrate with MANTLE_CHECK_FLOOR=keep,
systemd-run --user, --maxWorkers=3, one at a time, switch on unless said:
narrow-route.db.test.ts + narrow-area-routes.db.test.ts 1 (3 cells: the
denial noted twice through drizzle's wrapper, two sweep rows' setup) then 0
(19 passed); the sweep on the round 2 sources 1 (9 of 9 rows failed: the
proof); then on efe332bde: full DB vitest with MANTLE_NARROW_DUMP 0 (1130
files, 13907 passed, 1 skipped, no narrow denial), test:actor-off 0 (1191
passed), test:actor-on 0 (371), test:edit-on 0 (541), test:matrix 0 (8),
test:runtime-role in full 1 (2796 passed, 1 failed, 2 files: scope.db.test
`ensureConcurrentIndexes` "tuple concurrently updated", and
client-sourced-gate.db.test's setup, an item_grants workspace FK
violation; neither a permission error), the two files rerun once under the
same config 0 (14 passed): known flakes, both runs reported; full DB vitest
with MANTLE_NARROW_SYSTEM=0 0 (1130 files, 13907 passed, 1 skipped: the
switch-off proof, the nine sweep rows pass on the full route).

#### Open items, in item order

1. HIGH-1: done. Other area routes no suite drives may still write content
   on the narrow route (plan 2.1 risk 6); a3's telemetry and a new sweep row
   per such route are the limit.
2. MED-1: done (a tagged template's denial caught without a savepoint is
   seen only as the transaction's error).
3. MED-2: done; P3 (a function that leaves the role and takes it back) is
   the named known limit for S7b.
4. MED-3: the a2 part done; the trigger predicate is a3's.
5. MED-4: five content writers denied (11 entries); left: the trim to the
   measured set (mantle_brain_id, mantle_ws_set_moderator, plus the
   functions of the narrow-writable tables' defaults and checks) and the
   pin as an allowlist.
6. LOWs: done (LOW-3 by hand on the dev box after the merge).
7. Round trips: written above; the decision is S7b's.
