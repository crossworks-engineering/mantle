# The narrow route's own login, plan v3.2 (handover)

The default-on release of the narrow system role (plan v3.2 section 2.1
point 5), in two parts, one merge per part. Each part's section: what
changed, the design decisions with what was measured, the changed answers,
the pins, the gates with their exit codes, the rollback. The spec is
docs/runtime-role.md, "The narrow system role" and "The acting login".

## Part b1: the narrow pool and the acting login

Branch feat/s7b-b1, from main at d0a207d2a (v0.300.129 plus one docs
commit). The switch's default is unchanged (on in tests and development,
off in production). One migration, `0314_acting_login_definers` (`when`
1790198160000, 60000 above 0313's).

### What changed

- packages/db/src/runtime-role.ts: the narrow role logs in only when
  migrate sees `MANTLE_NARROW_SYSTEM` on (`ensureRuntimeRoles`'
  `narrowLogin`, passed by migrate.ts as `narrowSystemOn()`, by the test
  setup as on): `LOGIN` with `narrowRolePassword(masterKey)` (the runtime
  role's HKDF with its own label, `runtime-role:mantle_system_narrow`),
  `NOLOGIN` with no password otherwise, and `NOLOGIN` in per-database mode.
  `CONNECTION LIMIT 30` either way (`NARROW_CONNECTION_LIMIT`).
  `narrowDatabaseUrl()`: DATABASE_URL's server and database as the narrow
  role, or null in per-database mode. migrator-steps.ts logs which.
- packages/db/src/gateway/pools.ts: `narrowPoolSql()`, the route's own pool
  (`NARROW_POOL_MAX` 5 per process, `globalThis.__mantleNarrowSql`), made on
  the first narrow statement, ended by closeDb; refuses to open behind a
  closing system pool. The production pool line says which route is in use.
- packages/db/src/gateway/narrow-route.ts: on the login pool a statement
  outside a transaction is a session `SET` of the actor's settings, the
  statement and a `RESET`, pipelined on one reserved connection, the caller
  answered before the `RESET` (no `BEGIN`, no role `SET`, no hold check, no
  `COMMIT`); a transaction sets the actor's settings with its first
  statement and keeps the hold check before `COMMIT`. In per-database mode
  (no login) the S7a route as it was: the role per transaction on the
  system pool. The text check runs on both.
- The acting login: each system exit records the login it acts for beside
  its route (viewer.ts `SystemRouteEntry.login`, `actingLoginNow`; the
  actor object is unchanged); setActorSql sends it as `mantle.acting_login`;
  the narrow route always sends it; the full route sends it with the
  actor's settings, and for the request's own exit
  (`requestExitActingLogin`) in every check mode. A gateway setting
  (narrow-sendable.ts `GATEWAY_SETTING`).
- Migration 0314: `mantle_tg_chat_set` and `mantle_access_key_revoke` with
  no scope take only the acting login (42501 otherwise); in a scope the
  scope's own login, as before. Revert: rollback/0314_acting_login_definers.revert.sql.
- Tests: packages/db/src/narrow-login.db.test.ts (new); the hold-check cell
  of narrow-route.db.test.ts split into the login pool (nowhere to go) and
  the per-database route (rolls back); the narrow attributes (unit and DB);
  the ceiling (a third pool in pools.ts, the narrow role's line); the
  0313 and admin-membership cells that call the two definers with no scope
  now set the acting login; setActorSql's uuid check; narrow-sendable's
  gateway settings.
- Docs: docs/runtime-role.md (the role's login, the route, the acting login).

### Design decisions, with what was measured

- The login follows the narrow switch, as the runtime role's follows its
  own: migrate sets `LOGIN` only while it sees `MANTLE_NARROW_SYSTEM` on
  (compose passes the switch to migrate through x-app-env), `NOLOGIN`
  otherwise. Drill on pg18 (below): dev default on gives `LOGIN`;
  production with the switch unset `NOLOGIN`; production with
  `MANTLE_NARROW_SYSTEM=1` and `MANTLE_DB_RUNTIME_ROLE` unset `LOGIN`.
- `MANTLE_DB_RUNTIME_ROLE` off and the switch on: neither the old SET route
  nor a refusal to start. The narrow pool does not depend on the system
  pool's login, so it logs in as the narrow role there too: the fresh
  install works (the default DB suites run that shape: runtime role off,
  switch on), and narrow work there can no more reach the superuser than on
  a box with the runtime role on (on the S7a route the superuser's session
  was one reset away). Only per-database mode keeps the S7a route (the role
  has no login: one password cannot be every brain's on one cluster), with
  its hold check and text check.
- A role whose login migrate did not open while the app has the switch on
  fails the narrow statement (never the system pool instead): fail closed,
  narrower. It cannot happen through compose, which gives migrate and the
  app the same switch.
- Connections: 5 per process (`NARROW_POOL_MAX`), lazy (the cell counts
  the narrow backends of its database: 0 until the first narrow statement),
  every process's under the role's `CONNECTION LIMIT 30`. The ceiling
  (compose's `max_connections=450` on every box, 2-vCPU ones too; 90% =
  405): the full shape 349 to 379, full with runs off 309 to 339, core 181
  to 211; with the four stdio MCP servers' write connections 387 of 450.
- The hold check stays per transaction (it can no longer fire on the login
  pool: a role change lands on the narrow role). The text check stays as a
  guard against mistakes (a session setting, a gateway setting, a lasting
  call); it is no longer the boundary: the login is.
- Round trips, check off, statements / round trips
  (a2a-round-trips.db.test.ts with MANTLE_RT_REPORT, workstation pg18):

  | path            | switch off | S7a route (main, on) | login pool (on) |
  | --------------- | ---------- | -------------------- | --------------- |
  | chat turn start | 104 / 144  | 148 / 166            | 126 / 155       |
  | page save       | 15 / 20    | 19 / 22              | 17 / 21         |
  | member save     | 19 / 26    | 23 / 28              | 21 / 27         |

  Tree load, item open, search and the MCP tool call are unchanged in all
  three. What is left per narrow statement is the actor's session SET (in
  the statement's first send, no round trip) and its RESET, answered after
  the caller has its result (the 11 round trips of the turn start are
  those RESETs: 11 narrow statements, 22 more statements). On these numbers
  the turn-stream and tracing writes stay narrow: none costs the caller a
  round trip.

- Settings: no narrow statement may name `mantle.actor`, `actor_check`,
  `write_mode`, `route`, `acting_login`, `login_id`, `ws`, `mod_ws`,
  `scope_*`, `create_ws`, `private_ws`, `create_stamp` (a DB cell per name,
  set_config and SET LOCAL each; the unit cells keep the gateway's own SET
  sent).
- The acting login rides on the exit's route entry, not on the actor
  object: putting it on the actor changed every recorded actor (the app
  broker parity snapshot, audit and approval rows), so it moved beside the
  route, held while the exit's actor is bound. Other definers that take a
  login with no scope (listed in 0314's header): the two writers take the
  rule (`mantle_tg_chat_set`, `mantle_access_key_revoke`, cells for none,
  another and its own); the readers and the login facts do not (a caller
  with no acting login, or a fact another login may ask), and the narrow
  role may run none of them.

### Escape cells on pg18 (narrow-login.db.test.ts)

Each sent with no guard on a session logged in as the narrow role, then a
content insert as that session: concatenated role name, bound set_config,
session SET ROLE NONE, RESET ROLE, RESET ALL, U& name, comment to CR, typed
literal, nested comment, a text runner (query_to_xml), COMMIT inside a
transaction then RESET ROLE, pg_settings: the session is the narrow role
after each, the insert refused (42501), its row absent. The DO block that
leaves, writes and returns: refused whole (42501), row absent. A pg_temp
function: refused (no TEMPORARY). SET ROLE to mantle_runtime, mantle_owner,
mantle_system, the write role, the user role and the superuser: each 42501;
SET SESSION AUTHORIZATION: 42501; CREATE TEMP: 42501; no pg-boss routine
executable; every definer the login may run is on NARROW_SYSTEM_FUNCTIONS or
NARROW_PUBLIC_DEFINERS. Routed through the gateway the text check still
refuses each form (narrow-route.db.test.ts, unchanged cells).

### Changed answers

None for any member, client, key, peer or public link. At the definer level:
`mantle_tg_chat_set` and `mantle_access_key_revoke` with no scope refuse a
call with no acting login or another one (42501) where they acted for the
login passed; every product caller passes the request's own login, which
is the acting login (the suites below). Statements: with the check off, a
request exit's writes and transactions now carry the actor's settings (with
the acting login), where nothing was sent; on the narrow route, the S7a
BEGIN, role SET, hold check and COMMIT of a single statement are gone (above).
Two test harnesses that call a handler with the guard stubbed (no scope, no
exit) now run it inside a request exit, as the gate does
(w7d-telegram.db.test.ts); the area sweep traps the narrow pool too.

### Pins

rawSqlNonLiteral 63 to 64 (the login pool's one send site, with its note);
RAW_WRITE_PINS narrow-route.ts 4 to 5 (eslint-rules/no-raw-write-sql.mjs).
No other pin moved (arch:check 0). The connection ceiling's lines are
above.

### Rollback (part b1)

- Switch off (production default): the narrow pool never opens and the
  narrow role is `NOLOGIN` at the next migrate; the full route is as before
  but for the acting login it now sends for a request exit's actor.
- Image N-1: run rollback/0314_acting_login_definers.revert.sql first (as
  the superuser, one transaction): with 0314 in place the N-1 image's
  assistants area Telegram block and unpair are refused (it sends no acting
  login). N-1's migrate makes the narrow role `NOLOGIN` again (its own
  attributes), so no session of it outlives the roll. Revert SQL: the
  file's two CREATE OR REPLACE bodies (0313's and 0293's, md5 below) and
  `DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1790198160000`.
- db-restore.sh already makes the role (`NOLOGIN`) before pg_restore
  (part a1); the next migrate sets its login from the switch.
- The drill, workstation pg18, main d0a207d2a and the branch, each step's
  narrow login / the 0314 ledger row / md5 (first 8) of mantle_tg_chat_set
  and mantle_access_key_revoke:

  | Step                                                  | Exit | State                     |
  | ----------------------------------------------------- | ---- | ------------------------- |
  | init and migrate with main                            | 0, 0 | f / 0 / b8266526 a8aa6dbb |
  | migrate with the branch (N, switch on)                | 0    | t / 1 / 8c6bb848 4c0d41fe |
  | migrate with main (N-1 boot)                          | 0    | f / 1 / 8c6bb848 4c0d41fe |
  | the revert                                            | 0    | f / 0 / b8266526 a8aa6dbb |
  | migrate with main                                     | 0    | f / 0 / b8266526 a8aa6dbb |
  | migrate with the branch                               | 0    | t / 1 / 8c6bb848 4c0d41fe |
  | the branch, production, switch unset                  | 0    | f / 1                     |
  | the branch, production, switch on, runtime role unset | 0    | t / 1                     |
  | the branch, production, switch on, per-database mode  | 0    | f / 1                     |

### Gates

Code head 8e7a57b44 (the commit after it is this file only). Mac, Node 26,
DATABASE_URL unset: `pnpm -r typecheck` 0, `pnpm lint` 0, `pnpm
format:check` 0, `pnpm docs:check` 0, `pnpm arch:check` 0, `pnpm
boot:smoke` 0, `pnpm -C server/web build` 0, `vitest run server packages
eslint-rules` 0 (870 files passed, 283 skipped; 11284 tests passed).

Workstation, a fresh clone of the pushed branch at 8e7a57b44, one
pgvector pg18 container per suite (label mantle.test=s7b-b1,
max_connections=450, ports checked free), init-scratch and migrate with
MANTLE_CHECK_FLOOR=keep, systemd-run --user, test lanes, --maxWorkers=3,
switch on unless said:

| Suite                                             | Exit | Counts                              |
| ------------------------------------------------- | ---- | ----------------------------------- |
| full DB vitest, shard 1/2                         | 0    | 577 files; 6354 passed, 1 skipped   |
| full DB vitest, shard 2/2                         | 0    | 576 files; 7851 passed              |
| test:actor-off                                    | 0    | 140 files; 1400 passed, 1 skipped   |
| test:actor-on                                     | 0    | 34 files; 413 passed, 1 skipped     |
| test:edit-on                                      | 0    | 46 files; 583 passed                |
| test:matrix                                       | 0    | 4 files; 8 passed                   |
| test:runtime-role in full                         | 0    | 293 files; 2907 passed, 1 skipped   |
| full DB vitest, MANTLE_NARROW_SYSTEM=0            | 0    | 1153 files; 14205 passed, 1 skipped |
| a2a-round-trips.db.test.ts, MANTLE_RT_REPORT      | 0    | the table above                     |
| the migrate drill (N-1, production, per-database) | 0    | every step 0 (the rollback table)   |

The default DB suites are the fresh-install shape the brief names
(MANTLE_DB_RUNTIME_ROLE unset, the switch on): the system pool logs in as
the superuser and the narrow pool as the narrow role.

The first round, on b5571a300, failed (sh1 6, sh2 15, actor-off 1,
runtime-role 20, switch off 5, every other suite 0), three causes, each
fixed before the round above: the acting login on the actor object changed
every recorded actor (moved to the exit's route entry); the login pool did
not share drizzle's type serializers, so a jsonb value drizzle had
serialized was serialized again (audit and approval rows; the pool now
takes the system pool's parsers and serializers); and two harnesses that
call a handler with no scope and no exit (the Telegram moderation and
my-chats handlers, the area sweep's trap), named under Changed answers.
No flake met in the final round. Containers removed by exact name with
their volumes.

### Open items

1. b2 (the brief's second part): the full-route spots, the area routes'
   cells, the default on everywhere and the kill switch docs. When the
   switch goes on for a box, its migrate must see it (compose gives the
   migrate gate the same x-app-env), or the narrow statements fail closed.
2. The readers that take a login with no scope (0314's header) keep acting
   for the login passed; none is the narrow role's. S8c or S10's successor
   may take the same rule where every caller has an acting login.
3. Per-database mode keeps the S7a route (the role per transaction from the
   system pool's login, the text check and the hold check as the boundary).
4. The check-off full route now sends a request exit's actor settings (one
   more statement with a transaction's first, no round trip; a SET and a
   RESET around a single write). Not measured on a box.
