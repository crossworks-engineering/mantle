# Control Center handover (2026-11-09, phase 1, step 2 next)

Delete this file before the branch merges.

## Where things are

- **mantle branch** `feat/control-center-1`, head `c6037b1aa` (+ this file's commit). Based on origin/main `12f7c573a` (v0.500.41). Not merged.
- **Worktree (Mac):** `/Volumes/External500/Projects/mantle/.claude/worktrees/control-center-1-7a07dc` (a harness worktree; its branch was renamed to `feat/control-center-1`). Git identity jason@schoeman.me, `core.hooksPath scripts/git-hooks`.
- **Workstation run folder:** `jasons@192.168.100.75:~/runs/control-center-1` (repo = clone of the pushed branch; `bin/bun`; `static.sh`, `lane.sh`, `round.sh` (static + 9 lanes via `~/bin/test-lane`), `one.sh <port> <files>` (own pg, one test file), `unit.sh` (static + full unit + the control db test)). Ports 31811-31820, containers `cc1_*`. Run units with `systemd-run --user --unit=<name> -p WorkingDirectory=$HOME/runs/control-center-1 bash -c ./round.sh`; results in `res/`, logs in `logs/`. Never change `repo/` while lanes run.
- **Handoff task (phase 1, step 1):** dev brain task `7b90ec80-f081-4ae3-a7cc-ec39663ae884` (tag handoff-m2).
- **Client:** session `control-center-fleet-scr` (local_3eefe049) builds the Fleet section, the Users "Archived" list and the Company sign-in Admin category in mantle-client. Brief: side-session notes `control-center-1-client-brief.md`; later decisions were forwarded to it by message.

## Step 1 (DONE on c6037b1aa)

All gates 0 on c6037b1aa: typecheck, lint, format:check, docs:check, arch:check, boot:smoke, web build; lanes shard1 (8333), shard2 (10796), node (1783), actor-on (427), actor-off (1691), edit-on (603), serial (6), runtime-role (3991), matrix (9). GitHub build-check run 42699800051 success.

Audits (brief: side-session notes `control-center-1-audit-brief.md`): round 1 on 9cbfadd5a 8.5/10, round 2 on c4513f186 9/10, no HIGH or MEDIUM. Open LOWs: replay of a captured lift enable within 60 s (accepted, documented); a CC disable runs whole at login-credential (accepted); control_ban kind archive has no human confirm (open: split into its own destructive tool); worker_control not in BOX_CONTAINERS (Status screen).

What exists: migration 0364 (`auth.users.archived_at` + CHECK, `control_disables`, `control_boxes`, `control_bans`, `control_results`, `control_service`); `server/web/lib/control/{sign,env,box,run,key,fleet}.ts`; `POST /api/control/call`; `/api/fleet/*`; `packages/db/src/control-center.ts` (store + `planBox` match, writes via `controlWrite` at the new spot `control-center`); `packages/tools/src/builtins-control.ts` (7 tools, group `control`); `server/web/workers/control.ts` + compose `worker_control` (profile `control`); `docs/control-center.md`. The one CC line is `MANTLE_IS_CONTROL_CENTER` (`feature('controlCenter')`, `isControlCenter()` in `lib/control/env.ts`).

## Step 2 (NEXT, same branch): owner decision B and "CC code never loaded off a CC"

Jason (2026-11-09): "Lets go B, anything else that is meant only for CC, should never be in memory or loaded up for nothing." Written on plan page 553558c2 (top section). Do this:

1. **SCIM fully off off a CC.** The one check is `feature('controlCenter')` (no second check). Off a CC: every `/scim/v2/**` route answers the same 404 SCIM gives today when off, BEFORE importing `lib/scim/*` (do the flag check in each route file, then `await import('@/lib/scim/service')`). `server/web/app/api/users/sso-setup/scim-token/route.ts` refuses (404) off a CC. `GET /api/users/scim` answers `{ on: false }` off a CC. `MANTLE_SCIM_TOKEN_HASH`, the setup-row hash and `MANTLE_SCIM_AUTO_LINK` count only on a CC: find every reader (`scimOn`, `scimTokenHash`, `scimBootCheck` in `lib/oidc/boot`, the leaver report's `scimOn`, the OIDC auto-link path) and put the one flag first. Update `docs/scim.md`, `docs/oidc-sign-in.md`, `.env.example`, the admin guide env page.
2. **CC tools not registered off a CC.** Today `CONTROL_TOOLS` is in `BUILTIN_TOOLS` (hidden by `toolPolicyAllows`, refused in the handler). Move it out: register it lazily only when the flag is on (where the process registers builtins, and in `packages/mcp-core/src/build-server.ts`). Expect pin churn: remove the control_* lines from `packages/mcp-core/src/bridge.test.ts` EXCEPTIONS, `packages/runtime/src/risk-class-snapshot.json` + `tool-policy-snapshot.test.ts` AREAS, `packages/tools/src/{owner-scope-sweep,read-tool-writes,item-write-gate,destructive-coverage,client-sourced-rules.oracle}.test.ts`, `server/web/server/a8-coverage.test.ts` + pin `a8Exempt` (129 back to 125), `dispatch-parity.json`, `w7a-tool-sweep.db.test.ts` regex, `builtins-control.test.ts`, the manifest group `control` (manifest.test requires every builtin in a group; a tool that is no builtin may need the group dropped or kept with a reason). The `toolPolicyAllows` control_ line may then go.
3. **CC data code not loaded off a CC.** Take `control-center.ts` out of the `@mantle/db` index into a subpath export (`@mantle/db/control-center` in `packages/db/package.json`), and import it lazily in `lib/control/fleet.ts`, the fleet routes, the tools and `lib/control/run.ts`. Keep `controlDisables` (box side) and the schema in the index (migrations and the box route need them). The fleet routes: flag check first, then `await import(...)`.
4. **The box side stays on every subject box:** `/api/control/call`, `lib/control/{box,sign,env}.ts`.
5. **A pin test** (for example `server/web/lib/control/cc-only.test.ts`): with the flag off, a SCIM route answers 404, no `control_*` tool is registered, and the control worker does not start its loop (it idles). Consider a static check that no shared module imports a CC-only module at top level.
6. Gates (round.sh), CI green, a fresh independent audit (the brief, plus the new owner rules), then a handoff-m2 task for step 2.

## Phase 2 (after step 2, its own branch stacked on this one)

First item, Jason confirmed: fleet API-key update. One more fixed case on the signed route ("set provider key": provider from the box's own fixed list, and the key); the box seals it in its vault as a box Admin's key, tests it, answers ok or fail only; the CC keeps no key; audit line on the box; the CC records which boxes got it. Then the phases of plan page 553558c2 in order. Foundry last. Also logged (plan first, no code): task f0c65930, box users submit a bug or request to the CC through one more fixed case.

## Owner decisions so far (give all of them to every auditor)

- The CC may undo its own bans; a lift enables only logins the CC disabled. Not a finding.
- Only a box Admin undoes an archive, by hand; the archived login keeps its email.
- SCIM option B; CC code never loaded off a CC (step 2).
- SSO setup screen pick A (smaller, SCIM step CC-only), and Company sign-in moves to its own Admin category with a redirect from `/settings/company-sign-in`.
- Fleet API-key update is phase 2, item 1.
- The CC is generic MantleOS (no client names); Entra optional.
- Trust rule, one-or-two-checks rule, KISS, label HIGHs OUTSIDE/BUG/RULE, tighten-only gates, Bun only.

## Gotchas learned on this branch

- No bun on the Mac: type-check locally with `pnpm -C <pkg> exec tsc --noEmit` (ignore `route-manifest.gen` errors); eslint and prettier run locally; tests run on the workstation.
- Push with `--no-verify` (the pre-push hook runs verify on the Mac).
- Do NOT re-record whole sweep files (`A10_BODY_SWEEP_RECORD`, `A10_RATE_SWEEP_RECORD`, `S9_AREA_RECORD`): record into the workstation clone, copy only the new routes' lines, `git checkout` the rest, add a dated comment line. For s9, add changed answers to `CHANGED` in the test.
- Prettier rewrites `docs/configuration.md` and generated snapshot JSON: never run it on those.
- A new full-route spot needs: `FULL_ROUTE_SPOTS` (viewer.ts), `FULL_ROUTE_SPOT_FILES` and, for a wrapper, `FULL_ROUTE_SPOT_WRAPPERS` (eslint-rules/as-system-routes.mjs), `CALLS` in `narrow-write-scan.test.ts`, pins `fullRouteSpots`, `fullRouteSpotCalls`, `fullRouteSpotWrapperCalls`. Do not write a wrapper's name in any string elsewhere (the scan counts it).
- A table with an explicit `narrow` needs a `NARROW_CREDENTIAL_TABLES` entry; `NARROW_COUNTS` in runtime-role.test.ts.
- A new compose process with app env moves the role connection limits (runtime-role.ts, viewer-roles.ts, connection-ceiling.test.ts, viewer.test.ts, narrow-login.db.test.ts).
