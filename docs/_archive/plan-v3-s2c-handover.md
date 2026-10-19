# Plan v3.2 S2c: the runtime role reads the workspace tables (handover)

The branch `feat/s2c` (one branch, code only, no migration, one release).
The spec's rule is in [../actors.md](../actors.md) and
[../runtime-role.md](../runtime-role.md); this file holds the step's detail.
Built on `feat/s2b` while S2b was in audit, then rebased onto main once S2b
merged (S2b's commits dropped out as already applied).

## What changed

- `packages/db/src/access-matrix.ts`: `TableAccess.runtime` is now
  `'none' | 'read'`. `'read'`: the runtime role may SELECT the table and
  never write it. `workspaces`, `workspace_users`, `workspace_events` and
  `workspace_resources` take it. Not `'none'`: the system pool still reads
  them (llm-guard.ts, heartbeats/fire.ts, builtins-replay.ts and the readers
  S2b left).
- `packages/db/src/runtime-role.ts`: `runtimeReadOnlyTables()`, and
  `applyRuntimeGrants` revokes INSERT, UPDATE and DELETE on those tables
  from `mantle_runtime` after its blanket grant (one transaction, every
  migrate, so the live grants equal the matrix).
- `server/web/lib/workspace-ticks.ts` (`clearTicksTx`): the workspace row is
  read without `FOR UPDATE` (a row lock needs UPDATE, which the runtime role
  no longer holds). `mantle_ws_set_moderator` takes the row `FOR UPDATE` on
  its first call (through `mantle_ws_user_seat`) and holds it to commit, and
  checks archived, the Admin workspace and the last Moderator itself.
- `eslint-rules/rights-counts.mjs` (`workspaceTableRawWrites`): the typed
  write match also reads a table reached through a namespace
  (`db.update(schema.workspaces)`), so the precondition "no drizzle typed
  write" covers that form too. Still 0.
- `eslint-rules/cleanup-counts.mjs`: S2c joins `HISTORY_HEADING_CODES`
  (this file's heading). No product comment names it.
- Docs: `docs/runtime-role.md` (what `mantle_runtime` holds),
  `docs/actors.md` section 15 (the known limit "the runtime role may still
  write the four workspace tables" is closed and gone).

## Preconditions, each proven

1. **No raw or typed write outside a definer.** `workspaceTableRawWrites` is
   0 (pinned, `scripts/arch-scoreboard.pins.json`), now with the namespaced
   typed form counted too (`eslint-rules/rights-counts.test.ts`).
2. **The live catalog.** `packages/db/src/ws-runtime-read.db.test.ts`, the
   catalog cell: the fnscan of `rights-counts.mjs` (`writesWorkspaceTable`)
   plus a row-lock match, on `pg_proc` of a migrated database, not on
   migration text. Every invoker function that writes or row-locks one of
   the four tables, and every invoker function that calls one (by name,
   to a fixed point), may be run by no app role (no non-superuser role but
   `mantle_owner`) and is the function of no trigger; and no trigger on any
   table runs an invoker function that writes or locks them. Today the set
   is exactly three private helpers that only definers call:
   `mantle_ws_put_assistant`, `mantle_ws_user_seat` and
   `mantle_ws_resource_seat`.
3. **Admin workspaces with no assistant.** The box SQL below, numbers only,
   on every box, run by the CEO session (this branch does not ssh to client
   boxes). The same count is `admin_workspaces_without_assistant` in
   `scripts/arch-scoreboard-box.sh`.

## Cells

`packages/db/src/ws-runtime-read.db.test.ts` (a database of its own, a
connection logged in as `mantle_runtime`):

- the matrix marks exactly the four tables `runtime: 'read'`;
- live grants: SELECT on each for the runtime role; no INSERT, UPDATE,
  DELETE or TRUNCATE on each for the runtime role and every role it may
  SET ROLE to;
- a raw INSERT, UPDATE, DELETE and a row lock on each is refused (42501), a
  SELECT reads; the same INSERT after SET ROLE to each role it may become is
  refused;
- every workspace definer writes when the runtime role calls it: an Admin
  user (create, about, contact and landing cleared, add, tick, untick,
  connector add, write, remove, the assistant set and cleared, remove user,
  a grant event, archive; the eleven events pinned), a Moderator (add and
  remove), a login's private workspace, and system work (the clear-ticks
  command);
- the boot attach (`system:boot:migrate-workspaces`) and the onboarding
  attach (the login's scope) put the persona on an Admin with none;
- the catalog cell (precondition 2).

`server/web/lib/workspace-ticks.db.test.ts`: a Moderator change between the
unlocked read and the first clear (another transaction holds the row and
takes the Admin Moderator's tick off) fails the run whole with
`last_moderator`, no tick cleared; a second run reads the new state and
keeps the first member's tick.

`access-matrix.db.test.ts` and `runtime-role.db.test.ts` pin the live grants
equal to the matrix as before (`runtimeDeniedTables` unchanged); the
`runtime: 'read'` grants are pinned in the new file.

Test fixtures: under `test:runtime-role` the app's pools log in as
`mantle_runtime`, so every test that wrote the four tables through
`systemDb` (setup, cleanup) now writes them as the superuser
(`superuserExec` / `superuserClient`, `@mantle/db/test-support`). No
assertion changed and no write under test moved: 89 files, all fixture
setup, arrange and cleanup steps (the first full `test:runtime-role` run
on this branch failed exactly these, each with "permission denied for
table workspaces" or one of the other three). `superuserExec` now sends a
json or jsonb parameter of a drizzle query as the text it is, as the
app's drizzle pools do, so a fixture moved off `systemDb`
(`${JSON.stringify(v)}::jsonb`) writes the same object.

## Changed answers

- A system-pool INSERT, UPDATE, DELETE or row lock on the four tables, on a
  box with the runtime role on: was allowed, now refused (42501). Narrower.
  No product path does one (precondition 1 and 2; the full
  `test:runtime-role` run).
- `ws:clear-member-ticks --apply` while a Moderator change races it: before,
  the change waited for the clear's row lock (taken at the read). Now the
  clear's read is unlocked: a change committed between the read and the
  first clear either makes the definer refuse (the run fails whole, nothing
  cleared; the cell above) or leaves a tick the run did not see (a new
  member Moderator), which a second run clears. Never a workspace without a
  Moderator. Narrower or equal; no race opens a wider answer.
- Nothing else: with the runtime role off (the superuser) nothing changes.

## Counts and pins

- `workspaceTableRowLocks`: new, 0 (audit round 1, L1). Row locks (FOR
  UPDATE, FOR NO KEY UPDATE, FOR SHARE, FOR KEY SHARE, a drizzle `.for(`)
  in a statement that names one of the four tables anywhere (a FROM or a
  JOIN), in code (`rights-counts.mjs` `workspaceTableRowLocks`). The same
  test (`locksWorkspaceTable`) is the catalog cell's row-lock check
  (audit L2: a lock anywhere in a statement that names one, no longer only
  when the first FROM is one).
- `actorsMdLines` 349 to 347: the closed known limit left section 15
  (audit L3). Set by hand, not by `--pin`: `--pin` rewrites the whole file
  (key order, and it drops the pin notes), which every other lane would
  then conflict with.
- Unmoved: `workspaceTableRawWrites` 0 (its typed form widened, still 0),
  `workspaceTableWriterFns` 22, `historyCodeComments` 2341 (S2c joins
  `HISTORY_HEADING_CODES`; no counted comment names it).

## Rollback

No migration, so no revert file. Pin the image one release back (N-1). Its
boot runs `applyRuntimeGrants` from N-1's own matrix, which has no
`runtime: 'read'`: the runtime role gets INSERT, UPDATE and DELETE on the
four tables back. That is the one wider answer a rollback gives here, and
plan rule 2 accepts it (it is the state N-1 shipped and was audited in).
N-1's `clearTicksTx` takes `FOR UPDATE` again, which those grants allow.

## The box SQL (numbers only)

On each box, as the superuser, read only:

```sh
docker exec mantle_pg psql -U postgres -d postgres -tAc "
select count(*) as admin_ws_no_assistant,
       count(*) filter (where exists (
         select 1 from public.agents a
          where a.owner_id = w.owner_id and a.role = 'responder' and a.audience = 'admin'
            and a.enabled and a.workspace_id is null)) as of_them_with_a_pickable_persona
  from public.workspaces w
 where w.is_admin and w.archived_at is null
   and not exists (select 1 from public.workspace_resources r
                    where r.workspace_id = w.id and r.type = 'assistant')
   and not exists (select 1 from public.workspace_events e
                    where e.workspace_id = w.id and e.action = 'resource.remove'
                      and e.subject ->> 'kind' = 'assistant');"
```

Wanted: `0|0`. A first number above 0 with a second of 0 is explained (the
brain has no enabled admin responder for the attach to pick: nothing to
attach, before or after S2c). A second number above 0 is a box where the
attach should have put a persona and did not: name it before the roll.

## Open items

- The box SQL above, on every box, before the roll (CEO session).
- A box with the runtime role off runs the system pool as the superuser:
  Postgres refuses nothing there (`env_names_runtime_role` in the box
  script shows which boxes).
- The full DB run's one unhandled `CONNECTION_CLOSED` in
  `w7e-member-scope.db.test.ts` (see Gates) is the known teardown race
  that file's `afterAll` names; the file passed alone three times.

## Gates

Audit round 1 (9/10, merge; L1 to L4 folded in, L5 goes to S7), rebased
onto main 6f6e85704 (v0.300.102, S6 c2 with 0310; the rebase was clean),
at 446be696e (code; the commit after it only adds these lines):

On the Mac, `DATABASE_URL` unset: `pnpm install --frozen-lockfile` 0,
`pnpm -r typecheck` 0, `pnpm lint` 0, `pnpm format:check` 0,
`pnpm docs:check` 0, `pnpm arch:check` 0, `pnpm -C server/web build` 0,
`pnpm exec vitest run server packages eslint-rules` 0 (11059 passed).

On the workstation (a fresh `s2c_verify_pg`, the same settings as below):
full DB vitest 0 (1123 files, 13829 passed), `test:actor-off` 0 (1165
passed), `test:runtime-role` in full 1 (275 files, 2752 passed, 0 failed,
one unhandled `CONNECTION_CLOSED` from `w7e-member-scope.db.test.ts`, the
teardown race its `afterAll` names); that file alone under
`test:runtime-role` 0, three runs.

CI: https://github.com/crossworks-engineering/mantle/actions/runs/39254957548
(success, 446be696e).

After the rebase onto main 817fbb986 (v0.300.101, S2b merged; the rebase
was clean and S2b's four commits dropped out), at 2f4dc6643 (code; the
commit after it only adds these lines):

On the Mac, `DATABASE_URL` unset: `pnpm install --frozen-lockfile` 0,
`pnpm -r typecheck` 0, `pnpm lint` 0, `pnpm format:check` 0,
`pnpm docs:check` 0, `pnpm arch:check` 0, `pnpm -C server/web build` 0,
`pnpm exec vitest run server packages eslint-rules` 0 (11055 passed).

On the workstation (a fresh `s2c_verify_pg` on port 56341, `init-scratch`
then `migrate` with `MANTLE_CHECK_FLOOR=keep`, so main's changed 0309 is
the one applied; the same settings as below): full DB vitest 0 (1122 files,
13813 passed), `test:actor-off` 0 (1165 passed), `test:runtime-role` in
full 0 (274 files, 2740 passed), `test:matrix` 0 (8 passed). The
container, worktree, branch, scripts and logs are removed by exact name.

Before the rebase onto main, at 98070ea40 (on `feat/s2b` 4f89fc11f):

On the Mac, `DATABASE_URL` unset: `pnpm -r typecheck` 0, `pnpm lint` 0,
`pnpm format:check` 0, `pnpm docs:check` 0, `pnpm arch:check` 0,
`pnpm -C server/web build` 0, `pnpm exec vitest run server packages
eslint-rules` 0 (11055 passed).

On the workstation (own worktree `s2c-verify`, own pg18 container
`s2c_verify_pg` on port 56341, `max_connections=450`, `init-scratch` then
`migrate` with `MANTLE_CHECK_FLOOR=keep`, systemd-run, `--maxWorkers=3`, one
gate at a time): full DB vitest 1 (1122 files, 13811 passed, 0 failed, one
unhandled `CONNECTION_CLOSED` from `w7e-member-scope.db.test.ts`; that file
alone 0, three runs), `test:actor-off` 0 (1165 passed), `test:runtime-role`
in full 0 (274 files, 2738 passed), `test:matrix` 0 (8 passed).

CI: https://github.com/crossworks-engineering/mantle/actions/runs/39216506961
(success, 98070ea40).
