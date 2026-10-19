# Plan v3 S6 part c2 handover

Branch `feat/s6-c2`, rebased on main 5e01dda68 (v0.300.100). Not merged,
not tagged, not rolled. Plan v3.2 section "S6. Admin acts become
definers", part c2. Built in two rounds: the first builder wrote the code,
the pins and the unit gates and handed over at its tool-call limit; the
second (round 2, below) re-recorded the two DB-less sweeps, fixed a hang
the body sweep found, retargeted one DB test, and ran every gate.

## Done

The item gate's three Admin acts (session.ts itemWriteGate, its ADMIN_ACT
answers) get one narrow SECURITY DEFINER function each, in one migration,
`packages/db/migrations/0310_admin_act_definers_c2.sql` (journal `when`
1790197920000):

| Act                         | Route                                          | Definer                                         |
| --------------------------- | ---------------------------------------------- | ----------------------------------------------- |
| a share close by users area | DELETE /api/shares/:id                         | `mantle_share_close_admin(share)`               |
| a contact share's Can write | PATCH /api/shares/:id `{ canWrite }`           | `mantle_share_contact_write_set(share, can)`    |
| the deleted-app trash rows  | DELETE /api/apps/deleted/:id, POST .../restore | `mantle_app_trash_act(app, 'purge'\|'restore')` |

- `mantle_share_close_admin`: no login in the scope, 42501
  (`admin_act_unscoped`). The scope's login without the users area
  (`mantle_scope_has_area('users')`: an Admin user with it off, a member,
  role drift) is told `no-area` and nothing is written; the route then
  closes the link by its own rule, as the gate did. With the area: revoked
  now (`closed`) or `gone`.
- `mantle_share_contact_write_set`: a share that names no contact is
  `not-contact` (nothing written; the link's rule answers it, as the gate
  did). A contact share: `mantle_admin_act_brain` (0308, the c1 check), then
  one row lock: `not-found` (not live), `write-not-app`, or `ok` with the
  contact for the audit row.
- `mantle_app_trash_act`: `mantle_admin_act_brain` first (only Admin users
  reach these routes: no member route lists them). The newest pre_delete
  snapshot of a gone app, its home (meta.homeWs) and keepForOwner, exactly
  as the gate read them: the owner purges a held app; else a Moderator of
  its home (`mantle_may_manage`), or the owner for no home stored; a held
  app's purge by anyone else is `held` (the 403); a purge deletes the app's
  node_snapshots rows (files: the store sweep, 0284, as before); a restore
  writes nothing and answers the snapshot (seq, code, data file, schema
  version, member era). The restore's TypeScript part (createApp, the data
  file, history) runs after the yes, in the login's scope
  (`restoreDeletedAppFrom`, `packages/content/src/app-trash.ts`).
