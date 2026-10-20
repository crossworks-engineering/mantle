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

## Part a2: the narrow route (round 1, work in progress)

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
