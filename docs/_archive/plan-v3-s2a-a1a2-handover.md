# Plan v3.2 S2a a1+a2: the users of a workspace in SQL (handover)

The branch `feat/s2a-a1a2` (one branch, one migration, one release, two
builder parts). The spec's rule is in [../actors.md](../actors.md),
sections 8, 9 and 15; this file holds the step's detail and its handovers.
Parts a1 and a2 are both built here, with the a1 audit's fixes (a1 audited
8/10, CONTINUE TO a2). The branch merges as one release, one migration.

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
  set to the login it is asked for (measured by reading the code: the call
  was a plain `getAdminDb().execute`, no transaction, no setting, for every
  caller of `createHomeIntent`).
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

## Expected red until a2 (the ONE list; green after a2, see "DB tests (a2)")

Why: an Admin user's write on `/api/workspaces/*` takes
`noteSystem('admin-write')` before any scope (session.ts `anyLoginScope`),
so it reaches the definers with no acting login and a login actor. a1's
definers refuse that (`mantle_ws:no_acting_login`, a 500), and
`mantle_ws_create` too. a2's last commit puts those writes in the login's
scope; the branch merges only after a2. Every cell below fails on an Admin
user's create, add, tick or removal (or, after one, on the state it left);
a member's cell is green.

`server/web/lib/workspaces.db.test.ts` (it calls the handlers itself: a
member's call now runs in its request scope as the gate runs it; an Admin
user's runs with no scope, as the gate's `noteSystem('admin-write')`):

1. who may add whom: Moderators anyone; plain users nobody; Admin users anyone (S1)
2. the last Moderator can be neither removed nor demoted
3. only an Admin user ticks or clears Moderator, Team included (0286, decision 3.a)
4. Team keeps no Admin user (0286): demoted and removed like anyone
5. only an Admin user removes a Moderator; a plain user by a Moderator; anyone leaves (Q2)
6. the Admin workspace: adding a user is the admin role, removing it the member role
7. the Admin workspace: its checks run inside the role change, before the bridge (audit L2)
8. look: colour and icon by whoever may rename it, on every list (task 5edc9149)
   (cell 7's "back to a member" removal is refused, so its member stays an
   Admin user and sees the workspace this cell expects hidden)
9. the assistant is frozen once it has history (the same member, an Admin
   user since cell 7, creates a workspace with no acting login)

`server/web/server/f4-owner-flows.db.test.ts`:

10. every Admin user is a Moderator of Admin: never unticked there, an add is one
11. warn: round 4, making or unmaking an Admin user needs the users area
12. on: round 4, making or unmaking an Admin user needs the users area

`server/web/server/a6b-exit-sweep.db.test.ts`:

13. workspace-create: `POST /api/workspaces` as owner, adminAll and
    adminNoUsers answer 500 (recorded 201); the member cells are byte-equal.

**Red, not a1's (a bug on main the scoped test now meets).**
`server/web/lib/grants.db.test.ts` "move into a folder: edit the folder,
manage the item, confirm what it adds (S6)". The file now runs each write in
the login's request scope, as the gate runs every login's `/api/grants`
write (F4; `a6-grant-sweep.db.test.ts` does the same): unscoped, a1's
`mantle_workspace_event` refuses the grant's audit row. In scope, a
successful move into a folder fails on main as well: `followShares`
(`packages/content/src/tree/write.ts`) runs `mantle_embeds_reached` (0208,
an invoker function reading `node_embeds`, which no scoped role reads) as a
raw execute in the scope: `permission denied for table node_embeds`. The
grant sweep records no successful scoped move, so main had no cell for it.
Proposed as its own task (not fixed here).

## The a1 audit fixes (8/10, CONTINUE TO a2)

- **M2** (client.ts `wrapsStatement`): workspace system work sends EVERY
  statement with its actor, a read outside a transaction too. Before, only
  writes were wrapped outside a transaction, so a bare `select
  mantle_ws_...()` under `systemWork('ws-clear-ticks')` went with no
  `mantle.actor` and the definers refused it. Cell: "systemWork(ws-clear-ticks)
  sets mantle.actor ... in every check mode" now also reads the setting and
  calls a definer with `db.execute` outside a transaction.
