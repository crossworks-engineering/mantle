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
  one Admin decision on the role in session.ts. Its readers: `resolvedFor`
  (so `resolveLogin`, the cookie, the bearer and the API key login),
  `findOwnerAsset` (the `?at=` asset token), `findRender` (the render
  cookie) and `adminLoginActive` (the frame re-check). `holdsArea` and
  `loginHoldsArea` run only for a login `resolvedFor` made kind admin, so
  they follow the same pair. `memberLoginActive` and `findMemberAsset`
  keep their role read until S8b, as the plan says.
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
- **Migration 0305** (`0305_admin_membership`, journal `when`
  1790197680000): `mantle_login_is_admin_user(login)` is its 0293 text,
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

The two named cells of the plan, plus what follows from "kind admin = role
AND membership" at the sites the plan names. None exists on a box with
`mantle_role_drift() = 0`; no answer widens.

1. A login with role admin outside the Admin workspace (drift):
   - its `?at=` asset token is refused (401, as a random uuid's);
   - its render cookie is refused (401, as a random uuid's);
   - `adminLoginActive` answers false (the owner frame refuses its ticket);
   - `mantle_login_is_admin_user` answers false, so it no longer lists
     every key or revokes another login's key;
   - **its session is no login** (cookie, bearer, API key): `resolvedFor`
     makes kind admin only for the pair, and a role admin row is no member,
     so it resolves as a role this code does not name. The plan names the
     asset token and render cookie for this login; it also says
     `resolveLogin` reads the pair. That is the narrower reading, taken as
     the safer one. **Owner question:** if such a login should keep a
     session as a member instead, `resolvedFor` changes one line, and that
     is wider than this branch.
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
   every caller passes the request's own login, and the full DB run is
   green.

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
  S2a a1+a2's 1790197620000; a database at the migration before it applies
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

- `dbClientLines` 3142 to 3155: `loginAreas`, the one system-pool reader
  of `mantle_login_areas` (note appended).
- P1b's counters are not on main yet (`feat/p1b-counters`). Measured with
  P1b's own counter code (claude/p1b-fix2-5470d3) on main and on this
  branch:
  - `tsAreaRules` 3 to **0** (areasOf, areasFromLimits and requireArea's
    list rule gone).
  - `loginRoleDecisionReads` 36 to **33**; in session.ts 7 to 4. The four:
    `adminLogin` (the pair helper), `resolvedFor`'s member case,
    `memberLoginActive` and `findMemberAsset` (both kept until S8b by the
    plan). The plan's "16 to 1" was measured another way at c7acc88ff; P1b
    counts 36 in 16 files.
  - `loginKindBranches` 52 to 51.
  - `inHandlerAreaChecks` 21 to **23**: `requireArea` is now made of the
    two asks the plan names (`scopeHasArea`, `loginHasArea`), and the
    counter counts asks inside it as well as at each `requireArea` use. No
    new ask after a gate. When P1b lands first, this pin needs 23 with that
    reason, or P1b's counter treats `requireArea`'s body as a gate.

## Gates

Mac (unset DATABASE_URL for unit runs):

| gate | exit |
|---|---|
| pnpm -r typecheck | 0 |
| pnpm lint | 0 (1 old warning, contact-sharing-routes.db.test.ts) |
| pnpm format:check | 0 |
| pnpm docs:check | 0 |
| pnpm arch:check | 0 |
| pnpm -C server/web build | 0 |
| pnpm exec vitest run server packages eslint-rules | 0 |

Workstation (throwaway worktree `s8a`, container `s8a_pg` on 56163):

| gate | exit |
|---|---|
| new DB files + login-facts | GATES_DB_NEW |
| pnpm verify (full vitest with DB, actor-off, actor-on, edit-on, matrix) | GATES_VERIFY |
| pnpm test:runtime-role (full config) | GATES_RR |

CI: CI_URL

## Rebase notes

- `server/web/lib/workspaces.ts`: S2a a1+a2 edits the `@mantle/db` import
  list (adds a name) and lines 920-1265; this branch edits the same import
  list (adds `currentScope`, `loginAreas`, `loginHasArea`, `scopeHasArea`)
  and the areas block (200-256), `seeWorkspace` and `createWorkspace`'s
  first lines. A one-line import merge.
- `packages/db/src/client.ts`: `loginAreas` sits after `loginHasArea`;
  S4a's hunks are elsewhere. Its `dbClientLines` raise adds to S4a's.
- Migration: 0305 here and on S2a a1+a2. Whichever merges second renumbers
  (file name, journal entry, the proof test's TAG and its "above" `when`).
- `vitest.actor-on.config.ts`: one appended include line.

Head: HEAD_SHA
