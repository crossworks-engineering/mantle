# Closing the narrow role's content reads, plan v3.2 (handover)

Branch feat/s7c, from main v0.400.15 (851f7768c). The step: the narrow
role's content reads revoked (the matrix's derived `narrow` for a `content`
table goes from 'read' to 'none'), the switch MANTLE_NARROW_SYSTEM and the
report-only branch removed, one migration (0341, journal `when` 1790200620000) for what the database still holds of the report branch, the
docs. Rolling this release back re-grants the reads of v0.400.15 (plan
rule 2: the one-image rollback lands on N-1 as it shipped).

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

### The decision this needs (CEO)

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
is not a write door). This round did not do that: the branch still has the
'none' derivation, so its DB suites are red with the list above until the
decision.

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

### Left

1. The CEO's decision above; then the read sites per the decision.
2. Migration 0341 (`0341_narrow_reads_revoked`, `when` 1790200620000) and
   its revert: REVOKE SELECT on the content tables from
   mantle_system_narrow (migrate's grants do it too; the migration holds
   where the roles step does not run), and the report branch's database
   side: drop mantle_narrow_would_refuse_stmt with its derived triggers,
   mantle_narrow_would_refuse_expected, mantle_narrow_counter_missing,
   mantle_narrow_cascade_stmt with its three triggers; 0277's
   mantle_actor_check_stmt body back (no narrow arm); the report arms out
   of mantle_narrow_one_way, the message guard, mantle_narrow_login_hold
   and mantle_narrow_token_hold; then mantle_narrow_report,
   mantle_narrow_counted and mantle_narrow_actor dropped. narrow-lockout's
   re-run cell already names it (`narrow_reads_revoked`). Until it lands
   the database still raises the report notices, which the app now
   prints as plain notices.
3. The N-1 image after 0341 without its revert: its migrate's trigger step
   returns early (the trigger function is gone), its box script falls back
   to its inline copy; it boots. Check on rebase over S4b's 0340 that no
   column 0340 drops or retypes holds a would-refuse UPDATE OF trigger
   (the runner no longer drops them before pending migrations; 0341 does).
4. scripts/arch-scoreboard-box.sh (the would-refuse, content-write,
   cascade, counter-trigger and switch lines), scripts/test-deploy-scripts.sh
   (its would-refuse grep), the pins' narrow notes, docs/runtime-role.md
   (the kill switch, the report count, getScopeMarkedDb), docs/update-prod.md
   (the switch line in .env becomes inert), docs/actors.md, CHANGELOG.
5. Gates: not run as a set this round (typecheck 0, db and config unit
   tests 0, lint of the changed files 0); DB suites only the measurement.
