# Plan v3.2: one login shape, the login bridge dropped (handover)

Plan v3.2 section 2.2 point 5: delete the adapters and the resolved
caller's union; drop the no-op login bridge; the role is display only, held
by the login type test. Branch `feat/s8d` from main v0.400.6 (b7765205e).

## What changed

### Migration 0334 (journal `when` 1790200200000)

- `0334_s8d_drop_bridge_login.sql`: `DROP FUNCTION IF EXISTS
mantle_bridge_login(uuid)`. Since 0330 it only demoted (took a login whose
  role is not admin out of Admin). Checked before dropping: no TypeScript
  caller since 0330's image (S8b), no SQL function body calls it (a catalog
  cell strips comments and finds none), no trigger (0330 dropped
  `users_zz_bridge` and `mantle_bridge_login_trg`), and on a box it deletes
  nothing (0330 refused its migrate while any Admin seat lacked role admin;
  the definers write the role with the row and the role guard holds every
  other writer off). Every box has run 0330's image since 2026-10-24.
- Revert `packages/db/rollback/0334_s8d_drop_bridge_login.revert.sql`:
  0330's body byte for byte, PUBLIC revoked, owner = `mantle_ws_add_user`'s
  owner, EXECUTE for `mantle_runtime` and `mantle_owner` (as the older
  image's `ensureRuntimeRoles` grants it), 0334 off the ledger. Going below
  0330 too: this revert first (0330's reads the bridge's owner); the 0330
  revert drill now runs both in that order.
- `runtime-role.ts`: the bridge's lines in `RUNTIME_SYSTEM_FUNCTIONS` and
  `NARROW_DENIED_FUNCTIONS` go.
- `mantle_role_drift()` stays as the box count.
- DB cells: `role-guard.db.test.ts` runs 0330's demote cells on a database
  stopped before 0334, then migrates (gone, every other function body
  unchanged, no body calls it) and reverts (body md5, owner, definer and the
  PUBLIC, runtime and narrow EXECUTE answers equal to before). The other
  cells that called the bridge assert it is gone or drop the call
  (`ws-user-definers`, `narrow-containment` (42883), `acting-login-definers`,
  `role-readers-catalog`, `team-normal-0286`, `workspaces-live`,
  `login-create`). `former-clients-0272` runs at 0272 and keeps its calls.

### One login shape (server/web/lib/auth/session.ts)

- `Resolved` is one shape: `loginId`, `user` (the brain handle: anchor id,
  the login as actor), `source`, `epoch`, `contactId`, `admin`
  (`adminLogin(row)`, membership). A member's actor is built with
  `isOwner: false`, as before.
- Deleted: the kind union, `AnyLogin`, `legacyLogin`, `loginOf`,
  `loginSessionUser`, `chatCallerOf`, the `ChatLogin` type and the readers
  `loginCaller`, `chatLoginCaller`, `publicLoginCaller`,
  `ownerCallerWithLogin`. Handlers read `anyLoginCaller()`, `chatCaller()`
  (`getChatLoginOr401` answers the `ChatCaller` with its `asLogin`) and
  `publicLoginItself()`. `OwnerRouteLogin` has no kind (`member` set for a
  login that is not an Admin user). `loginRefused(admin: boolean)`.
- A shown role is `sessionRole(login)` (the row's membership, as the kind
  was): whoami, `/api/v1/whoami`, the shell, the access keys' answer and
  audit row; the gate's `HttpLogin.role`; the cookie upgrade's role.
- `findMemberAsset` and `memberLoginActive` keep their `role === 'member'`
  read. A first cut asked membership alone there; the workstation's
  edit-on run (`admin-membership.db.test.ts`, three cells) measured it
  looser for a role=admin login outside Admin (drift): its member asset
  token got a member's 404 where it gets 401 today. Reverted before the
  final run: the pair (role AND membership) stays, as S8a named it.
- `MemberCaller` stays as the member routes' record (its `role` is the
  constant 'member', shown only): moving its ~30 readers to the Login is
  churn with no decision in it. `SessionUser` stays as `ownerCaller()`'s
  brain handle (no kind, no role; renaming it would only game the counter).
