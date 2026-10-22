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

Migration 0314 left b1 in the fix round (its revert and its cells: the fix
round's "For b2 (moved out of b1)"; the drill with 0314 is this file at
cafa14530): b1 has no migration, so rolling it back needs no revert SQL.

- Switch off (production default): the narrow pool never opens and the
  narrow role is `NOLOGIN` at the next migrate; the full route is as before
  but for the acting login it now sends for a request exit's actor.
- Image N-1: N-1's migrate makes the narrow role `NOLOGIN` again (its own
  attributes), so no session of it outlives the roll. The fix round's drill
  holds the N-1 steps; fix round 2 adds the large-object creators' revoke
  (its "Rollback").
- db-restore.sh already makes the role (`NOLOGIN`) before pg_restore
  (part a1); the next migrate sets its login from the switch.

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

## b1 fix round 2

After the b1 re-audit at 33bbc0a8e (8/10, merge after fixes; MED-1, MED-2,
LOW-1 to LOW-4 closed). Same branch, a fresh builder. Code head d0ff46dfd
(the suites below ran on it); the commit after it is this file.

### What changed, by audit item

- MED-A, a reserve queued when a pooled connection closes never settled
  (postgres.js 3.4.9: the close took the next queued request as the one to
  open for, and a reserve is never a statement to run, so the connection's
  ReadyForQuery dropped it; the caller hung and closeDb behind it). Both
  parts:
  1. One bounded reserve for every pool: reserved.ts `reserveLease` waits
     at most `RESERVE_WAIT_MS` (15 s) unless the caller gives its own wait,
     then fails as `PoolBusyError` (a `BusyError`: isBusy, 409) and hands
     the late connection back when it comes. Every reserve goes through it:
     the narrow pool and the system pool (actor-sql.ts `settingsPipeline`),
     the per-database narrow route (narrow-route.ts), the turn scope's user
     pool (scope.ts `withLease`), the index builds (concurrent-indexes.ts),
     and the write pool, whose `boundedReserve` (role-tx.ts) is now that
     helper with the write pool's wait and error. One log line for both
     (`logPoolBusy`).
  2. patches/postgres@3.4.9.patch, three more hunks in each of src, cjs and
     cf: the close (index.js `onclose`) keeps a queued reserve queued while
     it opens a connection for it (`queries.peek()`, a new Queue method), as
     `reserve()` itself does, and onopen hands it the connection; a reserve
     whose connect fails leaves the queue (else the close would connect it
     again and again, and a later connection would go to a promise already
     over); a reserve that opens a connection with fetch_types off takes it
     (connection.js ReadyForQuery returned before onopen: a cold reserve
     with fetch_types off never settled, which is why fetch_types off was
     no fix). `pnpm install --frozen-lockfile` applies it (exit 0); the
     lockfile's patch hash 33d55f56... to 740f22bb....
- LOW-A. The narrow pool's startup parameters (pools.ts `narrowStartup`,
  read at each connect): pinned at the app's own values (compose sets none,
  so Postgres's defaults) `search_path`, `default_transaction_read_only`
  off, `default_transaction_isolation` read committed, `row_security` on,
  `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`,
  `idle_session_timeout` 0, `transaction_timeout` 0 on Postgres 17 and later
  (16 refuses a login with a startup parameter it does not know),
  `bytea_output` hex, `extra_float_digits` 1. The list is the auditor's plus
  the settings that would refuse narrow work or change the text drizzle
  parses (isolation, row security, bytea, floats, intervals, string
  literals). Any other stored setting holds until the next migrate (RESET
  ALL each run) and the boot line names it. Large objects: no app code and
  no dependency calls a server-side large-object creator (measured: a grep
  of packages, server, scripts and pg-boss), so migrate takes EXECUTE on
  `lo_create`, `lo_creat`, `lo_from_bytea` and `lo_import` (both) from
  PUBLIC every run, in each database it runs in (runtime-role.ts
  `revokeLargeObjectCreators`, in `applyRuntimeGrants` beside pg-boss's
  revoke). The text check is no longer the only guard there.
