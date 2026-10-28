# The narrow route always on, the report branch gone, plan v3.2 (handover)

Branch feat/s7c, from main v0.400.15 (851f7768c). The step as landed (the
CEO's decision after round 1, 2026-10-28): the switch MANTLE_NARROW_SYSTEM
and the report-only branch removed, one migration (0341, journal `when`
1790200620000) for what the database held of the report branch, the docs.
The narrow role keeps reading the `content` tables (its derived `narrow`
stays 'read', S7b's state): the read revoke is its own later step, S7d
(the last section). Rolling this release back lands on v0.400.15 as it
shipped (plan rule 2); nothing is re-granted, since nothing was revoked.

## Round 1: the measurement, the switch, the TypeScript side of the report branch

### The coverage proof: not met

The plan's condition for the revoke is that the read cells cover every area
route and systemWhole tool with the role on. Measured, not assumed: the
matrix change alone (commit b2eb499a3, `narrowFor` content to 'none'), the
full DB suite in two shards on the workstation with MANTLE_NARROW_DUMP (one
JSON line per narrow denial, vitest.setup.ts). Result: shard 1/2 17 tests
red (10 files), shard 2/2 33 red (12 files), 71 denials in the dump plus the
area sweep's own (it takes its denials per row, so they are in its failure
diff, not the dump). 39 distinct statements, all reads; no write.

Where they come from (each read runs on a narrow exit today and is allowed
only by the 'read' grant):

| code site                                                            | what it reads                                                             | reached by (tests that met it)                                                                                                                                                                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| packages/content/src/profile-preferences.ts (and its callers)        | profiles.preferences of a login                                           | system:admin-area tools in an Admin turn (w7a-tool-sweep, w7a-area-system-sweep, w7-int-fix2/3/4, runs execute-item), system:http:admin-area (narrow-area-routes, ws-onboarding-attach), system:http:login-self (w7-int-fix2/3) |
| packages/db/src/mixed-summaries.ts (systemDb inside a login's scope) | node_mixed_summaries                                                      | a login's own request or key on /api/v1 (a8-findings F1, w6a-route-sweep, w6a-fix-sweep, w6b-fix1): systemDb in a scope runs narrow                                                                                             |
| server/web/lib/dashboard.ts                                          | nodes, facts, entities, entity_edges counts and duplicates                | GET area rows (w6a-route-sweep, the area read sweep)                                                                                                                                                                            |
| server/web/lib/debug.ts                                              | facts with entities, nodes by type, conversation digests (topics, counts) | debug area reads (the area read sweep)                                                                                                                                                                                          |
| server/web/lib/integrity/audit.ts, integrity/landed.ts               | nodes and facts (dimensions, landed items, failed traces' subjects)       | the integrity screen (the area read sweep, w6a-fix-sweep M-a)                                                                                                                                                                   |
| server/web/lib/traces.ts                                             | traces joined to nodes (subject title)                                    | the traces list (the area read sweep)                                                                                                                                                                                           |
| packages/content/src/app-access-log.ts                               | app_access_log joined to nodes (contact title)                            | the apps area log (the area read sweep)                                                                                                                                                                                         |
| packages/content/src/member-invites.ts                               | member_invites joined to nodes (contact)                                  | the users area invites (s9-area-fold, the area read sweep)                                                                                                                                                                      |
| packages/content/src/peers/grants.ts                                 | peer_shares joined to nodes (title)                                       | the connectors area peer shares (narrow-spots round 5, the sweep)                                                                                                                                                               |
| packages/content/src/shares.ts                                       | shares                                                                    | the shares list (the area read sweep)                                                                                                                                                                                           |
| packages/content/src/tasks.ts or team-requests.ts                    | nodes (open tasks count)                                                  | an area read (the sweep)                                                                                                                                                                                                        |
| packages/files/src/docs.ts                                           | nodes of a docs collection                                                | the docs collections area (narrow-area-routes)                                                                                                                                                                                  |
| packages/content/src/events.ts                                       | nodes (a calendar's synced events)                                        | DELETE a calendar (narrow-area-routes)                                                                                                                                                                                          |
| the users area contact link (users-lockout)                          | nodes (is it a contact of this brain)                                     | PATCH /api/users/:id contact links (users-lockout, 3 cells)                                                                                                                                                                     |
| a systemWhole tool counting the brain's items                        | nodes (count where type <> branch)                                        | the systemWhole tool sweep (a5-read-tools-ro, w7a-fix2, w7a-tool-sweep)                                                                                                                                                         |
| packages/db/src/gateway/heads.ts (mantle_parent_folder)              | nodes (the heads check before a content write)                            | narrow-system-tx (the write was refused before; now its read is)                                                                                                                                                                |
| contacts by data (secrets count, contact data)                       | nodes                                                                     | the area read sweep                                                                                                                                                                                                             |

So the read cells do cover the routes and tools (the area sweep drives every
area GET and writing row, the systemWhole sweep every listed tool), but they
do not pass with the reads closed: at least 17 code sites read content on a
narrow exit. Reads were never measured before this step (plan 2.1 point 2
says so), and these are only the tested paths.

### The decision this needed (CEO)

The brief allows two paths per site, never a wider grant: the caller's own
login scope, or a named full-route spot. Neither is a mechanical choice
here:

- The login's own scope changes answers. Most sites are brain-wide Admin
  views (dashboard counts, debug, integrity, traces, the apps log, invites,
  peer shares, the docs collections, a calendar's events): in an Admin
  user's scope they would count and list only what that login can read, so
  an Admin user who is not in every workspace sees less (narrower, but a
  changed answer on about 12 area reads, each needing a cell and the
  owner's yes).
- A full-route spot keeps every answer but runs the whole block on the
  full system role, which may also write: about 12 to 15 new spots
  (fullRouteSpots 31 today), each wider than the narrow role with reads.
  The plan's own spot list was meant to shrink.
- Two sites are bugs either way and move to the caller's scope with no
  changed answer expected: mixed-summaries.ts reads content through
  systemDb inside a login's scope (systemDb is never for content reads),
  and a login's own profile preferences read on its login-self exit.

My recommendation: keep `narrow` 'read' on the content tables (S7b's
state) and land the rest of this step (the switch and the report branch
removed, which needs no read revoke), then close the reads per table in a
later step once each site above has its path (a read definer per view
would be the clean one: it answers brain-wide for an Admin of the area and
is not a write door). Taken: content stays readable to the narrow role for
this release, the rest of the step lands (round 2), the read revoke moves
to S7d.

### Done in this round (TypeScript, compiles, unit tests green)

- The switch: `narrowSystem` (features.ts), `MANTLE_NARROW_SYSTEM` in the
  config type, docker-compose.yml, .env.example, docs/configuration.md and
  compose-env.test.ts; `narrowSystemOn` and `setNarrowSystemForTests`
  (runtime-role.ts); the pool's switch (pools.ts `poolNarrow`, the boot
  line), systemDb's switch (handles.ts: in a scope always the narrow
  handle); migrate's `narrowLogin` (the narrow role gets its login whenever
  there is a master key outside per-database mode; migrator-steps.ts line
  and warning); `ensureRuntimeRoles` takes no `narrowLogin`.
- The report branch, TypeScript side: gateway/narrow-would-refuse.ts
  deleted (its call pattern CALLED_FN moved to narrow-sendable.ts),
  `getScopeMarkedDb` and `scopeMarkedParams` (the mantle.route 'narrow'
  mark), the would-refuse arm of `narrowRouteClient`, `sendOrNote` is
  `checkSendable` (the route's text check, noted and thrown), the narrow
  write notices in actor.ts (`SQL_NARROW_PREFIX`, `takeNarrowWrites`,
  `noteNarrowWouldRefuse`; NARROW_CHECKS keeps narrow-denied), migrate's
  would-refuse trigger step (`applyNarrowWouldRefuse`,
  `dropNarrowWouldRefuse`, the runner's drop before pending migrations).
- Kept: the narrow-denied count and its epoch (the box's evidence that no
  route or tool met a right the role lacks, the one signal after the
  revoke), the holds (0321, 0323, 0327, 0328: enforcement on the narrow
  login), the miss guard.
- Tests: narrow-observe (both), narrow-would-refuse (both) deleted; their
  still-true cells (the text check's denial note, the call pattern, the
  per-actor dedupe) in narrow-denial.test.ts; switch-off cells removed
  from narrow-route, narrow-login, narrow-lockout, runtime-role,
  migrator-steps, the area sweep (one pass now, its write record a scratch
  table instead of the notice) and the systemWhole sweep.
- Pins: rawSqlNonLiteral 66 to 65 (the deleted file's).

### Left after round 1

Round 2 took each item: the decision (above), the migration (renamed
0341_narrow_observe_removed: no REVOKE), the N-1 check, the scripts and
docs, the gates.

## Round 2: the matrix change reverted, the database side of the report branch

### What changed

- The matrix change of round 1 (b2eb499a3) reverted, that commit only:
  `narrowFor` derives 'read' for a `content` table again, as S7b shipped;
  runtime-role.test.ts's derivation, set and count cells (`NARROW_COUNTS`
  read 40, none 8) back with it.
- Migration 0341_narrow_observe_removed (`when` 1790200620000) and its
  revert. It drops the would-refuse count (its derived triggers, by name
  or by function; the function; its derivation
  `mantle_narrow_would_refuse_expected`; the box's
  `mantle_narrow_counter_missing`), the cascade count (its three triggers
  on auth.users, spaces and agents, and its function), the content count's
  arm in `mantle_actor_check_stmt` (0277's body, the actor read through
  `mantle_identity_actor` as 0322 has it), the report arms of
  `mantle_narrow_one_way`, `mantle_narrow_message_guard`,
  `mantle_narrow_login_hold` and `mantle_narrow_token_hold` (each returns
  at once off the narrow role and refuses on it as before; the inner
  exception blocks went with the arms), then `mantle_narrow_report`,
  `mantle_narrow_counted` and `mantle_narrow_actor`. It ends with a catalog
  check: no function in public calls any of the seven. Nothing else: the
  holds' readers, the miss guard, the one-way triggers and the grants are
  untouched. The revert is the live bodies of 0329's end state
  (`pg_get_functiondef` on a fresh pre-0341 database), the cascade
  triggers and the ledger row; the derived triggers are the older image's
  migrate's to make (its trigger step runs whenever the function is
  there).
- migrate drops the derived would-refuse triggers table by table before
  the pending migrations (`dropNarrowWouldRefuse`, runtime-role.ts, called
  from `applyJournal`): about 120 tables hold one on a box (311 triggers on
  a fresh v0.400.15 database), and DROP TRIGGER takes the table's
  strongest lock, so one migration transaction holding all of them while
  the old app serves (compose's migrate) could stall its writes or
  deadlock with them. Each table in its own transaction, `lock_timeout`
  3 s, retried on a lock wait or a deadlock (as v0.400.15's own step did
  for the UPDATE OF ones). 0341's loop then finds none on a box; it stays
  for a database migrated another way and for the drop of the function.
  On a database past 0341 the step is one catalog read finding nothing;
  it can go in S7d.
- Round 1's removals kept: the switch, the observe and would-refuse
  branch, the deleted test files. Nothing else reads the switch: compose,
  .env.example, the updater, install.sh, roll.sh and the box script name
  it nowhere; the two read-only cells that skipped their narrow-role
  assertion when the variable was set
  (`audit-read-only.db.test.ts`, `graph-path-read-only.db.test.ts`) assert
  it on every run. docs/configuration.md: round 1's whole-file reformat
  undone, only the switch's row removed.
- narrow-lockout's re-run cell names 0341 (`narrow_observe_removed`) and
  re-runs 0312 first: 0320's `mantle_narrow_counted` is a SQL function, its
  body checked when made, and it reads `mantle_narrow_actor`, which 0341
  drops and 0312 makes.
- narrow-observe-removed-0341.db.test.ts: the renumber proof, a database
  just before 0341 carrying one derived trigger of each kind, the runner
  applying 0341 and only it (the branch gone, the holds there), the revert
  putting it back and a roll forward removing it again.
- The box script prints `narrow_misses:denied`, `narrow_prev_epoch:denied`,
  `narrow_misses_since_epoch`, `narrow_traffic_since_epoch:*` and
  `narrow_hold_triggers`; the switch, counter and would-refuse lines are
  gone. test-deploy-scripts.sh's box check reads `narrow-denied`.
- Docs: runtime-role.md (the narrow route always on; "The narrow write
  count" is now "The narrow-denied count"; the switch's paragraphs and the
  report notes out of the login hold and message rows sections),
  update-prod.md (the section on the route: the `.env` line is inert, a
  box that had it at 0 is on after the roll, the fallback is a pin one
  back with the switch in the same edit; the 0341 rollback floor),
  actors.md (the known limit: content reads, S7d), the pins' notes,
  CHANGELOG.

### Measured on the workstation (pg18)

N-1 (v0.400.15 at 851f7768c, its own migrate) and the branch, one database:

| step                                       | migrate | would-refuse triggers | cascade triggers | report functions | hold triggers |
| ------------------------------------------ | ------- | --------------------- | ---------------- | ---------------- | ------------- |
| v0.400.15 migrate on a fresh database      | 0       | 311                   | 3                | 7                | 8             |
| the branch's migrate (0341)                | 0       | 0                     | 0                | 0                | 8             |
| v0.400.15 migrate again (pin, no revert)   | 0       | 0                     | 0                | 0                | 8             |
| the 0341 revert, then v0.400.15 migrate    | 0       | 311                   | 3                | 7                | 8             |
| the branch's migrate again (roll forward)  | 0       | 0                     | 0                | 0                | 8             |

So v0.400.15's migrate (the compose gate its app waits for) passes on a
database at 0341 with no revert and makes nothing (its trigger step
returns when the function is gone), and the revert restores what it
counts on. The app side, read from v0.400.15's source: no TypeScript
there names a dropped function but that trigger step
(runtime-role.ts `applyNarrowWouldRefuse`, `to_regprocedure` first) and
the box script (each read behind `to_regprocedure`); the report notices it
listens for are never raised; with its switch at 0 it sends
`mantle.route = 'narrow'` marks nobody reads. Its narrow route, holds and
grants are this branch's (the matrix is the same).

S4b's 0340 (origin/feat/s4b at 31594593b) replaces two functions
(`mantle_login_area`, `mantle_tg_moderated_chats`): no table, column or
trigger, so no would-refuse UPDATE OF trigger stands in its way; and the
branch's migrate drops them before any pending migration anyway.

GATES_TBD

### Left (round 2)

1. Rebase over S4b once it merges (0340): the journal's no-gap unit cell
   (migrations-journal.test.ts) is red on this branch alone, since 0341
   sits above a missing 0340; it goes green on the rebase. 0341's `when`
   stays above 0340's.
2. The CEO: the release notes' line for boxes that set
   `MANTLE_NARROW_SYSTEM=0` (they are on after the roll; update-prod.md
   says so).

## The read revoke, a later step

Its name in the plan: **S7d: close narrow content reads per table**.

The plan's S7c condition (the read cells cover every area route and
systemWhole tool with the content reads closed) was measured in round 1
and not met: at least 17 code sites read a content table on a narrow exit
(the table in round 1 above; 39 distinct statements, all reads, from the
full DB suite in two shards with `MANTLE_NARROW_DUMP`, plus the area
sweep's own). Only tested paths were measured.

Per site, never a wider grant, one of:

- the caller's own login scope: answers change for an Admin user who is
  not in every workspace (they count and list less). Fits the two that are
  bugs anyway (mixed-summaries.ts reading content through systemDb inside
  a login's scope; a login's own profile preferences on its login-self
  exit), with no changed answer expected;
- a named full-route spot: answers stay, but the block runs on the full
  system role, which may also write (12 to 15 new spots, fullRouteSpots 31
  today, a list meant to shrink);
- a read definer per view (round 1's recommendation): answers brain-wide
  for an Admin user with the area, reads only, no write door; one per
  Admin view (dashboard counts, debug, integrity, traces, the apps log,
  invites, peer shares, shares, docs collections, a calendar's events, the
  users area's contact link, the systemWhole item count, the heads check
  before a content write, contacts by data).

Then per table: the matrix row's `narrow` set to 'none' (a hand value may
only narrow), the area sweep and the systemWhole sweep green with it, the
read-only cells kept, and the rollback named (plan rule 2: N-1 re-grants
the reads). Also for that step: the `mantle.route = 'full'` mark the actor
SET still carries at a full-route spot (actor-sql.ts, actor.ts
`runOnFullRouteSpot`): no database rule reads it since 0341; the
migrate step `dropNarrowWouldRefuse` once every box is past 0341; and
`mantle_identity_leaks` (0322) still lists `mantle_narrow_would_refuse_stmt`
and `mantle.route`'s report reason in its reviewed lists (names only, no
effect).
