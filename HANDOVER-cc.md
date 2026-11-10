# Control Center handover (2026-11-10, step 2 done, phase 2 item 1 built)

Delete this file before the branch merges.

## Where things are

- **mantle branch** `feat/control-center-1`, step 2 head: see the last
  commit before this file's. Based on origin/main `12f7c573a` (v0.500.41).
  Not merged.
- **Worktrees (Mac):** step 1 in
  `.claude/worktrees/control-center-1-7a07dc` (branch
  `feat/control-center-1`, do not edit); step 2 in
  `.claude/worktrees/agent-a2432b19f7e845cad` (local branch `cc-step2`,
  pushed with `git push --no-verify origin HEAD:feat/control-center-1`).
  Git identity jason@schoeman.me, `core.hooksPath` set.
- **Workstation run folder:** `~/runs/control-center-1` (`ssh workstation`;
  `round.sh`, `lane.sh`, `one.sh <port> <files>`, `static.sh`; ports
  31811-31820, containers `cc1_*`). Run rounds with
  `systemd-run --user --unit=<name> -p WorkingDirectory=$HOME/runs/control-center-1 bash -c ./round.sh`.
  Move `repo/` to a head with `git fetch origin feat/control-center-1 && git checkout --detach FETCH_HEAD`, never while lanes run.
- **Handoff tasks:** step 1 `7b90ec80` (tag handoff-m2); step 2: see the
  dev brain, tags handoff-m2 + control-center.
- **Client:** mantle-client `feat/control-center-1` d3fbe725 (task
  325b3493): Fleet section, Users Archived list, Company sign-in at
  `/admin/company-sign-in`. It shows the SCIM step only when `GET /api/fleet`
  answers 200. It must also treat the setup status `scim: 'not-cc'` (new in
  client-types) as "no SCIM step"; client-types needs a release.

## Step 2 (DONE): owner decision B, CC code loads on a CC only

- The one check: `isControlCenter()` / `feature('controlCenter')`
  (`MANTLE_IS_CONTROL_CENTER`). `ccOff()` in `server/web/lib/control/env.ts`
  is the plain 404 every CC-only route answers off a CC, before any import.
- SCIM: every `/scim/v2` route and the SCIM-token route answer `ccOff()`;
  `GET /api/users/scim` answers `{ on: false }`; `scimTokenHash` asks the
  flag first; auto-link, the leaver report, the boot check and the setup
  status (`scim: 'not-cc'`) ask it before a lazy import. Off a CC with a
  token still set: one boot warning. The Entra tenant helpers moved to
  `lib/oidc/entra.ts` (company sign-in uses them everywhere).
- CC store: `@mantle/db/control-center` (subpath export), out of the index.
  Fleet routes, `lib/control/fleet.ts`, `run.ts`, the tools and the worker
  load it lazily. `box.ts` uses `loadAnchorId` (no SCIM import).
- Tools: `packages/tools/src/registry.ts` imports and registers
  `CONTROL_TOOLS` with a top-level await on a CC only; `controlTools()` is
  what mcp-core lists. The manifest `control` group and the `control` area
  gloss exist on a CC only. The `toolPolicyAllows` control_ line is gone.
  The sweeps run off a CC, so `builtins-control.test.ts` pins the seven
  tools' policy and params on a CC.
- LOW 3: archive is a person's act. `control_ban` takes `archive: boolean`;
  `control_ban.archive` (agent value false) is on `person-only-acts.ts`.
- Pins: `cc-only.test.ts` (routes 404, nothing CC loaded, worker idles,
  boot check, leaver report, an import scan over web, api, mcp, tools,
  mcp-core, runtime, db). A10 body/rate records: the scim-token cells
  403 to 404 (dated lines). `toolPolicyEntries` 7 to 8, person-only pin
  3 to 4, `a8Exempt` back to 125.
