# Plan v3.2 P1a handover: scoreboard core and CI (no behaviour change)

Branch `feat/p1a-scoreboard`, cut from main at ea671d46b (v0.300.83). No
product code changed: counters, pins, a test, a script check, the box
script and the CI subset.

## What changed

- `eslint-rules/rights-counts.mjs` (new), read by `measure()` in
  `eslint-rules/arch-counts.mjs` (one import, one spread after
  `itemPrecheckRoutes`, `balanced` exported). The P1a counters:
  `requestSystemExits` with `_area`, `_loginSelf`, `_adminWrite`, `_other`;
  `scopeHoldsAdminCalls`; `sqlAreaRules`; `workspaceTableRawWrites`;
  `workspaceTableWriterFns`; `setAssistantCopies`; `legacyPrecheckUndated`;
  `a8Uncovered`; `a8Exempt`; `rawWriteAllowlist`; `actorsMdLines`. Labels in
  `scripts/arch-scoreboard.ts`. `gapTables` and `dbClientLines` are S3's keys
  and are not added here.
- The SQL function counts read the migrations in journal order (create,
  replace, rename, security definer, drop), so `pnpm arch:check` needs no
  database. `packages/db/src/rights-catalog.db.test.ts` proves the reading
  equals the live catalog after migrate: the same 285 public functions, the
  same writers of the four workspace tables (definer or not), the same
  `areas` readers, the same set-assistant functions.
- `eslint-rules/rights-counts.test.ts`: each counter on small inputs, and two
  repo facts (every request exit reason readable; no undated legacy
  pre-check). In its own file, not `arch-lints.test.ts`, to stay
  key-disjoint with S3, which appends there.
- `scripts/merge-branch.sh`: before the merge it prints the next free
  migration number (and the `when` to beat) and refuses a branch whose new
  migration's number or journal `when` is at or below main's last, or a new
  file at or below main's last number outside the journal. Nothing merges
  on a refusal; the lock is freed. `scripts/test-merge-branch.sh` (new, 7
  cases) runs from `server/web/lib/shell-portability.test.ts` like the
  tag-release harness. Documented in docs/versioning.md and docs/scripts.md.
- `scripts/arch-scoreboard-box.sh`: a rights section, numbers only:
  `role_drift` (n/a until `mantle_role_drift()` exists, never a guessed 0),
  `brains_without_admin_workspace`, `admin_workspaces_without_assistant` (no
  assistant and no assistant removal event), `workspace_table_writer_fns`
  (live catalog), `env_names_runtime_role` (1/0, n/a without a stack dir).
  New `--stack <dir>` and `ARCH_BOX_PG=<container>` for a dry run.
- `.github/workflows/build-check.yml`: the runtime-role CI subset widened
  from db/src, the write gateway and grants to also the write-role cells
  (f4-admin-write-role, worker-write-role), the workspace definer tests
  (server/web/lib/workspace*, list-workspaces, workspace-landing,
  workspaces-bridge-writers) and any `/ws-` suite (S2a's definer tests).

## Pins (measured on main ea671d46b), against the plan

| Key | Pin | Plan | Why different |
|---|---|---|---|
| requestSystemExits (area / login-self / admin-write / other) | 5 (1 / 2 / 2 / 0) | 1 / 2 / 2 | same; lines now session.ts 1712, 1716, 1784, 2301, 2312 |
| scopeHoldsAdminCalls | 14 (13 files) | 15 | the plan counted the definition in client.ts |
| sqlAreaRules | 7 | 4 | also adminUserSql (packages/db/src/admin-user.ts) and the two Telegram asks in packages/telegram/src/chat-login.ts |
| workspaceTableRawWrites | 16 | 16 | same (14 workspaces.ts, 2 workspace-ticks.ts) |
| workspaceTableWriterFns | 12 (11 definers, 1 invoker) | 11 (10 + 1) | measured at main; equals the live catalog |
| setAssistantCopies | 1 | 1 | same |
| legacyPrecheckUndated | 0 | 0 | same |
| itemPrecheckRoutes | 2 (unchanged) | what R0 left | same |
| a8Uncovered | 207 (11 kinds, 196 tool policies) | measured | routes join with S11b |
| a8Exempt / rawWriteAllowlist | 0 / 0 | caps | the lists do not exist yet; their step pins the count when it makes them (rule 6) |
| actorsMdLines | 7517 | 6177 | the plan's number is c7acc88ff; R0's handovers added the rest |

`actorsMdLines` is in `MAY_GROW` until the docs split moves the history out
(every lane still appends its handover there); D1 takes it out of the set.

## Gates

At c006285b1 (the code head; this note is docs only on top of it).

Mac: `pnpm -r typecheck` 0, `pnpm lint` 0, `pnpm format:check` 0,
`pnpm docs:check` 0, `pnpm arch:check` 0, `pnpm boot:smoke` 0,
`pnpm -C server/web build` 0; `bash scripts/test-merge-branch.sh` 0 (7/7).

Workstation (own clone, own pgvector pg18 container, `--maxWorkers=3`): init
0, migrate 0, full vitest with DB 0 (1096 files, 13495 tests, the catalog
test 4/4), test:actor-off 0, test:actor-on 0, test:edit-on 0, test:matrix 0,
full test:runtime-role 0 (260 files), `scripts/test-deploy-scripts.sh` 0
(478 passed), `scripts/test-merge-branch.sh` 0.

Box script dry run against the throwaway database only (never a real box):
role_drift n/a, then 3 with a stub function; brains without Admin 0, then 1
with an owner and no Admin workspace, then 0 with one; Admin workspaces
without assistant 1; writer functions 12; .env names the role 1, n/a with no
stack dir.

CI: https://github.com/crossworks-engineering/mantle/actions/runs/39072580995
success; the widened runtime-role subset ran 72 files.

## Open items

- The role drift line prints n/a, not 0, until S2a a0 ships
  `mantle_role_drift()`: a 0 there would pass a "0 on every box" read that
  measured nothing. The plan says "reads 0"; this is the safer reading.
- The `/ws-` filter in the CI subset is there so S2a's definer suites join
  it without another CI edit.
- D1 takes `actorsMdLines` out of `MAY_GROW` when it moves the history out.