- LOW-B. The password cell: packages/db/src/narrow-password.serial.db.test.ts,
  the auditor's P5 end to end (the narrow login changes its own password
  and commits, the derived one gets 28P01, the other logs in, migrate's role
  step `ensureRuntimeRoles` sets the derived one again, the other gets
  28P01). A serial file: vitest.serial.config.ts (`pnpm test:serial`, one
  file at a time), which the default config and every other config leave
  out (`*.serial.db.test.ts`), and a CI step of its own after the matrix;
  on the workstation it ran on a container of its own. The drill below does
  the same through migrate.ts on a cluster of its own. The rolled-back cell
  in narrow-login.db.test.ts now claims only what it shows (each run's
  statement carries the derived password, the verifier after a run).
- LOW-C. TimeZone and DateStyle (and IntervalStyle, standard_conforming_strings)
  are the system pool's own: the values its connections last reported
  (postgres.js `sql.parameters`), read at each narrow connect. A process's
  first narrow statement waits for the system pool's first connect when it
  has not happened yet (narrow-route.ts `systemReported`: one `select 1`,
  then never again; no round trip otherwise, the measurement below).
- Nits. migrator-steps.ts: the runtime and narrow role lines name the cause
  that holds for NOLOGIN (the switch off, per-database mode, or the switch
  on with no MANTLE_MASTER_KEY). This file's b1 "Rollback" points to the b2
  note instead of describing 0314.

### Cells

reserve-queue.db.test.ts (new). Run with the branch's code on 33bbc0a8e's
patch and lockfile (PATCH_FROM, a fresh clone): 7 of 18 failed (6 cells
below and reserved.db.test.ts's type-lookup cell, each pending at
its 5 s mark or the 15 s test timeout) and the file's afterAll timed out (closeDb hung); on the new
patch every one passes:

| Cell                                                                  | Old patch | New |
| --------------------------------------------------------------------- | --------- | --- |
| P2: narrow pool, held connection, failed-SET pipeline, queued one     | pending   | ok  |
| the narrow pool: queued pipeline after a kill of a held connection    | pending   | ok  |
| P3: real route, Admin-area exit, 4 at once, a backend killed, closeDb | pending   | ok  |
| P6: system pool of one, failed-SET pipeline and a kill, closeDb       | pending   | ok  |
| the write pool: boundedReserve queued behind every held one, a kill   | pending   | ok  |
| fetch_types off: a cold reserve, and one queued after a kill          | pending   | ok  |
| the bounded wait: pool held whole, busy, late connection handed back  | ok        | ok  |
| a reserve whose connect is refused leaves the queue, the pool ends    | ok        | ok  |

