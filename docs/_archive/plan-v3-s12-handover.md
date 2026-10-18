# Plan v3.2 S12: dead branches and the legacy entries (handover)

The branch `feat/s12-dead-branches`, cut from main at 6e49ee5b4
(v0.300.93), rebased onto 53b507b53 (v0.300.95) in fix round 1. No migration, no behaviour change. The spec's rules are in
[../actors.md](../actors.md); this file holds the step's detail.

## S12 round 0

### Answers recorded first

Before any edit, every row of the route policy table
(`buildRoutePolicy(routeManifest)`, 417 route files) was dumped with its
`routeClass`, and dumped again after the edits. Every row is byte-equal.
The only lines that moved are three probes of patterns no route has:
`routeClass('/api/admin')`, `/api/admin/space` and `/api/admin/space/:id`
went from `self` to null. `routeClass` is called with manifest patterns
only (`route-policy.ts` rowScope), so no request reaches a pattern no
route has: no caller's answer changed. On main the table already had no
gone row and no row reading `memberAsset`.

### What changed (lines on main, 6e49ee5b4)

1. The empty `/api/admin` "self" prefix
   (`server/web/lib/auth/route-scope.ts:80-81`) is gone. No route file
   sits under `/api/admin` since the private-space stubs were deleted in
   arch A7. A new route there now has no class and fails
   `route-scope.test.ts` and boot (fail closed).
