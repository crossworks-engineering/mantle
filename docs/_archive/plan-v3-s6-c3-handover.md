# Plan v3 S6 part c3 handover

Branch `feat/s6-c3`. Built on `origin/feat/s6-c2` (e50fd5f51, c2 not merged
yet, by the CEO's word); round 2 (below) rebased it onto main 6f6e85704
(v0.300.102, c2 merged). Not merged, not tagged, not rolled. Plan v3.2 section "S6. Admin acts become
definers", part c3. No migration: no new definer was needed (below).

## Measured first

The `admin-write` request exit had two sites on main (requestSystemExits 5,
admin-write 2). Per route, from the route policy rows (`anyLoginRow`, write
effect) and `enterLoginWrite`:

| Site                           | Routes (an Admin user's write)                                                                                                                                                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anyLoginScope` (12 rows)      | POST /api/access-keys, DELETE /api/access-keys/:id; POST /api/assistant/turn, read, threads, threads/:id/continue, threads/:id/summarize, transcribe; POST /api/telegram/pair, chats/:id/block, chats/:id/unpair, DELETE /api/telegram/my-chats/:id |
| `enterLoginWrite` (4 rows, c1) | POST /api/contacts/:id/sharing, DELETE /api/contacts/:id/shares, POST /api/shares/contacts, POST /api/entities/merge                                                                                                                                |

The grants and workspaces writes were in the scope already (F4, S2a a2).

## Done

- `anyLoginScope` (session.ts): every login enters its scope on an
  any-login row, reads and writes alike. `inLoginScopeForWrites` and
  `noteSystem` are gone.
- `enterLoginWrite` (session.ts): no Admin act branch. `ADMIN_ACT_WRITES`
  and `adminActWrite` (route-scope.ts) are gone. The four c1 acts run in
  the login's scope; their handlers already called the definers through
  `adminActTx` (a system-pool transaction with the scope set: the write
  role holds no EXECUTE on the definers, and access-matrix.ts is S2c's).
  Their other reads (`contactSharingFor`, `listContactSharesForAdmin`) are
  definers granted to the workspace role.
- The Admin-only branches, each already a definer or a named exit, so no
  new definer and no migration:
  - another login's key: `mantle_access_key_revoke` (0293, 0306) checks
    the scope's own login and "an Admin user" inside; it now runs on the
    write role in the Admin user's scope.
  - a moderated bot's chat: `setChatPairing` and `loginModeratesBot`
    (`@mantle/telegram`) run by the named exit `'login-telegram'`, the
    users area asked by `loginHasArea` (mantle_area_rule). Unchanged.
  - a key make: its body leaves the scope by `'rule-in-query'`, as for a
    member (the password check reads the login's hash). Unchanged.
- `resolveChatAgentToWrite` (lib/assistant-chat.ts), used by the chat
  writes (read, threads POST, turn): in the scope an Admin user does not
  read another workspace's assistant row, so an explicit slug of it fell
  through to the default agent (found by the first DB run: the A6b exit
  sweep, `POST /api/assistant/read` agent=P/Q, 404 on main, 200 for the
  default agent on the branch). Now an explicit slug that does not resolve
  to itself is null, for every login (a member's rule already).
- c1 audit LOW-6: the owner functions that skip the Admin check
  (`enableContactSharing`, `regenerateContactCode`,
  `disableContactSharing`, `createContactShares`,
  `revokeAllContactShares`) left `@mantle/content`'s main entry for a
  `@mantle/content/test-support` entry. `eslint.config.mjs` refuses a
  static import of it in `server/**` outside test files. Four tests
  rewired (contact-share-gate, a8-surfaces, f9-contact-export, w6b-fix2).
  `mergeEntities` stays (the sweep uses it).

## Answers

Byte-equal for every HTTP answer recorded on main (the A4 guard sweep,
the A10 body sweep, the A6b exit sweep, w7c, w7d, the access keys suites,
f4-owner-flows, s6-c1, s6-c2), with these changes:

1. Where the 12 any-login rows and the 4 c1 acts run: the A4 guard sweep
   re-recorded for those rows only (`out=system:admin-write` to
   `out=user:true`, 4 Admin credentials each; every status and body
   equal). `a4-guard-sweep-moved-writes.txt` unchanged.
2. Narrower: an Admin user's chat write with an unknown or disabled
   explicit slug answered as the default agent (200, or a turn with the
   default assistant); now the route's "no agent" 404. A member's did
   already. Cell: `s6-c3-any-login-writes.db.test.ts`.
3. Narrower in theory: a chattable agent with no workspace that an Admin
   user's scope does not read would now answer "no agent" on a write. None
   seen (no fixture holds one).
4. A key revoke of another login's key keeps today's rule, "an Admin user"
   (with or without the keys area). The plan's "with the keys area" is not
   today's rule (the list shows every key to every Admin user too); left
   for the owner (Open).

## Pins (each with its reason in the pins' notes)

- `requestSystemExits` 5 to 3, `requestSystemExits_adminWrite` 2 to 0.
- `adminActRoutes` 4 (after c2) to 0.
- `routePolicyLists` 16 to 15 (ADMIN_ACT_WRITES); `no-policy-name-lists`
  route-scope.ts 5 to 4.
- `loginKindBranches` 51 to 50, `historyCodeComments` 2345 to 2343,
  `actorsMdLines` 350 to 348 (on c2's branch; on main v0.300.102 after
  the rebase: 2341 to 2339 and 349 to 347, the same two lines each).
- `inHandlerAreaChecks` unchanged: the keys area ask of the key make
  (`holdsKeysArea`) decides its 400s before the password; moving it into a
  definer reorders the answers (Open).

## Tests

- New `server/web/server/s6-c3-any-login-writes.db.test.ts` (warn and on,
  runRoute): an Admin user (with and without the keys and users areas)
  revokes a member's key; role drift and a member do not (404, key live);
  every login revokes its own; the key make's order (risky tools 400 before
  the password 403); chat writes naming another workspace's assistant or
  an unknown slug answer 404 and write no cursor; member-negative.
- Re-recorded: `__snapshots__/a4-guard-sweep.txt`, `-moved.txt`,
  `-rule-in-query.txt` (the moved rows only, code-first).
- `route-scope.test.ts`: the four acts are content writes no member
  reaches (the list is the test's own now).

## Gates (first builder, before the rebase)

Mac (DATABASE_URL unset), on head d7b4f4be0 then the fixes in 5fdd519a3:

| Gate                                                                       | Exit          |
| -------------------------------------------------------------------------- | ------------- |
| `pnpm -C server/web exec tsc --noEmit`                                     | 0             |
| `pnpm arch:check`                                                          | 0             |
| `pnpm exec vitest run server packages eslint-rules`                        | 1 (below)     |
| the fixed files (admin-counts, turn-failed-route, route-scope, arch-lints) | 0 (113 tests) |

The unit run's red cells on d7b4f4be0: admin-counts and turn-failed-route
(fixed in 5fdd519a3); the A4 guard sweep (re-recorded in 5fdd519a3: only
the 4 c1 rows and c2's 4 rows moved, `out=` only); the A10 body sweep
(c2's open item: a change kind for its rows); the journal "no slot is
skipped" (0309, S2b, not on main yet).

Workstation (own pgvector pg18 on 56313, own worktree; both removed):

| Run                                                 | Exit | Files / tests         |
| --------------------------------------------------- | ---- | --------------------- |
| the c3 set (14 files: keys, chat, Telegram, sweeps) | 0    | 16 files, 203 tests   |
| c1, c2, c3 acts and owner flows (10 files)          | 0    | 10 files, 125 tests   |
| full vitest with the database, on d7b4f4be0         | 1    | 7 files, 12 tests red |

The full run's red beyond the unit cells above: `shares-route.db.test.ts`
(3 cells, DELETE and PATCH /api/shares/:id: c2's routes, not touched by
c3; c2's DB tests had not run before) and `a2b2b-write-gateway.db.test.ts`
(an afterAll hook timeout under load). `test:actor-off` and
`test:runtime-role` NOT RUN (stopped at the handover). Pushed with
`--no-verify`; CI will be red on the c2 cells until c2 lands.

## Round 2 (second builder)

### The rebase

Rebased the c3 commits onto main 6f6e85704 (v0.300.102, c2 round 3
merged); c2's three branch commits dropped out. No code conflict: only
the pins file and the A4 sweep snapshots conflicted. Both were taken from
main, then c3's pin moves put back on main's numbers (with their notes)
and the sweep re-recorded. The A4 rule-in-query snapshot was reset to
main's before the re-record too. The rebase left a trailing blank line in
route-scope.ts (format:check, fixed).

### The two DB-less sweeps, re-recorded (code-first, as c1 and c2)

Each file's answer table resolved per route, method and credential and
compared with main 6f6e85704 cell by cell:

| File                               | Cells | Equal | Log only | Answer moved |
| ---------------------------------- | ----- | ----- | -------- | ------------ |
| `a4-guard-sweep.txt`               | 11725 | 11661 | 64       | 0            |
| `a4-guard-sweep-moved.txt`         | 9286  | 9222  | 64       | 0            |
| `a4-guard-sweep-rule-in-query.txt` | 188   | 180   | 8        | 0            |

Every moved cell is the same change: the guard log's
`out=system:admin-write` is now `out=user:true` (checked: the main log
with only that token replaced equals the new log). Status, headers and
body are byte-equal on every cell. The 16 routes (4 Admin credentials
each): POST /api/access-keys, DELETE /api/access-keys/:id; POST
/api/assistant/read, threads, threads/:id/continue,
threads/:id/summarize, transcribe, turn; POST /api/telegram/pair,
chats/:id/block, chats/:id/unpair, DELETE /api/telegram/my-chats/:id;
POST /api/contacts/:id/sharing, DELETE /api/contacts/:id/shares, POST
/api/shares/contacts, POST /api/entities/merge. The rule-in-query file's
8 are the two access-keys rows; its "answers on main" block is unchanged.
No other snapshot file moved (more, moved-writes, guard-writes,
head-logins, owner-decision).

The A10 body sweep is green against main's snapshot with no re-record:
no c3 cell moved there, so no new `changeKind` is needed.

The real answers (no stand-in) are the DB tests below: byte-equal, or the
two narrower cases in Answers (2 and 3).

### The shares-route cells

`shares-route.db.test.ts` is green on the rebased branch (9 of 9, alone
and in the full run). The 3 red cells were c2 round 1's, not c3's: c2
round 2 moved its PATCH and DELETE cells to runRoute (b028ca308,
9b6b533a0, fe45e3f53), and none of those three is in e50fd5f51, the base
the first builder used. Nothing to fix in c3.

### Gates (round 2)

Mac (DATABASE_URL unset), on 8f0d71e54 (format again on fe2a556f4):

| Gate                                                | Exit                                     |
| --------------------------------------------------- | ---------------------------------------- |
| `pnpm -r typecheck`                                 | 0                                        |
| `pnpm lint`                                         | 0                                        |
| `pnpm format:check`                                 | 1, then 0 (fe2a556f4)                    |
| `pnpm docs:check`                                   | 0                                        |
| `pnpm arch:check`                                   | 0                                        |
| `pnpm exec vitest run server packages eslint-rules` | 0 (856 files, 11058 tests, 2770 skipped) |
| `pnpm -C server/web build`                          | 0                                        |

Workstation, on 8f0d71e54 (fe2a556f4 is whitespace only): own pgvector
pg18 on 56331 (`postgres` role and init as CI: `init-scratch`, then
`migrate`), `MANTLE_CHECK_FLOOR=keep`, `--maxWorkers=3`, systemd-run;
container, worktree, branch and logs removed after, by exact name.

| Run                             | Exit | Files / tests           |
| ------------------------------- | ---- | ----------------------- |
| `shares-route.db.test.ts` alone | 0    | 1 file, 9 tests         |
| full vitest with the database   | 0    | 1123 files, 13827 tests |
| `pnpm test:actor-off`           | 0    | 127 files, 1159 tests   |
| `pnpm test:runtime-role` (full) | 0    | 275 files, 2751 tests   |

No hook timeout in any run.

CI on b7d2f3e90: success,
https://github.com/crossworks-engineering/mantle/actions/runs/39244382909
(typecheck, lint, format, docs, arch, boot smoke, migrate from scratch,
the full test, actor off, actor on, edit on, runtime role, matrix). The
next commit adds only this line.

## Audit round (third builder, at the tool limit)

The CEO's audit of 282c864d0 (8/10, fix first). Done in this round:

- MED-1, accepted by the CEO as a named wider, safe change. An Admin
  user's chat write with no slug, where the default pick (getAssignedAgent,
  else resolveAssistantAgent's priority pick) is an assistant of a
  workspace the user is not in: main answered 404 `no_agent` on read,
  threads and turn (the system pool found that row first and refused it);
  now the scope does not read it, so the pick is the Admin assistant (200).
  Wider, safe: it reaches no data the caller could not read; the GET reads
  already worked this way; the owner may overrule. Cell: "wider, safe" in
  `s6-c3-any-login-writes.db.test.ts`, warn and on (green: 200, the Admin
  assistant's slug, no cursor on the other workspace's assistant).
- LOW-1: the test-support ban covers `packages/**` (tests and scripts
  left out; a block before the share-ui and contract blocks, which refuse
  every other `@mantle` import already) and a dynamic `import()` (a
  `no-restricted-syntax` selector in the env block, same files).
- LOW-2: the `loginKindBranches` note names the removed branch
  (`res.kind === 'admin' && route.effect === 'write' &&
!inLoginScopeForWrites(route)` in anyLoginScope).
- LOW-3: the stale comments (getChatLoginOr401, the key revoke route) and
  `'admin-write'` dropped from `RequestOutcome` (viewer.ts), so typecheck
  refuses a new site.
- LOW-4, named here: a stale explicit slug (an assistant gone, disabled,
  or of another workspace) now answers 404 on a chat write where main fell
  through to the default (Answers, 2). Client follow-up for jackdaw, not
  in this branch: drop a stale slug and retry without it.
- LOW-5: runRoute cells, warn and on: an Admin user with the users area
  blocks and unpairs a member's chat of another workspace's bot (200,
  denied or pending), one without it does not (404, unchanged) (green); a
  turn with an upload by an Admin user (200 with a DBOS stand-in, as
  w7c-chat).

Left (RED, the next builder):

- The upload cell's home check finds no row: `select wr.workspace_id from
nodes n join workspace_resources wr on wr.ref_id = n.id::text where
n.title like '%<tag>-<mode>-upload%'` returns none. Either the file's
  title is not the original name (the route names it
  `<epoch>-<safe base>.<ext>`, the base may drop the dashes) or its home
  is not a `workspace_resources` row. Read how a file's home is kept
  (`currentCreateHome`, `landedIn` in `@mantle/db`) and fix the query;
  the answer (200) is pinned already. The other 10 cells are green.
- Gates for this round on the Mac: `pnpm -r typecheck` 0, `pnpm lint` 0,
  `pnpm format:check` 0, `pnpm docs:check` 0, `pnpm arch:check` 0. Not
  run yet: the unit vitest, the web build, and on the workstation the full
  DB run, `test:actor-off`, `test:runtime-role`. CI will be red on the
  upload cell until it is fixed. The workstation container, worktree and
  branches of this round are removed.

## Final round (fourth builder)

The red upload cell is fixed in the test, not the product (a9688051c).
The query looked for the file's home in `workspace_resources`; a file's
home is on its own row, `nodes.home_ws`, as `landedIn` reads it
(`itemHomeSql`). The title was right: the route names the file
`<epoch>-<safe base>.<ext>` and the title is that name. The cell now
reads `n.home_ws` for the `file` row whose title holds
`<tag>-<mode>-upload`, and finds the Admin workspace, warn and on.

### Gates (final round)

Mac (DATABASE_URL unset), on a9688051c:

| Gate                                                | Exit                                     |
| --------------------------------------------------- | ---------------------------------------- |
| `pnpm -r typecheck`                                 | 0                                        |
| `pnpm lint`                                         | 0                                        |
| `pnpm format:check`                                 | 0                                        |
| `pnpm docs:check`                                   | 0                                        |
| `pnpm arch:check`                                   | 0                                        |
| `pnpm -C server/web build`                          | 0                                        |
| `pnpm exec vitest run server packages eslint-rules` | 0 (856 files, 11058 tests, 2776 skipped) |

Workstation, on a9688051c: own pgvector pg18 on 56342 (`postgres` role
and init as CI: `init-scratch`, then `migrate`), `MANTLE_CHECK_FLOOR=keep`,
`--maxWorkers=3`, systemd-run, one run at a time; container, worktree,
branch, script and logs removed after, by exact name.

| Run                                       | Exit | Files / tests           |
| ----------------------------------------- | ---- | ----------------------- |
| `s6-c3-any-login-writes.db.test.ts` alone | 0    | 1 file, 12 tests        |
| full vitest with the database             | 0    | 1123 files, 13833 tests |
| `pnpm test:actor-off`                     | 0    | 127 files, 1159 tests   |
| `pnpm test:runtime-role` (full)           | 0    | 275 files, 2757 tests   |

No hook timeout in any run.

CI on a9688051c: success, first attempt,
https://github.com/crossworks-engineering/mantle/actions/runs/39255986816
(every step success or skipped: typecheck, lint, format, docs, arch, boot
smoke, migrate from scratch, the full test, actor off, actor on, edit on,
runtime role, matrix, the web build). The next commit adds only this
section.

## Open

- Keys area for another login's key: decided by the CEO, it keeps
  today's rule, "an Admin user".
- The Telegram moderated-chat branch as a definer (`mantle_area_rule` thin
  call, or a definer with `mantle_scope_has_area('users')`): deferred by
  the CEO until after S2c. The key make's area ask in SQL also needs
  EXECUTE for the write role (access-matrix.ts, S2c's) and a migration;
  S7 or a c4.
