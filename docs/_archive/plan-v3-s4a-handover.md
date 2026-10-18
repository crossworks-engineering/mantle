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
config 0 (2623 passed). The actor-off, actor-on, edit-on and matrix
configs: see the CI note and the final report.

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