- Coordinator follow-ups folded in: notice deep link and docs name
  `/admin/company-sign-in`; the lift test disables a CC-disabled login
  again through the users area's own change ("Disable again").

## Phase 2, item 1 (BUILT on `feat/control-center-2`, stacked on step 2): fleet API-key update

- Box side (`lib/control/box.ts`): sixth case `key { service, value }`.
  Service from the box's own list (getProvider or KNOWN_KEY_SERVICES); a
  name whose default row is no token is refused (`defaultKeyRow`); set via
  the vault gateway (via web), tested only when `canProbeService`; ok or
  one reason (service, refused, untested, failed). A failed test puts the
  box back exactly (old value, or the new row deleted).
- CC side: `control_boxes.key_job` / `key_result` (migration 0365, rollback
  clears waiting jobs). `queueControlKey` seals per box (master key, AAD
  `control-key:<box id>`) and asks the run; `sendKeyJob` (run.ts, 45 s
  `controlKeyCall`) sends once and clears; `expireControlKeyJobs` deletes
  unsent after an hour, each tick. Tool `control_key_set` (redacts
  `value`) and `POST /api/fleet/keys`; `boxView` shows `keyPending` and
  `keyResult`, never the sealed value. The Telegram approval card now masks
  a builtin's `redactInputFields` (also fixes `api_key_set`).
- Audits: round 1 on c5e1ff64d 7/10 (3 MEDIUM, fixed), round 2 (full) on
  ff1021e7c 9/10 no HIGH or MEDIUM; its LOWs fixed after. Open LOW: the
  service regex and the 8192 cap are written on both sides.
- Points for Jason are on the plan page ("the CC holds a sealed key for up
  to 1 hour"; a failed test restores; one attempt per request).

## Next (not started)

The plan's next phases in order: the optional Entra trigger (a SCIM
disable on the CC makes a CC ban, plan section 4), phase 3 fleet reads,
phase 4 first writes. Foundry last. Task f0c65930 (box users submit a bug
or request to the CC) is plan-first, no code.

## Owner decisions so far (give all of them to every auditor)

- The CC may undo its own bans; a lift enables only logins the CC disabled.
- Only a box Admin undoes an archive, by hand; the archived login keeps its email.
- SCIM option B; CC code never loaded off a CC (done in step 2).
- SSO setup screen pick A (smaller, SCIM step CC-only), and Company sign-in
  moves to its own Admin category (`/admin/company-sign-in`, old path redirects).
- Fleet API-key update is phase 2, item 1.
- The CC is generic MantleOS (no client names); Entra optional.
- Trust rule, one-or-two-checks rule, KISS, label HIGHs OUTSIDE/BUG/RULE,
  tighten-only gates, Bun only.

## To confirm with Jason (also on plan page 553558c2)

1. A box that runs SCIM today loses it when step 2 rolls (it logs one boot
   warning). A SCIM disable on the CC makes no fleet ban until the Entra
   trigger is built. Recommended: check the fleet for SCIM tokens before the
   roll; ban leavers on the Fleet screen meanwhile.
2. Client: hide the SCIM step on `scim: 'not-cc'`; release client-types.

## Gotchas learned on this branch

- No bun on the Mac: type-check with `pnpm -C <pkg> exec tsc --noEmit`
  (ignore `route-manifest.gen` and its TS7006 errors); eslint and prettier
  run locally; tests run on the workstation.
- The worktree-isolated agent shell refuses a command that names git twice,
  or `cd` plus git in one line: one git call per command.
- Push with `--no-verify`.
- Do NOT re-record whole sweep files (`A10_BODY_SWEEP_RECORD`,
  `A10_RATE_SWEEP_RECORD`, `S9_AREA_RECORD`): edit or copy only the changed
  routes' lines and add a dated comment line.
- Prettier rewrites `docs/configuration.md` and generated snapshot JSON:
  never run it on those.
- A new full-route spot, a new narrow table or a new compose process each
  move pins (see step 1's list in git history of this file).
