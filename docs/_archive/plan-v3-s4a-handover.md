# Plan v3 S4a handover

Plan v3.2 step S4a, "Defaults fail closed" (issue 5), the counting half.
Branch `feat/s4a-fail-closed`, cut from main at v0.300.90. Code and scripts
only, no migration. No answer changes; S4b (a later release, its migration)
refuses what this counts. The rules are in the spec, docs/actors.md
section 7 ("Fail-open counts") and section 14, with the detail in
docs/fail-open.md and docs/runtime-role.md.

## Done

- The six fail-open branches each write one miss row per site and calling
  file, check `fail-open:<site>` (`packages/db/src/fail-open.ts`, the
  writer and what makes a hit in `packages/db/src/fail-open-sites.ts`):
  `scope-holds-admin` and `scope-has-area` (a yes outside every scope, a hit
  only with no system actor bound), `typed-write` and `raw-write` (a scoped
  write to a table the write role does not hold, sent to the system pool),
  `turn-exit` and `system-db` (the two production allows in a turn scope,
  viewer.ts). A site asks one map before any stack and takes at most one
  stack a minute; one row per site and file in a process. A raw write with
  no app frame on its stack names its table.
- Box counts, numbers only (`scripts/arch-scoreboard-box.sh`):
  `fail_open_misses:all` and per site (distinct site and file pairs since
  `mantle_web` started), `env_has_runtime_role_line`. The existing
  `brains_without_admin_workspace` covers mantle_login_area's yes and
  areasOf's "migration skipped" path (each needs a brain with no Admin
  workspace).
- The scopedSystemWrite list, measured with the full vitest run on a
  throwaway database in warn (`MANTLE_FAIL_OPEN_DUMP`, vitest.setup.ts):
  `public.item_marks` (raw, 'own-marks'), `public.pending_tool_calls`
  (typed, 'approval-queue'), `public.assistant_messages` (typed,
  'conversation-store'). docs/fail-open.md, "The scoped writes that stay on
  the system pool". 146 hits, all login actors, no other table.
- Runtime role for new installs, no box flipped: `ensure_runtime_role_line`
  in infra/updater/updater.sh (called after the image tag, before compose
  recreates mantle_web; its line goes to update.log) and step 3b of
  scripts/roll.sh (sends the same functions from its checkout). A `.env`
  with no line gets the running mantle_web's value (`docker exec mantle_web
