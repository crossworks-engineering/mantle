# Plan v3 S3 handover

Plan v3.2 step S3's handover, rounds 1 to 4, moved out of docs/actors.md
when D1 made that file the spec (v0.300.84). The rules S3 put in force are
in the spec: section 5 (the write role in every mode, no rerun), section 6
(the profile row's write rule, the export links' manage rule) and section
15 (the three S3 limits are gone). What follows is the step's record as it
was written, the changed answers and every round's gates.

Plan v3.2 step S3, "Write role always, gap tables closed" (issue 4 part 1).
The check mode decides refuse or report, never the pool.

What changed:

- `packages/db/src/client.ts`: `loginWriteRoute` routes a scoped login write
  to the write role in every check mode, off included; the SET carries the
  actor and `mantle.actor_check` as the mode reads (off too).
  `loginWritesMayRoute` asks only whether the process opened the write
  pool. Gone: the gap rerun of `onLoginWritePool` (the system pool in warn,
  `checkedBegin` and `checkedSettingsSql` in on), `runsAsGapWriterWhenChecked`,
  the `GAP_*` regexes and `LOCKING_READ`, `WriteRoleGapError`, the `checked`
  and `gap` fields of a write transaction. A right the role does not hold is
  noted (`noteWriteRoleDenial`, the `write-role-gap` miss) and stays an
  error. 3294 lines to 3132.
- `packages/db/src/access-matrix.ts`: `WRITE_ROLE_GAP_TABLES`,
  `WRITE_ROLE_GAP_UNREADABLE`, `isWriteRoleGapTable` and `writeRoleGapTable`
  are gone. `profiles` is a write table with `writeRule: 'own-login'`;
  `app_table_exports` a write table read by all its row rule allows, with
  the write check `manage` of `app_node_id`. `syncGapWriterRights` keeps
  `mantle_gap_writer` holding nothing (every right revoked, every row rule
  naming it dropped).
- Migration 0302 (`0302_write_role_gap_tables.sql`; written as 0301,
  renumbered at the rebase on R0's 0301, its `when` 1790197440000 kept,
  above R0's 1790197380000): row level
  security on `app_table_exports` and its one read rule (manage of the app:
  a Moderator of its home, an Admin scope for an app with no home), and
  `mantle_write_role_sync_table(t, write, check_args, write_rule)`, whose
  `write_rule` 'own-login' makes profiles' write rules narrower than its
  read rule (matched by a policy note with a version,
  `mantle:write-rule:own-login:v2`, not by text: a changed rule bumps the
  version and a rerun replaces the policies; fix round 4: v2, the rule is
  one function, `mantle_profile_writable(user_id)`, which
  `profileRowWritable` asks too, and the export read rule calls
  `mantle_may_manage_home`, as `assertManageOrAdmin` does). The 0278 signature stays as a
  call with no write rule, for a rollback image. Fix round 3: it locks
  `app_table_exports` and `profiles` only, and makes the edit check's two
  item triggers (`mantle_edit_check_ro`, `mantle_edit_check_contact`, 0294's
  bodies) on profiles alone, disabled when the edit check's box mode is
  off; it no longer runs 0294's loop, which took a lock on every item table
  while profiles was held. No row is touched; no app, app row, app database
  or sandbox is removed.
- The gap writer role (`runtime-role.ts` `wantedMemberships`,
  `viewer-roles.ts`) stays one release, holding nothing: S3 part 2 drops it
  and both SET memberships of `mantle_system` (TODOs in both files).

The profiles policy (owner decision 2026-10-17, Outcome A):

- read (unchanged, 0266): the login's own row, the brain's row, every row
  in a scope that holds the Admin workspace;
- write on the write role: the login's own row, or the brain's (anchor)
  row when `mantle_scope_has_area('settings')` holds (the Admin workspace in
  the scope, the Settings area not limited off). Never another login's row.
  A delete is the login's own row only (no code deletes a profile).
- Who writes the brain's row, and what holds it there: `set_timezone`
  (scope 'admin', `ctx.ownerId` is the anchor) and an Admin turn's
  automatic time zone and reminder channel (`run-turn.ts`,
  `applyAutoTimezone` and `noteInboundChannel` of `ownerId`) run on the
  write role, so the row rule holds them, and since fix round 3 both ask
  `profileRowWritable` (the row rule, as the database asks it) first and
  skip a row the scope may not write, so nothing is logged per turn;
  `PUT /api/profile/reminder-channel` writes the brain's row for the anchor
  or an Admin user with the Settings area (`brandSettingsRefusal`, fix
  round 3), a 403 for one without; the `/api/profile/*` brand writers
  (system pool, 'self') already ask `brandSettingsRefusal` (anchor or the
  Settings area), `PUT /api/profile` the same for the brand keys and the
  anchor only for the prompt keys; `/api/settings`, `/api/appearance` and
  `/api/onboarding` are Settings-area routes. A member's turn reaches the
  brain's row only through the first-read insert of
  `loadProfilePreferences`, which the row rule refuses and the caller
  catches (the answer as before).

Changed answers (old vs new):

1. Off (no fleet box; dev and the 7 boxes are on/on): a scoped login write
   ran on the system pool; it runs on the write role. A write the row rules
   refuse is refused (narrower); a write check that would refuse in on
   reports a miss and runs, as warn. Cells: a2b2b "off: the same create runs
   on the write role too", "an Admin user's write request runs on the write
   role too" (its off half), "what only the database refuses: off and warn
   report and run it"; the A8 grants panel matrix cell "check off" (4
   misses, as warn; 0 before; still refused on both paths).
