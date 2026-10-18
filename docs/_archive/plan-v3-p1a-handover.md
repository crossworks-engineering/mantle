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

## Fix round 1

The audit at 814fe4382 rated it 8.5/10. Fixed:

- MEDIUM, request system exits could hide. The counter found wrappers in
  one file, as `function` declarations only, and skipped any
  `noteRequestSystem(x)` whose `x` matched a wrapper's parameter name
  anywhere in the file: an exported wrapper's calls in another file counted
  0, and `function f(ctx, reason) { noteRequestSystem(reason) }` counted 0.
  Now `requestSystemExits` runs the asSystem exits' AST engine
  (`eslint-rules/as-system-exits.mjs`) with `call: 'noteRequestSystem'`
  and `follow: 'forwarders'`: a call with a literal reason is an exit; a
  function passing one of its parameters on as the reason (declaration,
  arrow, method; exported or not; any parameter position) is followed to
  its uses in any file, each with the literal reason it passes; a wrapper
  no code calls counts its own site as unnamed; a wrapper of a wrapper is a
  problem (`perFile.rights.requestSystemExitProblems`, asserted empty by the
  repo test). The asSystem count keeps `follow: 'all'` and is unchanged
  (asSystemExits 58). One engine follows wrappers for both. Unit tests for
  both holes, the cross-file arrow and method forms, and the wrapper chain.
- `WORKSPACE_TABLE_WRITE` and the box script's writers query read
  `UPDATE ONLY` and `DELETE FROM ONLY` (`(?:only\s+)?`, as rawWriteTarget);
  the SQL regex starts at a word boundary (`\m`). Proven on pg18: `UPDATE
  ONLY workspace_users`, `delete from only public.workspace_events` match,
  `xupdate workspaces` does not.
- `setAssistantCopies` stays by name, marked in its pin note as a progress
  counter only: a body check (writes workspace_resources with 'assistant')
  finds the one-off backfills mantle_ws_attach_assistants and
  mantle_ws_migrate_bridged, not the setter.
- `readsAreaLimits` also reads `['areas']` and `#> / #>> '{areas,...}'`;
  the catalog test also asserts every live function naming the `areas` key
  is one the reader catches.
- The box script prints `env_names_runtime_role` as the value the app
  reads (FLAG_ON_WORDS: 1 for 1, true, yes, on in any case, quotes and
  spaces trimmed, the last line winning; 0 for unset, empty, 0 or anything
  else).
- The rights-counts.mjs header points at rights-counts.test.ts.
- `scripts/test-merge-branch.sh`: an 8th case, the lane that lost the race
  rebased and renumbered to the number it was told (0003, a when above
  310): it merges.

Pins before and after: unchanged. requestSystemExits 5 (area 1,
login-self 2, admin-write 2, other 0), sqlAreaRules 7,
workspaceTableRawWrites 16, workspaceTableWriterFns 12, setAssistantCopies
1, asSystemExits 58. Only the notes of requestSystemExits and
setAssistantCopies changed.

Gates at f9d7dd63c (the code head of this round). Mac: `pnpm -r
typecheck` 0, `pnpm lint` 0, `pnpm format:check` 0, `pnpm docs:check` 0,
`pnpm arch:check` 0, `pnpm -C server/web build` 0, `vitest run eslint-rules
server/web/lib/shell-portability.test.ts` 0 (20 files, 241 tests),
`bash scripts/test-merge-branch.sh` 0 (8/8).

Workstation (own clone at f9d7dd63c, own pgvector pg18 container `p1af_pg`,
`--maxWorkers=3`): init 0, migrate 0, `rights-catalog.db.test.ts` 0 (4/4),
full vitest with DB 0 (1096 files, 13499 tests, 1 skipped). A first full run
had `DATABASE_URL` exported by mistake and failed 5 cells in two suites that
expect it unset (a4-guard-sweep, heartbeats/tools); re-run as CI runs it
(`MANTLE_TEST_DATABASE_URL` only), green. The other DB suites (actor-off,
actor-on, edit-on, matrix, runtime-role) were not run: this round changes
only counters, tests and scripts, no product code. Box script dry run on
the throwaway database: writer functions 12, the runtime role 1 for `"On"`,
0 for `0`, empty and unset. Container, clone and unit cleaned up by name.