2. The `memberAsset` caller kind and the `member-asset` stub kind. No
   route reads them: no route file exports a `gone(...)` stub. Removed:
   - `server/web/lib/auth/route-policy.ts`: the RouteCaller member (143),
     its CALLER_LOGINS entry and comment (186-189), its ASSET_CALLERS
     entry (245), its line in the RouteCaller comment (118-123).
   - `server/web/lib/auth/session.ts`: `getMemberForAsset` (271-281), the
     PipelineAnswer variant (1025), the answerRouteCaller case
     (1210-1213), `memberAssetCaller` (1370-1377), the ANSWERED label
     (1459). `memberForAsset` and `RequestLogins.memberAsset` stay:
     `getReaderForAsset` reads a member `?at=` token through them.
   - `server/web/lib/gone-kinds.ts:6-7, 20-21` and
     `server/web/lib/gone.ts:27, 40, 61-64`: the `member-asset` kind.
   - `eslint-rules/session-guards.mjs:22, 47, 99-103`,
     `eslint-rules/session-guards.d.mts:16`,
     `server/web/server/public-session-routes.ts:205`: the guard and the
     reader names.
   - Tests: `eslint-rules/session-guards.test.ts:54`,
     `server/web/server/middleware/gate-caller.test.ts` (the memberAsset
     sweep row, its two answers, its reader throw, its three policy
     cells; the two gone cells now use `ownerAsset` on `/api/profile` and
     `readerAsset` on a POST, so "a gone row still takes an asset kind
     only on an asset row" stays proven), the mocks in
     `server/web/app/api/apps/member-runner-routes.test.ts:112` and
     `server/web/app/api/files/files-byte-cache.test.ts:39`.
   - The gone row itself (`RouteRow.gone`) stays: `lib/gone.ts` stays for
     a route retired later, and its rows need it.
3. The client portal branch (`route-policy.ts:398-401, 680`,
   `CLIENT_PORTAL_GONE`) classed any `/api/client/` pattern as `self`. No
   route file sits under `/api/client` since its stubs were deleted (A7).
   Removed with the filter in `route-scope.test.ts:45`. A new route there
   must be classed (fail closed).

### Recorded, not removed

4. `mantle_tg_moderated_chats`' "no Admin workspace: the anchor" branch
   (`packages/db/migrations/0293_a6b_scope_exits.sql:708`): stays, S4b's
   migration removes it. The box counts (`scripts/arch-scoreboard-box.sh`,
   "brains without an Admin workspace") read 0 on all 8 boxes on
   2026-10-18, as the CEO session gave them: no brain takes the branch
   today. Not read again here.
5. `mantle_member_space` (0180): stays (S8b's catalog check drops it).
   Nothing in product code calls it: `git grep` finds only a comment
   (`packages/content/src/member-space-login.ts:14`), a superuser call in
   a test (`packages/search/src/client-level.db.test.ts:200`) and the
   role reader list of `eslint-rules/admin-counts.test.ts:461`. Its last
   row policy (`nodes_team_drafts_read`, 0187) went in 0273, which drops
   every policy of `mantle_view_team`. Its EXECUTE grant to
   `mantle_view_team` (0180:166) stays until the drop; that role is
   NOLOGIN since 0273.
6. `packages/db/src/client.ts`: no dead leftover found, nothing removed.
   Each of the 62 exports has a caller outside the file; the 19 used only
   by tests or the barrel are used inside client.ts as well (test seams,
   thrown error classes). No module-level name is used once. The code
   graph (a fresh fast index of this worktree, project `mantle-s12`)
   gave 10 functions with no inbound call; each has a caller in a folder
   the fast index skips (`packages/tools`, `server/web/scripts`) or is an
   inner callback (`executeAsMigrator`, `openLoginWritePool`,
   `moderatorSeatsNow`, `withScope`, `logActorMiss` and the rest; checked
   by hand with `git grep`). The S4a hunks were not touched.
7. Legacy tool pre-checks: R0 removed all 29 (pin `itemPrecheckTools` is
   0; `packages/runtime/src/tool-policy-snapshot.test.ts:440` holds no
   policy with `items` or `legacyItemPrecheck`). No `LegacyItemPrecheck`
   type is left in `packages/tools/src/tool-policy.ts`, so the owner and
   end-date rule of the S12 paragraph has nothing to apply to.

### Pins

- `historyCodeComments` 2332 to 2328 on 6e49ee5b4: the comments of the
  removed code (2339 to 2335 after the rebase, fix round 1).
- `S12` joins `HISTORY_HEADING_CODES` (`eslint-rules/cleanup-counts.mjs`)
  with this heading; no counted comment names it, so the count is
  unchanged by it.
- No other count moved (`pnpm arch:check` on the branch).

### Gates (Mac, DATABASE_URL unset)

On 15e1765d6 (the code is 51710be97; the docs and pins commit on top):

| Gate                                                | Exit                           |
| --------------------------------------------------- | ------------------------------ |
| `pnpm -r typecheck`                                 | 0                              |
| `pnpm lint`                                         | 0                              |
| `pnpm format:check`                                 | 0                              |
| `pnpm docs:check`                                   | 0                              |
| `pnpm arch:check`                                   | 0                              |
| `pnpm -C server/web build`                          | 0                              |
| `pnpm exec vitest run server packages eslint-rules` | 0 (11022 passed, 2658 skipped) |

CI on 4a7dfe1d1 (the code, the pins and this handover with its gates): success,
https://github.com/crossworks-engineering/mantle/actions/runs/39154830485.
The commit on top adds only this line.

## S12 fix round 1 (audit at d3074d9cd: 9/10, merge, no changed answers)

1. Rebased onto 53b507b53 (v0.300.95, S4a and the tree bugs with 0305).
   One conflict, `scripts/arch-scoreboard.pins.json`: main's version kept
   (its tree-bugs note text and `failOpenSites` 6), then
   `historyCodeComments` re-measured on the rebased tree: 2339 to 2335
   ("Lowered 2339 to 2335" added to main's note). While the file was in
   conflict, `arch:check` read `actorsHistoryRefs` as 89 (the tracked file
   list held the conflicted file three times, once per stage); after
   `git add` it reads 75, main's pin.
2. A positive cell for the `row.gone ||` branch of `callerServes`
   (`route-policy.ts`): `server/web/server/middleware/gate-caller.test.ts`
   reads the member caller on a gone `GET /api/profile` row (served), and
   the same row without the stub is refused. Removing the branch fails the
   first cell.
3. The stale comments of `server/web/lib/auth-constants.ts` (the member
   byte paths, the member and the Admin private-file paths) no longer
   name `getMemberForAsset` or a route: each says no route serves the path
   any more. The paths stay (open items).
4. The byte-equal claim is a test:
   `server/web/lib/auth/route-policy-rows.test.ts` writes one line per row
   of `buildRoutePolicy(routeManifest)` (key, class, scope, caller, gone)
   and checks it against `server/web/lib/auth/__snapshots__/route-policy-rows.txt`
   (817 rows). The file was written with main's code (the eight changed
   source files checked out from 53b507b53, the manifest regenerated,
   `vitest -u`), then the branch's code was put back and the test passes
   unchanged: no row moved.

### Open items

- `server/web/lib/auth-constants.ts:51-65` still admits a `?at=` asset
  token on four paths no route serves (`/api/member/files/`,
  `/api/member/draws/:id/svg`, `/api/member/space/:id/bytes`,
  `/api/admin/space/:id/bytes`), and `server/web/lib/body-limit.ts:92`
  names `/api/admin/space`. Removing them could change a token request's
  answer on those paths (the router's 404 today, the gate's 401 after),
  so they are left for a step that may change an answer. The same holds
  for `server/web/server/middleware/gate.ts:93` (`MEMBER_FRAME_RE`, the
  `?t=` frame ticket carve for `/api/member/apps/:id/frame`) and its
  `FRAME_ROWS` entry in `server/web/lib/auth/route-policy.ts`: no route
  file serves that path.
- DB suites were not run: the step changes no SQL and no DB path; CI runs
  the DB subset.