2. profiles, every mode: an Admin user without the Settings area who is not
   the anchor no longer changes the brain's row from a scoped write
   (`set_timezone`, the automatic time zone and reminder channel of an Admin
   turn): refused (42501, a scope-write refusal); since fix round 3 the turn
   skips the two automatic ones before the write (`profileRowWritable`),
   nothing logged. A scoped write of another login's
   row is refused (it ran through the rerun before). Narrower. Cell: "S3:
   profiles on the write role".
3. app_table_exports: a scoped write of an export row needs manage of the
   app (was: the system pool, no row rule). `app_table_export_set` and
   `_remove` (owner-only, `edit('id')` at the gate) by an Admin user who may
   edit the app but not manage it are refused. Narrower. Fix round 3: both
   ask manage of the app first (`assertManagesApp`, the row rule's test),
   so a refused set creates no Table (it left an orphan Table each try) and
   a refused remove answers the refusal (it answered "no export link
   exists"). Cell: a2b2b "S3 fix round 3: an editor of the app who does not
   manage it".
   The workspace role now reads the export rows of the apps it manages
   (was: no grant, an error on any scoped read; every reader today reads on
   the system pool or through `mantle_table_app_link`). That wider read
   (a manager reads the export rows of the app it manages) was accepted
   by the CEO on 2026-10-17. Cell: "S3: app_table_exports on the write
   role".
4. A transaction that met a gap table ran twice (warn and on); it runs once.
   Cells: M1, L6 and round 3 A now expect one run.
5. Off: a folder delete over a hidden subfolder answers the hidden-items 409
   (`hidden_items`), as warn and on do; it answered "folder is not empty"
   (the merge delete 409, the plain Files route 400). Cell: a3a-folders
   "off the same since plan v3 S3".
6. Off, the a6b sweep: the off cells S3 changes (`S3_OFF_CELLS`, by
   section, fix round 4: 15 kind-root cells and 2 rule-in-query cells)
   answer as main's warn cell (F4's and S3's warn changes included); any
   other changed off cell fails the sweep. The F4 off cells, the worker write role off
   cells and the a2a round trips off cell (the write role's one SET, no
   round trip of its own) expect the write role.

7. profiles is an item table now (the actor check's trigger), so 0302 makes
   the edit check's two item triggers on it (0294's bodies; fix round 3: on
   profiles alone, not 0294's loop): the read-only refusal and the contact
   share's. A read-only session (a read key, an assistant with
   no user, a public link, a peer, a contact share without Can write) and
   a contact share with Can write change no profile row, their own
   included: warn reports it, on refuses it (42501, `ro_actor`); off as
   before. Narrower. Cell: edit-check.db.test.ts "coverage: every item
   table but the heads rows has the read-only refusal"; a2b2b "S3 fix
   round 3: read-only callers (a read key, an assistant with no user) and
   their profile rows (warn, on)": since fix round 4 it names the read key
   login(ro) inside the request slot, as the session guard does (before,
   the key was bound outside the slot and the write ran as login:rw, so
   the cell proved nothing about a read key); with the edit check on
   (`pnpm test:edit-on`) the key's own row is refused 42501 `ro_actor` in
   warn and on, with it off the write runs (the open item below).
8. Fix round 3: `PUT /api/profile/reminder-channel` by an Admin user
   without the Settings area answers 403 ("The brain's reminder delivery is
   changed by the brain owner or a user with the settings area."); it
   wrote the brain's row before S3 and was refused by the row rule in
   rounds 1 and 2. Narrower. The anchor and Settings holders unchanged.
   Cell: a2b2b "S3 fix round 3: PUT /api/profile/reminder-channel".
9. Fix round 3: a scoped write of an export row also needs edit of the
   linked Table (`editCheck` on `table_node_id`, insert and update; the
   edit check: off runs, warn reports, on refuses). Defense in depth: the
   sync rewrites that Table as the brain. Narrower.
10. Fix round 3: profiles' delete rule is the login's own row (was the
    write rule, the brain's row with Settings too). No code deletes a
    profile. Narrower.

Area-owned keys on the brain's row (owner decision 2026-10-17): the
approval and egress gates that `/api/tools/settings` writes go with the
Assistants area, and `teamPrivateReads` that `/api/team-admin/settings`
writes goes with the Users area; those routes keep their area gates and
write the brain's row on the system pool, unchanged.

Not changed: the HTTP brand writers (`brandSettingsRefusal`), `PUT
/api/profile`, the Settings routes and onboarding (system pool, gated as
the owner decision says already); a member's answers on the profile row
(the first-read insert of the brain's row was refused and caught before
too, now by the row rule instead of the gap path).

## Handover (S3 round 1, builder stopped at the 120 tool call mark)

- Done: everything above, at `3d8a509b1` on `feat/v3-s3-write-role`.
- Gates (workstation, own pg on a free port, `--maxWorkers=3`): at
  `1b3670e86` full vitest exit 1 (9 failures), test:actor-off exit 1 (4),
  test:actor-on exit 1 (2), each a cell this step changes; fixed in
  `5247f36d9` and `3d8a509b1`. At `5247f36d9` the 9 changed DB files: warn
  exit 0 (142 passed), actor-on config exit 0, actor-off config exit 1 (two
  a6b sections), fixed in `3d8a509b1`: the a6b sweep in off exit 0. On the
  Mac: eslint and prettier on every changed file clean, `tsc` of
  packages/db, packages/content and server/web clean (the generated route
  manifest aside), `node scripts/arch-scoreboard.ts --check` exit 0.
- Left for the next round, at the final head: `pnpm -r typecheck`, `pnpm
lint`, `pnpm format:check`, `pnpm docs:check`, `pnpm arch:check`, `pnpm -C
server/web build`, `pnpm boot:smoke`, full vitest with DB, test:actor-off,
  test:actor-on, test:edit-on, test:matrix and the full test:runtime-role
  (none of the last three ran: the chain was stopped), then CI. At merge:
  rebase on R0, renumber 0301 to 0302 (file, journal entry; `when`
  1790197440000 stays), lower dbClientLines if R0 moved client.ts.

## Handover (S3 round 2, the gates at the head)

- The first full run (at `c9b3de33f`; CI run 39019385969 failed on the
  same cells) found four failing cells, each fixed at its cause:
  - `migrations-journal.test.ts`: 0301 alters two tables, so it locks
    both in one statement first (`LOCK TABLE app_table_exports, profiles
IN ACCESS EXCLUSIVE MODE`, `lock_timeout` 30s, as 0283).
  - `edit-check.db.test.ts` coverage: profiles became an item table (the
    actor check's trigger), so 0301 runs 0294's item trigger loop
    (`mantle_edit_check_item_triggers()`), giving it the read-only and the
    contact share refusals. Changed answer 7.
  - `ops-docs.test.ts`: the access-levels restore line held a nested
    parenthesis that cut the role list short; reworded.
  - `a8-grants-panel.matrix.test.ts` "check off": 4 misses, as warn (was
    0); both paths still refused. Changed answer 1.
- Gates at `7a084b408` (workstation, Node 26, own pgvector pg18 container
  on a free port, migrated, `--maxWorkers=3`, removed after): `pnpm -r
typecheck` 0, `pnpm lint` 0, `pnpm format:check` 0, `pnpm docs:check` 0,
  `pnpm arch:check` 0, `pnpm -C server/web build` 0, `pnpm boot:smoke` 0,
  full vitest with DB 0 (1087 files, 12869 passed, 39 skipped),
  test:actor-off 0 (1055 passed), test:actor-on 0 (345 passed),
  test:edit-on 0 (513 passed), test:matrix 0 (7 passed), full
  test:runtime-role 0 (254 files, 2012 passed). The commit after it
  changes this handover only.
- Left for the merge: rebase on R0, renumber 0301 to 0302 (file, journal
  entry; `when` 1790197440000 stays), lower dbClientLines if R0 moved
  client.ts.

## Handover (S3 round 3, the audit at `686f085a5` (8/10), rebased on R0)

- Fixed (the audit's three mediums and its lows):
  - M1: 0302 locks `app_table_exports` and `profiles` only and makes the
    edit check's two item triggers on profiles alone (0294's bodies),
    disabled when the edit check's box mode is off; 0294's loop is no
    longer called (it locked every item table while profiles was held).
  - M2: `app_table_export_set` and `_remove` ask manage of the app first
    (`assertManageOrAdmin`, the item-rights gateway, the row rule's test:
    an app with no home needs an Admin scope), after R0's edit check and
    before anything is created: no orphan Table, and a refused remove
    throws the refusal to dispatch's mapper (not "no export link").
  - M3 a: `PUT /api/profile/reminder-channel` asks `brandSettingsRefusal`
    (named "The brain's reminder delivery"); M3 b: the area-owned keys
    written above as the owner's decision, no code change.
  - Lows: the turn's reminder channel and automatic time zone ask
    `profileRowWritable` and skip (no log per turn); `app_table_exports`
    asks edit of the linked Table (`editCheck`, insert and update);
    profiles' delete rule is the own row; the policy note carries a
    version (`own-login:v1`); `app_node_id` qualified in the read rule;
    `gapTables` counts role switches to any role but the pool's own
    (`gapRerunCount`, so a renamed const cannot hide a rerun), the helpers
    moved above `measure`'s JSDoc.
  - Cells: off for the export cell and the member `set_timezone` MCP cell;
    the editor's set and remove (no orphan, the refusal); the reminder
    channel route; the read-only callers' profile rows; the rollback
    (`write-role.db.test.ts`: the 3-argument sync, then the old gap writer
    rules in one rolled back transaction).
- Rolled back to the image before S3: the narrower rollback. Its sync drops
  S3's write rules and makes the gap writer's rules again, but the
  `mantle_actor_check`, `mantle_edit_check_ro` and `mantle_edit_check_contact`
  triggers stay on profiles and RLS stays on `app_table_exports` (its read
  rule too): that image never writes a profile in a read-only or contact
  session, so they refuse nothing it does. Cell: "a rollback to the image
  before S3".
- Open (named, not changed): a read key's own profile row is written by the
  library in warn and on while the edit check's box mode is off; the gates
  above hold it (its requests carry no write scope, its tools are read
  only), and with the edit check on the read-only refusal does. Pinned in
  the a2b2b cell "read-only callers" (since fix round 4 as login(ro), named
  in the request slot: `ok` with the edit check off, 42501 `ro_actor` with
  it on).
- The rebase on R0 (main `ea671d46b`, v0.300.83): the branch was squashed
  to one commit first (its history is in the round 1 and 2 handovers
  above), then rebased once. The migration is 0302 (file, journal idx 302,
  `when` 1790197440000 kept, above R0's 1790197380000), proven by
  `migrations-journal.test.ts` "S3 renumbered after R0"; R0's
  `check-floor-renumber.db.test.ts` cell now applies 0301 then 0302 (one
  hunk). Conflicts: the journal, the pins (both notes kept), the
  worker-write-role header, `app-table-exports.ts` (R0's edit check, then
  S3's manage check). Re-measured: `gapTables` 0, `dbClientLines` 3140
  (main 3302).
- Gates at `0a6231567` (rebased; workstation, Node 26, own pgvector pg18
  container on a free port, `MANTLE_CHECK_FLOOR=keep`, `--maxWorkers=3`,
  removed after): `pnpm -r typecheck` 0, `pnpm lint` 0, `pnpm format:check`
  0, `pnpm docs:check` 0, `pnpm arch:check` 0, `pnpm -C server/web build` 0,
  unit vitest (`server packages eslint-rules`, no DATABASE_URL) 0,
  `pnpm boot:smoke` 0, full vitest with DB 1 (13443 passed, 1 failed: R0's
  renumber cell, which assumed 0301 was the last), test:actor-off 1 (the
  same cell), test:actor-on 0 (349 passed), test:edit-on 0 (515 passed),
  test:matrix 0 (7 passed), test:runtime-role 1 (the same cell, and
  `tree-readonly.db.test.ts` "deadlock detected" in its setup). At
  `82080f6e9` (the cell fixed): those two files and the journal test,
  default 0 (22 passed), actor-off 0, runtime-role 0 (11 passed; the
  deadlock did not come back). The commit after it changes this handover
  only.

## Handover (S3 round 4, the re-audit at `117e8c717` (8.5/10), rebased on D1 and P1a)

- Fixed:
  - M1: the a2b2b cell "read-only callers" bound the read key with
    `runAsActor` outside the request slot, so the slot's own actor won and
    the write ran as `login:rw` (the auditor showed its `ok` held with the
    edit check on). It now names the key inside the slot
    (`setRequestActor(loginActor(mem, 'ro'))` before `enterRequestScope`,
    as the session guard does) and writes a time zone per mode. With the
    edit check on (`pnpm test:edit-on`) the key's own row is refused 42501
    `ro_actor` in warn and on; with it off the write runs (the open item
    of round 3, unchanged). The refusal happens: no product finding.
  - L1: one place per rule. The export read rule (0302) and
    `assertManageOrAdmin` (`item-rights.ts`) call `mantle_may_manage_home`
    (0279), granted to `mantle_view_user` in 0302 (it lacked EXECUTE: an
    invoker function taken from PUBLIC; the write role follows the
    workspace role's grants, the runtime role's allowlist follows by
    itself). Profiles' write rule is one invoker SQL function,
    `mantle_profile_writable(user_id)` (0302, PUBLIC revoked, the
    workspace role only), called by the INSERT and UPDATE policies and by
    `profileRowWritable`; the policy note is `own-login:v2`. The delete
    rule (the own row) is unchanged. Not definers, so the definer
    allowlist (`write-role.db.test.ts`) is unchanged. Answers byte-equal:
    the access matrix, write-role, a2b2b, a6b and edit-check cells pass in
    every config.
  - L2: `gapRerunCount` counts `SET ROLE x`, `SET SESSION ROLE x` and
    `SET ROLE TO x` too, when the target reads as a role name (so a column
    update and prose in a message are no switch). Unit test added;
    `gapTables` stays 0.
  - L3: `profileRowWritable` runs in a read transaction (a savepoint inside
    an open one), reads only 42501 as no and throws the rest;
    `noteInboundChannel` asks it inside its try (its caller does not wait).
    Unit test `profile-row-writable.test.ts`.
  - L4: the a6b off matcher is an explicit list (`S3_OFF_CELLS`: 15
    kind-root cells, 2 rule-in-query cells), taken from an off run.
- D1 (main v0.300.84): S3's rules went into the spec (sections 5, 6 and
  15; the three S3 limits dropped), this handover moved here, the four
  `docs/actors.md, "Plan v3 S3"` quotes point at the spec's section 5, and
  D1's `item-rights.ts` header now says the write role in every check
  mode. `dbClientLines` re-pinned 3140 to 3141 (D1 added one comment line
  to `client.ts`; main 3303).
- P1a (main v0.300.85): rebased cleanly, both sides' pins kept; 0302 and
  its `when` 1790197440000 stay above main's last (0301).
- Gates at `e80624bf1` (on D1; workstation, Node 26, own pgvector pg18
  container `s3r4_pg` on port 55981, `MANTLE_CHECK_FLOOR=keep`,
  `--maxWorkers=3`, removed after): `pnpm -r typecheck` 0, `pnpm lint` 0,
  `pnpm format:check` 0, `pnpm docs:check` 0, `pnpm arch:check` 0,
  `pnpm -C server/web build` 0, unit vitest 0, `pnpm boot:smoke` 0, full
  vitest with DB 1 (13460 passed, 0 failed; one unhandled
  `CONNECTION_CLOSED` from `w7e-member-scope.db.test.ts`, a file S3 does
  not touch), test:actor-off 0 (1072 passed), test:actor-on 0 (349),
  test:edit-on 0 (515), test:matrix 0 (7), full test:runtime-role 0 (2584).
- Gates at `ffcba6b30` (rebased on P1a, main `8b3099467`; the delta is
  counters, scripts and CI, so the static gates and the full vitest were
  run again, not the five DB configs): `pnpm -r typecheck` 0, `pnpm lint`
  0, `pnpm format:check` 0, `pnpm docs:check` 0, `pnpm arch:check` 0,
  `pnpm -C server/web build` 0, unit vitest 0, full vitest with DB 0
  (13493 passed; the `CONNECTION_CLOSED` did not come back). The commit
  after it changes this handover only.

## S11a-7 (hotfix, migration 0303)

A new export row was refused in `on` for every scoped caller, the app's
Moderator and the owner on an app homed in Admin too (42501 "not allowed to
grant to that workspace"; off and warn noted the miss "INSERT on
app_table_exports: not a Moderator of the workspace"), so
`app_table_export_set` made no new link once the actor check was on. The
cause was S3 giving the table the write check `manage` of `app_node_id`:
`mantle_write_check_trg` (0281's body) ends with a branch for `manage`
written for grant rows, which reads the row's `workspace_id`. An export row
has none, so the target was NULL and every INSERT failed the Moderator
test. `0303_export_check_grant_branch` keeps 0281's body and runs that
branch only on a row that carries a `workspace_id`; the per-row loop
(manage of the app, an Admin scope for an app with no home), the row rule
and the edit check still decide an export row. The matrix's two `manage`
tables: `item_grants` (has `workspace_id`, same answers) and
`app_table_exports`. Pinned in `a2b2b-write-gateway.db.test.ts` (both checks
off, warn and on; `createAppTableExport` end to end in on) and
`migrations-journal.test.ts`.
