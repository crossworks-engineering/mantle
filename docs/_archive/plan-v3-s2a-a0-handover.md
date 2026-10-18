# Plan v3.2 S2a a0: login facts in SQL (handover)

The branch `feat/s2a-a0-login-facts`. The spec's rule is in
[../actors.md](../actors.md), section 6 ("Who may do what") and section 15
("Known limits"); this file holds the step's detail and its handovers,
which never go to the spec. Moved here from the spec in fix round 1 (D1
made docs/actors.md the spec, with a down-only line pin).

## What the step does

Plan v3.2, S2a a0, migration 0304 (`0304_login_facts`, journal `when`
1790197560000; written as 0302, renumbered at the rebase on v0.300.90).
Each fact about a login that an area ask or an Admin ask reads has one SQL source:

- `mantle_area_rule(login, area)`: THE area rule about a login. The
  brain's live Admin workspace, an enabled login with a user row there, a
  known area, limits that do not switch the area off. For an ask about
  another login (the maker of a tool, a vault pair, a Telegram chat) and
  for unscoped system work. `loginHasArea` (`packages/db/src/client.ts`) is
  a thin call of it.
- `mantle_scope_has_area(area)`: `mantle_area_rule` for the scope's own
  login AND the brain's Admin workspace is in the scope. Every ask about
  the scope's own login uses this one, never the bare rule.
- `mantle_login_area(login, area)`: "the brain has no Admin workspace: yes"
  OR `mantle_area_rule`. The first branch is a fail-open site (S4a counts
  it, S4b removes it); it reaches neither `mantle_scope_has_area` nor
  `mantle_login_areas`.
- `mantle_login_areas(login)`: the areas `mantle_area_rule` gives, in
  SCOPE_AREAS order; the strict rule only (S8a's `areasFor` reads it).
- `mantle_login_is_admin(login)`: `loginHoldsAdmin`'s SQL, moved; an
  enabled login with a user row in the brain's live Admin workspace, never
  the role alone. `loginHoldsAdmin` is a thin call of it.
- `mantle_role_drift()`: enabled logins, former clients
  (`archive_client_logins`) left out, whose role disagrees with
  `mantle_login_is_admin` (role admin outside Admin, or another role
  inside it). A disabled login is left out: a disable keeps role admin.

Grants: PUBLIC, the viewer roles, the write role and the gap writer may not
EXECUTE `mantle_area_rule`, `mantle_login_areas`, `mantle_login_is_admin`,
`mantle_role_drift` or `mantle_login_area`; the runtime role runs the first
four (`RUNTIME_SYSTEM_FUNCTIONS`), the definers call them as their owner.
`mantle_scope_has_area` keeps the workspace role's EXECUTE.

`adminUserSql` (`packages/db/src/admin-user.ts`, the system pool's "an Admin
user holding an area" for `server/web/lib/workspace-ticks.ts`) was a plain
copy of the rule: it is a call of `mantle_area_rule` now.

**Changed answers.** `mantle_scope_has_area` is narrower: it gains the
disabled_at test, so a disabled login inside a scope that is still open no
longer holds an area (the named cell), and the brain-owner test, so a scope
holding another brain's Admin workspace holds none. No box has two brains
in one database, so the owner test changes no answer on a box; it changes
two test fixtures that make a second, fake brain on the shared test
database: `workspaces.db.test.ts`'s W5b1 cell (its owner's Admin now holds
no area: the two yes cells say no, and the yes, limits and Admin assistant
cells run on the brain's own Admin in `login-facts.db.test.ts`), and
`server/web/lib/runs/execute-item.db.test.ts` (it runs on a database of its
own, whose brain is its anchor, so its run's Admin scope holds the
assistants area as before). Every other fact answers as the text it
replaces (`packages/db/src/login-facts.db.test.ts`).

## Handover (round 0, audit at 2edf57374: 8.5/10)

**Recorded on main first** (v0.300.83, ea671d46b, workstation, own pg, the
checks' floor kept as CI keeps it): the A8 grid (`pnpm test:matrix`: 14608
cells, 9404 run, 9404 pass, 0 fail, 5204 not applicable); the guard and
role sweeps (`a4-guard-sweep`, `role-sweep`, `member-sweep`, `auth-sweep`,
`scope-areas`: 45 tests pass, recorded files unchanged); the DB files that
ask an area (`w7a-area-system-sweep`, `a6b-exit-sweep`, `w7a-admin-scope`,
`write-role`, `runtime-role`, `workspaces`: 148 pass). On the branch: the
same A8 summary, byte for byte; the sweeps pass with their recorded files
unchanged; the DB files pass but the W5b1 cell named above.

**Tests** (`login-facts.db.test.ts`): each fact against main's text on 9
logins (anchor, Admin user, Admin user with users off and keys "false",
disabled Admin user, member, role admin outside Admin, former client, a
user of another brain's Admin, no login) by 6 areas (the five and an
unknown one), `adminUserSql` too; `mantle_login_area` with and without an
Admin workspace (the strict facts stay no without one);
`mantle_scope_has_area` on 5 scopes, on the workspace role's settings and
on the system pool's: only the named cells differ, each yes to no;
`scopeHasArea` kind by kind on the brain's own Admin (W5b1's cells); the
disabled-in-scope cell on `mantle_view_user`; the drift cells (a disabled
Admin user 0, a role admin login outside Admin 1, a former client left
out, a member inside Admin 1); the catalog cell (as round 0 wrote it: no PUBLIC,
viewer role, write role or gap writer may EXECUTE a login fact, the
runtime role runs the four; the cell asked the viewer roles and the gap
writer only, fix round 1's M1 below); the renumber proof (0304's `when` above every one before it and
above the S11a-7 hotfix's 1790197500000; a database at 0303 applies 0304 and only it).
`check-floor-renumber.db.test.ts` is main's (S3's) form: it applies every
migration after 0301, 0304 too (`all.length - at`).

**Pins:** `sqlAreaRules` is not pinned here: P1a's counter is not on main
yet. Against P1a's counter (rights-counts.mjs on its branch, 7 on main:
`mantle_scope_has_area`, `mantle_login_area`, `loginHasArea`,
`loginHoldsAdmin`, `adminUserSql` and the two Telegram asks in
`packages/telegram/src/chat-login.ts`), this branch reads 3: the one SQL
function that reads the area limits is `mantle_area_rule`, and the two
Telegram asks are left (7 minus 4: the two SQL functions now call the rule,
the three TypeScript copies call it).

