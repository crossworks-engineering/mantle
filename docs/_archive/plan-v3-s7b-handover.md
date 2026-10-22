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

## Part b2, round 1: the definers and the user pool's limit (handed over)

Branch feat/s7b-b2, from main at 7f2d12292 (v0.300.130, b1 merged). This
round lands the brief's first commits (the definers and the pool limit),
measures what the spots and the area routes need, and hands over before
the spot moves: each move is a design choice with changed answers to
record first (below), and the round's budget would not hold them, their
cells and the full suites. The switch's default is unchanged (prod off).

### What changed

- Migration `0314_acting_login_definers` (`when` 1790198160000, 60000
  above 0313's; renumber at merge): `mantle_tg_chat_set` and
  `mantle_access_key_revoke` with no scope refuse unless `session_user` is
  the runtime role, the narrow role or a superuser (the system pool's login
  with the runtime role on or off, and the narrow route's), then take only
  `mantle.acting_login` (42501 otherwise, nothing changes). In a scope the
  scope's own login rules, as before. The bodies are cafa14530's plus the
  session check (the b1 audit's LOW-1). Revert:
  rollback/0314_acting_login_definers.revert.sql, needed only for an image
  older than v0.300.130 (b1 already sends the acting login).
- The harness changes of b1 (5cfdc673b, dda5c68d6, 8e7a57b44) to
  admin-membership, file-home-chat-0313 and w7d-telegram: the handlers run
  inside a request exit, as the gate runs them, and the direct calls set the
  acting login.
- packages/db/src/acting-login-definers.db.test.ts (new): a system session
  (the narrow login; the superuser; the app's system pool, which is
  `mantle_runtime` under test:runtime-role) refuses none and another acting
  login and runs its own; the write role clearing its scope and setting the
  acting login itself is refused, "no scope, and not a system session"
  (E4), and with no setting at all; the user role refused; in a scope the
  scope's own login rules. The other definers that take a login with no
  scope (0314's header), each called with no scope and a login that is not
  this brain's, the counts of written rows read before and after in the
  call's transaction: 17 run and write 0 rows, `mantle_ws_private_workspace`
  and `mantle_ws_remove_user` refuse (42501); the narrow role may run none
  of the 8 readers. (A first shape read `pg_stat_xact_*` once and counted
  an earlier transaction's unflushed rows: 3 for `mantle_personal_space`, a
  plain SELECT. The before and after delta fixed the cell, not the code.)
- The user role's limit (b1 open item): `ROLE_CONNECTION_LIMIT.user` 30 to
  54 (viewer-roles.ts), sized as the narrow role's: 12 compose processes x
  3 (`VIEWER_POOL_MAX`) = 36, 4 stdio MCP servers x 3 = 12, 2 operator runs
  x 3 = 6. connection-ceiling.test.ts drops min() for both scoped roles and
  a new cell holds the sum to the limit, the total to 90% of
  max_connections and the total plus every headroom to max_connections;
  narrow-login.db.test.ts reads `rolconnlimit` 54 off the migrated role.
  Ceiling, measured: full shape 379 of 405 (was 373 with the user line held
  at 30), full with runs off 339, core 193 (unchanged); 417 of 450 with
  the stdio servers' write connections and the narrow and user headroom.
- docs/runtime-role.md "The acting login": the rule as it now holds;
  pairing.ts's comment.

### Changed answers

None for any member, client, key, peer or public link. At the definer
level: `mantle_tg_chat_set` and `mantle_access_key_revoke` with no scope
refuse a caller that is no system session, and one with no or another
acting login (42501), where they acted for the login passed. Every product
caller passes the request's own login from the narrow or system pool (the
assistants area's Telegram routes), or runs in the login's scope (the key
revoke). The user role may hold 54 connections where it held 30.

### The spots, measured and assessed (for the next round)

Every spot is a narrow exit's write of a content table (`writer:
'content'`, narrow 'read'). Each has a row in
server/web/server/narrow-area-routes.db.test.ts (the route with the switch
on) and the full DB run with the switch off; none moved this round.

| Spot               | What it writes                                                            | Move                                                                                                  |
| ------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| profile-row        | profiles: a login's own row (login-self), the brain's (settings, backups) | write role in the login's own scope (the own-login rule); the brain's row needs a scope holding Admin |
| peer-item          | nodes `mantle_peer` + heads, the peers area                               | definer or the Admin login's scope (decision A below)                                                 |
| secrets-root       | nodes `branch` (the Secrets root) + heads                                 | decision A                                                                                            |
| secret-item        | nodes `secret` + sealed row, the keys area                                | decision A                                                                                            |
| sender-contact     | nodes `contact` (and the Contacts root), the email area                   | decision A                                                                                            |
| docs-collection    | nodes (documentation items) made and removed by a collection              | decision A; a resync is brain-wide maintenance                                                        |
| promotion-space    | space_items of the promoted login's personal space                        | a definer beside the role change (one transaction), the acting login holding the users area           |
| agent-conversation | assistant_messages and digest nodes of a deleted assistant                | a definer, or stays (brain-wide)                                                                      |
| calendar-events    | nodes the calendar synced (events), on unsubscribe                        | stays, or the delete moves to the calendar worker (system work): a changed timing                     |
| integrity-delete   | any node and its traces, brain-wide (the integrity screen)                | stays for S7c: the operator's delete is brain-wide by design                                          |
| reembed            | every vector of the brain                                                 | stays for S7c (or system work): brain-wide maintenance                                                |
| console-tool       | whatever the tool writes (LOW-5)                                          | the tool runs as the Admin login's turn in its scope (as its assistant would), then drop              |
| pending-call       | whatever the approved tool writes (LOW-5)                                 | the same, as the approving Admin login                                                                |

Decision A (for the CEO): a structure item an area makes (the Secrets and
Contacts roots, a peer, a secret, a contact, a documentation item) either
(1) moves to the write role in the acting Admin login's scope, where its
create home becomes that scope's (the Admin workspace: a changed answer for
where it lands and who reads it), or (2) goes through one definer that
inserts a structure item of a listed type with its heads, from a system
session with the acting login holding the area (the 0314 rule), the
narrow role granted EXECUTE on it and no table. (2) keeps every answer;
the safer option, and the one the next round should build unless the CEO
picks (1).

### The area routes (measured, for the next round)

The route table (buildRoutePolicy over the manifest) holds 142 area rows
that write (effect 'write'): settings 57, connectors 38, assistants 26,
keys 11, users 10. A static sweep of every `*.db.test.ts` (a request path
matching the row, or an import of its route module) finds 76 no DB test
names: assistants 6, connectors 23, keys 6, settings 36, users 5. The
switch is on in every DB suite but the switch-off run, so a row a test
drives already runs narrow. The 76 include the brief's POST /api/calendar,
POST /api/email/accounts, PATCH /api/email/messages/:id, PUT
/api/email/accounts/:id/folders, POST /api/secrets/:id/reveal and POST
/api/pdf-passwords; POST /api/secrets, POST /api/docs/collections and
DELETE /api/calendar/:id are driven (narrow-area-routes.db.test.ts). The
mail tables are `writer: 'admin'` (narrow 'all'), so the mail routes
cannot meet a content refusal; the rows to drive first are those whose
handler writes a `writer: 'content'` table. The next round: a cell per
undriven row, switch on and off, answers equal (the brief's item 2), and a
unit sweep pinning the undriven list (down only).

### Gates

Mac, Node 26, DATABASE_URL unset, on 0ee7b25da: `pnpm format:check` 0,
`pnpm docs:check` 0, `pnpm arch:check` 0, `pnpm lint` 0, `pnpm -r
typecheck` 0, `pnpm boot:smoke` 0, `pnpm -C server/web build` 0, `pnpm
test:serial` 0 (1 file skipped: no database), `vitest run server packages
eslint-rules` 0 (871 files passed, 285 skipped; 11299 tests passed).

Workstation, a fresh clone of the pushed 0ee7b25da per suite, one pgvector
pg18 container each (label mantle.test=s7b-b2, max_connections=450, port
checked free, removed by exact name with its volumes), init-scratch and
migrate with MANTLE_CHECK_FLOOR=keep, systemd-run --user, test lanes,
--maxWorkers=3, MANTLE_NARROW_SYSTEM=1 unless said; the default suites are
the fresh-install shape (MANTLE_DB_RUNTIME_ROLE unset, the switch on):

| Suite                                     | Exit | Counts                              |
| ----------------------------------------- | ---- | ----------------------------------- |
| full DB vitest, shard 1/2                 | 0    | 578 files; 6384 passed, 1 skipped   |
| full DB vitest, shard 2/2                 | 0    | 578 files; 7862 passed              |
| test:actor-off                            | 0    | 142 files; 1439 passed, 1 skipped   |
| test:actor-on                             | 0    | 34 files; 413 passed, 1 skipped     |
| test:edit-on                              | 0    | 46 files; 583 passed                |
| test:matrix (rerun, see below)            | 0    | 4 files; 8 passed                   |
| test:runtime-role in full                 | 0    | 295 files; 2933 passed, 1 skipped   |
| test:serial                               | 0    | 1 file; 1 passed                    |
| full DB vitest, MANTLE_NARROW_SYSTEM=0    | 0    | 1156 files; 14246 passed, 1 skipped |
| the new cells, targeted (2 files)         | 0    | 18 passed                           |
| the new cells under the runtime role      | 0    | 2 files; 22 passed                  |
| the drill (N-1: b1 against the b2 schema) | 0    | every migrate step 0 (below)        |

test:matrix first ran beside five other lanes and failed only its time
budget (the tool cells 212.2 s against 210 s; every cell the oracle's
answer, as b1 fix round 1 met); main 7f2d12292 in the same config passed
(161 s), and the branch again beside one other lane passed (137 s).
serial and the switch-off run first failed to start (a host port taken
between the check and `docker run`, then the leftover container's name);
suite.sh now removes its own container by exact name before and after a
failed start, and both ran clean.

The drill (main 7f2d12292 = b1, and the branch), each migrate step: ledger
rows / md5 of mantle_tg_chat_set's body / the user role's rolconnlimit /
the narrow role's rolcanlogin:

| Step                                                     | Exit | State                          |
| -------------------------------------------------------- | ---- | ------------------------------ |
| init and migrate with main (b1), production, switch on   | 0    | 313 / b8266526... / 30 / true  |
| migrate with the branch (b2), production, switch on      | 0    | 314 / c1ab8138... / 54 / true  |
| migrate with main (N-1 boot on the b2 schema)            | 0    | 314 / c1ab8138... / 30 / true  |
| N-1: the narrow login, its own acting login (b1's shape) | 0    | runs, no row                   |
| N-1: the narrow login, another acting login              | 1    | 42501 only the acting login    |
| N-1: the system pool (superuser), its own / another      | 0, 1 | runs / 42501                   |
| migrate with the branch again                            | 0    | 314 / c1ab8138... / 54 / true  |
| the branch, production, switch unset                     | 0    | 314 / c1ab8138... / 54 / false |
| the branch, production, per-database mode                | 0    | 314 / c1ab8138... / 54 / false |

N-1 keeps 0314's body (its migrate does not know it) and sets the user
role's limit back to its own 30; b1 sends the acting login, so its
Telegram calls run. Rolling b2 back to b1 needs no revert.

### Pins

No pin moved (arch:check 0). The spots' pins move with the spots.

### Left for the next round, in the brief's order

1. The spot moves (decision A, then each row of the table above), the
   list only shrinking; LOW-5's two spots after the tool writes move.
2. The area-route cells (above).
3. The default on everywhere (`narrowSystemOn()` true unless
   `MANTLE_NARROW_SYSTEM=0|off|false`, read once at boot and logged), the
   kill switch in docs/runtime-role.md and docs/update-prod.md, fresh
   installs and per-database mode named.
4. Pins: asSystemFull floor, fullRouteSpots and fullRouteSpotCalls down,
   systemWholeOnFull 0, requestSystemExits on narrow.
5. The box counts the CEO must see at 0 before the fleet flip (rule 2,
   risk 8): `narrow_misses` narrow-content-write, narrow-cascade-delete
   and narrow-denied, and `fail_open_misses`, on every box
   (scripts/arch-scoreboard-box.sh).

## Part b2, round 2: the structure definer (handed over)

Same branch, a fresh builder, on main 7f2d12292 (main had not moved). This
round lands the first item of the CEO's order (decision A: one definer for
the structure items, and its spots), plus the calendar's synced events
through the same definer. The other spots, the area-route sweep and the
default flip are left (below). The switch's default is unchanged.

### What changed

- Migration `0315_structure_item_definer` (`when` 1790198220000, 60000
  above 0314's; a second file, not folded into 0314, so each has its own
  revert; renumber at merge): `mantle_structure_item(kind, op, login,
owner, items, fields)`. KIND is one of a fixed list that fixes the item's
  type, the area its writer must hold, the operations open to it and where
  a new one lands:

  | kind           | type          | area       | ops                  | lands at                  |
  | -------------- | ------------- | ---------- | -------------------- | ------------------------- |
  | secrets-root   | branch        | keys       | insert               | secrets                   |
  | secret-item    | secret        | keys       | insert update delete | secrets                   |
  | peer-item      | mantle_peer   | connectors | insert delete        | peers                     |
  | contact-item   | contact       | connectors | insert               | contacts                  |
  | docs-folder    | branch        | settings   | insert               | documentation or under it |
  | docs-item      | documentation | settings   | insert update delete | documentation or under it |
  | calendar-event | event         | connectors | delete               | (a synced event only)     |

  The caller: no scope, a system session (0314's session_user rule),
  `login` equal to `mantle.acting_login` (none or another refused), that
  login holding the kind's area (`mantle_area_rule`), `owner` this brain,
  not read-only. Insert takes the folder's heads (share), one row, a branch
  kind doing nothing on a branch already there; update sets title and tags
  when given, data, updated_at, then markContentChanged's extract reset and
  `node_ingested` (the two kinds that edit index no field for embed work
  only, so no other reset is open; the gateway throws on one); delete takes
  the heads of each item and its folder (update) and removes rows of the
  kind's type (for calendar-event only a synced one, `data ?
'external_account_id'`). Heads through `mantle_lock_heads_nested`. EXECUTE
  from PUBLIC revoked; migrate grants it to the runtime role
  (RUNTIME_SYSTEM_FUNCTIONS) and the narrow role (NARROW_SYSTEM_FUNCTIONS).
  Revert: rollback/0315_structure_item_definer.revert.sql (drops it; not
  needed for any rollback: no older image calls it).

- packages/db/src/gateway/structure-item.ts (exported from index.ts, not
  client.ts: content-changed.ts's notify.ts imports client.ts):
  `insertStructureItem`, `updateStructureItem`, `deleteStructureItems`. On
  the narrow route (`narrowRouteNow()`, pools.ts: the switch the system
  pool read when it opened and the exit's pick) one definer call in the
  system pool's own transaction (a savepoint inside an open system
  transaction); anywhere else the app's own statements as before (heads
  helper, insert or update with markContentChanged, delete). Not
  withSystemTx outside one: its scope hides a request exit's route and
  acting login from the statements inside (viewer.ts boundExitEntry), so
  the first run of the cells answered "only the acting login" from the
  system pool. The acting login is read outside the transaction and passed.
- The callers: server/web/lib/secrets.ts (root, create with the sealed row
  in the definer's transaction, edit, delete), packages/tools
  builtins-secrets.ts (secret_create's root), packages/content
  peers/registry.ts (create, delete), contacts.ts createContact,
  packages/email discover.ts (no wrapper), packages/files docs.ts (folders,
  insert, edit, delete, purge; no wrapper), packages/content events.ts
  deleteAllExternalEvents and packages/calendar manage.ts (no wrapper).
- FULL_ROUTE_SPOTS 13 to 7: peer-item, secrets-root, secret-item,
  sender-contact, docs-collection, calendar-events gone (viewer.ts,
  eslint-rules/as-system-routes.mjs FULL_ROUTE_SPOT_FILES). Left:
  profile-row, integrity-delete, promotion-space, reembed,
  agent-conversation, console-tool, pending-call.
- docs/runtime-role.md: the definer under the narrow role's spots.

### Cells (packages/db/src/structure-item.db.test.ts)

Each in an Admin area request exit of an Admin login (narrowRouteNow true),
against the same exit on the full route (the app's own statements):

- every listed kind made both ways: the row equal as the database holds it
  (`to_jsonb(n)` less id and timestamps: type, owner, title, slug, path,
  data, tags, embedding, home_ws, read_ws, write_ws); the roots made once,
  then a no-op on both routes; the narrow role holds no INSERT on nodes.
- a secret with its sealed row in the definer's transaction; an edit that
  feeds the index (summary, entities and a vector stamp dropped, `extract`
  stamped, embedding null) and one that does not, equal both ways; no such
  item null both ways; delete removes the item and its sealed row and
  leaves an id of another type.
- a calendar's synced events: removed on the narrow route, an event made
  by hand left though named; the full route as before; connectors held by
  a login with keys taken away, not by a login in no Admin workspace;
  insert refused for the kind.
- refused (42501): an unlisted kind (`note`, `branch`), an operation not
  open to the kind, a place the kind does not land at, another brain, a
  read-only caller; with no acting login and with another, on the narrow
  login and the superuser; a login with no Admin workspace and one with
  keys taken away (connectors still held); a scope login set; the write
  role and the user role with their scope cleared and the acting login set
  (no EXECUTE); the gateway on an exit of a login without the area. EXECUTE:
  narrow role yes, write role, user role and PUBLIC no.
- The area routes of the six spots (narrow-area-routes.db.test.ts rows:
  secrets POST, PATCH, DELETE; peers; docs collections; email discover
  contacts; calendar unsubscribe) pass with the switch on, through the
  definer.

### Changed answers

None for any member, client, key, peer or public link: the definer runs
only on the narrow route, where it writes what the full route wrote (the
cells). Below them: on an Admin area's narrow exit these writes are one
definer call per item (the session is the narrow login, not the system
pool's); a calendar unsubscribe on the narrow route removes only events a
calendar synced (it already named only those); off the narrow route the
update and delete statements also name owner and type (the ids were read
with them, so the same rows).

### Pins

fullRouteSpots 13 to 7, fullRouteSpotCalls 15 to 8 (reasons in
scripts/arch-scoreboard.pins.json). No other pin moved (arch:check 0; the
hand kind list count stays 0: the kinds are named apart from node types).

### The other spots, assessed (not moved this round)

| Spot               | Decision for the next round                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| profile-row        | the write role in the login's own scope if answers are byte-equal, else a definer (round 1's table)                                            |
| promotion-space    | a definer beside the role change (one transaction), the acting login holding the users area                                                    |
| agent-conversation | a kind of the structure definer is the natural home (delete of the assistant's digests by agent id) plus assistant_messages; or stays with why |
| integrity-delete   | stays for S7c: the operator's delete is brain-wide by design (cell: narrow-area-routes.db.test.ts row)                                         |
| reembed            | stays for S7c: brain-wide maintenance writing every vector (cell: its row)                                                                     |
| console-tool       | run the tool as the Admin login's turn in its scope, then drop, only if every answer stays equal                                               |
| pending-call       | the same, as the approving Admin login                                                                                                         |

calendar-events moved (above) rather than to the calendar worker: the
worker would change when the events go (a changed answer), the definer
keeps it in the request.

### Gates

Mac, Node 26, DATABASE_URL unset: `pnpm format:check` 0, `pnpm docs:check`
0, `pnpm arch:check` 0, `pnpm lint` 0 (one warning, an unused disable in
contact-sharing-routes.db.test.ts, not this round's), `pnpm -r typecheck`
0, `pnpm boot:smoke` 0, `pnpm -C server/web build` 0, `pnpm test:serial` 0
(1 file skipped: no database), `vitest run server packages eslint-rules` 0
on the head (871 files passed, 286 skipped; 11299 tests passed). The first
gate run had format 1 (docs.ts), lint 1 (two unused imports in the new
cell file) and typecheck 2 (the secret_create test's mocked insert took no
argument); each fixed, then 0.

Workstation, a fresh clone of the pushed commit per suite (c2fd9c4a6; the
head ffa45666a changes only structure-item.db.test.ts, see below), one
pgvector pg18 container each (label mantle.test=s7b-b2, max_connections=450,
port checked free, removed by exact name with its volumes), init-scratch and
migrate with MANTLE_CHECK_FLOOR=keep, systemd-run --user, test lanes,
--maxWorkers=3, MANTLE_NARROW_SYSTEM=1 unless said; the default suites are
the fresh-install shape (MANTLE_DB_RUNTIME_ROLE unset, the switch on):

| Suite                                         | Exit | Counts                              |
| --------------------------------------------- | ---- | ----------------------------------- |
| full DB vitest, shard 1/2                     | 0    | 579 files; 6388 passed, 1 skipped   |
| full DB vitest, shard 2/2                     | 0    | 578 files; 7864 passed              |
| test:actor-off                                | 0    | 143 files; 1445 passed, 1 skipped   |
| test:actor-on                                 | 0    | 34 files; 413 passed, 1 skipped     |
| test:edit-on                                  | 0    | 46 files; 583 passed                |
| test:matrix (rerun beside main, see below)    | 0    | 4 files; 8 passed                   |
| test:runtime-role in full                     | 0    | 296 files; 2939 passed, 1 skipped   |
| test:serial                                   | 0    | 1 file; 1 passed                    |
| full DB vitest, MANTLE_NARROW_SYSTEM=0 (head) | 0    | 1157 files; 14252 passed, 1 skipped |
| structure-item.db.test.ts (head)              | 0    | 6 passed                            |
| the touched files, targeted (10, d84fbd886)   | 0    | 85 passed                           |
| the drill (N-1: b1 against the b2 schema)     | 0    | every migrate step 0 (below)        |

test:matrix first ran beside five other lanes and failed only its time
budget (the tool cells 212.3 s against 210 s), as rounds before it met;
main 7f2d12292 and the branch c2fd9c4a6 then ran side by side, two lanes:
both 0, the tool cells 145.1 s and 145.2 s, and the same 46 known cell
lines (a8-known-failures.ts) in both logs. The first switch-off run on
c2fd9c4a6 failed only the new file's three gateway cells (1 file, 3 of
14253): they assumed the switch on. The file now forces the narrow route
(setNarrowSystemForTests, as narrow-login.db.test.ts does) and the
switch-off run on the head is the row above. The first targeted run (on
beee04297) failed six cells, every one "only the acting login": the
definer calls ran inside withSystemTx, which hides a request exit's route
and acting login (above); d84fbd886 fixed it in the gateway.

The drill (main 7f2d12292 = b1, and the branch), each migrate step: ledger
rows / md5 of mantle_tg_chat_set's body / the user role's rolconnlimit /
the narrow role's rolcanlogin: init and migrate with main 313 / b8266526...
/ 30 / true; the branch 315 / c1ab8138... / 54 / true; main again (N-1
boot on the b2 schema) 0, 315 / c1ab8138... / 30 / true, the narrow login
and the superuser each running their own acting login and refused another
(42501); the branch again, switch unset and per-database mode each 0, as
round 1's. N-1 never calls mantle_structure_item, so rolling b2 back to
b1 needs no revert.

### Left for the next round, in the CEO's order

1. The other spots (the table above); LOW-5's two after the tool writes
   move.
2. The area-route sweep: ONE table-driven sweep over the route table's
   writing area rows (round 1: 142, 76 undriven), each driven as an Admin
   user with the switch on and off, equal answers, no narrow refusal; a
   route it cannot drive listed with why; failing when a new writing area
   route has no entry.
3. The default flip as the last commit (`narrowSystemOn()` true unless
   `MANTLE_NARROW_SYSTEM=0|off|false`, read once at boot and logged; the
   kill switch in docs/runtime-role.md and docs/update-prod.md; fresh
   installs and per-database mode named).
4. Pins: asSystemFull floor, fullRouteSpots and fullRouteSpotCalls down,
   systemWholeOnFull 0, requestSystemExits on narrow.
5. The box counts the CEO must see at 0 before the fleet flip (round 1's
   list).

Open: a request exit's system transaction (withSystemTx) runs on the
system pool, not the narrow route, and without the acting login
(boundExitEntry hides the request exit inside the system transaction's
scope). Found by this round's first cell run; the structure gateway avoids
it. Whether other narrow request exits' transactions should take the
narrow route is for the CEO (it would widen what the narrow role meets).

## Part b2, round 3: the system transaction's exit and two more spots (handed over)

Same branch, a fresh builder, on main 7f2d12292 (main had not moved). This
round lands the CEO's first item (a system transaction inside a narrow
exit) and two of the remaining spots. The default flip is NOT in this
round (CEO, mid-round: the interim audit of 0314 and 0315 found two MEDs
that a fresh builder fixes first). The switch's default is unchanged.

### The system transaction inside a narrow exit, measured

packages/db/src/narrow-system-tx.db.test.ts reports, for each way a
system transaction's work reaches the database, who it ran as
(current_user / session_user), the acting login and the actor it carried.
Before the fix (run on 9e203b2ae, the code of 3711425c9):

| Inside withSystemTx                     | request exit (`area`)                 | asSystem('admin-area') exit | full exit (spot)  |
| --------------------------------------- | ------------------------------------- | --------------------------- | ----------------- |
| the transaction's own statements (tx)   | narrow / narrow, acting login, actor  | narrow, acting login, actor | system pool login |
| `db` (the open transaction)             | narrow, acting login, actor           | the same                    | system pool login |
| a nested withSystemTx (savepoint)       | narrow, acting login, actor           | the same                    | system pool login |
| a statement on the system pool itself   | system pool login, no actor, no login | narrow, acting login, actor | system pool login |
| a statement on `systemDb`               | system pool login, no actor, no login | narrow, acting login, actor | system pool login |
| `systemRouteNow()` / `actingLoginNow()` | null / null                           | narrow / the login          | full / null       |

So the premise that a write inside withSystemTx ran on the system pool's
own login held only in part: the transaction itself takes the narrow
route already (the route is chosen when it begins, in the caller's
context), but inside it the request's exit was hidden (viewer.ts
boundExitEntry read the request slot only when no scope was open, and the
system transaction is a scope): a statement on another connection (the
pool itself, `systemDb`) ran as the system pool's login with no actor and
no acting login, and any code that asks the route (`narrowRouteNow`, the
structure gateway; `actingLoginNow`) got none. An asSystem exit's route
was never hidden (its own store).

The fix: `runInSystemTx` keeps the request's exit on the system
transaction's scope (`Scope.requestExit`, taken from boundExitEntry when
the transaction opens, so a nested one inherits it), and boundExitEntry
reads it there. After (c60b0ce9c): every row of the request-exit column is
the narrow login with the acting login and the actor; the full exit is
unchanged. Cells (each switch-forced on): "a narrow exit: withSystemTx runs
as the narrow login with the acting login" (both exits, five ways, route
and acting login inside), "a full exit: withSystemTx stays on the system
pool" (spot and a full reason), and "a content write through the heads (a
withSystemTx) is refused, nothing written" (`mantle_lock_heads` 42501 on
both exits, the denial drained by the cell).

The other system transaction helpers (gateway lens): `withSystemTx` is
the only one that opens a scope (`runInSystemTx`); the heads helpers
(`withHeads`, `withSubtreeHeads`, `withNodeInsertHeads`,
`withNodeDeleteHeads`) and `refuseHiddenRows` are withSystemTx; the
login write gateway's system path and `systemPoolTxInScope` begin on
`getAdminDb()`, whose client picks the route at begin in the caller's
context (narrow on a narrow exit; `systemPoolTxInScope` runs only in a
login's scope, not an exit); `systemDb.transaction` (member-turn-ledger.ts)
takes the narrow handle in a scope; `brokerLockTx` is the raw pool (a
store broker's row lock, no write of content; outside every caller's
transaction by design); `executeAsMigrator` is the first owner's DDL (a
full exit). The structure gateway's own transaction (round 2's narrowTx,
which avoided withSystemTx because of this gap) is now withSystemTx.

Refusals the fix brings, measured with the switch on: the full DB vitest
with MANTLE_NARROW_DUMP, before (14c3b10eb, the code of 3711425c9) and
after (c60b0ce9c), one lane each: 0 narrow denials and 0 narrow write
counts in both; after, 1158 files passed (14255 tests); before, 1157 and
the probe file (it failed at its first line on that commit, a missing
import). The narrow uses differ only by the probe's own (+5 per exit
reason). So no driven path wrote content from another connection inside a
request exit's system transaction: no new spot, the list did not go up.

### What changed

- packages/db/src/viewer.ts: `Scope.requestExit`, `runInSystemTx`,
  `boundExitEntry` (above).
- packages/db/src/gateway/structure-item.ts: `narrowTx` is withSystemTx.
- Migration `0316_promotion_agent_definers` (`when` 1790198280000, 60000
  above 0315's; renumber at merge), each with 0315's caller rule (no scope,
  a system session, the acting login, its area, not read-only; refused
  42501):
  - `mantle_space_settle_promotion(login, target)`, the users area: what
    settleSpaceOnPromotion did (the shared and submitted items of the
    target's personal space back to private drafts, their bundles gone);
    refuses a target whose `auth.users.role` is not admin (the condition
    the app settles on, written first in the same transaction).
  - `mantle_agent_delete(login, owner, agent, conversation)`, the
    assistants area: what deleteAgent did (the digests' heads, the agent
    row locked, its messages and digests with its conversation, a pinned
    Telegram chat denied, the agent row deleted); owner this brain.
    Revert: rollback/0316_promotion_agent_definers.revert.sql (not needed for
    any rollback: no older image calls them). EXECUTE: the runtime role and
    the narrow role (RUNTIME_SYSTEM_FUNCTIONS, NARROW_SYSTEM_FUNCTIONS).
- packages/db/src/gateway/spot-definers.ts: `settlePromotionOnNarrow`,
  `deleteAgentOnNarrow` (on the narrow route one definer call; elsewhere
  undefined or null and the caller's statements run as before). Callers:
  packages/content member-space-login.ts, server/web lib/agents.ts.
  login-update.ts's role change transaction no longer wraps a spot.
- FULL_ROUTE_SPOTS 7 to 5: promotion-space and agent-conversation gone
  (viewer.ts, eslint-rules/as-system-routes.mjs). Left: profile-row,
  integrity-delete, reembed, console-tool, pending-call.
- packages/db/package.json: the `./runtime-role` subpath (the server/web
  cell forces the switch).
- docs/runtime-role.md: the two definers, the system transaction's exit.

### Cells

server/web/server/narrow-spots.db.test.ts (4): a promotion settled on the
narrow exit equals the full route (the items' sharing, review state,
submitted stamp and bundles, the count; a second call 0 on both); its
refusals (no admin target, another and no acting login, a login whose
areas take users away, through the app's exit too; EXECUTE narrow yes,
write, user and PUBLIC no); an assistant deleted with and without its
conversation equal both ways (the result, the agent, messages, orphaned
messages, digests), no such assistant null both ways; its refusals
(another and no acting login, another brain, a login without assistants
through the app's exit, the agent kept; EXECUTE narrow yes, write and user
no). narrow-area-routes.db.test.ts: DELETE /api/agents/:id without its
conversation, a new row (before, that path took `mantle_lock_heads` on the
narrow exit, refused as the heads cell shows); the row with its
conversation now goes through the definer. runtime-role.test.ts: the
allowlist names the two.

Not celled: the Telegram chat denied by mantle_agent_delete (the same
statement as deleteAgent's; a chat needs a Telegram account to set up).

### Changed answers

None for any member, client, key, peer or public link. Below them: inside
a system transaction of an Admin area or login-self request exit, a
statement on the system pool itself or on `systemDb` runs on the narrow
login with the actor and the acting login (it ran as the system pool's
login with neither), and code that asks the route sees the exit's;
DELETE /api/agents/:id without its conversation answers on the narrow
route (it met the heads refusal); a promotion's settle and an assistant's
delete are one definer call each on the narrow route.

### Pins

fullRouteSpots 7 to 5, fullRouteSpotCalls 8 to 6; sqlRoleReaders 14 to 15
(the promotion definer reads auth.users.role: reasons in
scripts/arch-scoreboard.pins.json).

### Rollback (round 3)

0316 adds two functions; an older image never calls them (no revert
needed). The viewer.ts change is code only.

### Gates

Mac, Node 26, DATABASE_URL unset: `pnpm format:check` 0, `pnpm docs:check`
0, `pnpm arch:check` 0, `pnpm lint` 0, `pnpm -r typecheck` 0, `pnpm
boot:smoke` 0, `pnpm -C server/web build` 0, `pnpm test:serial` 0 (1 file
skipped: no database), `vitest run server packages eslint-rules` 0 on the
code head (871 files passed, 288 skipped; 11299 tests passed). The first
unit run exited 1 on runtime-role.test.ts (the allowlist cell did not yet
name the two 0316 definers); fixed, then 0. The head after the code head
changes the handover and comments only (format, docs and arch again 0).

Workstation, a fresh clone of the pushed 6644a4a00 per suite, one pgvector
pg18 container each (label mantle.test=s7b-b2, max_connections=450, port
checked free, removed by exact name with its volumes), init-scratch and
migrate with MANTLE_CHECK_FLOOR=keep, systemd-run --user, test lanes,
--maxWorkers=3, MANTLE_NARROW_SYSTEM=1 unless said; the default suites are
the fresh-install shape (MANTLE_DB_RUNTIME_ROLE unset, the switch on):

| Suite                                           | Exit | Counts                              |
| ----------------------------------------------- | ---- | ----------------------------------- |
| full DB vitest, shard 1/2                       | 0    | 580 files; 6392 passed, 1 skipped   |
| full DB vitest, shard 2/2                       | 0    | 579 files; 7868 passed              |
| test:actor-off                                  | 0    | 144 files; 1448 passed, 1 skipped   |
| test:actor-on                                   | 0    | 34 files; 413 passed, 1 skipped     |
| test:edit-on (rerun, see below)                 | 0    | 46 files; 583 passed                |
| test:matrix (rerun beside main, see below)      | 0    | 4 files; 8 passed                   |
| test:runtime-role in full                       | 0    | 298 files; 2947 passed, 1 skipped   |
| test:serial                                     | 0    | 1 file; 1 passed                    |
| full DB vitest, MANTLE_NARROW_SYSTEM=0          | 0    | 1159 files; 14260 passed, 1 skipped |
| the drill (N-1: b1 against the b2 schema)       | 0    | every migrate step 0 (below)        |
| the dump runs (full DB vitest, before / after)  | 1, 0 | above (before: the probe file only) |
| the 0316 cells and the role readers (866778e9c) | 0    | 2 files; 7 passed                   |

test:edit-on first failed one file's afterAll hook (w6b-fix2.db.test.ts,
closeDb and the drop over 10 s beside five lanes; every test passed); the
rerun in a lane of its own passed. test:matrix failed only its time budget
twice (211.9 s, then 232.8 s, against 210 s, beside other lanes; every
cell the oracle's answer, as earlier rounds met); main 7f2d12292 and the
branch then ran side by side, two lanes: both 0.

The drill (main 7f2d12292 = b1, and the branch), each migrate step:
ledger rows / md5 of mantle_tg_chat_set's body / the user role's
rolconnlimit / the narrow role's rolcanlogin: main 313 / b8266526... / 30 /
true; the branch 316 / c1ab8138... / 54 / true; main again (N-1 boot on
the b2 schema) 0, 316 / c1ab8138... / 30 / true, the narrow login and the
superuser each running their own acting login and refused another (42501);
the branch again 0, switch unset 0 (rolcanlogin false), per-database mode
0 (false). N-1 never calls the 0316 functions: rolling b2 back to b1 needs
no revert.

### Left for the next round

1. The interim audit's two MEDs on 0314 and 0315 (the CEO's list, a fresh
   builder), BEFORE the default flip.
2. The spots left: profile-row (the login-self routes, the settings and
   backups areas: five write forms in profile-preferences.ts and two in
   backup.ts, the jsonb merge, the revisioned save and the counter bump;
   the write role in the login's own scope if byte-equal, else a definer),
   console-tool and pending-call (the tool run as the Admin login's turn in
   its scope, only if every answer is equal; else keep with why),
   integrity-delete and reembed (stay for S7c; their area-route rows are
   the cells).
3. The ONE table-driven area-route sweep (round 2 inputs): not started.
4. The default flip, LAST, after item 1 (not in this round, CEO).
5. Pins: asSystemFull floor, fullRouteSpots and fullRouteSpotCalls down,
   systemWholeOnFull 0, requestSystemExits on narrow; the box counts list.

### Open items

1. The dump runs counted 0 narrow write counts (narrow-content-write) in
   both runs, before and after; the counts need the actor check at warn or
   on in the scratch database, which this report did not confirm per file.
   The denials (0 in both, and a denial fails its test) do not depend on
   it.
2. mantle_agent_delete's Telegram chat deny is not celled (above).
3. A full exit (a spot inside a request exit) sends no acting login
   (`acting` empty in the probe's full column): onFullSystemRoute's own
   entry carries none. Unchanged by this round; the definers never run
   there.

## Part b2, round 4: the interim audit of 0314 and 0315 (handed over)

Same branch, a fresh builder, on main 7f2d12292 (main had not moved). This
round does only the interim audit's list (MED-1, MED-2, LOW-1 to LOW-7) and
the round 4 note. The remaining spots, the area-route sweep and the
default flip are round 5. The switch's default is unchanged.

Migrations: LOW-1 folded into 0314 (a new `mantle_system_session()`, the
one session check, called by 0314, 0315 and 0316: it belongs with the rule
0314 made); LOW-2 and LOW-3 folded into 0315 (its own update and delete);
LOW-5 is a new `0317_narrow_observe_definer_frames` (`when`
1790198340000, 60000 above 0316's), since 0312 is on main already. None of
0314 to 0317 has run on a box. 0314's revert now also drops
`mantle_system_session` (revert 0316 and 0315 first, as their order says).

### The measurement (MED-1)

The full DB vitest, both shards, switch on, on 7b17a1d3f, each on a pg18
container started with `log_statement = mod` and a `%u@%d` line prefix
(~/s7b-b2/msuite.sh): every INSERT, UPDATE and DELETE the narrow login sent
(8285 statements; refused escape-cell statements are logged too). On the
credential and rights tables:

| Table               | What the narrow login sent (statements)                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| auth.users          | UPDATE session_epoch (35), password_hash (9), role (4), disabled_at (3); no INSERT, no DELETE                                                                |
| access_keys         | UPDATE revoked_at, revoked_by (35)                                                                                                                           |
| oauth_access_tokens | UPDATE revoked_at (38)                                                                                                                                       |
| mobile_tokens       | UPDATE revoked_at (43)                                                                                                                                       |
| oauth_auth_codes    | DELETE (38)                                                                                                                                                  |
| pairing_codes       | INSERT (3), DELETE (6)                                                                                                                                       |
| mantle_peers        | INSERT (10); UPDATE acts_as_login_id, ended_acts_as_login_id, write_enabled, allowed_risky_tools, inbound_token_hash, last_contacted_at                      |
| telegram_chats      | UPDATE allowlist_status, pairing_code, pairing_expires_at, pairing_replies, login_id (5)                                                                     |
| agents, tool_groups | agents INSERT (2), UPDATE assigned_user_id, tool_group_slugs, api_key_id, tts_worker_id; tool_groups INSERT (4), UPDATE tool_slugs, integration, description |
| api_keys, secrets   | api_keys INSERT (2), UPDATE last_used, key_enc; secrets INSERT (2), UPDATE ciphertext                                                                        |
| push_subscriptions  | INSERT (10), DELETE (58)                                                                                                                                     |

### What changed, by finding

- MED-1 (a), column rights. access-matrix.ts `NARROW_COLUMN_RIGHTS`, applied
  by migrate (runtime-role.ts `applyNarrowGrants`: SELECT, UPDATE of the
  listed columns, DELETE where listed, never INSERT). The narrow role may
  now write, per table: auth.users UPDATE (display_name, disabled_at,
  session_epoch) and DELETE; access_keys UPDATE (revoked_at, revoked_by);
  oauth_access_tokens UPDATE (revoked_at); mobile_tokens UPDATE
  (revoked_at). Never role, password_hash, email, is_owner, contact_id or
  id, no new login and no minted key or token. display_name is not in the
  measured list but the users area's PATCH writes it on the narrow exit
  (login-update.ts `changes`): kept, a label. What narrow work wrote and
  may no longer runs at a new full-route spot `login-credential` (the
  system pool's own login, as before b2): the users area's new login
  (login-create.ts, the transaction with `mantle_bridge_login`), a role
  change or a contact link (login-update.ts: the whole transaction, with
  the bridge and the promotion's settle), and a password set (session.ts
  `updatePassword`: the users area's reset and a login's own change).
  Pinned: runtime-role.db.test.ts (the live column grants equal the map;
  no UPDATE or INSERT on any credential column of auth.users).
- MED-1, every other rights or credential table the narrow role may write,
  decided (NARROW_CREDENTIAL_TABLES):
  - column-level now: auth.users, access_keys, oauth_access_tokens,
    mobile_tokens (above).
  - open for round 5 (each mints or redirects a way in, and narrow work
    writes exactly those columns, so column rights cannot split them; a
    definer is forgeable on the narrow login, so each needs a spot or the
    login's own scope): pairing_codes INSERT (a login-self pair code: a
    code for any login could be minted), oauth_auth_codes (DELETE measured;
    an INSERT path, /api/oauth/authorize, not driven narrow by any suite),
    member_invites (INSERT by the users area, not driven narrow),
    mantle_peers with peer_shares and peer_share_scopes (acts_as_login_id,
    inbound_token_hash, write_enabled: a peer acting as a login),
    telegram_chats.login_id (a chat paired to a login).
  - kept 'all' with their why: the outbound credentials and configuration
    the areas write (api_keys, secrets, pdf_passwords, email_accounts,
    calendar_accounts, ms_accounts, microsoft_config, telegram_accounts,
    channels, tailscale_config, oauth_clients, embedding_config,
    push_subscriptions, spaces): none lets a login or a key into this
    brain; agents and tool_groups (an assistant's tool grants, not a
    login's): for the CEO with the round 5 list.
  - read or none, unchanged: contact_share_codes, private_workspaces,
    former_user_workspaces, space_item_homes, the archives, the heads key.
- MED-1 (b). `mantle_bridge_login` left NARROW_SYSTEM_FUNCTIONS and is
  denied by name (NARROW_DENIED_FUNCTIONS): its callers (a new login, a
  role change) run at `login-credential`, so no narrow reason calls it
  (measured: the only narrow callers were those two). The runtime role keeps
  it.
- MED-1 (c). packages/db/src/narrow-containment.db.test.ts (new), on a
  switched brain (the switch's Admin with bridge_key 'admin', a real admin
  and a real member), raw statements on a narrow session: each credential
  column and each new login or credential row 42501, the measured columns
  allowed, the rights digest (auth.users, workspace_users, workspace_events
  count, access_keys, telegram_chats) unchanged; the audit's chain (any
  acting login named, the member's role raised, bridged, a structure item
  as it) refused at each step, the digest unchanged; the 21 definers that
  take a login with no scope plus mantle_structure_item and the two 0316
  definers, each called as the narrow role with the member as the login
  and the admin, then the member, as the acting login: refused or 0 rows
  written in the call's own transaction (pg_stat_xact delta), the digest
  unchanged.
- MED-1 (d). docs/runtime-role.md ("The narrow system role" rights,
  "The acting login"), and 0314, 0315 and 0316's headers: on the narrow
  login the acting login is a mistake guard; the database boundaries are
  kind, op, place, type, owner and the column rights.
- MED-2. viewer.ts `exitLogin`: an `asSystem` exit whose outer actor is no
  login acts for the login of the turn scope it leaves (a Telegram turn
  with the actor check off). gateway/structure-item.ts `structureRoute`:
  on the narrow route with an acting login, the definer; with none (a
  heartbeat's turn that answers no login), the app's own statements at a
  new spot `structure-no-login`. Cells: narrow-containment.db.test.ts, a
  turn as system(workflow:telegram-turn) and as the login: the definer's
  transaction is the narrow login with the turn's login as acting login;
  a turn with no login: the spot (the system pool's login, no acting
  login). Other narrow callers that need an acting login: the 0316
  definers (agents.ts, login-update.ts), `mantle_tg_chat_set`
  (agent-telegram.ts) and `mantle_ws_set_moderator` (workspaces.ts) are
  reached only from Admin area request routes, whose exit always has the
  request's login; `exitLogin` covers any turn caller too.
- LOW-1. `mantle_system_session()` (0314): session_user the runtime role,
  the narrow role, a superuser, or the definers' owner (session_user =
  current_user inside the definer). Cell: a definer owned by a
  non-superuser role answers true under SET SESSION AUTHORIZATION as that
  owner and as the narrow role, false as the write role.
- LOW-2. 0315 update: FIELDS must name `data` as an object, else 22023
  (was: a wipe to {}). Cell: three shapes 22023, the row unchanged.
- LOW-3. `deleteStructureItems(kind, owner, ids, match)`: the account id
  (events.ts deleteAllExternalEvents) and the collection key (docs.ts
  purgeCollection) are matched again under the heads on both routes (app:
  `data @> match`; definer: FIELDS' `match`). Cell: an event moved to
  another account and a doc of another collection between the read and the
  delete are left, on the narrow and the full route.
- LOW-4. narrow-containment.db.test.ts: an edit with a vector set first
  drops it on both routes, and both announce `node_ingested` the same
  number of times (heard on a LISTEN); 0314's own runs write on the narrow
  login (a real chat paired to the admin unpaired: status pending, login
  cleared); a real key revoked (the system session: the narrow role may not
  run the key revoke); 0316's Telegram deny (round 3's open item 6): an
  assistant's delete on the narrow login denies the chat pinned to it. Not
  done: the docs-item insert and update at route level with a real markdown
  file (round 5, with the sweep).
- LOW-5. 0317: both 0312 counts ask that current_user be the session's own
  role (the role it SET, else its login): a definer's frame is left out on
  every route. Cell (narrow-observe.db.test.ts): on the per-database shape
  (the narrow role SET on the superuser's session) a superuser-owned
  definer's content write and its delete count nothing; the role's own
  delete still counts; as the runtime role a definer's delete counts
  nothing; as the superuser with no role set the named limit holds.
- LOW-6. Cell: a structure write inside an open system transaction of a
  narrow exit (the savepoint branch) sees the narrow login and the acting
  login.
- LOW-7. packages/db/src/rollback-when.test.ts (unit): every revert's
  ledger `created_at` equals its own tag's journal `when`, so a renumber at
  merge that misses a revert fails the unit gate.
- Round 4 note. 0316's promotion definer reads auth.users.role: safe now,
  because no narrow column sets a role (the definer's own check that the
  target is an admin cannot be met by a narrow session's write), and the
  role change itself runs at `login-credential`. With the role change at
  the spot no narrow statement calls `mantle_space_settle_promotion` any
  more; it stays on NARROW_SYSTEM_FUNCTIONS (on a narrow session it can only
  take an admin's own personal items back to private drafts) for the CEO's
  call: drop it in round 5, or keep it for a signed acting login. Both 0316
  definers are in the MED-1 (c) loop as the narrow role.

### Changed answers

None for any member, client, key, peer or public link. Below them:

- On a narrow exit, a new login, a role change, a contact link and a
  password set run on the system pool's own login (`login-credential`),
  as before b2; the narrow login may no longer write those columns or make
  a login, a key, a token or a device token (42501).
- A structure item in a turn whose actor is no login: through the definer
  for the turn's login (was 42501 "only the acting login"); with no login
  at all, the app's own statements at `structure-no-login` (was 42501).
- `mantle_structure_item` update with no data: 22023 (was: data wiped to
  {}). A calendar's or a collection's delete leaves an item that left the
  account or collection between the read and the delete (was: removed).
- 0317: a definer's write or delete is not counted as narrow-content-write
  or narrow-cascade-delete.
- The definers' session check also takes the definers' owner.

### Pins

fullRouteSpots 5 to 7, fullRouteSpotCalls 6 to 10 (login-credential,
structure-no-login: reasons in scripts/arch-scoreboard.pins.json; the CEO
told). The spot lint (as-system-routes.mjs) reads `onFullSystemRoute`
imported from the viewer module inside packages/db. No other pin moved.

### Rollback (round 4)

0314 to 0316 as before (no older image calls the new functions; 0314's
revert drops `mantle_system_session` after 0316's and 0315's). 0317: an
older image runs with either trigger body; its revert puts 0312's back.
The column rights are migrate's: an older image's migrate grants its own
matrix back.