- **M3, the decision**: the first owner (signup, `first-owner.ts`) and
  onboarding (`onboarding-provision.ts`) run the assistant attach **in the
  login's own scope** (the plan's path: the assistants area by
  `mantle_scope_has_area`), never as system work. No exception to
  `systemWork`'s "never inside a request" rule, and the SQL allowlist holds
  two actors, not four: `system:ws-clear-ticks` and
  `system:boot:migrate-workspaces`. `attachDefaultAssistants(loginId)` runs the
  call in a system-pool transaction with that login's `mantle.ws`,
  `mantle.mod_ws` and `mantle.scope_login` set (as `systemPoolTx` sets a
  write scope); signup passes the new owner's id, onboarding
  `configuredBy ?? ownerId`. Cells: `workspaces-migrate.db.test.ts` (signup's
  attach logs no failure; onboarding's form attaches the persona on Admin, 1;
  no actor and no system work refused; the boot's form as `systemWork`), and
  the SQL cell "the assistant attach (a2)" in `ws-user-definers.db.test.ts`.
  Under `test:runtime-role` the onboarding cell is the "fresh install ends
  with the persona on Admin, runtime role on" cell.
- **L1** (`createHomeFallback`): `mantle.scope_login` is the login bound to
  the call (`boundLoginId`, viewer.ts: a login actor's, else the open
  scope's login, as an assistant turn names it); a call for another login,
  or with none bound, is refused in TS (`RuntimeFaultError`). Cells in
  `ws-user-definers.db.test.ts`.
- **L2**: see "Counts".
- **L3** (`mantle_ws_create`): through `mantle_ws_acting_login`, as the user
  definers: a disabled acting login and a read-only caller are refused; a
  login other than the acting one says `mantle_ws:forbidden`.
- **L4** (`dbClientLines`): 3142 on main, 3175 here, the offset kept with a
  reason line for the F auditor in the pin's note (every added line is a
  rule of the definers' callers only the gateway can hold until S5).
  `boundLoginId`, `withSystemPoolInWriteScope` and `carriedWriteScope` live in
  viewer.ts to keep client.ts down.
- **L5**: `ws-clear-member-ticks.ts`'s header, the `createWorkspace`, `wsRoute`,
  `workspaceCaller` and `workspaceWriteSystem` comments, and docs/actors.md
  section 9: the 0305 writers (users, resources, assistant, the attach)
  refuse no acting login but system work; the workspace row, the landing app
  and the archive write in TS until S2b.
- **L6**: `viewer.test.ts` "systemWork with a workspace reason refuses inside
  a request slot" (every reason of `WORKSPACE_SYSTEM_REASONS`; `fn` never
  runs).

## Part a2: what it does

All SQL in the same migration `0305_ws_user_definers` (re-runnable,
CREATE OR REPLACE only; no table, row or trigger changes):

- `mantle_ws_put_assistant(fn, owner, ws, current, next, actor, by)`: private
  (granted to no role). THE one SQL body that puts an assistant on a
  workspace or takes it off: `setAssistant`'s rules moved (the current one
  with history stays; a new one is a chat assistant of the brain, not another
  workspace's, not one with history elsewhere), the resource row, the unbind
  of a detached one with no history, the event rows.
- `mantle_ws_resource_seat` (private): the acting login, the workspace locked
  as `mantle_ws_user_seat` sees it, the area (connectors, or assistants for
  the assistant kind) by `mantle_scope_has_area`, archived refused.
  `mantle_ws_assistant_of(ws)` (private): the assistant now.
- `mantle_ws_resource_add(owner, ws, kind, ref, write)`,
  `mantle_ws_resource_set_write(owner, ws, kind, ref, write)`,
  `mantle_ws_resource_remove(owner, ws, kind, ref)`,
  `mantle_ws_set_assistant(owner, ws, agent)`: SECURITY DEFINER, PUBLIC
  revoked, the write role's (`WRITE_ROLE_FUNCTIONS`). The refusals in the
  order the routes answered in; each change writes its event row (the acting
  login as actor and `added_by`).
- `mantle_ws_attach_assistants`: SECURITY DEFINER, its inserts through
  `mantle_ws_put_assistant`. No acting login: `mantle_ws_system_work()` (the
  boot); one: the assistants area. Its rows are as before (no `added_by`, no
  event actor, `by: attach`). The runtime role's, as before.
- `mantle_ws_system_work`'s allowlist: plus `system:boot:migrate-workspaces`
  (and `WORKSPACE_SYSTEM_REASONS`); server/main.ts's workspaces step is
  `systemWork(..., 'boot:migrate-workspaces')` in the same commit (the
  snapshot copies kept a `runAsSystem` of their own, renamed
  `boot:snapshot-copies`).

TypeScript:

- `addResource`, `patchResource`, `removeResource`: the read in the caller's
  scope (`seeWorkspace`, `mayManageResource`: the 404 and the 403 before any
  change, as before), then one definer call in the caller's own transaction
  (`resourceDefiner`), one mapper (`wsRefusal`'s table, then
  `assistantError`'s constraints). The in-transaction re-read and lock are
  gone (the definer locks).
- Last commit: an Admin user's write on `/api/workspaces/*` enters the
  login's scope on the write role, as a member's does (session.ts
  `anyLoginScope`, `inLoginScopeForWrites`: the grants panel and the
  workspaces); `noteSystem('admin-write')` stays for the other any-login rows
  (keys, chat, pairings). `adminRoleChange` runs inside
  `withSystemPoolInWriteScope` (viewer.ts; client.ts `db` sends its reads to
  the system pool and opens each transaction with the request's write scope
  set: `mantle.ws`, `mantle.mod_ws`, `mantle.scope_login`), because the write
  role holds no right on `auth.users`, sessions or push devices, and the user
  definer inside checks the scope's login. Its "no role change" path runs the
  same way.
- The box script already counts "Admin workspaces with no assistant and no
  assistant removal event" (`admin_workspaces_without_assistant`, P1a).

**WsError codes (the new refusals and their answers, each as the route
answered before):** `resources_admin_only` 42501 (403 admin_only, "Only an
Admin user can change this workspace's resources."), `no_kind` P0002 (404),
`assistant_exists` 55000 and `connector_exists` 55000 (409
resource_exists), `invalid_id` 22023, `no_assistant` 22023, `no_connector`
22023, `no_write_tick` 22023 (400 invalid), `assistant_in_use` 55000 (409),
`assistant_has_history` 55000 (409), `connector_not_on` and
`assistant_not_on` P0002 (404 not_found). `mantle_ws:forbidden` from
`mantle_ws_create` (a login other than the acting one) and `read_only` /
`no_acting_login` / `not_brain` stay unmapped: faults, not answers.

**Changed answers: none intended.** Changed rows: an Admin user's create,
user change and resource change now carry the acting login on the write role
(the rows and events are as before; the request's outcome is the login's
scope, not `system: admin-write`).

## Counts

- Unscoped callers of `mantle_workspace_event` (the rule's count, taken
  with the rule on, the full DB vitest run on the workstation at 9750aae23):
  10, every one `server/web/lib/grants.db.test.ts` calling the grant
  handlers with no request scope (a test bypass: the gate puts every login's
  grants write in its scope). 0 from product code. After the test entered
  the scope as the gate does: 0. Miss rows in warn on dev: not read (this
  step touches no box and never the dev DB); the CEO reads them before the
  merge if wanted.
- Unscoped callers of `mantle_ws_private_workspace`: 0 in product code
  (`createHomeFallback` sets the login now); 14 test fixtures called it as
  the superuser with no setting, now with `mantle.scope_login` set to the
  login in the same call.
- The full DB vitest run at 9750aae23 (before the last two fixes): 13544
  passed, 24 failed in 5 files: the 13 cells above, `grants.db.test.ts` 10
  (the 10 unscoped calls, fixed by scoping the test; 1 left, the main bug
  above) and `a10-body-sweep` 1 (setModerator's 404 read, fixed).

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

On the Mac, `DATABASE_URL` unset, at d5c0d20c5: `pnpm -r typecheck` 0,
`pnpm lint` 0, `pnpm format:check` 0, `pnpm docs:check` 0, `pnpm arch:check`
0, `pnpm -C server/web build` 0, `pnpm exec vitest run server packages
eslint-rules` 0 (846 files passed, 258 skipped; 10937 tests). The first
unit run (1) caught the a10 body sweep's four `PATCH .../users/:loginId`
cells (setModerator had lost its read in the caller's scope), fixed.

On the workstation, own clone and pg18 container (port 56073), migrated
with `MANTLE_CHECK_FLOOR=keep`, `--maxWorkers=3`, at d5c0d20c5 (both checks
as the configs set them; the sweeps run their warn and on cells):

- `ws-user-definers.db.test.ts` 0 (alone); in every mode run below it passes.
- Full DB vitest 1 at 9750aae23: the counts above.
- `test:actor-off` 1: only a6b `workspace-create` (item 13).
- `test:actor-on` 1: item 13 and the grants move (not a1's).
- `test:edit-on` 1: items 10 to 13 and the grants move.
- `test:runtime-role` 1: items 1 to 13 and the grants move (2635 passed).
- `test:matrix` 0: 14608 cells, 9404 run, 9404 pass, 0 fail, 5204 not
  applicable (as on main).
- boot:smoke not run (no boot path changed).

CI (build-check, verify) on d5c0d20c5: failure, the 14 cells above only
(the 13 Admin cells and the grants move):
https://github.com/crossworks-engineering/mantle/actions/runs/39132687727

**Rebase.** Rebased onto origin/main 6ad35e465 (v0.300.91, a0 merged as
0304_login_facts). Main's one commit since the base (35861dbe9) is the
release commit, version fields only, so the gates above stand; the commit
hashes above are from before the rebase. After it: `pnpm arch:check` 0,
`pnpm docs:check` 0, the journal, arch-lints and wsRefusal unit cells 0.
0305 stays the next number (`when` 1790197620000, above 0304's).