**Migration number:** claimed at the merge (plan v3.2 rule 3). Written as
0302 (with 0303 and no 0302 on main, `migrations-journal.test.ts`, "no
slot is skipped", fails a branch). R0 landed 0301, S3 0302 and the S11a-7
hotfix 0303 (`when` 1790197500000), so at the rebase on v0.300.90 it is
0304: file name, journal idx 304 and tag, the `TAG` in
`login-facts.db.test.ts` and the renumber proof's names. The `when` stays
1790197560000, above 0303's.

**Rollback** (plan rule 2): a one-image rollback to v0.300.83 lands
narrower or equal. Migrations are forward only: 0304's functions stay, and
v0.300.83's migrate sees its mark above every journal entry (nothing
pending, no gap). What remains: `mantle_scope_has_area` and
`mantle_login_area` keep 0304's bodies (the disabled login inside an open
scope stays refused; the owner test stays); `mantle_area_rule`,
`mantle_login_areas`, `mantle_login_is_admin` and `mantle_role_drift` stay
in the catalog, and v0.300.83's boot grants take them from the runtime role
(its allowlist does not name them), so no app role runs them;
`loginHoldsAdmin`, `loginHasArea` and `adminUserSql` answer from their own
text again, the same answers.

**Gates** (workstation, own clone and pg18 container, the checks' floor
kept at migrate as CI keeps it, `--maxWorkers=3`, one at a time, on
40a0e3543; the head adds docs only): typecheck 0, lint 0, format 0, docs 0,
arch 0, web build 0, unit vitest without a database 0, boot:smoke 0,
test:actor-off 0, test:actor-on 0, test:edit-on 0, test:matrix 0 (the A8
summary as on main), full vitest 0 and full test:runtime-role 0. The first
full vitest and runtime-role runs passed every test (13485, 2587) but
exited 1 on one unhandled CONNECTION_CLOSED in
`w7e-member-scope.db.test.ts`'s teardown (the fire-and-forget audit insert
its own comment names; it hit the first g2 runtime run too). The file
passed twice alone, and both suites passed again whole, exit 0.

**Left:** audit; the CEO's renumber at merge if S3 lands first; the
`sqlAreaRules` pin at 3 once P1a is on main; the box script reads
`mantle_role_drift()` once this rolls (S8a waits for 0 on every box).

## Fix round 1 (audit at 2edf57374: 8.5/10, no widening)

Rebased onto main 8b3099467 (v0.300.85, D1 and P1a merged). This round
is test, doc, log and pins only; no SQL, no answer changes.

- **Docs.** This file is the old "Login facts in SQL (S2a a0)" section of
  docs/actors.md and its handover, moved out of the spec. The spec's
  section 6 now says the one SQL area rule: `mantle_area_rule`;
  `mantle_scope_has_area` is that rule plus "Admin in the scope";
  `mantle_login_area` keeps the counted fail-open branch (S4). Its "Known
  limits" line "the area rule is written in four SQL places and in
  TypeScript" is gone (a0 closes it); the line left says `mantle_login_area`
  is the rule or, with no Admin workspace, yes (S4). The spec stays at 350
  lines (`actorsMdLines` 350, unchanged).