## Fix round 2

The re-audit at b8e9e9b15 rated it 8/10. Fixed at 415b4b855:

- MEDIUM, a member call of noteRequestSystem counted 0 (a regression of
  round 1). The engine (`eslint-rules/as-system-exits.mjs`) now takes a
  call of the bare name or of a member of that name (`db.noteRequestSystem`
  through a namespace import, `x?.call`, `x['call']`), as the per-file
  site regex already read `x.asSystem(`; the same for both counts. The call
  under another name (a renamed import, a renaming destructure,
  `const n = call`, `const n = db.call`, `n = call`, `{ n: call }`) is a
  problem, and so is any followed wrapper under another name, in its own
  file or (exported) in a file importing it. Unit tests for each form, and
  one for an asSystem member call.
- MEDIUM, `requestSystemExitProblems` failed nothing. The repo block of
  `eslint-rules/rights-counts.test.ts` asserts it is `[]`, and
  `pnpm arch:check` (`scripts/arch-scoreboard.ts --check`) now fails on
  any entry of it or of `asSystemExitProblems` (that one was only asserted
  in arch-lints.test.ts before). Proven: a `const x = noteRequestSystem`
  line in session.ts makes arch:check exit 1 with the problem named.
- LOW, `readsAreaLimits` also reads `json(b)_extract_path(_text)(...,
  'areas', ...)` (the arguments read balanced, so a later `'areas'` outside
  the call is not one), the array path `#> array['areas', x]` and the
  escape string `E'areas'` in every form, in migration bodies and TS SQL
  text alike.
- LOW, the box script's runtime role line reads the value the app sees:
  `MANTLE_DB_RUNTIME_ROLE` in mantle_web's environment (`docker inspect`,
  `ARCH_BOX_WEB=<container>` for a dry run); the stack's .env only when
  that container is not there, read as compose reads it (a quoted value is
  what the quotes hold; an unquoted one ends at a `#` at its start or after
  a space), then the ends trimmed (parseFlag). Numbers only.
- LOW, a wrapper whose sites pass different parameters on is a problem
  (its uses are read at one parameter).

Pins before and after: unchanged. asSystemExits 58, requestSystemExits 5
(area 1, login-self 2, admin-write 2, other 0), sqlAreaRules 7; problems
`[]` for both counts. Only the requestSystemExits note changed.

Gates at 415b4b855. Mac (DATABASE_URL unset): `pnpm -r typecheck` 0,
`pnpm lint` 0, `pnpm format:check` 0, `pnpm docs:check` 0,
`pnpm arch:check` 0, `pnpm -C server/web build` 0, `vitest run
eslint-rules server/web/lib/shell-portability.test.ts` 0 (20 files, 250
tests), `bash scripts/test-merge-branch.sh` 0 (8/8).

Workstation (own clone at 415b4b855, own pgvector pg18 container
`p1ag_pg`, systemd-run --user, `--maxWorkers=3`): init 0, migrate 0,
`rights-catalog.db.test.ts` 0 (4/4). Box script dry run against
`p1ag_pg` and throwaway containers only: writer functions 12; the runtime
role 0 for a container value `1 # on` (the app sees that string), 1 for
` On `; with no container, 1 for a .env `1 # on`, 0 for `o n`, 1 for
`"on" # x`; n/a with neither. Containers (`-v`), clone, stack dir and
unit cleaned up by name.

CI at 415b4b855:
https://github.com/crossworks-engineering/mantle/actions/runs/39081727888
success.
