# The narrow route's own login, plan v3.2 (handover)

The default-on release of the narrow system role (plan v3.2 section 2.1
point 5), in two parts, one merge per part. Each part's section: what
changed, the design decisions with what was measured, the changed answers,
the pins, the gates with their exit codes, the rollback. The spec is
docs/runtime-role.md, "The narrow system role" and "The acting login".

## Part b1: the narrow pool and the acting login

The fix round below changed this part: migration 0314 and its cells left it
(the definers land with b2, so b1 has no migration), the pool holds 2
connections per process under a limit of 36, and the narrow login's
statements share the actor client's pipeline. Where this section and the
fix round differ, the fix round holds.

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

## b1 fix round

After the b1 audit at cafa14530 (7.5/10, merge after fixes; the class close
and the pooled sessions' isolation proven clean). Same branch, a fresh
builder. Code head dbcebf99d (the suites below ran on it); the commit after
it is this file and one pin.

### What changed, by audit item

- MED-1, the connection budget. `NARROW_POOL_MAX` 5 to 2, an idle timeout
  of 30 s (gateway/pools.ts); the role's `CONNECTION LIMIT` 30 to 36
  (runtime-role.ts `NARROW_CONNECTION_LIMIT`), sized to every pool a box
  may open at once: 12 compose processes with the app env x 2 = 24, plus 4
  stdio MCP servers x 2 = 8 and 2 operator runs (a maintain run and one
  more CLI) x 2 = 4: 36. connection-ceiling.test.ts counts every process's
  narrow pool with no min() (the line is 24 on the full shape, 12 on core)
  and a new cell holds box + headroom (36) to the limit, the total to 90% of
  max_connections and the total plus every headroom to max_connections.
  Cell: narrow-login.db.test.ts "the role's CONNECTION LIMIT holds every
  process's narrow pool at full use": the narrow role's rolconnlimit is 36;
  on a role of its own with the same limit (the narrow role's connections
  are shared with the test files running beside it), 18 pools made by the
  pool's own factory, each 2 busy at once: 36 asked, 0 refused, 36
  backends; one more connection while all are held: 53300.
- MED-2, rule 2. Migration 0314 (the file, its revert and its journal
  entry) left b1, with its cells (the narrow-login cell of the two
  definers) and the three test harness changes made for it
  (admin-membership, file-home-chat-0313, w7d-telegram are main's again).
  b1 has no migration. The sender stays: the exit's route entry carries the
  acting login, the gateway sends `mantle.acting_login` (on the narrow
  route always, for a request exit's actor in every check mode), and no
  narrow statement may name it.
- LOW-1. docs/runtime-role.md "The acting login" now says this part only
  sends it, and that the acting login alone does not close the gap: the
  write role can clear its scope and set `mantle.acting_login`, so b2's
  definers must also refuse with no scope unless the caller is a system or
  narrow login. The b2 note below carries it.
- LOW-2. Migrate's role step runs `ALTER ROLE mantle_system_narrow RESET
ALL` and the `IN DATABASE` form for each database a setting is stored
  for (runtime-role.ts `resetNarrowRoleSettings`), every run, after the
  `ALTER ROLE ... PASSWORD` it already sent each run. The pool sends
  `search_path`, `TimeZone`, `DateStyle` as startup parameters
  (`NARROW_STARTUP`: `"$user", public`, UTC, `ISO, MDY`, the boxes'
  defaults). The production boot line reads the role
  (`readNarrowLogin`) and names any stored setting. Cells: "the narrow
  pool's startup parameters"; "a setting the narrow login stores on
  itself" (the login stores two, a raw session takes the per-database
  search_path, the pool's session does not, the boot note names 2, migrate's
  step leaves 0); "the narrow login may change its own password" (it can,
  shown in a transaction that rolls back since the role is shared with the
  files running beside it; each run's statement carries the derived
  password; after a run the stored SCRAM verifier is the derived
  password's and not the other).
- LOW-3, gateway lens. One pipeline for a statement with session settings
  around it: actor-sql.ts `settingsPipeline`, used by the actor client's
  write outside a transaction and by the narrow login's statement with an
  actor (narrow-route.ts `narrowLoginStatement`, which now only routes).
  One failure answer: the statement's own result when it ran (a SET that
  failed beside it is not the caller's error, the statement committed; the
  connection then ends), else the SET's error when it failed too, else the
  statement's; a failed SET or RESET ends the connection. The narrow route
  had thrown the SET's error over a committed statement; the actor client
  had not ended a connection whose SET failed. Cell: "one pipeline for both
  pools, one failure answer" (all well, SET failed, both failed, statement
  failed, RESET failed, SET text throws).
- LOW-4. With the switch on and the route logging in as the role, the boot
  line names a role that cannot log in and the fix ("run migrate with
  MANTLE_NARROW_SYSTEM on ..., or set MANTLE_NARROW_SYSTEM=0",
  `NARROW_LOGIN_FIX`); a refused login on the narrow pool (28000, 28P01)
  fails the statement as `NarrowLoginError` with the same fix. closeDb ends
  the narrow pool with a 5 s timeout (a pool whose logins all failed did
  not end otherwise: found by the cell). Cells: runtime-role.test.ts (the
  boot note, unit) and "a pool that cannot log in as the narrow role fails
  the statement, closed, with the fix named" (a statement and a
  transaction).
- LOW-5. "the session SET is gone after the statement": after a narrow
  statement of a request exit (it saw the acting login and the actor), every
  connection of the pool held at once, outside a transaction, the
  statement's own among them: none holds `mantle.acting_login` or
  `mantle.actor`. "60 parallel narrow statements of two acting logins": 0
  cross, every session the narrow role, at most 2 backends, the pool clean
  after. The w7a sweep harness makes its narrow pool with the pool's own
  factory (`newNarrowPool`), no parser copy.

### Measured

- Connections: the narrow line 24 of the role's 36 (12 left for 4 stdio
  MCP servers and 2 operator runs); the full shape 373 of 405 (90% of 450),
  393 of 450 with the stdio servers' write and narrow connections and the
  operator runs; full with runs off 333; core 193.
- Round trips with the pool of 2 (a2a-round-trips.db.test.ts,
  MANTLE_RT_REPORT, workstation pg18, statements / round trips, check
  off): chat turn start 126 / 155, page save 17 / 21, member page save 21 /
  27, tree load 13 / 17, item open 9 / 12, search 23 / 30, MCP tool call
  37 / 49: the same as b1 with the pool of 5.

### The drill (N-1), workstation pg18, main d0a207d2a and the branch

Each step: rolcanlogin / rolconnlimit / stored setting rows of the narrow
role / ledger rows (no migration: 313 throughout).

| Step                                                  | Exit | State                |
| ----------------------------------------------------- | ---- | -------------------- |
| init and migrate with main, production                | 0    | false / -1 / 0 / 313 |
| migrate with the branch, production, switch on (N)    | 0    | true / 36 / 0 / 313  |
| the narrow login stores a setting on itself           | 0    | true / 36 / 1 / 313  |
| migrate with main (N-1 boot)                          | 0    | false / 36 / 1 / 313 |
| the narrow login after N-1 (refused: NOLOGIN)         | 2    | false / 36 / 1 / 313 |
| migrate with the branch, production, switch on        | 0    | true / 36 / 0 / 313  |
| the narrow login again: search_path `"$user", public` | 0    | true / 36 / 0 / 313  |
| the branch, production, switch unset                  | 0    | false / 36 / 0 / 313 |
| the branch, production, switch on, runtime role unset | 0    | true / 36 / 0 / 313  |
| the branch, production, switch on, per-database mode  | 0    | false / 36 / 0 / 313 |
| the branch, development default (switch on)           | 0    | true / 36 / 0 / 313  |

N-1 leaves the limit at 36 and a stored setting in place (main sets
neither); the role has no login there, and the next migrate of the branch
clears the setting. db-restore.sh makes the role before pg_restore, as in
b1.

### Changed answers

None for any member, client, key, peer or public link. Against b1: the two
definers with no scope act for the login passed again (main's 0313 and
0293 bodies: b1 no longer changes them). The actor client's write whose SET
failed now ends its connection after the RESET (the answer is unchanged:
the write's own); the narrow login's statement whose SET failed answers
the statement's result where it threw the SET's error.

### Pins

historyCodeComments 2334 to 2333 (one counted comment line fewer in the
rewritten pipeline comments). rawSqlNonLiteral stays 64 and narrow-route.ts
5 (its login pool send site now sends a statement with no actor; with an
actor the statement goes through actor-sql.ts, whose pin 9 holds). No
other pin moved.

### Gates

Mac, Node 26, DATABASE_URL unset, on the code head: `pnpm format:check` 0, `pnpm docs:check` 0, `pnpm arch:check` 0,
`pnpm lint` 0, `pnpm -r typecheck` 0, `pnpm boot:smoke` 0, `pnpm -C
server/web build` 0, `vitest run server packages eslint-rules` 0 (870 files
passed, 283 skipped; 11286 tests passed). The first full unit run had 2
shell harness files time out under load (deploy-scripts.test.ts,
shell-portability.test.ts, exit 1); alone they passed (11 tests, exit 0),
and the full run again exited 0 (the counts above).

Workstation, a fresh clone of the pushed dbcebf99d per suite, one
pgvector pg18 container each (label mantle.test=s7b-b1,
max_connections=450, port checked free, removed by exact name with its
volumes), init-scratch and migrate with MANTLE_CHECK_FLOOR=keep,
systemd-run --user, test lanes, --maxWorkers=3, MANTLE_NARROW_SYSTEM=1
unless said; the default suites are the fresh-install shape
(MANTLE_DB_RUNTIME_ROLE unset, the switch on):

| Suite                                        | Exit | Counts                              |
| -------------------------------------------- | ---- | ----------------------------------- |
| full DB vitest, shard 1/2                    | 0    | 577 files; 6363 passed, 1 skipped   |
| full DB vitest, shard 2/2                    | 0    | 576 files; 7851 passed              |
| test:actor-off                               | 0    | 140 files; 1409 passed, 1 skipped   |
| test:actor-on                                | 0    | 34 files; 413 passed, 1 skipped     |
| test:edit-on                                 | 0    | 46 files; 583 passed                |
| test:matrix                                  | 0    | 4 files; 8 passed (run alone)       |
| test:runtime-role in full                    | 0    | 293 files; 2914 passed, 1 skipped   |
| full DB vitest, MANTLE_NARROW_SYSTEM=0       | 0    | 1153 files; 14214 passed, 1 skipped |
| the narrow cells (5 files, targeted)         | 0    | 5 files; 73 passed                  |
| a2a-round-trips.db.test.ts, MANTLE_RT_REPORT | 0    | the numbers above (on c9354afa3)    |
| the drill (N-1, production, per-database)    | 0    | every migrate step 0 (above)        |

test:matrix first ran with the five other suites and failed only its time
budget (the tool cells 214.5 s against 210 s, every cell the oracle's
answer); run again beside two others it took 226.5 s, and b1's head
8e7a57b44 beside it under the same load 221.0 s (also over): the load, not
the pool of 2. Alone it passed (the tool cells 68.3 s warn, 46.8 s on).
The round-trip run and the drill ran on c9354afa3, whose migrate and pool
are the head's (the commit after it changed the boot line, closeDb's end
timeout and one cell). Containers removed by exact name with their
volumes.

### For b2 (moved out of b1)

- The definers, from cafa14530: `git show
cafa14530:packages/db/migrations/0314_acting_login_definers.sql` and its
  revert under packages/db/rollback, the journal entry (renumber and a new
  `when` at merge), the narrow-login.db.test.ts cell "mantle_tg_chat_set and
  mantle_access_key_revoke with no scope take only the acting login", and
  the harness changes of 5cfdc673b, dda5c68d6 and 8e7a57b44 to
  admin-membership.db.test.ts, file-home-chat-0313.db.test.ts and
  w7d-telegram.db.test.ts (the handlers run inside a request exit, as the
  gate runs them).
- LOW-1: with no scope, `mantle_tg_chat_set` and `mantle_access_key_revoke`
  must refuse unless the caller is a system login or the narrow login
  (session_user, not only current_user), then take only the acting login;
  the write role clearing its scope and setting `mantle.acting_login`
  itself is refused (the auditor's E4 as a cell). The other definers that
  take a login with no scope, as listed in 0314's header, each with a cell.
- Rolling b2 back to b1 then needs no revert: b1 already sends the acting
  login.

### Open items

1. The user role's pool has the same arithmetic gap MED-1 named for the
   narrow role: 12 processes x 3 = 36 asked under its limit of 30
   (connection-ceiling.test.ts still takes min() there). Not in b1's
   scope (viewer-roles.ts); for the CEO to place.
2. In the pipeline cell's first shape, a max-1 pool's reserve right after
   the pipeline ended its connection did not return (the cell now takes a
   pool per case). Not reproduced in isolation with reserveLease (a reserve
   after lease.end, after an idle close and after a kill all returned).
   The narrow pool ends a connection only when its SET or RESET fails.
3. N-1 keeps the limit at 36 and any setting stored while N ran (above).
4. Per-database mode keeps the S7a route (no login for the role).