- **M1, the catalog cell** (`login-facts.db.test.ts`, "catalog: no role but
  a superuser..."). It asks every role in the cluster that is not a
  superuser, `mantle_runtime` or `mantle_owner` (so every viewer role,
  `mantle_write_user`, the gap writer, `mantle_system`, and any role a
  later step adds), and PUBLIC, for each of the five login facts,
  `mantle_login_area` too: none may EXECUTE one, and each is a definer. It
  also asserts the roles it is about exist (a viewer role, the write role,
  the gap writer, and `mantle_system` where the runtime roles are made), so
  it cannot pass on an empty list. The runtime role runs the four and never
  `mantle_login_area`, as before.
- **L1, the area list** (`login-facts.db.test.ts`, "mantle_login_areas
  gives the anchor every area TypeScript knows"): `mantle_login_areas` of
  the anchor equals `WORKSPACE_AREAS` (`@mantle/client-types/dto/workspaces`),
  in order. An area TypeScript gains that the SQL's list lacks fails it.
- **L2, the log** (`packages/db/src/client.ts`, `loginFactFailed`):
  `loginHoldsAdmin` and `loginHasArea` still answer no on any error (fail
  closed). On a 42501 (permission denied: a lost EXECUTE grant) the first
  one per process logs a `console.warn` with the `[db]` prefix, the
  idiom of the file's other warnings (packages/db cannot use `log(scope)`:
  @mantle/tracing sits above db); nothing else is logged. Eleven lines
  added beside the two functions, so S3's client.ts hunks do not meet it.

**Pins** (scripts/arch-scoreboard.pins.json, each with its note):
`sqlAreaRules` 7 to 3, measured by P1a's counter on this branch
(`mantle_area_rule` and the two Telegram asks left; the two SQL functions
call the rule, the three TypeScript copies are thin calls). `consoleCalls`
475 to 476: L2's one warning. `actorsMdLines` 350, unchanged.
At the rebase on v0.300.90: `dbClientLines` 3141 to 3142 (S3's pin, on
main since; a0's client.ts hunks are 21 lines in and 20 out);
`sqlAreaRules` reads 3 on the rebased tree, as pinned.

- **P1a's catalog cell** (`packages/db/src/rights-catalog.db.test.ts`,
  "finds the same functions reading the 'areas' limits") asked that the
  live functions reading the limits include `mantle_scope_has_area`; after
  0304 it calls the rule, so the cell now says the list is exactly
  `mantle_area_rule`. The first full runtime-role run caught it (1 failed
  of 2593); one line, P1a's file.

**Merge notes for the CEO.**

- Done at the rebase on v0.300.90: `check-floor-renumber.db.test.ts` is
  S3's form (a0's hunk dropped; it passes with 0304_login_facts after it),
  and the migration is `0304_login_facts.sql` (`when` 1790197560000).
- The Telegram membership asks (`packages/telegram/src/chat-login.ts`, the
  two queries that read `workspace_users` with the Admin workspace as a
  helper's fallback) are not the area rule and stay as they are: they wait
  for S2b b3. P1a's `sqlAreaRules` counter classes them as area rules (3 on
  this branch: `mantle_area_rule` and the two), so the counter needs
  them moved to a membership class later; then the count reads 1.

**Gates (fix round 1).** On the Mac, on cc991f22f (the head adds
the one rights-catalog line), `DATABASE_URL` unset: `pnpm -r typecheck` 0,
`pnpm lint` 0, `pnpm format:check` 0, `pnpm docs:check` 0, `pnpm
arch:check` 0, `pnpm -C server/web build` 0, `pnpm exec vitest run server
packages eslint-rules` 0 (842 files passed, 256 skipped; 10914 tests
passed). On the workstation, own clone and pg18 container (`a0f_pg`, its
own free port, max_connections=450), migrated with `MANTLE_CHECK_FLOOR=keep`,
`--maxWorkers=3`, one at a time: `login-facts.db.test.ts` 0 (11 passed);
full `pnpm test:runtime-role` 1 at cc991f22f (the rights-catalog cell
above), then 0 at f2da6ec12 (261 files, 2592 passed, 1 skipped); `pnpm
test:actor-on` 0 (28 files, 343 passed, 1 skipped). L1's proof: with
`'mutant'` added to `WORKSPACE_AREAS` in the clone, the new cell failed
(exit 1, the SQL's five against TypeScript's six), then the file was
restored. Not rerun this round: full vitest with a database,
test:actor-off, test:edit-on, test:matrix and boot:smoke; they passed at
40a0e3543 (round 0), and this round changes tests, docs, one log line and
pins only. Clone, container (with its volume) and logs removed by exact
name.

**Left:** the Telegram asks' class in the `sqlAreaRules` counter (S2b b3); the box script reads `mantle_role_drift()` once this rolls (S8a
waits for 0 on every box).
