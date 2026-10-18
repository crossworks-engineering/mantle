# Plan v3.2 S2a a1+a2: the users of a workspace in SQL (handover)

The branch `feat/s2a-a1a2` (one branch, one migration, one release, two
builder parts). The spec's rule is in [../actors.md](../actors.md),
sections 8, 9 and 15; this file holds the step's detail and its handovers.
Part a1 is built here; part a2 is the next builder's.

## Part a1: what it does

Migration `0305_ws_user_definers` (journal `when` 1790197620000, above
0304's 1790197560000; the number is claimed at the merge, plan rule 3, and
`ws-user-definers.db.test.ts` holds the renumber proof).

- `mantle_ws_system_work()`: the one "system work" a workspace definer takes
  from a caller with no acting login. True only when no acting login is set
  (`mantle_scope_login_id()` null), no scope is open, `mantle.write_mode` is
  not `ro`, and `mantle.actor` is exactly one string of its allowlist. a1's
  allowlist is `system:ws-clear-ticks` (the command `ws:clear-member-ticks`).
  It is no prefix test: `system:workspace-write`, `system:admin-area`,
  `system:http:*`, `system:test`, `system:operator:*` and every other
  `AsSystemReason` are refused. PUBLIC revoked, granted to no role (the
  runtime role neither), called by the definers as their owner.
- `mantle_ws_acting_login(fn, owner)` and `mantle_ws_user_seat(fn, owner,
ws, acting)`: private helpers (as above). The acting login is
  `mantle_scope_login_id()`, an enabled login, on its brain (`owner` =
  `mantle_brain_id()`), never read-only (`mantle.write_mode` `ro` refused:
  a read key or a peer with Write off changes nothing). The seat locks the
  workspace row (FOR UPDATE) and says whether the acting login is a
  Moderator there or an Admin user with the users area
  (`mantle_scope_has_area('users')`: the scope's own login, Admin in the
  scope; never the bare `mantle_area_rule`). A workspace it may not see is
  `not_found`, as the screen answers.
- `mantle_ws_add_user(owner, ws, login, moderator)`,
  `mantle_ws_set_moderator(owner, ws, login, moderator, by)`,
  `mantle_ws_remove_user(owner, ws, login)`: SECURITY DEFINER, search_path
  `public, pg_temp`, PUBLIC revoked, the write role's
  (`WRITE_ROLE_FUNCTIONS`; the runtime role runs what a viewer role runs).
  The rules of `addUser`, `setModerator` and `removeUser` moved, refusal by
  refusal, in the order the routes answered in: a Moderator of the
  workspace or an Admin user with the users area manages its users; the
  Moderator tick, any Admin workspace change and removing a Moderator need
  the users area; Admin users stay Moderators of Admin; never the last
  Moderator; archived, already a user, the anchor out of Admin and a
  self-removal from Admin refused. Each writes its `workspace_events` row
  (the acting login as actor; system work: none, and `by` names the
  command). A refusal says `mantle_ws:<code>` with its SQLSTATE (42501 a
  right, P0002 nothing there, 55000 a state).
- `mantle_ws_create` (0293): refused with no acting login unless system
  work; a `login` other than the acting one is refused whether a scope is
  open or only its login is set (0293 checked only an open scope).
- `mantle_ws_private_workspace` (0272): only the acting login's own (`login`
  = `mantle_scope_login_id()`), or system work. `createHomeFallback` did not
  carry the login's write scope (a plain system-pool read, no settings): it
  now runs the call in a transaction of its own with `mantle.scope_login`
  set to the login it is asked for (measured: no caller of
  `createHomeIntent` had any setting on that statement).
- `mantle_workspace_event` (0279): refused with no acting login unless
  system work. Unscoped callers counted first: see "Counts" below.

TypeScript:

- `packages/db/src/viewer.ts`: `WORKSPACE_SYSTEM_REASONS` (`ws-clear-ticks`)
  and the closed type `WorkspaceSystemReason`, which only `systemWork` takes
  (`asSystem` with one fails typecheck: the `@ts-expect-error` cell in
  `ws-user-definers.db.test.ts`). `systemWork` refuses a workspace reason
  inside any scope, a system exit or transaction, or a request.
- `packages/db/src/client.ts` `actorParams`: the system pool sets
  `mantle.actor` for workspace system work in every check mode. It did not
  with the check off (`actorParams` returned null), so the definers would
  have seen no actor there; the cell "systemWork(ws-clear-ticks) sets
  mantle.actor ... in every check mode" runs in `test:actor-off` too.
