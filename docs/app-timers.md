# App timers

A mini app's tool call on a clock, with no model and no person per run
(migration 0355). The author's side, what a timer may call and where its
runs land, is in [app-authoring-guide.md](./app-authoring-guide.md),
"Timers: collect data on a clock". This page is the operator's.

## What runs where

- **The rows**: `app_timers`, one per timer: the app, a name, one tool and
  its arguments, `every_minutes` (1 to 1440), `keep_days` (1 to 400), the
  switch, the login it runs as (`created_by`, the last login that set it),
  and the scheduler's bookkeeping (`next_run_at`, the last run's time,
  outcome, fixed error text and duration, `fail_count`, the claim of a run
  in flight). A timer goes with its app (foreign key cascade). Read and
  written with manage of the app: the row rule and the write check
  (`packages/db/src/access-matrix.ts`).
- **The caps**, held by the database whoever writes
  (`mantle_app_timers_cap`, a trigger under one advisory lock, on an insert
  and on an update that moves a timer to another app or login): 5 timers
  per app, 20 per login, 100 per box, and of those at most 80 set by
  logins that are no Admin user (20 kept for Admin users).
- **The floors** (`packages/tools/src/app-timers/rules.ts`): every minute
  for an Admin user's timer, every 5 for anyone else's, every 15 for an
  HTTP tool. Held when a timer is set and again at every run (a login that
  is no longer an Admin user runs at its floor).
- **The scheduler**: the maintenance worker (`worker_maintenance`,
  `server/web/workers/maintenance.ts`), queue `mantle.app-timers.tick`, a
  pg-boss cron every minute. A tick runs 4 lanes; each lane, after a random
  delay of up to 5 seconds, claims ONE due timer right before it runs it
  (`FOR UPDATE SKIP LOCKED`, and a claim stamp no tick on any replica
  passes while it is live, 5 minutes), runs it within 60 seconds, writes
  its outcome under its claim, and claims the next, until 45 seconds into
  the tick. A set while a run holds the claim keeps the claim (the run's
  outcome is written, the next run follows from the new setting), and
  `app_timer_run` answers "running now" instead of making it due. A
  worker killed mid-run leaves a claim that is due again after 5 minutes.
- **A run on demand** (`app_timer_run`) makes a timer due now only once
  its floor has passed since its last run (the back-off of 30 minutes
  included); sooner, it is refused with the time it can run from. So a run
  on demand never runs a timer more often than its clock could.
- **A set** (`app_timer_set`) that changes a timer's call or clock, or
  switches it on, starts it within 30 seconds, but for a timer that has
  run never sooner than its floor after the last run, the back-off judged
  on the failures in a row before the set. The failures in a row start
  over only when the tool or its args change. So flipping a setting back
  and forth runs it no more often than its clock could either.
  No new container: with the maintenance worker down, no timer runs.
- **Capacity**: 4 lanes for 45 seconds. With runs of about a second that
  is some 180 runs a minute; with every run at its 60 second deadline it is 4. The floors keep the load down, and they hold for `app_timer_run` too: at most 20 timers (one Admin user's 20) could run every minute, the rest every 5 minutes or slower. A timer
  that falls behind is never run twice to catch up: it is due, and runs
  when a lane claims it.
- **A run** (`packages/tools/src/app-timers/run.ts`): as the timer's login
  as it is now, read only (actor mode `ro`), through the app tool broker's
  own plan (`packages/tools/src/app-tool-run.ts` `appToolRunPlan`, which
  `server/web/lib/app-tool-broker.ts` runs a person's `host.tools.call`
  with): the rules the app's holders and author allow for an Admin user,
  the team rules for anyone else; the verdict on the app's declared tools;
  the dispatch through the one gate as the app's broker. At admin rules it
  reads in the login's own scope, at team rules in the app's. The login
  must still manage the app and be enabled. The tool rule is asked again
  before every run, and a tool that needs the owner's confirmation never
  runs. An HTTP tool's own timeout is cut to the run's 60 seconds; a
  built-in read that runs past it goes on to its end with its answer
  dropped (the run is recorded as timed out and its claim let go).
- **The record**: one row per run in the app's own SQLite (`_timer_runs`,
  with the rules the run was judged at), pruned on each run (rows past
  `keep_days` and rows of deleted timers, at most 1000 a run; a run at team
  rules removes every row of its timer kept at admin rules). Rows read at
  admin rules never outlive the admin rules: a run of an app that no
  longer runs at them (held by a workspace other than Admin, or
  member-built) removes every row of the app kept at admin rules first,
  whatever its own call came to (the login gone included); switching a
  timer off or deleting it removes its own at once, in the caller's scope
  (`appTimerPurgeAdminRows`). Before it writes, the batch sets the reserved
  objects right: a trigger on the log or a view of its name is dropped, a
  table of its name that is not exactly the server's plain table is moved
  aside to `timer_runs_moved_<random>` with its rows (one of exactly the
  server's shape stays: an app can only fake rows of its own log), a
  foreign index on it is dropped; then its statements run under an
  authorizer that admits only the log's own create, index, insert and
  delete. The batch's connection has foreign keys off and
  `legacy_alter_table` on, so an app table with a foreign key to the log
  (cascading or not) cannot stop the prune or turn it into a write of the
  app's rows, and a broken view of the app's cannot stop the move aside. One trace per run (kind `manual`, subject `app_timer`, no model
  step), one Activity row on the app per run, and an error row for a
  failure. `set`, `delete` and `run` over MCP or an agent leave the tool
  call audit row like any tool write.

## Fixed failure texts

A failed run records one of these, never a caught error's text:
`the login that set this timer is gone`, `the login that set this timer
may no longer run it`, `the app is gone`, `the tool is not one a timer may
call`, `the call was refused`, `the tool call failed`, `the tool call timed
out`, `result too large`, `the app database is full`, `the run could not be
recorded`, `the run stopped on an internal error`. After 5 failures in a
row a timer runs at most every 30 minutes until a run succeeds.

## Checking a box

```sql
select a.title, t.name, t.tool_slug, t.every_minutes, t.enabled,
       t.next_run_at, t.last_run_at, t.last_ok, t.last_error, t.fail_count,
       t.claimed_at
  from app_timers t join nodes a on a.id = t.app_node_id
 order by t.next_run_at;
```

The worker logs one line per tick that ran anything
(`app timers: N run, N ok, N failed`).

## Stopping them

`MANTLE_APP_TIMERS=0` in the host `.env` (passed to the containers by the
compose `x-app-env` anchor), then restart `worker_maintenance`: the tick
runs no timer and says so once; the nightly sweeps go on. One timer:
`app_timer_set` with `enabled: false`, or `app_timer_delete`.

## Rollback

`packages/db/rollback/0355_app_timers.revert.sql` takes 0355 off the
ledger and keeps the table and its rows; the older image runs no timer.