- `login-shape.test.ts` also holds the owner and chat answers to neither
  kind nor role, and the chat guard to the one `ChatCaller` shape.
- `eslint-rules/session-guards.mjs`: the Login readers keep the legacy
  readers' sweep entries (`pipeline:login`, `pipeline:chat`,
  `pipeline:publicLogin`, `pipeline:ownerWithLogin`); `logs` is gone. The
  guard sweep rebuilds the legacy shapes from the Login and `sessionRole`
  in the test (`legacyShape`), so the recorded files compare one answer.

## Changed answers

None. The guard sweep's recorded files (`server/web/server/__snapshots__`)
are unchanged byte for byte on the Mac unit run and the DB runs; the route
rows snapshot and the auth sweep pass unchanged. One looser answer was
found on the way (above) and reverted; the final run has none.

## Pins

| pin                     | before | after |
| ----------------------- | ------ | ----- |
| loginKindBranches       | 17     | 0     |
| loginRoleDecisionReads  | 16     | 16    |
| sqlRoleReaders          | 15     | 14    |
| workspaceTableWriterFns | 21     | 20    |
| adminDecisionFlags      | 40     | 40    |
| loginTypeKindOrRole     | 0      | 0     |

`adminDecisionFlags` is the workspace's own `isAdmin` flag and the
assistant's (not a login decision). Of the 16 role reads, two are the
member pair in session.ts (above); the rest are not the caller's role: a new or changed login's requested role (users routes,
login-create, login-update), a shown role (access keys, OAuth consent,
owner SSO, the notices' told role) and the member-path checks of the MCP
login; each equals membership while drift is 0.

## Gates

Mac, on 7def7a565 (exit codes): `pnpm -r typecheck` 0, `pnpm lint` 0,
`pnpm format:check` 0, `pnpm docs:check` 0, `pnpm arch:check` 0,
`pnpm -C server/web build` 0, unit vitest (`server packages eslint-rules`,
DATABASE_URL unset) 0 (932 files, 12051 passed). f73fed7b0 changes one DB
test file only (the 0334 revert cell grants the runtime role as the older
image's migrate did).

Workstation, each suite in a fresh clone of the pushed commit and its own
pgvector pg18 container (`s8d-*`, removed), MANTLE_CHECK_FLOOR=keep,
`--maxWorkers=3`, through `~/bin/test-lane`:

| suite                       | head      | exit | tests                   |
| --------------------------- | --------- | ---- | ----------------------- |
| DB vitest shard 1/2         | f73fed7b0 | 0    | 6887 passed, 19 skipped |
| DB vitest shard 2/2         | 7def7a565 | 0    | 8344 passed, 11 skipped |
| test:actor-off              | f73fed7b0 | 0    | 1647 passed, 1 skipped  |
| test:actor-on               | 7def7a565 | 0    | 419 passed, 1 skipped   |
| test:edit-on                | 7def7a565 | 0    | 589 passed              |
| test:matrix                 | 7def7a565 | 0    | 8 passed                |
| test:runtime-role (full)    | f73fed7b0 | 0    | 3170 passed, 1 skipped  |
| test:serial                 | f73fed7b0 | 0    | 1 passed                |
| 0334 up, revert, up (fresh) | 7def7a565 | 0    | see below               |

The suites on 7def7a565 do not run `role-guard.db.test.ts`, the only file
f73fed7b0 changes. The drill: after migrate the bridge is gone and 0334 is
on the ledger; after the revert it is back, owned as `mantle_ws_add_user`,
the runtime role may run it, PUBLIC may not, 0334 is off the ledger; a
second migrate drops it again and puts 0334 back on the ledger.

Found and fixed on the way: the first run (0e07e459b) found the looser
member asset answer above (edit-on) and the 0334 cell's grant assumption
(shard 1, actor-off).

## Open items

- The 14 role reads that are not the caller's role and the member pair's
  two (pins note): each equals membership while `mantle_role_drift()` is 0.
- `MemberCaller` and `SessionUser` stay (above).
- Migration 0334's `when` is 1790200200000; renumber at merge if main
  takes a migration first.
