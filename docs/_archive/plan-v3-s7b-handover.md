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
