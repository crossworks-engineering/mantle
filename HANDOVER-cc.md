# Control Center handover (2026-11-10, phase 1 step 2 done, phase 2 next)

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

## Phase 2 (NEXT, its own branch `feat/control-center-2`, stacked on step 2)

First item, Jason confirmed: fleet API-key update. Notes from reading the
code (nothing built yet):

- Box side: one more case on the signed switch (`lib/control/box.ts`),
  e.g. `setKey { service, value }`, service from the box's own fixed list
  (`KNOWN_KEY_SERVICES`, packages/api-keys services.ts). Use the vault
  gateway: `setVaultKey(who, anchorId, { ref: { name: service }, value, addKind: 'token' })`
  then `testVaultKey`; answer ok or fail only, never the key or the
  provider's text. `who` = `{ loginId: null, email: 'control-center', via: 'web' }`
  (via `web`: no hold; `mustHold` is for MCP). The gateway's `gate()` asks
  `callerHasAreaBound('keys')`: run it in a scope that holds the keys area
  (check how `areaSystem` in packages/tools admin-gate.ts does it). The
  gateway writes the audit row (`vault.key.set`, `vault.key.test`).
- CC side: the brain never signs, so the key must reach the control
  service through a row. Simplest: a job row (service, the key sealed with
  the master key and the row id as AAD, box ids, made by), the service
  sends it once per box, records ok/fail per box, then nulls the sealed
  value. "The CC keeps no key" then means: only until delivered (seconds).
  Write this on the plan page under "To confirm with Jason" with that
  recommendation. Tool `control_key_set` (peerRisky, settings area,
  clientSourced always, `redactInputFields: ['value']`) and a Fleet route
  (`POST /api/fleet/keys`, ledger line, A10 record lines for the new route
  only, per the gotchas below).
- Then the plan's phases in order (Entra trigger, phase 3 reads, phase 4
  writes). Foundry last.

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
