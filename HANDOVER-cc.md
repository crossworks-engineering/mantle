# Control Center handover (2026-11-10 night: phases 2b, 3 and 4 built)

Delete this file before the branch merges.

## Where things are

All on mantle, each stacked on the one before, none merged, tagged or rolled:

| Branch                  | What                                                | Task                                            |
| ----------------------- | --------------------------------------------------- | ----------------------------------------------- |
| `feat/control-center-1` | phase 1 (ban) + step 2 (CC code only on a CC)       | 7b90ec80, 9b1cccb5                              |
| `feat/control-center-2` | phase 2 item 1, fleet provider key                  | b43340a0                                        |
| `feat/control-center-3` | phase 2 item 2, the SCIM (Entra) trigger, e9c1cc567 | f7ac6c67                                        |
| `feat/control-center-4` | phase 3, the fleet matrix (facts case)              | see dev brain, tags handoff-m2 + control-center |
| `feat/control-center-5` | phase 4, first fleet write: an agent's model        | see dev brain                                   |

- **Plan page 553558c2:** build designs under sections 4.1, 5.1.1 and 5.2.1;
  "To confirm with Jason (phases 2b, 3 and 4)" at the top.
- **Mac worktree:** `.claude/worktrees/agent-a03f87d2978445a02`, local
  branches `cc-phase3` (-3), `cc-phase3-matrix` (-4), `cc-phase4` (-5). Push
  with `git push --no-verify origin HEAD:feat/control-center-N`.
- **Workstation run folder:** `~/runs/control-center-1` (`ssh workstation`;
  ports 31811-31820, containers `cc1_*`). `round.sh` (static + 9 lanes) runs in
  `repo/`; `one2.sh <port> <files>` runs files in `repo2/` (use it while a round
  holds `repo/`). Start a round with
  `systemd-run --user --unit=<name> -p WorkingDirectory=$HOME/runs/control-center-1 bash -c ./round.sh`.
  Results of finished rounds are kept in `hist/<sha>/`.

## Phase 2b: the SCIM trigger (feat/control-center-3)

`server/web/lib/scim/service.ts` `fleetBan`: every SCIM `active:false` on the CC
(PATCH, PUT, DELETE, also when the CC keeps its own login) runs
`ensureControlBan` (`packages/db/src/control-center.ts`): an active ban that holds
the email is `held`, else one disable ban `made_by scim` (+ the CC's Entra
issuer and the externalId as oid when it is a GUID). State, not the edge. No
ban on create, no lift on enable. Docs: control-center.md "The SCIM trigger",
scim-entra.md "On a Control Center".

## Phase 3: the fleet matrix (feat/control-center-4)

- Box: case 7 `facts` (`server/web/lib/control/facts.ts`): box_status numbers,
  sign-in mode, agents (role, provider, model, enabled, assigned; slug only
  when shipped, MANIFEST_AGENTS), workers by kind, counts, last backup. No
  audit row.
- CC: migration 0366 (`facts`, `facts_reason`); `run.ts` `readFacts` after the
  ban part, every string held to a pattern (a misfit kept as ''), status
  through `shapeBoxStatus` (`@mantle/tools/box-status`); box rows read without
  facts (`BOX_COLUMNS`, `factsAt` only). `GET /api/fleet/matrix`,
  `control_fleet_matrix`.

## Phase 4: an agent's model (feat/control-center-5)

- Box: case 8 `agentModel { slug, model }` (`server/web/lib/control/agent-model.ts`):
  shipped slug and not an own assistant; the box's model policy; then
  `updateAgent` with the model only. Audit row names the model.
- CC: migration 0367 (`model_job`, `model_result`); `queueControlModels`,
  `saveControlModelResult`, `expireControlModelJobs` (SQL, an hour);
  `run.ts` `sendModelJob` after the ban part, one timeout per hung box.
  `POST /api/fleet/models`, `control_agent_model_set`.

## Client (not built; for the mantle-client session)

- Fleet: a matrix view from `GET /api/fleet/matrix` (per box: version,
  health, spend, sign-in mode, agents and models, counts, backup;
  `factsReason` and `facts.at` for staleness).
- Fleet: "Set an agent's model": pick a shipped agent (from the matrix's
  slugs), type the model, pick boxes; `POST /api/fleet/models`; per box
  `modelJob` (waiting) and `modelResult` (per change ok, was, reason) from
  `GET /api/fleet` box rows.
- A SCIM ban shows as an ordinary ban with madeBy `scim`.

## Next (not started)

Phase 4 more writes (a model pool entry, the update notice, worker groups),
each one more fixed case in the same job pattern, on Jason's word. Foundry
last. Task f0c65930 (box users submit a bug or request) is plan-first.

## Owner decisions (give all of them to every auditor)

- The CC may undo its own bans; a lift enables only logins the CC disabled.
- Only a box Admin undoes an archive, by hand; the archived login keeps its email.
- SCIM option B; CC code never loaded off a CC.
- The CC holds a sealed provider key for up to an hour.
- Anyone holding the CC's SCIM token can ban fleet-wide (accepted).
- The CC is generic MantleOS (no client names); Entra optional; match by email first.
- Trust rule, one-or-two-checks rule, KISS, label HIGHs OUTSIDE/BUG/RULE,
  tighten-only gates, Bun only.

## Gotchas learned

- No bun on the Mac: type-check with `pnpm -C <pkg> exec tsc --noEmit`
  (ignore `route-manifest.gen` and its TS7006 errors); eslint and prettier run
  locally; tests run on the workstation.
- The agent shell refuses a command that names git twice, or computes a
  value into git or pnpm: one git call per command, plain arguments.
- A new route moves: route-policy.rows.json, route-policy-rows.txt (by hand),
  the a4 guard sweep files (record on the workstation with `pnpm test -u` in
  repo2, then copy only the diff), the A10 body record for a write (hand edit
  with a dated line), narrow-area-sweep.entries.ts (a write), the arch-lints
  row counts, and the ledger line. A new controlWrite call moves
  `fullRouteSpotWrapperCalls` in scripts/arch-scoreboard.pins.json.
- `eslint` refuses a hand age check (`mantle-std/ttlAgeCheck`): expire in SQL.
- postgres.js stringifies a value bound to a jsonb param: in tests cast through
  `::text::jsonb`.
- The CI `narrow-login.db.test.ts` connection-limit cell can fail under CI load
  (5 refused instead of 1, phase 3's first run); the file passes on the
  workstation. Rerun the failed job (`gh run rerun <id> --failed`).