- Route callers: `adminCloseShare`, `adminSetContactShareCanWrite`,
  `adminAppTrashAct` (`packages/content/src/admin-acts.ts`), through
  `adminActTx` as c1 (the write role's EXECUTE list is access-matrix.ts,
  S2c's, not touched).
- The link's rule in the handler: `shareItemRefusal`
  (`server/web/lib/auth/item-answers.ts`), asked in the login's scope with
  the gate's 404 and 403 bodies byte for byte (`itemNotFound`,
  `itemRefused`, which the gate's node path now uses too). The body peek
  that told a Can write change moved from session.ts into the share route.
- `route-scope.ts`: `ITEM_REF_PREFIXES` is gone; `itemWriteTarget` answers
  null for every route (kept as the row field and the gate's seam the
  pre-check removal cells feed); `ItemRef` is `'node'`.
- `session.ts`: the `ADMIN_ACT` constant and the gate's share and
  deleted-app branches are gone; `enterLoginWrite` keeps the system pool
  only for the four ADMIN_ACT_WRITES (c3).
- The three requests now run in the login's scope (`enterLoginScope`).
- Grants: PUBLIC loses EXECUTE on the three; the runtime role runs them
  (`RUNTIME_SYSTEM_FUNCTIONS`, each with why).
- Not touched: access-matrix.ts, workspaces.ts, workspace-ticks.ts,
  viewer.ts workspaceWriteSystem, the workspace readers. No mini app, app
  row, app DB or sandbox is removed by any new path; the purge rule is
  today's.

## Answers

Byte-equal by construction for an Admin user and a member, recorded on
main by the existing cells (f4-owner-flows, w6a-fix-sweep, w6b-fix1,
f4-admin-write-role, w6a-route-sweep, shares-route) and the new
`server/web/server/s6-c2-admin-acts.db.test.ts`, all run on the
workstation in round 2 (Gates). Changes, all narrower or internal:

1. Role drift (role admin, no Admin seat) asking Can write on a contact
   share: 200 on main, now the guard's 403 body from inside the definer
   (as c1). Role drift is 0 on all boxes.
2. Role drift purging or restoring a trash app: main ran the gate's home
   check as an Admin user; now 403 (`mantle_admin_act_brain`).
3. Times come from the database (`now()`): the close's `revoked_at`, the
   Can write row's live test.
4. The trash's snapshot read now filters the brain's owner_id (the gate's
   did not, the handler's did): equal on a one-brain database.
5. One transaction for the Admin branches instead of a gate read then a
   handler write.
6. A request the gate's item check refused before now passes the gate
   and is refused by the handler with the same status and body. Its gate
   audit row (`api.write METHOD path login`) is now written for it, as for
   every other content write since the pre-check removal. The guard sweep
   shows it (Round 2, the moved-writes file). One more audit row, no
   wider right.
7. A PATCH /api/shares/:id body over 64 KB no longer hangs the request
   (Round 2, the hang). On main the same peek hung only for an Admin user
   on a contact share; the branch had widened it to every PATCH before
   the fix.

## Pins (each with its reason in the pins' notes)

- `itemPrecheckRoutes` 2 to 0.
- `adminActRoutes` 7 to 4.
- `inHandlerAreaChecks` 23 to 22, `inHandlerAreaCheckFiles` 19 to 18
  (shares/[id]'s requireArea went).
- `actorsHistoryRefs` 75 to 74 (a removed comment quoted a docs heading).
- `historyCodeComments` unchanged (one new code line trimmed).

## Tests

- New: `server/web/server/s6-c2-admin-acts.db.test.ts` (warn and on): each
  definer in a hand-set scope (Admin user with and without the users area,
  member, role drift, unscoped); the routes by runRoute (member-negative,
  drift's guard body, the hidden link's 404, Can write without the area,
  the held purge refused for a non-owner with its rows kept, the owner's
  purge, no app database file touched by any path).
- Retargeted: `share-mode-route.test.ts` (definer mocks, two cells),
  `route-scope.test.ts` (share and trash name no item),
  `item-write-encoded.test.ts` (the decoded-id check now in the handler's
  `shareItemRefusal`), `gate-caller.test.ts` (the gate asks no item: both
  pipelines alike).

## Round 2 (second builder)

### The two DB-less sweeps, re-recorded (code-first, as c1)

Only the four c2 rows moved (DELETE and PATCH /api/shares/:id, DELETE
/api/apps/deleted/:id, POST .../restore). Checked cell by cell against
main 5e01dda68 (each file's answer table resolved per route, method and
credential, so the renumbered answer ids do not hide a change); no other
row of any file moved.

- `a4-guard-sweep.txt`: 16 cells (the 4 routes, owner, admin, limited
  cookies and the admin bearer). Status and body byte-equal on every one
  (the stand-in's opaque 500 on main and now). Only the guard log moved:
  on main the gate's item check threw for want of a database (or let the
  close through); now the gate lets the owner guard answer and the handler
  meets the stand-in.
- `a4-guard-sweep-more.txt`: the 13 cells of those routes that "wanted a
  database" in the first sweep no longer do, so the second sweep drives
  them no more (13 to 0). Their stand-in answers on main (the item read's
  404, or the opaque 500) were the harness's, not HTTP answers.
- `a4-guard-sweep-moved.txt` (9299 to 9286 lines) and
  `a4-guard-sweep-moved-writes.txt` (3763 to 3750): the same 13 cells
  leave the "again" part; the 16 "first" cells now log the owner guard's
  ok and the gate audit row (Answers, change 6). No other cell moved.
- `a10-body-sweep-changes.txt`: 12 cells, each named in `changeKind`:
  - `close-first (Admin act definer, 0310: the close is asked of the
database first)`: DELETE /api/shares/:id owner, 6 bodies. Main
    `200 {"ok":false}` (the gate let the close through, the revoke read
    no row through the stand-in), now the opaque 500 (adminActTx meets
    the stand-in). Real answers: the c2 DB test.
  - `trash-first (Admin act definer, 0310: the trash check is asked of
the database first)`: POST /api/apps/deleted/:id/restore owner, 6
    bodies. Main `409 ... holds no code` (the stand-in's snapshot row),
    now the opaque 500. Real answers: the c2 DB test, f4-owner-flows,
    w6a-fix-sweep.
  - Every other cell answers as before; PATCH /api/shares/:id and DELETE
    /api/apps/deleted/:id answer byte for byte.

These are the harness's answers with a database stand-in. Every real
answer is narrower or byte-equal (the DB tests below).

### The hang (found by the body sweep, fixed)

The body sweep hung on `PATCH /api/shares/:id owner chunked`, on the Mac
and on the workstation. Cause: `readBytesCapped` awaited `reader.cancel()`
on a clone (`req.clone()`, the Can write peek). A clone's branch settles
its cancel only when the other branch is cancelled too, so a body over
64 KB hung the request for good. Fix: the cancel is not awaited
(`server/web/lib/body-limit.ts`); new cell in
`server/web/server/body-ceiling.test.ts` (red before the fix, a 10 s
timeout; green after). Main had the same latent hang, reachable only for
an Admin user's PATCH on a contact share. `server/web/lib/mcp-auth.ts`
peeks a clone the same way (Open, below).

### Tests changed in round 2

- `server/web/app/api/shares/shares-route.db.test.ts`: its PATCH and
  DELETE cells called the handler with no gate and no scope; the link's
  rule is now asked in the login's scope, so they go through runRoute
  (the full pipeline). One expectation moved to main's real HTTP answer:
  the close of a hidden link by an Admin user without the users area is
  the gate's `404 {"ok":false,"error":"not found"}` (main's gate sent it;
  the old cell saw the handler's body only because it skipped the gate).
- `server/web/server/s6-c2-admin-acts.db.test.ts`: the trash cell also
  watches a sandbox folder (`SANDBOXES_DIR`, a seeded file), and adds a
  held purge by an Admin user without the users area (403, the held body)
  and a member's restore (403). Before and after every refused purge, no
  app database file and no sandbox file changed.

### The purge rule

Exactly today's. `mantle_app_trash_act` removes only the gone app's
`node_snapshots` rows, as `purgeOne` did on main; a held app (deleted by a
login other than the brain's owner) only by the owner; else a Moderator of
its last home, or the owner for no home stored. Proved by the c2 DB test
(definer and HTTP): member, role drift and no scope refused (42501, the
guard's 403 over HTTP); an Admin user with or without the users area
`held` (403), rows kept; the owner purges; the app database and sandbox
folders unchanged by every path. No new removal of an app, app row, app
database or sandbox anywhere in the branch.

## Gates

Code head c097ab770, rebased on 5e01dda68 (the commit after it changes
this file only).

Mac (DATABASE_URL unset):

| Gate                                                | Exit | Note                                           |
| --------------------------------------------------- | ---- | ---------------------------------------------- |
| `pnpm -r typecheck`                                 | 0    |                                                |
| `pnpm lint`                                         | 0    | 1 old warning (contact-sharing-routes)         |
| `pnpm format:check`                                 | 0    |                                                |
| `pnpm docs:check`                                   | 0    |                                                |
| `pnpm arch:check`                                   | 0    |                                                |
| `pnpm boot:smoke`                                   | 0    | 14 services link                               |
| `pnpm exec vitest run server packages eslint-rules` | 1    | on 111d9edc1: only the journal cell (expected) |

Workstation (own worktree, own pgvector pg18 container on 56471,
max_connections 450, migrated with `MANTLE_CHECK_FLOOR=keep`, both
removed after by exact name; `--maxWorkers=3`):

| Run                                    | Exit | Files                 | Tests                  |
| -------------------------------------- | ---- | --------------------- | ---------------------- |
| migrate                                | 0    |                       |                        |
| `pnpm -C server/web build` (111d9edc1) | 0    |                       |                        |
| the two sweeps (a4, a10)               | 0    | 2 passed              | 9 passed               |
| full vitest with the database          | 1    | 1 failed, 1119 passed | 1 failed, 13792 passed |
| `test:actor-off`                       | 1    | 1 failed, 125 passed  | 1 failed, 1144 passed  |
| `test:runtime-role` (in full)          | 0    | 272 passed            | 2717 passed, 1 skipped |
| `test:actor-on`                        | 0    | 29 passed             | 361 passed, 1 skipped  |
| `test:edit-on`                         | 0    | 41 passed             | 531 passed             |
| `test:matrix`                          | 0    | 4 passed              | 8 passed               |

The one red cell in each red run: `packages/db/src/migrations-journal.test.ts`
"no slot is skipped", only because 0309 (S2b) is not on main yet. Expected:
it goes green when S2b's 0309 lands; the CEO renumbers or says when to
rebase. Every other cell is green, the c2 DB test (8), f4-owner-flows
(56, the trash cells and the restore in the login's scope), w6a-fix-sweep
(16), shares-route (9) and f4-admin-write-role included, in warn, on and
the runtime role.

CI on 349c1099a (the code head plus this file's first round 2 text):
https://github.com/crossworks-engineering/mantle/actions/runs/39222663729,
failure on the Test step only, on the journal cell alone (1 failed, 1119
passed files). Every step before it passed (typecheck, lint, format, docs
paths, architecture counts, boot smoke, migrate). The steps after it
(actor off, actor on, edit on, runtime role, matrix, build) did not run
in CI because Test failed; each ran on the workstation above, exit 0
apart from the journal cell.

## Rollback

N-1 works on this schema: 0310 adds functions only and N-1 calls none.
Roll the N-1 image back and leave 0310 in place. No revert file.

## Open

- `purgeDeletedApp` (app-trash.ts) is now test-only (two DB tests call
  it); left in place.
- `server/web/lib/mcp-auth.ts:216` peeks `req.clone()` with
  `readBodyCapped`, as the share route does: the body-limit fix covers
  it if a body there ran past its cap (not tested there; no test of its own).
- The journal cell: red until S2b's 0309 is on main.