printenv`; unset 0), or 0 with no running mantle_web, through
  `persist_env`; a line already there is kept; a failed read of a running
  container writes nothing. scripts/install.sh writes 1 on a fresh box;
  .env.example shows it set. features.ts and docker-compose.yml unchanged.
  Off logs `[db] SECURITY: MANTLE_DB_RUNTIME_ROLE is unset or 0.` at start
  (dbRoleNote).
- Pins: `failOpenSites` new at 6 (S4b: 0). `dbClientLines` raised 3141 to
  3144 with its reason (the typedWrite and loginWriteClient hooks and their
  import, less isWriteRoleTable); every other pin unchanged.

## Answers

Recorded on main (f970ff0cf) and on the branch with one scratch test of
every site (unscoped yes with no actor, a login actor and a system actor;
each area and an unknown one; a scoped typed write to a system and a
write-role table; system work; the turn exit and the systemDb caller in
test and production, with the console lines): byte-equal, sha1
e7275a5527d977ed6935a70182e2e9f8b1168d90. A scoped write still runs on the
system pool (fail-open.db.test.ts reads the row it wrote). Changed log text
only: the runtime-role warning starts with `[db] SECURITY:` when off.

## Gates (exit codes)

Mac, DATABASE_URL unset: pnpm -r typecheck 0, pnpm lint 0 (1 on the first
run: two unused imports, fixed), pnpm format:check 0, pnpm docs:check 0,
pnpm arch:check 0, pnpm -C server/web build 0, pnpm exec vitest run server
packages eslint-rules 0 (10948 passed), bash scripts/test-deploy-scripts.sh
0 (500 passed).

Workstation, throwaway pgvector pg18, MANTLE_CHECK_FLOOR=keep:
fail-open.db.test.ts 0 in warn and 0 with both checks on (edit-on config,
which now includes it); full vitest with DB 1: one failure,
recall-native.db.test.ts "M7: the embed refill", which passes 3 of 3 alone
(timing under load; no S4a code on its path); test:runtime-role full
config 0 (2623 passed); the actor-off, actor-on, edit-on and matrix
configs 0 each. The container, worktree and branch there are removed.

## Left

- S4b: refuse each site, add `scopedSystemWrite` to the three matrix rows,
  remove mantle_login_area's no-Admin branch (its migration), after one
  fleet release whose box counts read 0 (a dev roll first: the tests bind
  `system(test)`, so the unscoped yes and the production allows are only
  seen on a box).
- Rebase onto a0, P1b and S11a when they merge: client.ts hunks are
  disjoint from a0's (loginHoldsAdmin/loginHasArea); the pins JSON and
  arch-counts.mjs are key-disjoint additions; P1b edits the box script's
  runtime-role block next to the new counts.

## Fix round 1 (audit of 298625b43, 8/10)

- A pair's row is written again after an hour (as actor.ts does), and is
  marked only once a writer took it (`writeActorMissRow` answers false
  before the pool sets its writer). Unit cells for both.
- The box counts the last 24 hours, or since the last roll began (the
  updater's `started_at`) when that is later, not since `mantle_web`
  started. The query was run on a throwaway database: a roll 30 minutes ago
  counts 1 of 3 rows, no roll known counts 3.
- `ensure_runtime_role_line` says "no readable .env" and writes nothing
  when `.env` is missing or unreadable; the box prints n/a then.
- Deploy cells: a CRLF line, no trailing newline, a commented line,
  duplicate lines, no `.env`.
- docs/fail-open.md and the spec say what the dedupe does and that the list
  is vitest plus the box counts, with what vitest cannot see.
- Rebased onto v0.300.92 (384b64d02). Re-pin: `dbClientLines` 3142 to 3145
  (the same three S4a lines over main's new count); `failOpenSites` 6.

Gates: Mac typecheck 0, lint 0, format:check 0, docs:check 0, arch:check 0,
web build 0, unit vitest 0, test-deploy-scripts 0 (508 passed).
Workstation: fail-open.db.test.ts and fail-open.test.ts 0 in warn (21),
fail-open.db.test.ts 0 with both checks on (4). Cleaned up there.

## Fix round 2 (diff check of 4cd5d509b)

- Rebased onto v0.300.93 (6e49ee5b4, P1b counters). The four first commits
  are squashed into one, which carries the `dbClientLines` re-pin (3142 to
  3145), so every commit passes `pnpm arch:check` (checked commit by
  commit). The handover heading makes S4a a history code: 'S4a' is in
  HISTORY_HEADING_CODES in the commit that adds the heading, and
  `historyCodeComments` is re-pinned there, 2332 to 2340 (the S4a code
  comments that name it).
- The box's fail-open floor is never later than an hour ago:
  `greatest(now() - 24 h, least(started_at, now() - 1 h))`. Any write of the
  updater's status moves `started_at` and none restarts a server, so an
  error reads as a false non-zero, never a false 0. The box script needs
  ssh, docker and Postgres, so its query was run on a throwaway database
  (rows 50 minutes, 10 minutes and 20 hours old: no roll known 3; a roll 5
  minutes ago, 3 hours ago or a bad future time 2, the hour-old rows kept),
  and two static cells in test-deploy-scripts.sh hold the floor and the
  `-r` checks.
- The runtime role's `.env` fallback in the box script reads `-r` (n/a
  when unreadable).
- docs/fail-open.md: a second caller is found when it is the first hit
  after the site's minute gate.

Gates: Mac typecheck, lint, format:check, docs:check, arch:check, web
build, unit vitest, test-deploy-scripts, cleanup-counts.test.ts and
arch-lints.test.ts: see the final report.

## The scopedSystemWrite list (feat/s4a-list, 2026-10-26)

The piece S4b reads before it refuses a scoped typed write to a table the
write role does not hold. Every site box miss was `fail-open:typed-write`
from a login actor; each site is named, moved or left for the owner.

- `TableAccess.scopedSystemWrite` (a reason) and `SCOPED_SYSTEM_WRITE`
  (packages/db/src/access-matrix.ts); `noteScopedSystemWrite` skips a named
  table. One table: `public.item_marks` (own marks: actor_id is the
  caller's login; the node is read in scope first). Its comment no longer
  says owner paths only. New pin `scopedSystemWriteTables` 1, counted from
  the matrix rows (eslint-rules/arch-counts.mjs); access-matrix.test.ts
  holds each reason non-empty, never a write-role table, the list equal to
  the pin.
- `bumpAgentUsage` and `bumpWorkerUsage` on `systemDb` (narrow in a scope),
  not named: a reason on agents or ai_workers would let every scoped
  configuration write through. ai_workers' NARROW_WRITES gains
  `last_used_at` and `usage_count`. Grants are applied at every migrate
  (applyRuntimeGrants), so no migration (0336 not used). systemDbUses 68 to
  70, systemDbFiles 20 to 22, systemDbUses_narrow 64 to 66; the narrow
  write scan's pin for the bump is gone.
- `api_tool_update`: updateTool, addToolToGroup and setToolExternalAccess
  through `areaSystem('connectors', …)`. The gate is unchanged.
- vitest.setup.ts fails a test whose typed-write hit names a table that is
  neither named nor in `SCOPED_SYSTEM_WRITES_LEFT` (fail-open.ts, pinned by
  fail-open.test.ts). Left for the owner: `pending_tool_calls` (the approval
  queue, 164 hits over the suites) and `assistant_messages` (a login's MCP
  turn rows, 8 hits). Measured with MANTLE_FAIL_OPEN_DUMP over both DB shards and
  test:actor-off, actor-on, edit-on, matrix, runtime-role and serial: no
  other table.
- No answer changed. Cells: fail-open.test.ts (a named table is no hit; the
  left list), fail-open.db.test.ts (item_marks no hit; the counters move with
  no hit), packages/tools/src/api-tool-update-area.db.test.ts (a member and
  an Admin user with connectors off refused, nothing written; an Admin user's
  update, group join and External access off with no hit).

Gates on the Mac (rebased on v0.400.7): pnpm -r typecheck 0, eslint on the
changed files 0, format:check 0, docs:check 0, arch:check 0, web build 0,
unit vitest 0 (one harness timeout under load in deploy-scripts.test.ts,
0 when rerun alone). Workstation suites on eab94e984 (the pushed head
before this docs-only note), all exit 0: DB vitest shard 1/2 6889 passed
and 2/2 8349 passed, test:actor-off 1652, actor-on 419, edit-on 591,
matrix 8, runtime-role 3174, serial 1.

## The list's fix round 1 (audit of 44e39726a)

- MED-1: a `scopedSystemWrite` reason covers a login's write only
  (`noteScopedSystemWrite`): an assistant's, a link's or a contact's
  scoped typed write to `item_marks` still counts and fails the suite's
  guard (`unnamedScopedWrites`, fail-open.test.ts).
- The owner's direction, both tables left moved to the system pool
  helpers, nothing named: `pending_tool_calls` through
  `packages/db/src/pending-calls.ts` (one `parkPendingCall` at the spot
  `pending-park` for all six parks, execute-call.ts and the dev console
  included; `decidePendingCall`, `unclaimPendingCall`,
  `revertPendingCall`, `settlePendingCall` with `deciderFilter` in the
  WHERE); `assistant_messages` through
  `packages/db/src/conversation-writes.ts` (`threadLoginFor`: with a login
  actor bound the row is that login's, another refused). The supersede
  stamps a settled inbound row, which 0323 never lets the narrow role
  rewrite, so it runs at a new full-route spot `turn-supersede` (the
  system pool it ran on): the one place the order's "narrow" could not be
  kept without a refusal. No grant added; no answer changed (an owner's
  row names the anchor's id, as the stamp gave). `SCOPED_SYSTEM_WRITES_LEFT`
  is empty, pinned empty.
- LOW-1 to LOW-3: noteFailOpen's comment, five branches in actors.md and
  the scoreboard label; the three test files that drain the hits pinned;
  the guard's blind spots named in vitest.setup.ts.
- LOW-4: a write site's minute gate is per site and table and its check
  names the table (`fail-open:typed-write:public.x`); the box's per-site
  counts read `split_part(check_name, ':', 2)`; docs/fail-open.md gives
  the numbers-only query of the tables.
- Pins: systemDbUses 70 to 77, systemDbFiles 22 to 23,
  systemDbUses_narrow 66 to 73, fullRouteSpots 31 to 32,
  fullRouteSpotCalls 122 to 118.