reserved.db.test.ts: the reservation whose new connection dies during its
type lookup is now awaited and answers (it never settled before: pending
on the old patch). narrow-login.db.test.ts: the pipeline cell runs every
case on ONE pool of one connection (and a pipeline queued behind one whose
SET fails), the pool ending without a timeout; "every setting that would
refuse, cut short or change narrow work" (13 settings stored IN DATABASE by
the narrow login: a raw session is read only and cut short at 50 ms, the
pool's session has each at narrowStartup's value, migrate leaves 0 stored);
"the narrow login may make no large object" (5 forms 42501, none made, no
creator EXECUTE for PUBLIC); the startup cell reads narrowStartup over the
system pool's report. narrow-route.db.test.ts: a large object sent
unguarded is 42501 now (was: committed, owned by the narrow role). Unit:
reserved.test.ts (busy at the wait, the late connection back, a reserve
that never settles, the caller's own error), runtime-role.test.ts
(narrowStartup on 16 and 18, and read at each connect).

### Measured

Round trips (a2a-round-trips.db.test.ts, MANTLE_RT_REPORT, workstation
pg18, check off, statements / round trips): chat turn start 126 / 155, page
save 17 / 21, member page save 21 / 27, tree load 13 / 17, item open 9 /
12, search 23 / 30, MCP tool call 37 / 49: the same as the fix round.

### The drill (N-1), workstation pg18, main 75a82e302 and the branch

Each step: rolcanlogin / rolconnlimit / stored setting rows of the narrow
role / ledger rows / whether PUBLIC may run `lo_from_bytea`. The narrow
login's psql runs over the container's network (scram), not 127.0.0.1
(trust in the image, where a password is never asked: the fix round's
drill could not have seen a password change).

| Step                                                             | Exit | State                        |
| ---------------------------------------------------------------- | ---- | ---------------------------- |
| init and migrate with main, production                           | 0    | false / -1 / 0 / 313 / true  |
| migrate with the branch, production, switch on (N)               | 0    | true / 36 / 0 / 313 / false  |
| the narrow login stores a setting on itself                      | 0    | true / 36 / 1 / 313 / false  |
| migrate with main (N-1 boot)                                     | 0    | false / 36 / 1 / 313 / false |
| the narrow login after N-1 (refused: NOLOGIN)                    | 2    | false / 36 / 1 / 313 / false |
| migrate with the branch, production, switch on                   | 0    | true / 36 / 0 / 313 / false  |
| the narrow login again: search_path `"$user", public`            | 0    | true / 36 / 0 / 313 / false  |
| the narrow login changes its own password, committed             | 0    | true / 36 / 0 / 313 / false  |
| the derived password after it (refused, password failed)         | 2    | true / 36 / 0 / 313 / false  |
| migrate with the branch, switch on (the role step sets it again) | 0    | true / 36 / 0 / 313 / false  |
| the derived password logs in again                               | 0    | true / 36 / 0 / 313 / false  |
| the narrow login makes a large object (permission denied)        | 1    | true / 36 / 0 / 313 / false  |
| the branch, production, switch unset                             | 0    | false / 36 / 0 / 313 / false |
| the branch, production, switch on, runtime role unset            | 0    | true / 36 / 0 / 313 / false  |
| the branch, production, switch on, per-database mode             | 0    | false / 36 / 0 / 313 / false |
| the branch, development default (switch on)                      | 0    | true / 36 / 0 / 313 / false  |

N-1's migrate leaves the large-object creators revoked (main grants
nothing back; no main code calls one).

### Changed answers

None for any member, client, key, peer or public link. Below them:

- A server-side large object: refused (42501) to every role but the
  superuser, at the first migrate (it was PUBLIC's; on the narrow route the
  text check refused the plain calls already).
- A reserve on the system, narrow or user pool that waits 15 s fails busy
  (`PoolBusyError`, 409) where it waited for good; the write pool's wait and
  error are unchanged.
- A reserve queued when a connection of its pool closes is answered (it
  never settled), on every pool.
- The narrow pool's sessions start with the pinned settings, and TimeZone
  and DateStyle are the system pool's reported ones (were `UTC` and `ISO,
