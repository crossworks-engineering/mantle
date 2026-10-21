# Fresh signup: the first owner's exit (handover)

Branch `feat/fresh-signup`, rebased on main at v0.300.128 (first built on
v0.300.127). Not merged, not
tagged, not rolled. Dev-brain task d5289a8b.

## The bug

Every fresh install on current releases could not create its owner:
`POST /api/auth/signup` answered 503 `not-switched`, the web process
stopped, and its restart refused to serve ("this brain is not on
workspaces (no workspaces yet)"). Existing brains were not affected (they
are switched already; their signup answers 403).

Cause, measured: the signup made the owner, then ran the workspaces switch
(`mantle_ws_migrate_locked`, through `executeAsMigrator`) inside the request,
whose actor is the gate's `system:http:no-login`. With the runtime role
OFF (the published image's default, and the client e2e's setup) the switch
went out as `db.execute` of a bare select, and the actor client sends the
actor only with a write or inside a transaction, so the switch's writes
(`mantle_lock_heads` inserting `node_acl_head`) met the actor check (on
after the checks' floor) with no actor: "INSERT on node_acl_head with no
actor". With the runtime role ON the switch did run (executeAsMigrator
sets the bound actor on the migrator's connection), but as
`system:http:no-login`, a request actor that names no work. The boot's
switch works because `systemWork('boot:migrate-workspaces')` binds a
workspace system actor, whose every statement is sent with its actor; and
`systemWork` refuses a request, so the signup could not use it.

## The fix

- `packages/db/src/viewer.ts`: a third request system exit,
  `first-owner` (`RequestSystemWhy`), routed **full** in
  `REQUEST_SYSTEM_ROUTE` (typed: every why picks), its actor reason in the
  new `REQUEST_SYSTEM_REASON` (`first-owner-attach`; `area` and
  `login-self` moved there from `noteRequestSystem`, unchanged).
  `noteRequestSystem` cannot take `first-owner`. `enterFirstOwnerExit(fn)`
  runs `fn` as `system:first-owner-attach` on the full route with any
  request scope masked, for that call only, and refuses before `fn` runs
  unless: inside a request slot; no scope of any kind and nothing the
  session guard let through; the request's actor is still the gate's
  `system:http:no-login`; first use in this request. Not in `index.ts`.
- `packages/db/src/first-owner-exit.ts`: `firstOwnerSwitch(loginId, fn)`,
  the exported entry: inside the exit it reads the brain and refuses
  unless its one login is `loginId`, the anchor, and it has no workspace.
- `server/web/lib/workspaces-migrate.ts`: `migrateWorkspacesQuietly(when,
loginId)` runs the switch through `firstOwnerSwitch` when a first owner's
  id is given inside a request (the signup). Outside a request (the
  terminal wizard, `scripts/onboard.ts`) the switch runs as that process's
  own actor (`system:script:onboard`), as the boot's runs as its
  `systemWork`. The assistant attach still runs in the new owner's own scope.
- `packages/db/src/gateway/handles.ts`: `executeAsMigrator` with the runtime
  role off runs the switch in a transaction of its own on `db`, which sends
  the bound actor first, as the runtime role path always did. Without this
  no actor reaches the switch with the role off, whatever is bound.
- No migration: the SQL allowlist of workspace system work
  (`mantle_ws_system_work`) does not need the pair. The switch calls none
  of its definers (the boot's actor is listed only for the assistant
  attach, and the boot's switch works), and the attach that follows runs
  in the owner's scope. No change to what a member, client, key, peer or
  public link may do.

## Proof

`server/web/server/ws-fresh-signup.db.test.ts` (8 cells; in the full DB run,
`test:actor-on`, and CI's runtime-role subset by its `/ws-` name). A fresh
scratch brain, `mantle_set_actor_check('on')`, a test-only trigger that
records `mantle.actor` for each workspace row made:

- the box is fresh with the check on;
- the exit refuses: outside a request; in a request a login made; in a
  request whose actor is a guard's system reason; inside another exit; on a
  brain with no login (and `fn` never runs);
- inside a request it binds `system:first-owner-attach` on the full route,
  the request's actor is `system:http:no-login` before and after, and a
  second use in the request refuses;
- `POST /api/auth/signup` answers 200 `{ok: true}`: one login, the anchor,
  an admin; the brain on workspaces (`mantle_ws_skip_reason()` null); only
  the Admin workspace, owned by the owner, the owner a Moderator in it;
  every workspace row the switch wrote was written as
  `system:first-owner-attach`; no actor miss;
- a second signup: 403, unchanged;
- the exit refuses on the switched brain, the owner's own id included;
- the boot's switch on the switched brain changes nothing, unchanged;
- the terminal wizard's first owner (no request, `system:script:onboard`)
  on a second fresh brain: switched, written as `system:script:onboard`.

On main (the test commit alone, before the fix), on the workstation:

- runtime role off: 2 failed. The signup cell: `expected [ 'no workspaces
yet' ] to deeply equal []` (the route answered `not-switched`; log
  `[workspaces] first owner: failed: Failed query: select * from
"public"."mantle_ws_migrate_locked"()`). The boot cell then found the
  brain unswitched and switched it.
- runtime role on (`test:runtime-role`): the signup switched, but the actor
  cell failed: `expected [ 'system:http:no-login' ] to deeply equal [
'system:first-owner-attach' ]`.

With the fix: 8 passed in each of: full (role off, narrow on), narrow off
(`MANTLE_NARROW_SYSTEM=0`), `test:actor-on`, `test:runtime-role`, and
`test:runtime-role` with narrow off.

## Fresh install end to end (workstation)

The client e2e recipe, on an own docker network `fsu-net` with containers
`fsu-e2e-<tag>-{pg,os,brain}` (pgvector pg18 `max_connections=450`, the
project's RustFS mirror, the server image), brain on `127.0.0.1:55948`:

1. `docker run pgvector/pgvector:pg18` (`POSTGRES_PASSWORD`), the object
   store, then `cat /app/infra/postgres/init/*.sql` from the image into psql.
2. In the image: `pnpm -C packages/db migrate && pnpm -C server/web
pgboss:init && pnpm -C server/api provision && pnpm -C packages/storage
objectstore:ensure` (`NODE_ENV=production`, fresh `MANTLE_MASTER_KEY`
   and `SESSION_SECRET`, S3 to the store). `mantle_actor_check_mode()` is
   then `on` (the image's floor).
3. Start the image as the e2e does (no `MANTLE_DB_RUNTIME_ROLE`), wait for
   `/api/version`, then `POST /api/auth/signup` with an email and password.

Results:

- `titanwest/mantle-server:v0.300.127` (main): 503 `not-switched`; brain
  log `[workspaces] first owner: failed: Failed query: select * from
"public"."mantle_ws_migrate_locked"()`; Postgres `mantle actor check:
INSERT on node_acl_head with no actor`; one login, no workspace.
- The same image with this branch's six changed runtime files copied over
  it (`viewer.ts`, `first-owner-exit.ts`, `index.ts`, `gateway/handles.ts`,
  `workspaces-migrate.ts`, `auth/first-owner.ts`; the server runs from
  source under tsx, so this is the branch's server): 200 `{"ok":true}`;
  one login, the anchor; `admin` the only workspace, the owner its
  Moderator; `mantle_ws_skip_reason()` null; no actor miss; brain log
  `[workspaces] first owner: migrated onto workspaces`.

Again on the head rebased on v0.300.128 (no image is published for it):
the same fresh install with the server run from the clone
(`pnpm -C server/web exec tsx server/main.ts`, the image's command,
`NODE_ENV=production`, `MANTLE_CHECK_FLOOR=raise`, no runtime role): check
mode `on`, signup 200 `{"ok":true}`, one anchor, `admin` the only
workspace with the owner its Moderator, on workspaces, no actor miss; the
route table below answered the same.

## The public and first-run write routes (fresh brain, check on)

On the fixed brain above (runtime role off, as the image runs), after the
signup. `actor_check_misses` stayed 0 throughout, and neither the brain
nor Postgres logged an actor error.

| Route                                              | Caller               | Answer                               |
| -------------------------------------------------- | -------------------- | ------------------------------------ |
| POST /api/auth/signup                              | no login             | 200 (fixed here); a second one 403   |
| POST /api/auth/login                               | no login             | 200                                  |
| POST /api/onboarding step, profile (with a locale) | the new owner        | 200 `{ok: true}`                     |
| POST /api/onboarding provision                     | the new owner        | 200 (no key yet: nothing made)       |
| POST /api/onboarding infra, sanity                 | the new owner        | 200                                  |
| POST /api/team-admin/invites                       | the owner            | 201                                  |
| GET /api/auth/invite/:code                         | no login             | 200                                  |
| POST /api/auth/invite/accept                       | no login             | 200, the member signed in            |
| POST /api/auth/token, mobile-login, device-login   | no login             | 200 each                             |
| POST /api/auth/token/refresh                       | bearer               | 200                                  |
| POST /api/auth/mobile-logout                       | bearer               | 200                                  |
| POST /api/auth/pair, then /api/auth/pair/claim     | owner, then no login | 200, 200                             |
| POST /api/oauth/register                           | no login             | 404 until remote MCP is on; then 201 |
| POST /api/oauth/token (a bad code)                 | no login             | 400 invalid_request                  |
| POST /api/auth/change-password                     | the member           | 200                                  |
| POST /api/auth/logout                              | the owner            | 200                                  |
| POST /api/auth/sso                                 | no SSO configured    | 401                                  |
| POST /api/federation/query                         | no peer              | 401                                  |
| password reset                                     | none                 | no such route in this release        |

Not exercised: onboarding's assistant attach with a real persona (needs a
provider key; its scope path is covered by `ws-onboarding-attach.db.test.ts`),
the OAuth code exchange end to end, SSO, and federation with a real peer.

## Pins

- `requestSystemExits` 3 to 4 (the reason is in the pin's note): the first
  owner's exit, one use. `eslint-rules/rights-counts.mjs` counts each use of
  `firstOwnerSwitch` under `first-owner` (known, so
  `requestSystemExits_other` stays 0; full, so `requestSystemExits_narrow`
  stays 3), and fails arch:check when any file but `viewer.ts` and
  `first-owner-exit.ts` names its entry `enterFirstOwnerExit`. Nothing
  else moved. Re-measured after the rebase on v0.300.128: the same. The
  request exits bullet of `docs/actors.md` is one line, so the spec's line
  count (down only, 344 on main) does not move.

- Actor binders (`eslint-rules/actor-binders.mjs`), `viewer.ts` 7 to 6, a
  pin that went down: the first owner's exit would have been an eighth
  `runAsActor` call; instead `asSystem`, `systemWork` and the exit bind
  through one private helper (`runSystemExit`), the same expression the
  first two held inline.

## Hardening round

The audit at `53a620fe0` said merge, with five low findings and a note.
Each is fixed here with a cell, before the merge.

- **LOW-1, the exit ran any function.** `firstOwnerSwitch(loginId, fn)`
  ran whatever `fn` it was given as `system:first-owner-attach` on the
  full route, and `@mantle/db` exports it. Now `firstOwnerSwitch(loginId)`
  takes no function: inside the exit it runs the switch itself, the same
  call the boot runs (`mantle_ws_migrate_locked` through
  `executeAsMigrator`), and returns its rows. `migrateWorkspacesQuietly`
  calls it with the id only (`WsMigrateRow` is the exit's row type). Cell
  (`ws-fresh-signup.db.test.ts`): a function passed past the type by a cast
  is never run in any refusal; on the switched brain the exit refuses and
  the workspaces are unchanged. The request exits count
  (`eslint-rules/rights-counts.mjs`) now counts each call of
  `firstOwnerSwitch` as one exit and does not follow its login id as if it
  were a reason (with the id as its only argument the engine had followed
  `migrateWorkspacesQuietly` to its callers and read 2); a unit cell pins
  that (three callers of the wrapping function: still 1).
- **LOW-2, the brain check and the switch were not atomic.** Moot with
  LOW-1: no caller can put other work between them, and the check now
  runs in the switch's own transaction. `executeAsMigrator(query, guard)`
  takes an optional guard (a select whose `ok` must be true, else it
  throws its refusal and the query never runs), on both paths (runtime
  role off: `db.transaction`; on: the migrator's connection), through one
  helper so each path keeps its one statement site (the raw SQL pin of
  `handles.ts` stays 4). Read committed: a login committed between the two
  statements is not seen by the guard, but the signup's own 403 and the
  switch's skip of a brain with clients still stand.
- **LOW-3, `noteRequestSystem` refused `first-owner` at the type level
  only.** With a cast it bound `system:first-owner-attach` for the rest of
  the request, and an unknown value bound a system actor with no reason.
  It now throws at run time unless `why` is `area` or `login-self`, before
  it reads the slot. Cell (`viewer.test.ts`): `first-owner`, `admin-write`,
  an empty string and `undefined`, each cast, throw inside a request slot,
  leave no outcome, no route and the same actor; `first-owner` throws
  outside a slot too.
- **LOW-4, `runSystemExit` was a binder the pin did not see.** The actor
  binders count (`eslint-rules/actor-binders.mjs`) now counts its calls; a
  unit cell in `process-entries.test.ts` (its definition and a comment do
  not count, a call with type arguments does).
- **LOW-5, the comment on `executeAsMigrator`.** It said only the switch
  calls it; `server/web/scripts/backfill-conversation.ts` does too (ALTER
  TABLE ... DISABLE and ENABLE TRIGGER, which run in a transaction). The
  comment names both callers and says that, both paths being a
  transaction, CREATE INDEX CONCURRENTLY or VACUUM would fail through it
  with the role off as well as on (no caller sends one). The reviewed
  reason in `eslint-rules/heads-writers.mjs` says the same.
- **LOW-6, note only.** The `first-owner` bullet of `docs/actors.md` is
  one long line, kept so the spec's line count (down only) does not move.
  Left as it is.

Pin moves in this round:

- Actor binders, `packages/db/src/viewer.ts` 6 to 9, measured, with its
  note in the pin: no new binder; the count now sees the three calls of
  the private helper (`asSystem`, `systemWork`, the first owner's exit),
  so a fourth exit through it moves the pin.
- Nothing else moved: `requestSystemExits` 4 (`first-owner` 1), the raw
  write SQL pin of `handles.ts` 4.

## Gates and CI

See the final report of this branch's session for the exit codes and the
CI run.
