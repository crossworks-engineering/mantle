# Plan v3.2 S8a: an Admin login is role AND membership (handover)

The branch `feat/s8a-admin-membership`, cut from main at 384b64d02
(v0.300.92). The spec's rule is in [../actors.md](../actors.md), section 6
("Who may do what"); this file holds the step's detail and its handover.

## What the step does

Plan v3.2 section 2.2 point 2. It narrows only: every change ANDs a second
condition to an Admin decision or moves an area ask to its SQL source.

- **The membership fact rides in the one login read.** `loadLoginRow`
  (`server/web/lib/auth/login-row.ts`) selects
  `mantle_login_is_admin(id)` as `adminMember`, next to the scope columns.
  No request gains a query.
- **One pair helper.** `adminLogin(row)` in
  `server/web/lib/auth/session.ts`: role admin AND `adminMember`. It is the
  one Admin decision on the role in session.ts. Its readers:
  `findOwnerAsset` (the `?at=` asset token), `findRender` (the render
  cookie) and `adminLoginActive` (the frame re-check). `holdsArea` and
  `loginHoldsArea` ask `requireArea`, whose SQL rules hold membership, so
  a login outside Admin holds no area. The session (`resolvedFor`, so
  `resolveLogin`) stays on the role until S8b (owner decision, below), and
  so do `memberLoginActive` and `findMemberAsset`.
- **Area asks** (`server/web/lib/workspaces.ts`):
  - `requireArea(caller, area)`: in a scope for the caller's own login it
    asks `mantle_scope_has_area` (`scopeHasArea`; a scope that does not
    hold Admin answers no); unscoped system work asks
    `mantle_area_rule(caller.loginId)` (`loginHasArea`); a scope for another
    login, or for no login, throws.
  - `areasFor(caller)` is `mantle_login_areas` through the new
    `loginAreas` (`packages/db/src/client.ts`, next to `loginHasArea`, on
    the system pool: `getAdminDb` lives only in client.ts). It feeds the
    shell, `grants.ts` and the area chips.
  - Deleted: `adminInfo`, `areasOf` (with its "migration skipped" branch)
    and `areasFromLimits`. `createWorkspace`'s "not set up yet" check reads
    `mantle_ws_admin_id` directly (`brainHasAdmin`), the same answer.
  - Asks about another login (the secret ref maker, the vault pair,
    Telegram) already call `loginHasArea` = `mantle_area_rule` since a0;
    nothing to change.
- **Migration 0306** (`0306_admin_membership`, journal `when`
  1790197680000; written as 0305, renumbered on v0.300.95): `mantle_login_is_admin_user(login)` is its 0293 text,
  moved verbatim, AND `mantle_login_is_admin(login)`. Its readers,
  `mantle_access_keys_seen` and `mantle_access_key_revoke`, follow.
  `SET LOCAL lock_timeout = '30s'`, CREATE OR REPLACE only (re-runnable),
  grants kept.
- **Test stand-ins.** Every stood-in login row carries `adminMember`,
  explicit (never derived from the role): an admin row of a sweep is a user
  of Admin, as on a box with no role drift. `run-route-stand-ins.ts`
  defaults it to false; each `standInLogin` of a role admin passes `true`.
- The `areasFromLimits` unit cells in `server/web/lib/scope-areas.test.ts`
  went with it; the limits rule (false and "false") is held by
  `packages/db/src/login-facts.db.test.ts` on the SQL.

## Changed answers (narrowing only)

The two named cells of the plan (section 2.2 point 7), at the gates the
plan names. None exists on a box with
`mantle_role_drift() = 0`; no answer widens.