MDY` by hand).
- migrate's role lines: NOLOGIN names its cause.

### Pins

No pin moved (arch:check 0). The console calls stay 476: the write pool's
busy line and the new pool's one share `logPoolBusy` (reserved.ts).

### Rollback (fix round 2)

No migration. The revoke lives in migrate's grants step: an N-1 image's
migrate leaves it in place (its app calls no large-object creator). To
give it back by hand, in each database, as the superuser:
`GRANT EXECUTE ON FUNCTION pg_catalog.lo_create(oid), pg_catalog.lo_creat(integer), pg_catalog.lo_from_bytea(oid, bytea) TO PUBLIC`
(`lo_import` stays the superuser's, Postgres's own default). The patch
and the bounded wait are code: an N-1 image runs its own.

### Gates

Mac, Node 26, DATABASE_URL unset: `pnpm format:check` 0, `pnpm docs:check`
0, `pnpm arch:check` 0, `pnpm lint` 0, `pnpm -r typecheck` 0, `pnpm
boot:smoke` 0, `pnpm -C server/web build` 0, `vitest run server packages
eslint-rules` 0 (870 files passed, 284 skipped; 11291 tests passed). The
first unit run exited 1 on one cell (process-entries.test.ts: reserved.ts's
new timer missing from docs/process-inventory.md, added in d0ff46dfd); the
rerun is the count above. `pnpm install --frozen-lockfile` with the new
patch: 0.

Workstation, a fresh clone of the pushed d0ff46dfd per suite, one pgvector
pg18 container each (label mantle.test=s7b-b1, max_connections=450, port
checked free, removed by exact name with its volumes), init-scratch and
migrate with MANTLE_CHECK_FLOOR=keep, systemd-run --user, test lanes,
--maxWorkers=3, MANTLE_NARROW_SYSTEM=1 unless said; the default suites are
the fresh-install shape (MANTLE_DB_RUNTIME_ROLE unset, the switch on):

| Suite                                        | Exit | Counts                              |
| -------------------------------------------- | ---- | ----------------------------------- |
| full DB vitest, shard 1/2                    | 0    | 577 files; 6371 passed, 1 skipped   |
| full DB vitest, shard 2/2                    | 0    | 577 files; 7858 passed              |
| test:actor-off                               | 0    | 141 files; 1424 passed, 1 skipped   |
| test:actor-on                                | 0    | 34 files; 413 passed, 1 skipped     |
| test:edit-on                                 | 0    | 46 files; 583 passed                |
| test:matrix                                  | 0    | 4 files; 8 passed                   |
| test:runtime-role in full                    | 0    | 294 files; 2924 passed, 1 skipped   |
| test:serial (new)                            | 0    | 1 file; 1 passed                    |
| full DB vitest, MANTLE_NARROW_SYSTEM=0       | 0    | 1154 files; 14229 passed, 1 skipped |
| the drill (N-1, production, per-database)    | 0    | every migrate step 0 (above)        |
| the narrow cells (5 files, targeted)         | 0    | 5 files; 78 passed (on 235bacf14)   |
| the cells on the old patch (2 files)         | 1    | 7 failed, as above (on 8121ffc3c)   |
| a2a-round-trips.db.test.ts, MANTLE_RT_REPORT | 0    | the numbers above (on 235bacf14)    |

The first full round on d0ff46dfd had two failures, each a timing flake of
the load (six lanes at once), each rerun 0: shard 1/2's
turn-create-home.db.test.ts afterAll (closeDb and the scratch drop) over
its 10 s hook budget (the file took 19 s under the load; alone, six runs
on the branch and six on 33bbc0a8e, 10 s each, no timeout, no busy line in
the log), and the switch-off run's spend-budget.db.test.ts "a narrated
status line counts" (it waits 200 ms for the trace write; with the switch
off, six runs alone all passed). Shard 1/2 and the switch-off run again,
two lanes: the counts above. The targeted runs and the round trips ran on
235bacf14 (d0ff46dfd less one line of docs/process-inventory.md); the
old-patch run on 8121ffc3c, whose code outside the test files is
d0ff46dfd's (its cells then ended two pools before their pipelines were
done, which 235bacf14 fixed in the cells; the old patch's 7 failures are
the queued reserves, each pending before that point).

### Open items

1. postgres.js: a reservation released after its pool's `end()` began goes
   back to the open queue and is never ended, so that `end()` never
   finishes (seen once here: a cell ended a pool while a pipeline's RESET
   was still out; the cells now wait for the pipelines first). closeDb
   waits for every pipeline before it ends a pool (`actorPipelinesDone`),
   and every other lease goes back before its caller has its answer, so
   closeDb does not meet it. Not patched (outside MED-A); one line in
   `reserve()`'s release (terminate when the pool is ending) if the CEO
   wants it.
2. A box whose postgresql.conf sets one of the pinned settings would not
   see it on the narrow pool (the startup parameter wins). Compose sets
   none.
3. The user role's pool limit (the fix round's open item 1) is still for
   the CEO to place.
4. Per-database mode keeps the S7a route (no login for the role).

## b1 fix round 3

After the b1 re-audit 2 at a76241a46 (8.5/10, merge after fixes; MED-A
closed and proven, LOW-A, LOW-B and LOW-C closed; no HIGH or MED). Same
branch, a fresh builder, on d0a207d2a (main had not moved).

### What changed, by audit item

- LOW-1, the bound per pool (CEO decision). reserved.ts: `RESERVE_WAIT_MS`
  is 120 s, the default wait of `reserveLease`, taken by the system pool
  (the actor client's pipeline, actor-sql.ts `settingsPipeline`), the user
  pool (scope.ts `withLease`, a turn's scoped statements), the
  per-database narrow route (narrow-route.ts, the system pool's
  connections) and the index builds (concurrent-indexes.ts): long, so it
  only catches a reserve that never settles. `NARROW_RESERVE_WAIT_MS` is
  15 s, taken only by the narrow login pool (`settingsPipeline` takes a
  `wait`; narrowLoginStatement passes `{ pool: 'narrow' }`). The write
  pool keeps its own 15 s and `WritePoolBusyError` (role-tx.ts
  `boundedReserve`). The busy log line names the pool. The busy text:
  `PoolBusyError` lives in pg-error.ts beside a new `POOL_BUSY_MESSAGE`
  ("The server is busy; try again in a moment.", the text the write
  pool's error already had; `WritePoolBusyError` now extends it), and
  `busyMessage(err, fallback)` returns it when a pool's wait ran out
  anywhere on the cause chain (drizzle wraps a read's error), else the
  caller's text as before. Used by the app's 409 (server/web/server/app-error.ts),
  the tools' refusal (packages/tools/src/visibility-refusal.ts), the tree's
  conflict and move answers (packages/content/src/tree/write.ts) and
  `withBusyRetry`. Before, a pool busy under drizzle's wrap answered the
  folders text.
- LOW-2, a late reserve after the end. patches/postgres@3.4.9.patch (src,
  cjs and cf index.js): `reserve()` refuses while the pool is ending
  (CONNECTION_ENDED); `end()` refuses every reserve still queued
  (`endReserves`, the other queued requests kept in order), and the close
  (`onclose`) does the same while ending instead of connecting for one; a
  reservation handed back after `end()` began ends its connection
  (`c.terminate()`, which settles that connection's end) instead of going
  back to the pool (the builder's open item 1: `end()` never finished).
  `pnpm install --frozen-lockfile` applies it (exit 0); the lockfile's
  patch hash 740f22bb... to 5f9e8433....
- LOW-3, more pins. pools.ts `NARROW_STARTUP_FIXED` adds `exit_on_error`
  off (any error would end the session), `synchronous_commit` on (a commit
  returns once durable), `array_nulls` on, `transform_null_equals` off,
  `xmloption` content and `gin_fuzzy_search_limit` 0 (each changes what a
  statement reads or writes). `timezone_abbreviations` is taken from the
  system pool with TimeZone, DateStyle, IntervalStyle and
  standard_conforming_strings (it changes how a date's zone is read, and
  is a box-level setting like TimeZone). The comment and
  docs/runtime-role.md now say what is true: a chosen list, not every
  setting a session can carry; any other stored setting reaches narrow
  sessions until the next migrate, and the boot line names it.
- Nits. The system values: narrow-route.ts `systemStartup` reads
  `pg_settings.reset_val` once per system pool (the value a session of it
  starts with: server, database and role settings and the pool's own
  startup, never a session or transaction SET; postgres.js's
  `sql.parameters` followed every SET of any connection) and keeps it;
  pools.ts `newNarrowPool` takes it at each connect (`systemStartupOf`).
  Fail closed: a read that fails, or misses a name, fails the narrow
  statement (`NarrowStartupError`) and nothing is sent on the narrow pool;
  the next statement reads again. One statement per process, its first
  narrow statement. `pnpm verify` runs `pnpm test:serial` last.

### Cells

| Cell                                                                                         | Where                                                 | Old patch | New |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------- | --- |
| an ending pool reserves nothing, refuses a reserve queued as it ends, no backend left        | reserve-queue.db.test.ts                              | fails     | ok  |
| a reservation handed back after the pool's end began ends, and the end returns               | reserve-queue.db.test.ts                              | fails     | ok  |
| a CLI (child process): pipeline asked as closeDb begins, long statement holds the pool       | reserve-queue.db.test.ts                              | fails     | ok  |
| the waits per pool on the real route: narrow busy at its wait, the system pool still waiting | reserve-queue.db.test.ts                              | ok        | ok  |
| the waits: 120 s default (pending at 119.999 s), 15 s narrow; settingsPipeline both ways     | reserved.test.ts (fake timers)                        |           | ok  |
| each reserve names its wait (only the narrow login pool the short one; write pool its own)   | reserved.test.ts                                      |           | ok  |
| busy text: a pool's wait under drizzle's wrap is the plain text; others keep theirs          | reserved.test.ts, server/web/server/app-error.test.ts |           | ok  |
| every pinned setting stored by the narrow login (20 names): raw session takes it, pool pins  | narrow-login.db.test.ts                               |           | ok  |
| startup from the system pool's session-start values; a session SET timezone does not leak    | narrow-login.db.test.ts                               |           | ok  |
| systemStartup fails closed (read fails, a name missing), reads once, then never again        | runtime-role.test.ts                                  |           | ok  |

On 37a21a3b3's patch reverted to a76241a46's (PATCH_FROM, a fresh clone),
the CLI cell is the auditor's shape exactly: closeDb returned, the late
pipeline answered, 1 backend live and the process did not exit (killed by
its pid at 20 s). The reserve asked of an ending pool was handed a
connection, and the end with a reservation handed back late stayed
pending.

### Measured

Round trips (a2a-round-trips.db.test.ts, MANTLE_RT_REPORT, workstation
pg18, check off, statements / round trips, on 37a21a3b3): chat turn start
126 / 155, page save 17 / 21, member page save 21 / 27, tree load 13 / 17,
item open 9 / 12, search 23 / 30, MCP tool call 37 / 49: unchanged (the
session-start read is one statement per process, before its first narrow
statement).

### Changed answers

None for any member, client, key, peer or public link while every pool
answers in time. Below them, every caller that can now see busy, and
after how long (before b1 each of these but the write pool waited for
good; fix round 2 bounded all at 15 s):

| Caller                                                                                     | Pool, wait           | What it sees                                                                       |
| ------------------------------------------------------------------------------------------ | -------------------- | ---------------------------------------------------------------------------------- |
| a write as the actor outside a transaction, every process (web, workers, agent, MCP, CLIs) | system, 120 s        | PoolBusyError; a route 409 plain text; a worker's job fails and pg-boss retries it |
| a narrow statement with an actor outside a transaction (login pool)                        | narrow, 15 s         | the same                                                                           |
| a narrow statement in per-database mode (the role taken on the system pool)                | system, 120 s        | the same                                                                           |
| a member's or client's turn: every scoped statement, reads too                             | user, 120 s          | the same; a read now says the plain text, never the folders one                    |
| the index builds (migrate, maintenance)                                                    | system, 120 s        | the index counts as failed; the next run builds it                                 |
| a write on the write pool                                                                  | write, 15 s (as was) | WritePoolBusyError, its text unchanged                                             |

Narrow statements with no actor and narrow transactions take no reserve
(no bound, as before). A worker job fails busy only after a reserve that
never settled for 120 s, so a retry's repeated model work needs a pool
that stopped answering for two minutes.

- A pool's busy answer under drizzle's wrap: "The server is busy; try
  again in a moment." (was the folders text). A deadlock or lock timeout
  keeps its text.
- postgres.js: a reserve of an ending pool fails CONNECTION_ENDED (was:
  queued, then given a connection that outlived the end); a reservation
  handed back after the end began ends its connection.
- The narrow pool's sessions: six more pinned settings, and the system
  values are its session-start ones (were the last reported, which a
  session SET could change). A narrow statement fails closed when they
  cannot be read (was: connected without them).

### Pins

No pin moved (arch:check 0; scripts/arch-scoreboard.pins.json untouched
this round). The console calls stay 476: the busy line of every pool is
still the one `logPoolBusy`.

### Rollback (fix round 3)

No migration. Code and the patch only: an N-1 image runs its own.

### Gates

Mac, Node 26, DATABASE_URL unset, on fae48ca2d: `pnpm format:check` 0,
`pnpm docs:check` 0, `pnpm arch:check` 0, `pnpm lint` 0, `pnpm -r
typecheck` 0, `pnpm boot:smoke` 0, `pnpm -C server/web build` 0, `pnpm
test:serial` 0 (1 file skipped: no database), `vitest run server packages
eslint-rules` 0 (871 files passed, 284 skipped; 11297 tests passed).
`pnpm install --frozen-lockfile` with the new patch: 0.

Workstation, a fresh clone of the pushed fae48ca2d per suite, one pgvector
pg18 container each (label mantle.test=s7b-b1, max_connections=450, port
checked free, removed by exact name with its volumes), init-scratch and
migrate with MANTLE_CHECK_FLOOR=keep, systemd-run --user, test lanes,
--maxWorkers=3, MANTLE_NARROW_SYSTEM=1 unless said; the default suites are
the fresh-install shape (MANTLE_DB_RUNTIME_ROLE unset, the switch on):

| Suite                                        | Exit | Counts                              |
| -------------------------------------------- | ---- | ----------------------------------- |
| full DB vitest, shard 1/2                    | 0    | 578 files; 6381 passed, 1 skipped   |
| full DB vitest, shard 2/2                    | 0    | 577 files; 7858 passed              |
| test:actor-off                               | 0    | 141 files; 1432 passed, 1 skipped   |
| test:actor-on                                | 0    | 34 files; 413 passed, 1 skipped     |
| test:edit-on                                 | 0    | 46 files; 583 passed                |
| test:matrix                                  | 0    | 4 files; 8 passed                   |
| test:runtime-role in full (rerun, see below) | 0    | 294 files; 2928 passed, 1 skipped   |
| test:serial                                  | 0    | 1 file; 1 passed                    |
| full DB vitest, MANTLE_NARROW_SYSTEM=0       | 0    | 1155 files; 14239 passed, 1 skipped |
| the drill (N-1, production, per-database)    | 0    | every migrate step 0, as round 2's  |
| the new cells (5 files, targeted, 37a21a3b3) | 1    | 81 of 82: the cell fixed below      |
| narrow-login.db.test.ts (fae48ca2d)          | 0    | 17 passed                           |
| reserve-queue.db.test.ts on the old patch    | 1    | the 3 end cells fail, as above      |
| a2a-round-trips.db.test.ts, MANTLE_RT_REPORT | 0    | the numbers above (37a21a3b3)       |

The drill (main d0a207d2a and the branch, the same steps as round 2's):
every state equal to round 2's table (the narrow login refused after N-1,
its stored setting and its own password taken back by the branch's
migrate, no large object).

The first test:runtime-role run exited 1 on one cell under the load of
six lanes: a2a-round-trips.db.test.ts "the edit check on adds no
statement and no round trip" counted 162 round trips with the edit check
on and 161 off, the one more a narrow pipeline's RESET after the answer
(a statement sent after the caller's answer: counted or not by when the
window closes). The file alone in the same config, three times on
fae48ca2d: 0, 0, 0; the full suite again in a lane: the counts above.
The targeted run on 37a21a3b3 failed one cell of the stored-settings cell
(exit_on_error on ends the raw session, so the driver answered
CONNECTION_CLOSED, not 57014); fae48ca2d takes either.

### Open items

1. Plain statements (not reserves) queued behind a full pool when its
   `end()` begins are still served by upstream's close (it connects for
   the next one), and that connection then goes back to the open queue
   instead of ending (the same class as LOW-2, upstream's own). No
   caller of this package ends a pool with plain statements queued
   (closeDb waits for every pipeline first); not patched, to keep the
   graceful end. One line in `onclose` if the CEO wants it.
2. A box whose postgresql.conf sets a fixed pin would not see it on the
   narrow pool (the startup parameter wins; the system values follow the
   box). Compose sets none.
3. The user role's pool limit (fix round 1's open item) is still for the
   CEO to place.
4. Per-database mode keeps the S7a route (no login for the role).

## b1 delta audit and the last fix

The delta audit of fix round 3 (a76241a46 to 448848f1d) scored 9/10, merge.
Its LOW-A, fixed before the merge: withBusyRetry (pg-error.ts) and the
tree's refusing (packages/content tree/write.ts) ran a write once more on
any busy error, a pool's wait run out too, so a save or a tree op could
wait the whole 120 s bound twice. isPoolBusy (pg-error.ts, the cause chain
as busyMessage reads it) now answers busy on the first run out, with
POOL_BUSY_MESSAGE; the second run stays for deadlocks and lock timeouts.
Changed answer: the write pool's run out (15 s) is also not run again, so
a save that waited 30 s on main before busy now waits 15 s. Cell:
pg-error.test.ts "a pool's wait run out is not run again, even wrapped by
drizzle".

Left for later (upstream postgres.js, unchanged by b1, no caller reaches
them): end() can resolve with one backend live when a plain statement is
queued behind a full pool at end(); end() never resolves when an in-use
reservation's connection dies after end() began. closeDb waits for every
pipeline first, so neither is reached today.
