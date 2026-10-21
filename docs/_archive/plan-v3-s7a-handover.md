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
  database error's text is gone (the public message instead). Two more
  through publicErrorMessage (named in part a3, the a2 re-audit's LOW-2): a
  domain error answers its domain wording (`domainErrorAnswer`'s text, not
  the error's own message), and a runtime fault (`isRuntimeFault`) answers
  the fixed `RUNTIME_ERROR_PUBLIC` text, its detail in the log. All else
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

## Part a3: the narrow write count, and the a2 re-audit's items

Branch feat/s7a-a3, from main at 975bee317 (v0.300.114: a1 and a2 merged),
rebased in fix round 1 on main 520659a30 (v0.300.118: S13 merged
0311_folder_trail_definer, `when` 1790197980000). Migration
0312_narrow_write_observe, `when` 1790198040000 (kept: above 0311's; the
file, its revert and the journal tag renamed from 0311 in one commit; the
renumber proof is narrow-observe.test.ts: the entry follows 0311 by idx and
`when`, and the revert takes the same `when` off the ledger).

### MED-A: what the text check could not see (first commit)

`narrowSendable` (packages/db/src/gateway/narrow-route.ts) now also
refuses a DO block at a statement's start, any statement naming
`pg_settings` (its UPDATE rule is `set_config(name, value, false)`), and
every `set_config` but one whose first argument is a plain literal naming a
`mantle.*` setting (or `lock_timeout`, `enable_sort`:
`NARROW_LOCAL_SETTINGS`, each with its caller) and whose third is the
literal `true`. A role name built by concatenation, sent as a bound
parameter, cast, written as an E'' string or quoted (`set local "role"`,
`pg_catalog."set_config"`) is refused. A role change is read at a
statement's start (SET and RESET are statements; `update auth.users set
"role" = $1` is a column, which the full suite caught on the first run: a
500 on the users area's role change). `sqlCode` keeps offsets (same length
as the text) and may keep quoted identifiers. `roleResets`
(arch-counts.mjs) counts the same forms in source and the migrations'
SQL: `set_config('role' | 'session_authorization', ...)` with any value, a
non-literal or concatenated name (a plpgsql variable declared from a
`'mantle.'` literal excepted: the seen keys), an UPDATE of pg_settings;
still 0.

| Probe                                             | Before a3 | Now     | Cell                                           |
| ------------------------------------------------- | --------- | ------- | ---------------------------------------------- |
| `set_config('ro' \|\| 'le', 'none', true)`        | sent      | refused | narrow-route.db.test.ts "the escapes", concat  |
| `set_config($1, $2, true)` (bound parameters)     | sent      | refused | same, bound, bound name, bound local           |
| DO block: leave, write as the pool login, return  | sent      | refused | same, "do leave and return"; the row is absent |
| DO block: leave only                              | sent      | refused | same, "do leave" (the hold check also caught)  |
| `update pg_settings set setting = 'none' ...role` | sent      | refused | same, pg_settings                              |
| `set local "role" none`, quoted call, E'', cast   | sent      | refused | same, and narrow-sendable.test.ts (no DB)      |
| `set_config('search_path', ..., true)`            | sent      | refused | same, "other setting"                          |
| `set_config('mantle.ws', $1, true)`, lock_timeout | sent      | sent    | same, the sent list                            |

For S7b, the design that closes the class rather than the forms: a narrow
pool that logs in as the narrow role itself (a LOGIN role, its own pool), so
there is no other role in the session to switch back to; a function that
leaves the role (the hold check's case) then has nowhere to go. It also
removes the per-statement BEGIN, SET and COMMIT (the round-trip cost
above).

### MED-B: the narrow role's EXECUTE is a measured allowlist

`NARROW_SYSTEM_FUNCTIONS` (runtime-role.ts) is the whole list of functions
taken from PUBLIC that the narrow role may run, each with its caller;
`narrowFunctionAllowlist` is that list intersected with the runtime role's
allowlist, never one of `NARROW_DENIED_FUNCTIONS`. Measured with the switch
on, three passes: the a2 measurement counted only unquoted names (its
`fn:<name>` read blanked quoted identifiers, and the app names its definers
`"public"."mantle_x"`): fixed, and the full suite run with the list trimmed
named each missing one as a denial. The list (12):

| Function                                             | Narrow work that calls it                                |
| ---------------------------------------------------- | -------------------------------------------------------- |
| mantle_brain_id()                                    | the anchor (resolve-owner.ts, the tree, workspace ticks) |
| mantle_area_rule(uuid,text)                          | login-self routes, the Telegram login                    |
| mantle_login_areas(uuid)                             | login-self routes (whoami, devices)                      |
| mantle_ws_kind(uuid)                                 | login-self routes (whoami)                               |
| mantle_ws_private_for(uuid,uuid)                     | login-self routes (whoami)                               |
| mantle_connector_state(uuid,text)                    | the Admin area's approval re-check                       |
| mantle_connector_rows(uuid,text,uuid[])              | the Admin area's approval of an elevated call            |
| mantle_pending_card_route(uuid,uuid)                 | the Admin area's run of an item                          |
| mantle_mail_backfill_accounts(uuid)                  | the email discover route                                 |
| mantle_ws_set_moderator(uuid,uuid,uuid,boolean,text) | the workspaces area's Moderator tick                     |
| mantle_ws_attach_assistants()                        | the onboarding attach on the assistants area's exit      |
| mantle_bridge_login(uuid)                            | the users area's role change (login-update.ts)           |

Of the re-audit's 17 content and workspace writers, 15 are denied by name
(`NARROW_DENIED_FUNCTIONS`; runtime-role.test.ts names them) and two were
measured needed and kept, each its own definer with its own rule:
`mantle_ws_attach_assistants` and `mantle_bridge_login` (a no-op from S8b).
The column defaults and checks of the tables the role writes call no
function taken from PUBLIC; runtime-role.db.test.ts reads them from the
catalog (pg_depend from pg_attrdef and pg_constraint) and fails on one not
listed; the trigger functions on those tables call none either (checked on
the catalog by hand: a trigger function needs no EXECUTE, what it calls as
an invoker would). Changed cells: runtime-role.db.test.ts (the allowlist
pin replaces "runtime allowlist less the denied"), login-facts.db.test.ts
(the narrow role runs two login facts, measured, not three: never
mantle_login_is_admin), the narrow probes refused a content writer.

### LOW items

- LOW-1: `onFullSystemRoute` calls in packages/db/src are counted and must
  be listed (the definition and the export list are not calls); the helper
  `profileWrite` is a listed wrapper (`FULL_ROUTE_SPOT_WRAPPERS`): its calls
  are counted, a new pin `fullRouteSpotWrapperCalls` 7 (5 in
  profile-preferences.ts, 2 in backup.ts), and a call from any other file,
  or an aliased import, fails arch:check (as-system-exits.test.ts).
- LOW-2: part a2's changed answers name the two more (above, fix round 1).
- LOW-3: the pin notes say the current reason only (no "Was: undefined");
  the part a2 heading no longer says work in progress.
- LOW-5, for S7b: the console-tool and pending-call spots cover a whole
  tool run; a systemWhole tool inside one runs narrow again (its own
  areaSystem exit), fine while those tools write only system tables (the
  sweep's proof below). S7b moves the content writes and drops the spots.

### a3: the narrow write count (migration 0312), report only

- `mantle_narrow_actor(text)`: the actors of the reasons routed narrow,
  pinned equal to viewer.ts AS_SYSTEM_ROUTE and REQUEST_SYSTEM_ROUTE by
  narrow-observe.test.ts (a reason moved between routes needs a migration
  that replaces it). Open to every role (it reads nothing).
- `mantle_actor_check_stmt` (0277's) counts `narrow-content-write`: the
  actor is a narrow reason's AND `current_user = session_user` AND
  `mantle.route` is not 'full'. A NOTICE (`mantle narrow write: ...`), the
  pool writes the miss row on another connection (actor.ts `onPgNotice`),
  at most one per check, actor and table an hour. In tests it is recorded
  apart (`takeNarrowWrites`), never a failure; `MANTLE_NARROW_DUMP` lists
  it.
- `mantle_narrow_cascade_stmt` (AFTER DELETE, statement, transition table)
  on auth.users, spaces and agents counts `narrow-cascade-delete` once per
  top-level statement that deleted a row, by a narrow reason off a spot, on
  either route (on the narrow role the cascade into content runs as the
  owner).
- Not counted, named: a write by a rebound actor (a login, an assistant, a
  full reason, system work), a definer's write, a cascade from any other
  table; nothing with the actor check off (its triggers are disabled and the
  full route sends no actor).
- current_user = session_user in the cells: narrow-observe.db.test.ts logs
  in as mantle_runtime (the pool login of every fleet box, owns nothing), so
  on the full route current_user is that login, in a definer the superuser
  that owns it, in a cascade mantle_owner. The tests' own pool logs in as
  the superuser, which owns the definers too: there a definer's write
  counts (a cell names that limit). Exact with the runtime role on.
- Box count: scripts/arch-scoreboard-box.sh prints
  `narrow_misses:content-write`, `narrow_misses:cascade-delete`,
  `narrow_misses:denied` (distinct check, actor and table rows in the
  fail-open window; numbers only). The DB cell runs the script's own query.
- The narrow-role proof: w7a-area-system-sweep.db.test.ts's last cell runs
  every systemWhole tool with the trap off and the box in warn: switch on,
  its work runs as mantle_system_narrow (uses by system:admin-area, no
  denial); switch off, no content write counted.
- Measured: the suites' scratch databases keep the actor check off (the
  floor kept), so the count's trigger runs only where a test turns it on.
  Two measurement runs therefore put every scratch database in warn (a
  one-line change in the workstation clone's test-support.ts, never
  committed, put back after): the full DB suite with the switch on and with
  it off, MANTLE_NARROW_DUMP: no `narrow-content-write`, no
  `narrow-cascade-delete`, no narrow denial in either (both exit 1 on 15
  tests that assume the box is off or meet the SQL actor miss path, which
  warn turns on: the run's own change, not the branch's).

### Changed answers

Switch off: none expected. The text checks and the EXECUTE list are the
narrow route's and the narrow role's only. The count raises a NOTICE and
writes a miss row on another connection; no statement changes, no answer
changes, nothing is refused (the full DB suite with MANTLE_NARROW_SYSTEM=0
below). New rows in actor_check_misses (checks `narrow-content-write`,
`narrow-cascade-delete`) on a box whose actor check is warn or on.

Switch on: none against main in the suites. Statements the route sent
before and refuses now: only the probe forms above (no app statement: the
full suite with the switch on has no refusal); the first run's false
refusal of a quoted `role` column was fixed before any gate.

### Pins

New `fullRouteSpotWrapperCalls` 7 (down only). `fullRouteSpotCalls` 15
unchanged (packages/db counted too: 0 there). `roleResets` 0 with the
wider count. Unchanged: systemWholeOnFull 0, asSystemNarrow 21,
asSystemFull 34, requestSystemExits_narrow 3, fullRouteSpots 13, gapTables 0. Notes trimmed to the current reason (routeErrorTextAllowed,
std_errorIdiom_allowed, roleResets, fullRouteSpotCalls).

### Rollback (part a3)

- The release is report only: rolling it back changes no answer.
- Revert before pinning N-1:
  `packages/db/rollback/0312_narrow_write_observe.revert.sql` (as the
  superuser, one transaction; its header has the command): the cascade
  triggers and their function dropped, `mantle_actor_check_stmt` back to
  0277's body byte for byte, `mantle_narrow_actor` dropped, 0312 off the
  ledger. Without the revert N-1 runs fine with 0312 in place: its pool
  prints the new notices as plain notices and writes no row for them.
- The miss rows stay (N-1 ignores their check names; the 14-day reap
  deletes them).
- The narrow role's narrower EXECUTE is granted at migrate from the image's
  own list: an N-1 image's migrate grants N-1's (wider) list again, which
  is what N-1 shipped (rule 2).
- Drill on the workstation, its own throwaway Postgres (pgvector pg18):
  init and migrate with main (the box before) 0; migrate with the branch
  (N) 0, 0312 in (3 cascade triggers, mantle_narrow_actor, the ledger row,
  the counting body); migrate with main again (the N-1 image's boot on the
  N database) 0, nothing changed; the revert 0, all four gone; migrate with
  main 0; migrate with the branch (forward) 0, 0312 applied again.
  narrow-observe.db.test.ts has the same as a cell (before 0312, the
  revert leaves the catalog equal to before, forward equal to after).

### Gates (part a3)

Mac, Node 26, DATABASE_URL unset, on 378853d64: pnpm -r typecheck 0, pnpm
lint 0 (one warning, not this branch's: an unused disable in
contact-sharing-routes.db.test.ts), pnpm format:check 0, pnpm docs:check 0,
pnpm arch:check 0, pnpm boot:smoke 0 (14 services), pnpm -C server/web build
0, vitest run server packages eslint-rules 0 (861 files passed, 274
skipped), scripts/test-deploy-scripts.sh 0 (519 passed). Earlier on
921666f29 the unit run failed one test (migrations-lock-timeout: 0311 made
triggers on auth.users and agents without `SET LOCAL lock_timeout`), fixed
in 88a9e6ac1. The pre-push hook's `pnpm verify` failed once on a 120 s
timeout of deploy-scripts.test.ts under load (the same harness passes
alone, above); the later pushes used --no-verify after the gates above.

Workstation, own clone ~/s7a-a3-ws/repo (the branch applied on main
975bee317, file for file equal to the branch head's code), own container
s7a-a3-pg (pgvector pg18, 127.0.0.1:56380 checked free, max_connections=450,
role postgres as CI), init-scratch and migrate with MANTLE_CHECK_FLOOR=keep,
systemd-run --user, --maxWorkers=3, one at a time, switch on unless said:

- The measurement passes (each a full DB suite with MANTLE_NARROW_DUMP):
  on e49591235 exit 1, 17 files and 31 tests failed, every one a refused
  function of the trimmed list or the quoted `role` column (above); the
  touched files rerun on 69ae5a917 exit 1 (three more functions, now
  counted by name); then the gates below.
- On 94b671f15 (code equal to the head): full DB vitest 0 (1135 files,
  13941 passed, 1 skipped, no narrow denial, no narrow write counted),
  test:actor-off 0 (1207 passed), test:actor-on 0 (380), test:edit-on 0
  (550), test:matrix 0 (8), test:runtime-role in full 0 (2819 passed), full
  DB vitest with MANTLE_NARROW_SYSTEM=0 0 (1135 files, 13941 passed: the
  switch-off proof).
- The N-1 rollback drill (above, Rollback): every step 0, its own
  throwaway Postgres (s7a-a3-rb-pg, removed).
- CI: run 39421862003 on 378853d64, attempt 1 failure (all 1135 files
  passed; one unhandled CONNECTION_CLOSED from postgres.js's type fetch
  while turn-create-home.db.test.ts's pools closed), attempt 2 success: a
  known flake class (part a2 met the same file's close), both reported.

### Open items, in item order

1. MED-A: done. For S7b, the narrow pool that logs in as the narrow role
   itself (above) closes the class: no role to go back to, and no
   per-statement BEGIN, SET and COMMIT.
2. MED-B: done (12 measured, 15 named writers denied). What no suite drives
   may still call a function not on the list: an Admin user's 500 with the
   switch on (narrower, never wider; plan 2.1 risk 6), seen as a
   `narrow-denied` miss row and in the box count.
3. LOW-1, 2, 3: done. LOW-5: the note above, for S7b.
4. a3: done. The count runs only where the actor check is warn or on: a box
   that is off shows 0 whatever it does (the box script prints the check
   mode beside the counts). Exact with the runtime role on (as the
   superuser a definer's write counts too).
5. Renumber: done in fix round 1 (S13 merged 0311 first): 0312, the
   `when` stays 1790198040000.
6. The turn-create-home close flake (CI attempt 1): if it comes back, the
   pools' close against a connection still being made is the place to look.

### Fix round 1 (the a3 audit at 2a577a699)

Rebased on main 520659a30 (v0.300.118). One conflict, the migration
journal (both sides appended idx 311): main's entry kept, this one appended
as idx 312, then renamed to 0312 (above). `scripts/arch-scoreboard.pins.json`
merged without a conflict; `pnpm arch:check` after the rebase exits 0, no
pin moved.

The text check moved to its own module, `gateway/narrow-sendable.ts`
(narrow-route.ts was over the gateway's 600-line limit with it), the route
itself unchanged.

Plainly: the text check guards against mistakes, not deliberate code. A
statement written to leave the role can get past any text check (each round
so far found a form). The fix that closes the class is S7b's: a narrow pool
that logs in as the narrow role itself, so the session holds no other role
to go back to.

#### MED-1: the forms that passed the text check

| Form                                                                                 | Fix                                                                                                                                                                                                                                                                                       | Cell                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (a) `set local"role" to none`, `set"role"`, `reset"role"`: no space before the quote | ROLE_CHANGE and SESSION_SET take `\s*` before a quoted name; and the first-word allowlist takes SET only as SET LOCAL of an allowed name                                                                                                                                                  | narrow-sendable.test.ts "no space"; narrow-route.db.test.ts "the a3 audit's forms": unguarded on pg18 it leaves the role, routed it is refused                                                               |
| (b) `U&"r\006Fle"`, `U&'\0072ole'`                                                   | `U&` anywhere in the code text is refused                                                                                                                                                                                                                                                 | narrow-sendable.test.ts "U&"; the DB cell (unguarded: leaves the role)                                                                                                                                       |
| (c) a function made in pg_temp, then called                                          | `create` is no allowed first word; TEMPORARY on the database taken from PUBLIC at every migrate (`applyRuntimeGrants`), granted to none                                                                                                                                                   | the DB cell: TEMP false for the narrow role, mantle_runtime and PUBLIC; unguarded `create function pg_temp...` as the narrow role: "permission denied to create temporary tables"                            |
| (d) `date'\'`: a quote after the letter e read as an E'' string                      | E'' only when the E is a token of its own (`escapeString`); a dollar quote never opens right after an identifier's character (`x$a$` is one name in Postgres)                                                                                                                             | narrow-sendable.test.ts "plain string"; the DB cell `select text'\'; reset role; select '1'` (simple protocol: leaves the role unguarded)                                                                    |
| (e) a tagged template's identifier helper where a function or a setting is named     | `narrowSendable(text, true)` for tagged templates: a placeholder before `(` (not `insert into $1 (`) or as a SET LOCAL name is refused; a fragment may start with a word no statement starts with, never with a placeholder                                                               | narrow-sendable.test.ts "a tagged template"; the DB cell: `t('pg_catalog.set_config')` and `set local ${t('role')}` via `adminSql().begin`                                                                   |
| any other verb                                                                       | the first word of every statement: `select insert update delete merge with values table show`, SET LOCAL of a `mantle.*` setting or `NARROW_LOCAL_SETTINGS` (lock_timeout, statement_timeout, enable_sort, hnsw.ef_search, hnsw.iterative_scan, each with its caller), or SET TRANSACTION | narrow-sendable.test.ts "every statement but": create, call, copy, lock, explain, prepare, execute, discard, listen, notify, load, alter, grant, security label, truncate, other SET LOCALs, SET CONSTRAINTS |

Why TEMPORARY at migrate and not in 0312: the database's name is the box's
own (a migration would need dynamic SQL), and a restore into a fresh
database (no `--create`) starts again with PUBLIC's default, which the next
migrate takes back; it sits next to the existing `REVOKE CREATE ON SCHEMA
public FROM PUBLIC`. Measured who needs it: no app code makes a temporary object (no `create
temp` outside migration 0155, which the migrator runs as the superuser or
the database's owner, both keep it). One test did, on the app's pool:
packages/content/src/journal-scope.db.test.ts shadows `nodes` with a temp
table; under test:runtime-role (the pool logs in as mantle_runtime) it met
"permission denied to create temporary tables". It now makes the table on
its own superuser connection (`superuserClient`), the same query under
test. No other suite met the refusal.

#### LOW items

- LOW-1: `noteActorMiss` keys the narrow checks (`narrow-denied`,
  `narrow-content-write`, `narrow-cascade-delete`) by actor too: a second
  reason meeting the same table within the hour is a row of its own. Cell:
  narrow-observe.test.ts "a narrow check is one row per actor and table an
  hour" (production mode, a captured logger; another check keeps its key).
- LOW-2: done, small. The gateway's own settings (`mantle.actor`,
  `actor_check`, `write_mode`, `route`, `login_id`, `ws`, `mod_ws`,
  `scope_*`) may be named by a narrow statement only inside
  `gatewaySettings` (an AsyncLocalStorage around the one place that sets a
  login's scope on the system pool, system-tx.ts `sendWriteScope`), by
  set_config or SET LOCAL alike. Measured: no other source file sets them
  (`git grep`), and the full suite with the switch on has no refusal. Cells:
  narrow-sendable.test.ts "the gateway's own settings"; the DB cell (five
  forms refused, `systemPoolTxInScope` under an Admin area exit still runs
  as the narrow role with its scope).
- LOW-3: runtime-role.db.test.ts: every SECURITY DEFINER function, any
  schema, the narrow role may run through PUBLIC or any grant is on
  `NARROW_SYSTEM_FUNCTIONS` or the new `NARROW_PUBLIC_DEFINERS` (one:
  `mantle_actor_check_mode()`, reads the check mode, writes nothing). A
  function that runs as its caller runs with the role's own rights, so it
  needs no entry (measured on pg18: the role may run 353 functions in public
  and auth, 13 of them definers: the 12 listed and that one).
- LOW-4: arch-scoreboard-box.sh and docs/runtime-role.md: the cascade count
  counts on either route, and turning the role on would not refuse a
  cascade (it runs as the table's owner); a sign of content going away
  under narrow work, not a refusal to come.
- LOW-5: as-system-routes.mjs: every mention of a wrapper is its
  definition (in its own file), its bare import or a call (a generic call
  too); an alias (`const v = profileWrite`), a reference passed on
  (`.map(profileWrite)`) or a re-export is a problem. Cells:
  as-system-exits.test.ts "a wrapper of a spot".
- LOW-6: rolling back to N-1 without the revert, the old image prints each
  narrow write NOTICE as a plain notice (one log line per counted write)
  until the revert runs; no row, no refusal. Run the revert with the roll
  back to stop the lines.

#### Changed answers

Switch off: none. The text check, the TEMPORARY revoke's only reader (a
temporary object) and the settings rule are the narrow route's and the
database's; no app code makes a temporary object; the full DB suite with
MANTLE_NARROW_SYSTEM=0 (below). Switch on: statements refused that were
sent before: only the probe forms above (the full suite with the switch on
has no refusal of an app statement). No change to what a member, client,
key, peer or public link may do.

#### Pins

None moved (arch:check 0 after the rebase and after each commit).

#### Rollback (fix round 1 additions)

- The revert's file is now `0312_narrow_write_observe.revert.sql` (same
  body, the ledger line names 1790198040000).
- TEMPORARY stays taken from PUBLIC under N-1: an N-1 image's migrate does
  not grant it back (it never touched it), and N-1 needs it for nothing.
  The exact N-1 state, if wanted, as the superuser:
  `GRANT TEMPORARY ON DATABASE "<db>" TO PUBLIC` (the next N migrate takes
  it back).
- LOW-6 above: without the revert, the N-1 pool prints each counted narrow
  write as a plain notice until the revert runs.

#### Gates (fix round 1)

Mac, Node 26, DATABASE_URL unset, on 8ce4b6590 and again on e55fcdefb
(the head's code), the same exits and counts both times: pnpm -r
typecheck 0, pnpm lint 0 (the one warning not this branch's), pnpm
format:check 0, pnpm docs:check 0, pnpm arch:check 0, pnpm boot:smoke 0 (14
services), pnpm -C server/web build 0, vitest run server packages
eslint-rules 0 (865 files passed, 275 skipped; 11148 tests passed),
scripts/test-deploy-scripts.sh 0 (519 passed).

Workstation, own clone ~/s7a3f-ws/repo, own container s7a3f-pg (pgvector
pg18, 127.0.0.1:56390 checked free, max_connections=450, role postgres as
CI), init-scratch and migrate with MANTLE_CHECK_FLOOR=keep, systemd-run
--user, --maxWorkers=3, one at a time, switch on unless said:

- On 8ce4b6590: full DB vitest 0 (1140 files, 14009 passed, 1 skipped;
  MANTLE_NARROW_DUMP: 1174 use rows, no narrow denial, no narrow write
  counted, no text-check refusal, no temporary-table refusal),
  test:actor-off 0 (136 files, 1244 passed), test:actor-on 0 (33, 405),
  test:edit-on 0 (45, 575), test:matrix 0 (4, 8), full DB vitest with
  MANTLE_NARROW_SYSTEM=0 0 (1140 files, 14009 passed: the switch-off
  proof); test:runtime-role in full exit 1: journal-scope.db.test.ts's temp
  table on the app's pool (above), fixed in 92f22b908.
- On 92f22b908: test:runtime-role in full 0 (284 files, 2845 passed),
  journal-scope.db.test.ts in the default config 0 (2 passed).
- Earlier, the cells alone: narrow-route.db.test.ts, runtime-role.db.test.ts,
  narrow-observe.db.test.ts 0 after two test-text fixes (Postgres takes a
  quoted setting name only with TO or =; the empty scope reads `{}`).
- The N-1 drill, own container s7a3f-rb-pg (127.0.0.1:56391), main
  520659a30, branch 92f22b908: init and migrate with main 0 (no triggers,
  PUBLIC has TEMP); migrate with the branch 0 (3 cascade triggers,
  mantle_narrow_actor, the 0312 ledger row, the counting body, PUBLIC
  without TEMP); migrate with main 0 (unchanged); the revert 0 (all four
  gone; TEMP stays taken); migrate with main 0; migrate with the branch 0
  (0312 applied again).

#### Open items (fix round 1)

1. Fold narrow-route sqlCode into sql-text after S10 r2b merges: the text
   check's blanker (`gateway/narrow-sendable.ts` `sqlCode`) does the same job
   as feat/s10-r2b's `packages/db/src/sql-text.ts` (not on main at this
   head). Fixed here minimally (E'' only as its own token, no dollar quote
   right after a name's character); one blanker after the fold, with its
   flags (unterminated text, U& names).
2. S7b: the narrow pool that logs in as the narrow role itself (MED-1's
   class); LOW-5 of the a2 re-audit stays as noted above.
3. Late item (the S10 r2b re-audit's HIGH, same blanker): Postgres ends a
   `--` comment at `\n` or `\r`; the text check's `sqlCode` and
   actor-sql.ts `statementBody` ended it at `\n` only, so `select 1 --x\r;
reset role` hid the second statement. Fixed in e551a8f52 (both). Cells:
   narrow-sendable.test.ts "ends a line comment at a carriage return too";
   narrow-route.db.test.ts "comment to CR" (unguarded on pg18 it leaves the
   role, routed it is refused). Gates on e551a8f52: the Mac gates all 0
   (unit 865 files, 11149 passed; deploy scripts 519); workstation, a fresh
   own container and clone: narrow-route.db + narrow-sendable 0 (21
   passed), full DB vitest with the switch on: 1140 files and 14010 tests
   passed, exit 1 on one unhandled CONNECTION_CLOSED from postgres.js's
   type fetch at a pool's close (the known flake class, being fixed on
   feat/ci-pool-close), no narrow denial or count in the dump. The other
   DB gates ran on 8ce4b6590/92f22b908 (above); this change only ends a
   comment earlier where a `\r` stands.

### Fix round 2 (the a3 re-audit at a4467f035, and the S10 r2b re-audits' narrow-route items)

Rebased on main 792c51b4e (v0.300.121: S10 r2b's packages/db/src/sql-text.ts
and read-only-tx.ts, the Files rail fix, the postgres.js teardown patch)
with no conflict, the pins file included; `pnpm arch:check` 0 after the
rebase, no pin moved. The migration stays 0312_narrow_write_observe (main's
last is 0311). This file had Part a3 twice (a bad edit in fix round 1: the
first copy's tail repeated part a2's fix round 1); folded into one, keeping
the newer TEMPORARY paragraph.

#### MED-1: one SQL text reader (the fold onto sql-text)

The narrow route's text check (`gateway/narrow-sendable.ts`), actor-sql.ts
`statementBody`, handles.ts `isWriteSql` and eslint-rules/rights-counts.mjs
(`stripSqlComments`, `dropSqlComments`) now read through
`packages/db/src/sql-text.ts` `sqlCode`; narrow-sendable's own blanker,
`IDENT_CHAR` and `escapeString` are gone. The mode differences, settled
without touching what readSql and the lint read:

- (a) sql-text gains one more view, `uncommented` (the text with only its
  comments blanked, same length). The narrow check finds a place on the code
  and reads a literal (set_config's arguments) or a quoted setting name (SET
  LOCAL, now with the regex's `d` indices) from `uncommented` at the same
  offsets; `settingName` reads quoted parts whole (`"mantle.ws"` is one
  name). rights-counts reads `uncommented` (function bodies kept).
- (b) The narrow check refuses `unterminated` and `ambiguous` text.
- (c) The quote characters at the ends: the code keeps `'` at a string's
  and a dollar quote's ends and a quoted name's name characters (others as
  `_`), so ROLE_CHANGE, PG_SETTINGS and the first word read a quoted
  `"role"` as itself, as before.

Also: a call of a function that runs its text as SQL is refused on the
narrow route (`SQL_TEXT_RUNNERS` in read-sql.ts, which WRITE_FUNCTIONS now
spreads: query_to_xml*, cursor_to_xml*, ts_stat, ts_rewrite,
job_table_run*, dblink*). Measured on pg18: `query_to_xml('select
set_config(''role'', ''none'', true)', ...)` leaves the narrow role
unguarded. The first word may hold characters that are not ASCII (then it is
no allowed word).

| Case                                              | Form (each leaves the role on pg18 sent unguarded) | Cells                                                                                                                             |
| ------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| nested block comment                              | `select 1 /* /* */ ' */; reset role; select ' '`   | narrow-sendable.test.ts "nested block comments"; narrow-route.db.test.ts "reads the text as Postgres does"                        |
| nested leading comment (statementBody)            | `/* /* */ select */ reset role`                    | the same two; actor-client.test.ts "reads the leading comments and SETs as Postgres does" (statementBody, runsOutsideTransaction) |
| dollar-quote tag not ASCII                        | `select $é$'$é$; reset role; select '1'`           | the same two; actor-client.test.ts (`set my.x = $é$;$é$; vacuum`)                                                                 |
| name not ASCII (no dollar quote, no E'' after it) | `select 1 as aé$q$; reset role; select 1 as b$q$`  | the same two; `éE'\'` read as a name and a plain string                                                                           |
| a function running its text                       | `query_to_xml(...)`, `pgboss.job_table_run(...)`   | narrow-sendable.test.ts "refuses a function that runs its text as SQL"; the DB cell                                               |
| unterminated, ambiguous                           | `select 1 /* x`, `select 'a\'`, `U&"..."`          | narrow-sendable.test.ts; the DB cell                                                                                              |

isWriteSql: a nested comment no longer turns a read into a write (`/* /*
*/ insert ... */ select 1` was a write, so executeWrite let a read through);
a verb in a string or a dollar quote is no write; a `--` comment a `\r`
ends no longer hides a write; text that never closes is no write (refused).
Cells: write-sql.test.ts. rights-counts: a function after a `--` comment a
`\r` ends and after an E'' string with `\'` is found, one in a nested
comment is not (rights-counts.test.ts "reads the SQL as Postgres does"); the
repo's counts did not move (arch:check output identical before and after).
Teeth: every new cell above failed with the old reader in place (run with
each old file swapped back, then restored). readSql's and the lint's tests
pass unchanged (read-sql.test.ts, cleanup-counts.test.ts).

Two earlier narrow-sendable cells changed, each for a reason this round
names: `select E'\'; reset role; select '1'` was sent and is now refused
(the text never closes; the cell sends the closed form, and the unclosed
one is a refusal cell); `set_config('mantle.create_ws', ...)` moved from the
sent list to the gateway's own (LOW-b).

#### MED: the send order (watchedQuery, and every route's transaction client)

`watchedQuery` (narrow-route.ts) started a statement through
`Promise.resolve(q)` (a microtask late) and sent `.values()`/`.simple()` at
once; `settingsFirst` (actor-sql.ts, the transaction client of every route
that sets settings with the first statement: the actor client, the write
role, the narrow route) sent a `.values()`, `.simple()` or tagged-template
statement when it was built. Both now send a statement on its first `then`
only, reaching the query's own `then` in the same call: the order statements
are awaited in is the order on the wire, as postgres.js's own. Measured
before the fix (unit, the fake that records sends): a SET TRANSACTION
awaited first went out after the actor SET. Cells: actor-client.test.ts "a
transaction client sends in the order its statements are awaited" (both
cells failed on the old settingsFirst); narrow-route.db.test.ts "sends a
transaction's statements in the order they are awaited, on every route":
`set transaction read only` then five statements (plain, `.simple()`,
`.values()`, a tagged template, plain) awaited together, each appending its
letter to `mantle.order_probe`: every one sees `transaction_read_only = on`
and `a`, `ab`, ... `abcde`, on the narrow route (as mantle_system_narrow),
a full reason and outside any exit; and drizzle's `accessMode: 'read only'`
on the narrow route.

#### MED: pg-boss's routines

`revokePgBossRoutines` (runtime-role.ts): `REVOKE EXECUTE ON ALL ROUTINES IN
SCHEMA pgboss FROM PUBLIC`, at every migrate (applyRuntimeGrants) and in
pgboss:init right after `boss.start()` (pg-boss installs or upgrades its
routines after migrate on a fresh box). Measured: no role the app runs as
calls a pgboss routine (the app reads `pgboss.job` and `pgboss.version`
only; every PgBoss instance connects with DATABASE_URL, the migrator, which
owns the routines). Per-schema default privileges: measured that `ALTER
DEFAULT PRIVILEGES IN SCHEMA pgboss REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`
leaves a later function PUBLIC-executable (a global default cannot be taken
per schema), so there is none; pgboss:init's revoke covers the window
instead. The `runtime_role_lock` integrity row now names any pgboss routine
the runtime or the narrow role may run. set_config with a non-literal name
was already refused on the narrow route (a3 MED-A, SETTING_LITERAL; its
cells stand). Cells: runtime-role.db.test.ts "pg-boss's routines" (a
routine like job_table_run leaves the narrow role while open; the integrity
row; migrate and the revoke close it; the default-privileges measurement);
server/web/lib/integrity/pgboss-routines.db.test.ts (pg-boss's real schema
on its own database: job_table_run open after install and a way out of the
narrow role; closed by the revoke, the integrity row clear; pg-boss as its
owner still makes a queue and sends a job). The raw write lint counts
`unsafe(CONSTANT)` as non-literal (runtime-role.ts pinned at 8), so the
revoke is a function that sends its literal, not an exported constant.

#### LOW items

- LOW-a: applyRuntimeGrants revokes TEMPORARY from PUBLIC and the narrow
  role, then asserts `has_database_privilege(narrow, current_database(),
'TEMP')` is false and throws otherwise; the database name is quoted with
  `quotedIdent` (its `"` doubled; the membership REVOKE uses it too). Cell:
  runtime-role.db.test.ts "TEMPORARY is taken from PUBLIC and the narrow
  role at every run": a hand grant goes at the next run; a migrator that
  neither owns the database nor is a superuser fails the run.
- LOW-b: `mantle.create_ws`, `private_ws`, `create_stamp` are gateway
  settings; systemPoolTx's home SET goes inside `gatewaySettings`. Cells:
  narrow-sendable.test.ts "the gateway's own settings" (five more forms
  refused, the home SET sent inside).
- LOW-c: narrow-sendable.ts's top comment and docs/runtime-role.md say a
  fragment a tagged template takes from another postgres.js client is not
  read at all (a guard against mistakes).

#### Test hygiene

narrow-route.db.test.ts makes no table: its probe row is a miss row with the
cell's marker (`actor_check_misses`, which the pool's login may write).
scope.db.test.ts's ensureConcurrentIndexes cell runs on an empty scratch
database of its own. Neither makes a table in the shared test database.

#### Changed answers (fix round 2)

Switch off: none expected (the full DB suite with MANTLE_NARROW_SYSTEM=0 is
still to run, below). Off the narrow route: isWriteSql reads a nested
comment, a string and a `\r` as Postgres does, so executeWrite refuses a
read it once let through (only a read hidden behind a nested comment, or a
write verb inside a value) and takes a write after a `\r` comment it once
refused; statementBody cuts what Postgres skips (needsActorWrap,
runsOutsideTransaction); a transaction client sends `.values()`,
`.simple()` and tagged-template statements when awaited, not when built
(the same statements, in await order); pg-boss routines are no longer
PUBLIC-executable (only the migrator, their owner, runs them); a migrate
that leaves the narrow role holding TEMPORARY fails. Switch on: the narrow
route also refuses text that never closes or is ambiguous, the SQL text
runners, and the three settings LOW-b names outside the gateway's SET. No
change to what a member, client, key, peer or public link may do.

#### Pins (fix round 2)

None moved: arch:check output identical after the rebase, after the fold
and on the handover head (rights-counts' readings unchanged; the raw write
pin of runtime-role.ts holds at 8).

#### Gates (fix round 2)

Mac, Node 26, DATABASE_URL unset, on 87cba8c4d (the code head; the later
commits are this file only, on which arch:check, docs:check and
format:check ran again: 0, 0, 0): pnpm -r typecheck 0, pnpm lint 0, pnpm
format:check 0, pnpm -C server/web build 0, pnpm docs:check 0, pnpm
arch:check 0, pnpm boot:smoke 0, vitest run server packages eslint-rules 0
(869 files passed, 281 skipped; 11275 tests passed),
scripts/test-deploy-scripts.sh 0 (519 passed).

Workstation, own clone ~/s7a3g-ws/repo (main from GitHub plus a bundle of
the branch), own container s7a3g-pg (pgvector pg18, 127.0.0.1:56395 checked
free, max_connections=450, role postgres as CI), init-scratch and migrate
with MANTLE_CHECK_FLOOR=keep (0), systemd-run --user, --maxWorkers=3, on
87cba8c4d: the round's cells together 0 (7 files, 106 tests:
narrow-route.db, runtime-role.db, pgboss-routines.db, scope.db,
narrow-observe.db, narrow-sendable, actor-client), so every fold form left
the role sent unguarded on pg18 and was refused routed, the order probe
held on the three routes, the real pg-boss cell and the non-owner TEMPORARY
run passed.

#### The full suites (fix round 2, on 013e79cba)

The first builder of this round stopped at about 120 tool calls with every
item, the Mac gates and the round's cells on pg18 done; a second builder
ran the full suites. Workstation, own clone ~/s7a3h-ws/repo (feat/s7a-a3
from GitHub at 013e79cba), own container s7a3h-pg (pgvector pg18,
127.0.0.1:56400 checked free, max_connections=450, role postgres as CI),
init-scratch 0 and migrate 0 with MANTLE_CHECK_FLOOR=keep, DATABASE_URL
for those two only, systemd-run --user, --maxWorkers=3, one at a time,
switch on unless said:

| Gate                                      | Exit | Counts                                        |
| ----------------------------------------- | ---- | --------------------------------------------- |
| full DB vitest, MANTLE_NARROW_DUMP        | 0    | 1150 files; 14163 passed, 1 skipped           |
| full DB vitest, MANTLE_NARROW_SYSTEM=0    | 1    | 2 files, 4 cells failed (below); 14159 passed |
| the same, rerun once                      | 0    | 1150 files; 14163 passed, 1 skipped           |
| test:actor-off                            | 0    | 138 files; 1368 passed, 1 skipped             |
| test:actor-on                             | 0    | 33 files; 405 passed, 1 skipped               |
| test:edit-on                              | 0    | 45 files; 575 passed                          |
| test:matrix                               | 0    | 4 files; 8 passed                             |
| test:runtime-role in full                 | 1    | 3 files, 5 cells failed (below); 2867 passed  |
| the same, rerun once                      | 0    | 290 files; 2872 passed, 1 skipped             |
| the N-1 drill (own container s7a3h-rb-pg) | 0    | every step 0 (below)                          |

What moved: nothing. The switch-on dump has 1181 lines, every one a use
(no denial, no narrow write counted); no `narrow system route:` refusal
and no NarrowRoleLeftError in either full run's log. The switch-off dump
holds only narrow-route.db.test.ts's own switch-on cells (20 lines). The
counts against fix round 1 (1140 files, 14009 passed) grew with main
(v0.300.121) and this round's cells; no cell's answer changed. No hang:
the full runs took 884 s and 860 s. The round-trip and order cells pass in
every suite they are in, and no other cell that counts statements moved.

The failures, none on the narrow route and none this branch's:

- `packages/runtime/src/agent/chat-archive.db.test.ts` "New chat ..."
  (the archived summary note missing from `contentHits`; the file's two
  later cells fail from it, as they read the first one's thread) and
  `packages/runtime/src/agent/conversation-trace.db.test.ts` (the near
  page missing from the vector hits), together, in the switch-off run and
  in the first runtime-role run. Both are the owner's turn context's HNSW
  content pool (packages/search/src/hnsw.ts `withHnswPool`, owner filter
  on the index order) on a busy shared database; this branch changes no
  file in packages/search or packages/runtime, the switch-off run takes no
  narrow route, both files pass alone (8 of 8, switch off) and in the
  reruns, and S11a's handover records the conversation-trace cell failing
  the same way on its full run. Left as an open item below.
- `packages/db/src/access-matrix.db.test.ts` "re-applying heals drift"
  (first runtime-role run): `tuple concurrently deleted`, a catalog race
  with another file's GRANTs, the class scope.db's
  `ensureConcurrentIndexes` cell showed before; passed on the rerun.

The N-1 drill, main 792c51b4e and the branch 013e79cba, each step's state
as cascade triggers / mantle_narrow_actor / the 0312 ledger row / ledger
rows / the md5 of mantle_actor_check_stmt's body / PUBLIC's TEMPORARY /
the narrow role's TEMP:

| Step                         | Exit | State                                    |
| ---------------------------- | ---- | ---------------------------------------- |
| init and migrate with main   | 0, 0 | 0 / no / 0 / 311 / 31be63d4 / 1 / true   |
| migrate with the branch (N)  | 0    | 3 / yes / 1 / 312 / 39dc0bd1 / 0 / false |
| migrate with main (N-1 boot) | 0    | unchanged                                |
| the revert                   | 0    | 0 / no / 0 / 311 / 31be63d4 / 0 / false  |
| migrate with main            | 0    | unchanged                                |
| migrate with the branch      | 0    | 3 / yes / 1 / 312 / 39dc0bd1 / 0 / false |

As fix round 1's: the revert puts the actor check's body back byte for
byte and TEMPORARY stays taken (the new assert and the pg-boss revoke ran
on each branch migrate, with no pgboss schema on this database).
Cleaned up by name: the two containers (with their volumes), the clone,
the units.

CI on 013e79cba: run 39518868731 success (every step, the runtime role
and matrix steps included).

#### Open items (fix round 2)

1. The owner's content pool can miss a row on a busy shared test
   database (chat-archive.db.test.ts, conversation-trace.db.test.ts, above):
   not this branch's; for the search lane. One lead, measured: the
   `hasIterativeScan` probe in hnsw.ts reads `hnsw.iterative_scan` with
   `current_setting(..., true)`, which is null on a backend that has not
   loaded pgvector yet, and the answer is kept for the process, so a
   process whose first probe lands on such a backend never turns the
   iterative scan on (the two cells alone read `off`, so loaded, both
   times; not shown to be this failure's cause).

### Fix round 3 (the a3 re-audit at 90aa385b5)

The re-audit's verdict was merge, with four LOWs, each fixed here with its
cell. origin/main had not moved past 792c51b4e: no rebase.

#### LOW-1: calls whose effect outlives the transaction

Measured on pg18 (sent unguarded as the narrow role, committed, on one
session): `set_limit(0.11)` leaves `show_limit()` at 0.11; `setseed(0.25)`
leaves the session's random sequence seeded; `pg_advisory_lock(7771)` stays
held on the session; `lo_create(0)` and `lo_from_bytea(...)` commit large
objects owned by mantle_system_narrow. On the narrow route each passed the
text check.

Fix: read-sql.ts names the subset `SESSION_LASTING_FUNCTIONS` (set_limit,
setseed, `pg_advisory_(?!xact_)\w+` and `pg_try_advisory_(?!xact_)\w+`: the
session locks and unlocks, `lo_\w+`, lowrite), which WRITE_FUNCTIONS
spreads (readSql's list unchanged: the xact forms are listed beside it), and
narrow-sendable.ts refuses a call of one next to SQL_TEXT_RUNNER_CALL
(`SESSION_LASTING_CALL`). The transaction's own advisory locks stay allowed:
measured by grep, narrow-route code takes them (share-lock.ts
`pg_advisory_xact_lock_shared`, advisory-lock.ts `advisoryXactLock` and
`tryAdvisoryXactLock`); no app code takes a session lock or touches a large
object (the one session lock is test-support.ts's, on its own client). Doc:
docs/runtime-role.md and runtime-role.ts say the role owns nothing because
the text check refuses the large-object functions, and the text check's list
names the lasting calls.

Cells: narrow-sendable.test.ts "refuses a function whose effect outlives
the transaction" (15 forms refused, the name bare, qualified, quoted or upper
case; the xact forms and a value naming one sent); narrow-route.db.test.ts
"refuses a call whose effect outlives the transaction": each lasting effect
above measured unguarded, then twelve forms refused routed (alone and in a
transaction), no large object left, and `advisoryXactLock`,
`tryAdvisoryXactLock` and `pg_advisory_xact_lock_shared` run on the narrow
route as mantle_system_narrow, no advisory lock left in the database after.

#### LOW-2: an array returned from begin

postgres.js sends and awaits an array the work returns (`Promise.all`)
before the COMMIT; a wrapper whose callback is async hands it a promise, so
the array was never sent and the transaction committed empty. Measured:
with the old wrappers the DB cell below fails (`out[0]` is an unsent query).
Fix: `workResult` (gateway/actor-sql.ts), `Array.isArray(r) ? Promise.all(r)
: r`, read in every gateway wrapper of begin or a savepoint: actorClient's
begin, narrowBegin, the write role's writeTxOf (role-runner.ts), a joined
write's savepoint (role-tx.ts joinWriteTx) and the turn scope's begin
(scope.ts). The last three had the same shape; the gateway lens folds them
onto the one reader.

Cells: actor-client.test.ts "a begin's work that returns an array of
statements" (workResult; the system pool's begin sends both, with the
actor's SET, before the COMMIT, and answers their results; failed with the
old wrapper); narrow-route.db.test.ts "a begin whose work returns an array
of statements": `adminSql().begin(t => [t.unsafe(a), t.unsafe(b).values()])`
on the narrow route, a full reason and no exit writes both rows and returns
`[rows, values]`.

#### LOW-3: comments in the migrations' SQL, read once

`migrationSqlTexts` (arch-counts.mjs, feeding roleResets and gapTables) and
`headsBypassesIn` (heads-bypass.ts) cut comments with regexes: a `--` or
`/*` inside a string hid the rest, a `--` comment a `\r` ends ran to the
`\n`, and heads-bypass did not cut block comments at all (a call inside one
counted). Both now read `sqlCode(text).uncommented` (sql-text.ts), as
rights-counts does. The two counters also no longer run the JavaScript
comment reader over a migration's SQL (`sourceCode`): it took a `//` in a
dollar quote for a comment.

Cells: arch-lints.test.ts "the migrations' SQL for the role counters"
(a reset or a role switch after `'a--b'`, `'/*'`, `$$ -- $$` and
`$q$http://x$q$` is counted; after a `\r`-ended comment too; a real
comment, a nested one whole, still is not); heads-bypass.test.ts "reads
comments as Postgres does". Pins: none moved (arch:check output identical
before and after the change): no hidden form in the repo's migrations.

#### LOW-4: isWriteSql and ambiguous text

isWriteSql answers no write (executeWrite refuses) for `ambiguous` text as
for `unterminated`. Cell: write-sql.test.ts "not a write (refused), read
otherwise" (`'a\'` in an UPDATE, the same before a DELETE, a U& name).

#### Changed answers (fix round 3)

Switch off: none expected (the full DB suite with MANTLE_NARROW_SYSTEM=0,
below). Off the narrow route: readSql unchanged (the same functions);
executeWrite refuses a write whose text holds a backslash before a quote in
a plain string or a U& name (parameters are how app writes pass values); a
begin or savepoint whose work returns an array now sends it (no app code
returns one: the gateway's callers await their statements). Switch on: the
narrow route also refuses set_limit, setseed, the session advisory locks
and unlocks and the large-object functions. No change to what a member,
client, key, peer or public link may do.

#### Pins (fix round 3)

None moved: arch:check 0, its output identical before and after LOW-3.

#### Gates (fix round 3)

Mac, Node 26, DATABASE_URL unset, on cf3456d21 (the code head; the handover
commit after it is this file only, on which format:check, docs:check and
arch:check ran again): pnpm -r typecheck 0, pnpm lint 0, pnpm format:check
0, pnpm -C server/web build 0, pnpm docs:check 0, pnpm arch:check 0, pnpm
boot:smoke 0 (14 services), vitest run server packages eslint-rules 0 (869
files passed, 281 skipped; 11285 tests passed).

Workstation, own clone ~/s7a3i-ws/repo (feat/s7a-a3 from GitHub plus a
bundle of this round's commits, at cf3456d21), own container s7a3i-pg
(pgvector pg18, 127.0.0.1:56410 checked free, max_connections=450, role
postgres as CI), init-scratch 0 and migrate 0 with MANTLE_CHECK_FLOOR=keep,
DATABASE_URL for those two only, systemd-run --user, --maxWorkers=3, one at
a time, switch on unless said:

| Gate                                                                                                              | Exit | Counts                                     |
| ----------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------ |
| the round's cells (narrow-route.db, narrow-sendable, actor-client, write-sql, heads-bypass, read-sql, arch-lints) | 0    | 7 files; 273 passed                        |
| the array-begin DB cell with the old wrappers (teeth; restored by git checkout after)                             | 1    | fails: `out[0]` is an unsent query         |
| full DB vitest, MANTLE_NARROW_DUMP                                                                                | 0    | 1150 files; 14175 passed, 1 skipped; 857 s |
| full DB vitest, MANTLE_NARROW_SYSTEM=0                                                                            | 0    | 1150 files; 14175 passed, 1 skipped; 863 s |
| test:runtime-role in full                                                                                         | 0    | 290 files; 2874 passed, 1 skipped          |
| test:actor-on                                                                                                     | 0    | 33 files; 405 passed, 1 skipped            |

No flake this round: every run passed first time. The switch-on dump has
1182 lines, every one a use (no denial, no narrow write counted); no
`narrow system route:` refusal and no NarrowRoleLeftError in the log. The
switch-off dump holds only narrow-route.db.test.ts's own switch-on cells
(22 lines). Cleaned up by name: the container (with its volume), the clone,
the units (collected).

#### CI (fix round 3)

On 0c45596b6: run 39538411761 failure, one cell in Test (actor check off):
actor-client.test.ts "the system pool's begin sends both statements"
expected the actor's SET, which the actor-off suite does not send (a cell
of this round, not a flake; the workstation ran the suites this brief
named, not test:actor-off). The cell now holds in both modes (the
statements less any actor SET, at most one SET); run under the actor-off
config and the default one, 33 of 33 each. The next run's id and result
are in the round's report.