1. A login with role admin outside the Admin workspace (drift):
   - its `?at=` asset token is refused (401, as a random uuid's);
   - its render cookie is refused (401, as a random uuid's);
   - `adminLoginActive` answers false (the owner frame refuses its ticket);
   - `mantle_login_is_admin_user` answers false. Its readers: the key
     list (GET /api/access-keys asks `mantle_access_keys_seen(NULL)` for an
     admin-kind caller, in the caller's own scope) answers it no key
     (main: every key); unscoped the definer asks no login and answers
     every key, as on main, but no request of a login reaches it unscoped.
     `mantle_access_key_revoke` lets it revoke only its own keys (main:
     any key). Cells: function level scoped and unscoped, and the route;
   - it keeps its session (cookie, bearer, API key) and works in its own
     scope, byte-equal to main; it is not Admin: an Admin area route
     refuses it (403 `area`), as on main.
2. A role=member login inside the Admin workspace (drift) stays a member:
   the member gate lets it in, the owner gate refuses it as any member, the
   reader byte route answers it as any member. As on main.
3. A brain with no Admin workspace (the "migration skipped" branch of
   `areasOf`): a kind admin login held every area there; now none (the
   strict rule). The S8a precondition is that no box has such a brain.
4. A disabled login holds no area through `areasFor` / `requireArea` (the
   rule's enabled check). A disabled login has no session, so no request
   reaches this.
5. `requireArea` in a scope for another login throws. No caller does this:
   every caller passes the request's own login, and the full DB run
   shows none.

## Proof

- **Guard and role sweeps, recorded on main first**, byte-compared after:
  `a4-guard-sweep`, `role-sweep`, `auth-sweep`, `member-sweep`,
  `link-render-sweep` (47 tests) pass on main at 384b64d02 and on the
  branch, and every file in `server/web/server/__snapshots__/` is byte
  for byte the one main holds (`cmp` over all 48). The DB sweeps
  (`w6a-route-sweep`, `a6-grant-sweep`, `a6b-exit-sweep`,
  `w7a-area-system-sweep`, `w6a-fix-sweep`) run in the full DB run below
  against their recorded answers.
- **The named cells** (`server/web/lib/auth/admin-membership.db.test.ts`,
  real app, real login row; warn in the full run, on in `test:actor-on`
  and `test:edit-on`): the asset token, the render cookie, the session and
  the frame re-check of a role admin login outside Admin, each next to the
  Admin user's as-before cell; a role=member login inside Admin answers as
  any member; member-negative: the drift admin and an outsider answer the
  asset token as a random uuid's token, byte for byte, and every non-Admin
  render cookie too; `requireArea` unscoped, in its own scope, and in
  another login's scope (throws); `areasFor` equals `mantle_login_areas`.
- **The migration** (`packages/db/src/admin-membership.db.test.ts`): every
  login of a grid answers its 0293 text AND `mantle_login_is_admin`, and
  the only changed cell is `out: true -> false`; the revoke reader's cells
  (Admin user, drift admin, drift member, no login, own key); PUBLIC has no
  EXECUTE; the renumber proof (its `when` above its predecessor and above
  0305_folder_rename_write's 1790197620000, no 0305 entry of its own left; a database at the migration before it applies
  it and only it; its statements again change nothing).

## Brains without an Admin workspace (the precondition count)

The SQL the fleet reads (`scripts/arch-scoreboard-box.sh`, `no_admin`),
numbers only:

```sql
select count(*) from auth.users o
 where o.is_owner
   and not exists (select 1 from public.workspaces w
                    where w.owner_id = o.id and w.is_admin and w.archived_at is null);
```

Measured: 0 on the workstation's throwaway database (migrated, no owner
login yet), and 0 on the test brain of `admin-membership.db.test.ts` (an
anchor and the workspaces switch; one owner), which asserts it. The CEO
reads it on the fleet before merge, with `mantle_role_drift()`.

## Pins

Rebased on 6e49ee5b4 (v0.300.93, P1b's counters merged); every pin below
is P1b's own count, set by hand with its reason in `_notes`:

- `tsAreaRules` 3 to **0**: areasOf, areasFromLimits and requireArea's
  list rule are gone (`eslint-rules/admin-counts.test.ts` now expects none).
- `loginRoleDecisionReads` 36 to **34** (the plan said 16 to 1, measured
  another way at c7acc88ff; P1b counts 36 in 16 files): in session.ts 7
  to 5. Left: `adminLogin` (the pair helper), `resolvedFor`'s admin and
  member cases (the session stays on the role by the owner decision),
  `memberLoginActive` and `findMemberAsset` (both until S8b by the plan).
- `loginKindBranches` 52 to **51**: areasOf's "migration skipped" branch.
- `historyCodeComments` 2339 to **2338** (on v0.300.95); `S8a` is added to
  HISTORY_HEADING_CODES (`eslint-rules/cleanup-counts.mjs`) for this
  file's heading, and no new code comment names it.
- `inHandlerAreaChecks` 21 to **23**, raised: requireArea is now made of
  the two asks the plan names (scopeHasArea in its login's own scope,
  loginHasArea unscoped); the counter counts the asks inside it as well as
  each requireArea use. No new ask after a gate.
- `dbClientLines` 3145 to **3160** (on v0.300.95), raised: `loginAreas`, the one
  system-pool reader of `mantle_login_areas` (getAdminDb lives only in
  client.ts).
- `sqlRoleReaders` 14, unchanged: 0306 redefines a reader, adds none.

## Gates (head 71af6c10e, then this handover)

Mac (DATABASE_URL unset for unit runs), on the rebased head:

| gate | exit |
|---|---|
| pnpm -r typecheck | 0 |
| pnpm lint | 0 |
| pnpm format:check | 0 |
| pnpm docs:check | 0 |
| pnpm arch:check | 0 |
| pnpm -C server/web build | 0 |
| pnpm exec vitest run server packages eslint-rules | 0 (11022 passed) |

Workstation (throwaway worktree `s8a`, own `s8a_pg` on 56163, removed
after each run):

| run | exit | result |
|---|---|---|
| pnpm verify (full vitest with DB, actor-off, actor-on, edit-on, matrix) | 1 | 63 failed in 15 files: hook timeouts and "too many clients" (the box runs other lanes' containers); a different set each run |
| those 15 files alone | 0 | 506 passed |
| the run before (c5a423b33): its 64 failing files alone, plus the 5 moved files | 0 | 948 passed |
| pnpm test:runtime-role, full config | 0 | 2646 passed |

CI (it runs the full DB suite too): green on 71af6c10e,
https://github.com/crossworks-engineering/mantle/actions/runs/39142603872
(c5a423b33 failed on the two things 71af6c10e fixed: the cell's probe
route, and refold-embeds meeting the Admin workspace the helper then made
on the shared database).

What the earlier runs found, and this branch fixed: `loginAreas` letting a
throw before its query escape (500 for main's 404 in the a10 body sweep);
test brains making admin logins with no Admin workspace (the five files
now run on scratch brains with `ensureAdminUsers`, so the shared database
keeps no Admin workspace of theirs); app code on a brain stopped before
0272 (mcp-revived-credentials installs 0304's fact); a SELECT-only role
(login-row-readonly grants it EXECUTE, as the runtime role has).

## Owner decision (closed 2026-10-18): the session stays on the role

Question: a role admin login taken out of Admin, with `resolvedFor` on the
pair, had no session (401); two existing tests encode main's answer, a
session in its own scope (`a1-d1-routes.db.test.ts` "an Admin user keeps
the owner acts; an admin-role login out of Admin does not";
`w7-int-fix3-session.db.test.ts`, its `outsider`).

Decision (CEO, option 2): `resolvedFor` stays on the role, so sessions are
byte-equal to main and both tests stay as main has them. The pair gates
only what the plan names (section 2.2 point 7): asset tokens, the render
cookie, `adminLoginActive`, the area and Admin decisions and the SQL read
`mantle_login_is_admin_user`. Reason: the plan names only those
narrowings and an unnamed changed answer is a blocker; a 401 lockout of a
signed-in user is the sharpest kind of change; S8b (membership decides,
the role follows it) settles the session for good. The cell "a role=admin
login outside Admin keeps its session but is not Admin"
(`admin-membership.db.test.ts`) proves it: past the owner gate as the
Admin user, an Admin area route (`/api/users`) refused, no asset token, no
render cookie, `adminLoginActive` false.

## Audit fix round 1 (audit at 3132519a0: 8/10, narrowing only)

Rebased on e6f75059e (v0.300.94, S4a merged); migration kept as 0305 with
`when` 1790197680000 (merge order: tree-bugs 0305, then S2a a1+a2; this
branch renumbers at its merge, the proof test stays).

- **M1, the public demo.** 0306 grants `demo_reader` (where the role
  exists, 0293's pattern) EXECUTE on `mantle_login_is_admin` (the login
  row), `mantle_login_areas` (`areasFor`) and `mantle_area_rule`
  (`requireArea` unscoped): the demo runs the app's system pool as that
  SELECT-only role, so without them every signed-in demo request fails
  42501 (the login row) or loses its areas (fails closed). Cell: the grant
  statement on a database that has the role, in a rolled-back transaction.
  The 0304 catalog cell allows `demo_reader` by name. **The demo branch
  is not touched: `demo/deploy/readonly-role.sql` needs the same three
  GRANT lines there.**
- **L1, loadLoginRow in a scope.** Picked: a comment and a cell, not a
  fallback. Every caller finds a credential's login before the request
  enters a scope; in a scope the select is refused (42501) and throws, so
  it never answers a guess, and a catch would only hide a misuse. Cell:
  unscoped it answers `adminMember` for the Admin user, the drift admin
  and the drift member; inside `withViewer` it rejects.
- **L2, the key list.** Cells at the function level (scoped: the Admin
  user sees every key, the drift admin none; unscoped: every key, the
  definer asks no login) and through GET /api/access-keys (the Admin user
  sees another login's key, the drift admin not: the route runs in the
  caller's own scope). The migration header and "Changed answers" now say
  exactly that: no key, not "its own keys".
- **L3, seeWorkspace.** Not passed through: a member's transaction runs on
  the write role, which may not EXECUTE `mantle_login_areas` (0304 grants
  the runtime role only). The areas read now runs before the row lock, so
  no lock is held while it waits. Left: an Admin user's write transaction
  runs on the system pool, the pool `loginAreas` reads from, so that read
  takes a second connection of the same pool while the transaction holds
  one (a short STABLE read; it never waits on the row lock, MVCC).
- **Nits.** `docs/actors.md` section 6 has the `mantle_login_area` counted
  fail-open line again (until S4b), within 350 lines; new product comments
  carry no step code and no decision date (they stay here).

## Rebase on v0.300.95 (53b507b53)

tree-bugs merged with `0305_folder_rename_write` (`when` 1790197620000).
This branch's migration is now `0306_admin_membership`, journal idx 306,
`when` 1790197680000 (kept, above 1790197620000). The proof test asks
for the new tag, idx and `when`, and that no `0305_admin_membership`
entry is left. Pins re-measured on the new base (the same reasons).

## Diff-check lows (with the rebase on v0.300.95)

- The drift admin's key list request must answer 200 (a 500 no longer
  passes the cell).
- loadLoginRow in a scope: the cell asks for SQLSTATE 42501. The first
  refusal there is the table, not the fact: a viewer role reads no
  `auth.users` row ("permission denied for table users"), so the read
  threw in a scope on main too; the comment says so.
- `demo_reader` is pinned to exactly the three facts: a text check over
  every migration (no other login fact granted to it) and, where the
  cluster has the role, the live catalog.
- seeWorkspace reads the areas through its transaction when that role may
  run `mantle_login_areas` (asked with `has_function_privilege`, which never
  fails, so it cannot abort the transaction): an Admin user's locked write
  on the system pool takes no second connection of that pool. A member's
  transaction (the write role, no EXECUTE) reads them on the system pool,
  not its own pool, as before. Still before the row lock.
- The renumber wording (0306, `0305_folder_rename_write`'s `when`) is in
  the migration header, the proof test and this file.

Gates on bf82b466b (Mac, DATABASE_URL unset): typecheck 0, lint 0,
format:check 0, docs:check 0, arch:check 0 (pins unchanged this round;
asSystemExits 59 as main), web build 0, unit vitest 0 (11042 passed); the
guard sweep snapshots byte-equal to main. Workstation DB files (own
`s8a_pg`, removed after): the 16 files this branch touches or that cover
its paths (both admin-membership files, login-facts, tree-bugs,
login-row-readonly, mcp-revived-credentials, access-keys,
access-keys-hardening, device-tokens, mcp-oauth-grants, member-mcp,
a1-d1-routes, w7-int-fix3-session, both workspaces.db files,
w6a-route-sweep): 219 of 220 passed; the one failing cell (it asked for
the function's message, the refusal is the table's) was fixed, and its
three files then passed, 28 of 28.

## Rebase notes

- `server/web/lib/workspaces.ts`: S2a a1+a2 edits the `@mantle/db` import
  list (adds a name) and lines 920-1265; this branch edits the same import
  list (adds `currentScope`, `loginAreas`, `loginHasArea`, `scopeHasArea`)
  and the areas block (200-256), `seeWorkspace` and `createWorkspace`'s
  first lines. A one-line import merge.
- `packages/db/src/client.ts`: `loginAreas` sits after `loginHasArea`;
  S4a's hunks are elsewhere. Its `dbClientLines` raise adds to S4a's.
- Migration: renumbered 0305 to 0306 on v0.300.95 (tree-bugs took 0305,
  `when` 1790197620000); it keeps `when` 1790197680000. S2a a1+a2 takes a
  later number and `when`.
- `vitest.actor-on.config.ts`: one appended include line.

Head: see `git log -1 feat/s8a-admin-membership`.