- `server/web/lib/workspaces.ts`: `addUser`, `setModerator` and
  `removeUser` call the definers in the caller's own transaction (a
  member's on the write role), never inside `workspaceWriteSystem` (a cell
  proves the definer refuses `system:workspace-write`). TS keeps the read in
  the caller's scope (`seeWorkspace`: the 404 and which path), the call, and
  one mapper (`wsRefusal`: SQLSTATE plus message code to today's `WsError`,
  and the Admin workspace's last-Moderator check at commit). The Admin add
  keeps its early answer (`ADMIN_TICK_KEPT`, `mayChangeAdminUsers`) before
  the login is looked up and before `applyLoginChange`'s own checks (the
  anchor, the caller itself), as the route answered. `adminRoleChange` is
  one transaction: the definer runs first inside `applyLoginChange`'s
  (`firstInTx`), then the role, the login bridge (a no-op once the definer
  made or removed the row) and the lockout. `mayManageUsers`, `mayPromote`,
  the in-transaction re-checks, `userRow` and `otherModerators` are gone.
- `server/web/lib/workspace-ticks.ts` `clearMemberTicks`: its transaction
  runs as `systemWork('ws-clear-ticks')`, each clear a call of
  `mantle_ws_set_moderator(..., false, 'ws:clear-member-ticks')`.
- Lints: `eslint-rules/system-work-allowlist.mjs` pins
  `workspace-ticks.ts` (1, `ws-clear-ticks`); `arch-lints.test.ts` refuses
  a workspace reason string anywhere else, and in any `runAsSystem`,
  `systemActor` or `systemUnder` call, and caps the reasons at five.

**Changed rows, no changed answer.** An add to or removal from Admin through
the workspace screen no longer writes the login bridge's `bridge.login`
event: the definer makes or removes the row first, so the bridge changes
nothing (before, the bridge's row and event came first, then the upsert and
`user.add`). The `user.add` / `user.remove` row and the user row are as
before. In the drift case only (a login whose role and Admin row disagree),
leaving Admin by oneself is refused now (`self_demote`), as the role change
always refused it.

## Expected red until a2 (the ONE list)

Why: an Admin user's write on `/api/workspaces/*` takes
`noteSystem('admin-write')` before any scope (session.ts `anyLoginScope`),
so it reaches the definers with no acting login and a login actor. a1's
definers refuse that (`mantle_ws:no_acting_login`, a 500), and
`mantle_ws_create` too. a2's last commit puts those writes in the login's
scope; the branch merges only after a2. Every cell below fails on an Admin
user's create, add, tick or removal (or, after one, on the state it left);
a member's cell is green.

FILLED-IN-BELOW

## What a2 must do

- Resources and the assistant attach (plan v3.2 S2a a2): the definers
  `mantle_ws_resource_add`, `mantle_ws_resource_set_write`,
  `mantle_ws_resource_remove`, `mantle_ws_set_assistant`;
  `mantle_ws_attach_assistants` a definer through `mantle_ws_set_assistant`'s
  helper; the three allowlist actors `system:boot:migrate-workspaces`,
  `system:first-owner-attach`, `system:onboarding-attach` (in
  `mantle_ws_system_work`'s array and `WORKSPACE_SYSTEM_REASONS`, each
  caller moved to `systemWork`; server/main.ts's `runAsSystem` with
  `boot:migrate-workspaces` is refused by a1's arch-lints cell once the
  reason is in the list, so it moves in the same commit).
- Last commit: an Admin user's write on `/api/workspaces/*` enters the
  login's scope (session.ts `anyLoginScope`). Then `adminRoleChange`'s one
  transaction must run on the system pool WITH the caller's write scope set
  (the write role holds no right on `auth.users`, sessions, push devices),
  so `applyLoginChange`'s `db.transaction` must not route to the write role
  there, and its system path must set `mantle.ws`, `mantle.mod_ws` and
  `mantle.scope_login` as `systemPoolTx` does (today `loginWriteClient`'s
  system path, `adminSql().begin`, sets none). a1 did not add that switch:
  with no write scope to carry in a1 it could not be proved, and it sits in
  client.ts's gateway lines (S3, S4a hunks). The list above is then green.
- The pins of a2 (plan): `requestSystemExits_adminWrite` down,
  `scopeHoldsAdminCalls` down, `setAssistantCopies` 1 to 2,
  `workspaceTableRawWrites` down to what S2b holds, `sqlAreaRules` stays 3
  (its last two are S2b b3's Telegram asks).

## Counts

FILLED-IN-BELOW

## Pins (a1)

- `workspaceTableRawWrites` 16 to 9 (addUser, setModerator, removeUser,
  clearMemberTicks are definer calls).
- `workspaceTableWriterFns` 12 to 15 (the three user definers; the 15, each
  a rule or a named exemption, are `WRITERS` in `ws-user-definers.db.test.ts`
  and checked against the live catalog there; `mantle_ws_migrate_bridged`
  is the twelfth P1a found beyond the plan's 11, migrator only).
- `asSystemExits` 58 to 56 (addUser and removeUser left `workspaceWriteSystem`).
- `dbClientLines` 3142 to 3155 (`actorParams`, `createHomeFallback`).
- `actorsMdLines` 350 to 349.
- The SQL allowlist (`mantle_ws_system_work`) holds 1 actor, capped at 5
  (arch-lints cell over `WORKSPACE_SYSTEM_REASONS`).

## Gates (a1)

FILLED-IN-BELOW
