# Actors: who every statement runs as

Every statement the brain sends to Postgres carries its **actor**: who the
work is done as. A process entry (an HTTP request, a worker job, a turn, a
timer) names its actor once, where it starts. Everything it awaits carries
it. This is the workspaces architecture plan v2, section 4, phases A2a and
A2b.

A statement with no actor is a "miss". In `warn` it is written to
`actor_check_misses` and runs as before. In `on` it is refused (A2b). Every
box runs `off` or `warn`: `on` waits for the scaling task (2d96f472).

## The actor kinds

| Kind             | Who                                                                                                           | Writes                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `login(rw)`      | a signed-in user, a read-write key, a peer acting as a login with Write on                                    | what the login may change                |
| `login(ro)`      | a read-only key, a peer with Write off                                                                        | nothing                                  |
| `login(owner)`   | the owner cases of the guide: the Admin assistant with no user, a run with no login, the owner's Telegram bot | what the owner may change                |
| `assistant`      | a workspace assistant with no user asking (a heartbeat, a schedule)                                           | nothing                                  |
| `link`           | an open public link                                                                                           | nothing                                  |
| `contact`        | a contact share                                                                                               | its app's data, when the share allows it |
| `system(reason)` | a process, an Admin area route, a login's own things, a named repair                                          | what the reason needs                    |
| `peer(share)`    | a peer without "Acts as", reading what it is shared                                                           | nothing                                  |

An assistant turn for a user runs as that user's login. Work done later for
a login (a run, a heartbeat with a maker, a pending tool call, a Telegram
turn) runs as that login **as it is now**, when the work runs: the entry
reads the login again then. One helper does it: `loginActorNow` in
`packages/db/src/client.ts`. A login disabled since is still bound in A2a
(nothing is refused) and named in one warning.

## How code binds an actor

From `@mantle/db`:

- `runAsSystem('worker:extract', fn)`: a process's own work.
- `runAsActor(loginActor(id, 'rw'), fn)`: work for a login (`'ro'`,
  `'owner'` for the other login kinds).
- `registerActorWorkflow(name, actorOf, impl)`
  (`server/api/src/workflows/actor-workflow.ts`): the one way a DBOS
  workflow registers. Each run asks `actorOf` with its own arguments who it
  runs as, then runs `impl` as that actor (`systemEntry(reason)` for the
  runner's own work).
- `runInActorSlot(initial, fn)`: an entry whose caller is known only later.
  The route loader starts each request as `system(http:no-login)`. The
  session guard names the login (a read key: `login(ro)`), the share gate
  names the link or the contact, an Admin area route becomes
  `system(http:admin-area)` and a login's own things `system(http:login-self)`.
- `asSystem(fn, reason)`: leave the caller's scope for the system pool. The
  reason is required (a type error without one), and `fn` runs as
  `system(reason)`. Each reason is described in `packages/db/src/viewer.ts`
  and each calling file is pinned in `eslint-rules/as-system-allowlist.mjs`.
- A workspace scope (`withViewer`, a turn scope) runs as the login it is
  for, keeping the mode its caller named.

An inner binding replaces an outer one.

`asSystem` inside a read-only caller stays read only (`systemUnder`): under
`login(ro)`, a `link` and a `contact` without `can_write`. An `assistant`
and a `peer(share)` keep their own system work read-write (their traces,
their audit rows).

## Nested system transactions (A2b, plan 20.2)

`withSystemTx` inside an open system transaction is a SAVEPOINT of it. It
never opens a second transaction:

- An inner error rolls back the inner writes only and runs the inner
  `afterRollback` hooks. The outer transaction goes on. On success the
  inner hooks join the outer ones and follow its outcome.
- One nested call at a time on one level, and none after the level ended
  (a detached call): both are refused (`NestedSystemTxError`).
- `withHeads` there calls `mantle_lock_heads_nested` (0277): the database
  takes more heads (`mantle_lock_heads_more`, FOR UPDATE NOWAIT) where it
  holds some, else the first lock with its rules. Never a second
  `mantle_lock_heads`. The database also refuses `withSubtreeHeads` where
  heads are held (55000): lock the subtree in the outer call.
- `withDeadlockRetry` inside runs once. Only the outermost call retries.
- A nested call with another actor or create home is refused. There is no
  set-and-restore helper yet.
- **No nested write in a loop.** Each nested call is a savepoint, and
  postgres.js never releases one. A release would not help: Postgres keeps
  the id of each subtransaction that wrote until the top transaction ends.
  Past 64 of them the backend's subtransaction cache overflows, and every
  snapshot on the box gets slower. More than 32 nested calls in one
  transaction log one warning (`NESTED_SAVEPOINT_WARN`). Put the loop in one
  nested call, or do the writes in the outer call.
- **A first heads lock in a savepoint that rolls back** keeps the
  transaction id it took (`txid_current`, in `mantle_heads_mac`). The
  savepoint takes back the signed held list but not the id, so the
  transaction now holds no heads but is no longer at its start. A later
  `withHeads` in the outer call is a first lock again: with
  `mantle.heads_check = on` it is refused (55000, the first-lock rule), in
  `warn` it is a heads miss. Take the heads in the outer call before the
  nested call that can fail.

`packages/db/src/a2b-nested-tx.db.test.ts` runs each shape, and `withHeads`
under every actor kind, with `mantle.heads_check = on`.

## No transaction across a model call (A2b)

The lint `mantle-tx/no-model-in-transaction`
(`eslint-rules/no-model-in-transaction.mjs`) refuses an awaited model call,
an awaited `fetch` and a `for await` stream read inside a transaction's
callback. A model call is a promise method of a model dispatcher (read from
the `AdapterMeta` interfaces in
`packages/voice-client/src/adapters/types.ts`) or a function of the model
packages. It sees direct calls only.

## How the actor reaches Postgres

Only `packages/db` sets the settings (the lint
`actor-setters-in-db-only`). On the system pool, while the check is not
off and an actor is bound, `client.ts` (`needsActorWrap`):

- sets `mantle.actor` and `mantle.write_mode` in every transaction
  (`withSystemTx`, the heads helpers, `db.transaction`), sent unawaited
  right before its first statement, so both go in one send: no round trip
  of its own (after a `SET TRANSACTION`, which Postgres takes only first).
  The SET carries its values as quoted literals: with prepare off,
  postgres.js sends a statement with parameters in two steps and holds
  what is queued behind it. A SET that fails is the error reported;
- sends a write outside a transaction (INSERT, UPDATE, DELETE, MERGE,
  TRUNCATE, COPY, a WITH that names a write verb anywhere, more than one
  statement, and any verb it cannot name) on one reserved connection: a
  session-level SET in the same send as the write (no BEGIN, no COMMIT:
  the write commits by itself), then a real `RESET` of the three
  settings. The caller gets the write's own answer and waits no longer
  than with the check off. The connection goes back to the pool only once
  the RESET has answered; a RESET that fails ends the connection
  (A2b1 audit, Q1). No pooled connection keeps an actor;
- sends a read (SELECT, WITH ... SELECT, VALUES, SHOW, EXPLAIN without
  ANALYZE or ANALYSE) plain, exactly as with the check off.

`server/web/server/a2a-round-trips.db.test.ts` pins the cost on six hot
paths: with the check off no statement sets or reads the actor (the actor's
own statements carry a `/* mantle:actor */` tag: its lookups and the
wrapper's RESET), and warn sends the same statements as off plus the
actor's own, in the same number of round trips apart from the round trips
that send only the actor's own statements. No round trip carries the SET
alone, and page save takes off's round trips apart from the RESET after
its answer.

The wrapper of a write in warn is a promise with `values()` and
`simple()` only: no `cursor`, `forEach`, `describe`, `readable` or
`writable`. A `COPY ... FROM STDIN` through `.writable()` on the system pool
breaks in warn. Nothing in the app does that today; send one inside a
transaction instead.

A SELECT that calls a function that writes an item table runs plain too, so
in warn the 0275 trigger logs it as a miss. That is wanted: it shows the
case. The TypeScript check below still covers reads, in process, with no
round trip.

With the check off, or no actor bound, every statement runs exactly as
before. The box's mode is read when the pool opens and then each minute on
a timer, never in a statement's path. `MANTLE_ACTOR_CHECK` is a floor. Until
the first read lands, a write or a transaction that has an actor waits for
it (A2b), so a process's first writes never go out as `off` on a `warn` or
`on` box. Reads never wait, and after the first answer nothing waits again. The client sets the settings with plain
`set_config` (it works on every role and on a database before 0275);
`mantle_set_actor` is the checked form for psql and tests. The workspace
role (`mantle_view_user`) cannot run the setter functions.

This is not a secret: any role can set a `mantle.*` setting (see Known
limits). The protection is the lint, the runtime role (A9) and the read rule
on the write role.

## The check

`mantle.actor_check` is `off` (the default), `warn` or `on`, set per box in
the database with `mantle_set_actor_check(mode)` (0277, docs/update-prod.md):
it sets the setting and switches the item-table triggers together. A session
can only make it stricter (the rule of `mantle.heads_check`).
`MANTLE_ACTOR_CHECK` raises it for one process.

- **TypeScript**: every statement through `db` or `systemDb`, and every
  `withSystemTx`, with no actor bound is a miss. In `on` it is also refused
  (`ActorMissingError`). Until the first mode read lands this side uses
  `MANTLE_ACTOR_CHECK` alone; the SQL side reads the box itself.
- **SQL**: the statement trigger `mantle_actor_check` is on every item
  table: nodes, pages, draws, tables, apps, app_databases, the recall
  tables, node_embeds, app_table_exports, shares, node_snapshots,
  item_grants, peer_shares, contact_share_codes, node_comments, and the
  other content tables of the access matrix (`mantle_actor_check_tables()`
  lists them from the catalog; `actor-trigger-coverage.db.test.ts` pins
  them). The triggers are enabled only while the box is `warn` or `on`. On a
  box that is `off` they are disabled, so a write calls no trigger at all
  (the owner's scaling rule), and a session that raises its own value does
  not turn them on. A write with no `mantle.actor` raises a NOTICE in
  `warn`. It writes nothing in that transaction, so it never takes a
  transaction id before `mantle_lock_heads`. The app reads the notice and
  logs the miss later, on another connection. In `on` it is refused: 42501, detail `no_actor`
  (migration 0277).

Misses are capped at 100 rows an hour per check. An operator's psql names
itself with `mantle_operator_actor('reason')` (docs/update-prod.md).

### The 0266 checks on the write role (migration 0277)

The 0266 create and delete checks (a new item needs edit of its folder, a
delete needs manage of the item's home) run when a write carries a scope.
Today only an Admin user's write request and an Admin turn carry one. When
A2b2 scopes every login write on the write role (`mantle_write_user`), a
refusal there follows the check: `off` runs the write, `warn` reports it as
a miss, `on` refuses it. Every other session refuses as before. The gate
(`mantle_scoped_write_refuses`) keys on the session's role, never on a
`mantle.*` setting, and runs only on the refusing path.

The test suite runs in `warn`. `vitest.setup.ts` fails a test on any miss.
A statement a test sends itself runs as `system(test)`: the test is its
process entry. Inside `runWithoutActor` that no longer holds, which is how
a test proves an entry binds its own actor.

## Writes inside read paths

A read request or read tool that writes is named and pinned in
`READ_PATH_WRITES` (`packages/db/src/actor.ts`). Each runs as
`system(repair:…)` or `system(backfill:…)`, so it still writes for a
read-only key. The scoreboard counts them (`readPathWrites`); the count
only goes down. Today: closing a caller's abandoned traces, the app-nav
layout and app-marks backfills, a missing kind root or files root, the
default documentation collections, and a page's missing block ids.

## The process inventory

Every file that starts work on its own, by kind, with the actor it binds.
`eslint-rules/process-entries.test.ts` fails when a file starts work and is
not listed here, or is listed and no longer does. Its header says how each
kind is found. `timeout-loop` is every file that calls `setTimeout(` and
reaches the database (a value import from `@mantle/db`, or a file of
`packages/db/src`): text cannot tell a re-arming timer from a sleep or a
deadline, so each is listed and named here. A timer carries the actor of
the code that set it. `packages/db/src` is scanned too.

Every binder call (`runAsActor`, `runAsSystem`, `runReadPathWrite`,
`runInActorSlot`, `actorStore.run`, `actorStore.enterWith`) is pinned per
file with its count in `eslint-rules/actor-binders.mjs`, so a binder only
appears, moves or goes with a reviewed pin change.

```entries
# kind file actor
dbos-workflow server/api/src/crash-test.ts none: a dev script run by hand on scratch databases, never imported by the runner nor run on a box (exempt from registerActorWorkflow)
dbos-workflow server/api/src/workflows/actor-workflow.ts defines the helper: registerActorWorkflow binds actorOf(...args) around each run
dbos-workflow server/api/src/workflows/assistant-turn.ts the turn's login as it is now, else login(owner)
dbos-workflow server/api/src/workflows/client-turn-retired.ts system(workflow:client-turn-retired): a retired no-op that sends no statement
dbos-workflow server/api/src/workflows/forum-turn-retired.ts system(workflow:forum-turn-retired): a retired no-op that sends no statement
dbos-workflow server/api/src/workflows/ping.ts system(workflow:ping)
dbos-workflow server/api/src/workflows/runs-resume-turn.ts system(workflow:runs-resume-turn); the turn itself the run's login as it is now, else login(owner)
dbos-workflow server/api/src/workflows/runs-worker-turn.ts system(workflow:runs-worker-turn); the turn itself the run's login as it is now, else login(owner)
dbos-workflow server/api/src/workflows/team-turn.ts the member's login as it is now
dbos-workflow server/api/src/workflows/telegram-turn.ts the paired chat's login as it is now (login(owner) for the owner's), else system(workflow:telegram-turn); system(workflow:telegram-turn) with the check off or when the lookup fails
interval packages/content/src/process-heartbeat.ts none: touches a file, no database
interval packages/db/src/client.ts none: the box mode read, on the raw pool outside the actor client (started in runWithoutActor)
interval packages/share-ui/src/event-presenter.tsx none: browser code
interval server/api/src/agent/extract-queue.ts system(tick:extract-reconcile); each job system(queue:extract)
interval server/api/src/agent/telegram/helpers.ts none: a typing indicator, no database
interval server/api/src/agent/ticker.ts system(tick:<name>) per tick: reflector, heartbeat-tick, extract-sweep, table-migration-sweep
interval server/sandboxd/src/main.ts none: the sandbox daemon has no brain database
interval server/web/app/api/assistant/stream/route.ts the request's actor (a keepalive, no database)
interval server/web/app/api/assistant/turn/[turnId]/stream/route.ts the request's actor (a keepalive, no database)
interval server/web/lib/sse.ts the request's actor (a login check on ping)
interval server/web/workers/_runner.ts none: keeps the process open
interval server/web/workers/docs-sync.ts system(worker:docs-sync)
interval server/web/workers/events-reminders.ts system(worker:events-reminders)
interval server/web/workers/telegram-poll.ts system(worker:channel-poll)
listen server/api/src/agent/runtime.ts system(listen:<channel>) per channel (listenAs); the turn it starts binds its own
listen server/api/src/turn-cancel.ts none: aborts a turn in memory, no database
listen server/sandboxd/src/egress.ts none: a network listener, no brain database
listen server/sandboxd/src/main.ts none: a network listener, no brain database
listen server/web/lib/realtime.ts system(listen:realtime)
listen server/web/workers/push-notify.ts system(worker:push-notify)
process-on packages/content/src/app-sql-runner.ts none: the SQLite child's message handler, no brain database
process-on server/api/src/main.ts none: the signal handlers stop DBOS and the runtime, no statement of their own
process-on server/web/server/main.ts none: signal and error handlers that close the server and log
process-on server/web/workers/_runner.ts none: signal handlers run the worker's teardown; a rejection handler that logs
queue-work server/api/src/agent/extract-queue.ts system(queue:extract) per job
queue-work server/web/workers/calendar-sync.ts system(worker:calendar-sync)
queue-work server/web/workers/email-sync.ts system(worker:email-sync)
queue-work server/web/workers/maintenance.ts system(worker:maintenance)
queue-work server/web/workers/microsoft-sync.ts system(worker:microsoft-sync)
queue-work server/web/workers/runs.ts the run's login as it is now, else login(owner)
request-slot packages/db/src/viewer.ts defines the helper: runInRequestSlot starts a request as system(http:no-login)
request-slot server/web/server/middleware/gate.ts system(http:gate) for the gate's own lookups (an API key, a token)
request-slot server/web/server/pages/print.ts system(http:render), then the render cookie's login
request-slot server/web/server/pages/share.tsx system(http:share-page), then the link or the contact
request-slot server/web/server/route-loader.ts system(http:no-login), then what the guard names
timeout-loop packages/content/src/app-broker.ts the caller's actor: a drain sleep inside an app database restore
timeout-loop packages/content/src/app-table-exports.ts the scheduling caller's actor, which the debounce timer carries to the export sync
timeout-loop packages/db/src/client.ts the caller's actor: a retry sleep
timeout-loop packages/db/src/resolve-owner.ts the caller's actor: the wait for the first signup
timeout-loop packages/db/src/test-support.ts none: test helpers' poll and retry sleeps
timeout-loop packages/db/src/viewer-roles.ts the caller's actor: a retry sleep
timeout-loop server/api/src/agent/runtime.ts system(timer:summarize) for the summarize debounce
timeout-loop server/web/lib/maintenance/sweeps.ts the caller's actor: a sweep's deadline, system(worker:maintenance)
timeout-loop server/web/lib/onboarding-steps.ts the request's actor: a fetch deadline
timeout-loop server/web/lib/push/login-notice-handler.ts system(worker:push-notify), carried by the batching timer
timeout-loop server/web/lib/sanity/checks.ts the caller's actor: a check's deadline
timeout-loop server/web/lib/system-health.ts the caller's actor: a probe's deadline
timeout-loop server/web/workers/_runner.ts none: the shutdown deadline, it only exits
timeout-loop server/web/workers/telegram-poll.ts system(worker:channel-poll): a settle sleep at shutdown
worker-shell server/web/workers/_runner.ts system(worker:<name>) around each worker's setup (startWorkerAs)
worker-shell server/web/workers/calendar-sync.ts system(worker:calendar-sync)
worker-shell server/web/workers/docs-sync.ts system(worker:docs-sync)
worker-shell server/web/workers/email-sync.ts system(worker:email-sync)
worker-shell server/web/workers/events-reminders.ts system(worker:events-reminders)
worker-shell server/web/workers/files-watch.ts system(worker:files-watch)
worker-shell server/web/workers/maintenance.ts system(worker:maintenance)
worker-shell server/web/workers/microsoft-sync.ts system(worker:microsoft-sync)
worker-shell server/web/workers/push-notify.ts system(worker:push-notify)
worker-shell server/web/workers/runs.ts system(worker:runs); each item as its run's login
worker-shell server/web/workers/telegram-poll.ts system(worker:channel-poll)
```

### Entries the grep does not see

| Entry                                                                       | Where                                                                      | Actor                                                                                                                                                                                              |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The API process boot                                                        | `server/api/src/main.ts`                                                   | none around the boot or the DBOS dispatch loop: each workflow binds its own through `registerActorWorkflow`, and one that forgot is a miss; the agent runtime boot is `system(boot:agent-runtime)` |
| The DBOS system database setup                                              | `server/api/src/provision.ts`                                              | none: a raw client on the `postgres` database, no brain table                                                                                                                                      |
| The agent runtime boot (seed tools, drain pending, drain unextracted)       | `server/api/src/agent/runtime.ts`                                          | `system(boot:agent-runtime)`                                                                                                                                                                       |
| The extract queue consumer                                                  | `server/api/src/agent/extract-queue.ts`                                    | `system(queue:extract)`                                                                                                                                                                            |
| The LISTEN handlers of the agent runtime                                    | `server/api/src/agent/runtime.ts` (`listenAs`)                             | `system(listen:telegram-message)`, `listen:summarize-due`, `listen:provider-recover`, `listen:node-ingested`, `listen:heartbeat-due`; the summarize debounce `system(timer:summarize)`             |
| A heartbeat fire                                                            | `packages/runtime/src/heartbeats/fire.ts`                                  | a workspace assistant: `assistant`; else its maker as it is now; else `login(owner)`. A forced fire keeps its caller's actor. With the check off `system(heartbeat:fire)`, decided with no query   |
| A pending tool call, approved                                               | `packages/tools/src/pending.ts` (the route, the tool, the Telegram button) | the call's login as it is now; a call with no login keeps the caller's                                                                                                                             |
| A run item                                                                  | `server/web/lib/runs/execute-item.ts`                                      | the run's login as it is now, else `login(owner)`                                                                                                                                                  |
| The stdio MCP server                                                        | `server/mcp/src/server.ts`, `stdio-actor.ts`                               | `system(boot:mcp-stdio)` to find the owner, then `login(owner)` for that owner login on the connect and every message, never system                                                                |
| The web boot tasks (manifest reconcile, snapshot copies, app table exports) | `server/web/server/main.ts`                                                | `system(boot:…)`                                                                                                                                                                                   |
| A page's block-id backfill (a detached promise)                             | `packages/content/src/pages/read.ts`                                       | `system(backfill:page-block-ids)`                                                                                                                                                                  |
| The audit row of a connector call on a login's MCP (a detached promise)     | `packages/mcp-core/src/login-surface.ts`                                   | `system(audit-log)`                                                                                                                                                                                |
| Operator scripts                                                            | `server/web/scripts/*`, `maintain`, any `scripts/` file run as the process | `system(script:<file name>)`, from the process's main file (`scriptActor` in `packages/db/src/actor.ts`)                                                                                           |
| Hand psql                                                                   | the box                                                                    | `mantle_operator_actor('reason')` first                                                                                                                                                            |
| Migrations                                                                  | `packages/db/src/migrate.ts`                                               | `system(migration)`, set on each migration's transaction                                                                                                                                           |

The pg-boss senders (`packages/email/src/backfill-queue.ts`,
`packages/runs/src/boss.ts`) only queue jobs; the consumer that runs each
job binds its actor.

## Known limits

- **The trigger follows the box mode.** On a box that is `off` the
  item-table triggers are disabled: a write calls none. In `warn` and `on`
  they are enabled. A write with an actor pays one setting read. A write
  with no actor (the miss path) first reads the box mode from the catalog
  (`mantle_actor_check_mode`, SECURITY DEFINER), so a session that sets its
  own value to `off` cannot skip a box that is `warn` or `on` (A2b1 audit,
  L4). A session can raise the check only where the triggers are enabled:
  on a box that is `off` a session value of `warn` or `on` checks nothing
  in SQL (the TypeScript check still runs).
- **Change the mode only with `mantle_set_actor_check`.** A bare
  `ALTER DATABASE ... SET mantle.actor_check` changes the setting but not
  the triggers. A restore drops the database, so the setting is gone while
  pg_dump keeps each trigger's state: `scripts/db-restore.sh` puts the
  triggers in step with the mode (off) and says how to set the modes again.
  The integrity row `actor_check_drift` and one warning at a pool's start
  (`ACTOR_CHECK_DRIFT_SQL`) show any other drift; the app never fixes it
  (no DDL from the app). The function locks every table it changes at once,
  with NOWAIT (5 tries): it never stalls writes table by table. A migration
  that adds the trigger to a new table calls
  `mantle_actor_check_triggers(mantle_actor_check_box_mode() <> 'off')`
  after it, and the coverage test fails until the states match.
- **An approved pending call** runs as the login that asked, on the owner
  surface, with the approver named in the audit. Open for A2b: whether it
  should run as the approver instead.
- **The settings are not a credential.** `set_config('mantle.actor', …)`
  and `set_config('mantle.write_mode', …)` are callable by any role,
  `mantle_view_user` included, so revoking `mantle_set_actor` is cosmetic.
  No untrusted SQL reaches Postgres today, so that is fine for A2a. A2b and
  later must never decide access from `mantle.actor` or `mantle.write_mode`
  on a role that can run caller-shaped SQL.

## Closed in A2b1

Found in the A2a audits:

- **The first statements of a process.** A write or a transaction with an
  actor waits for the pool's first mode read (see above).
- **Narrowing to read only.** `systemUnder` narrows only under `login(ro)`,
  `link` and `contact` without `can_write`.
- **The Recall slug with no scope seen.** It counts up only for a system
  actor and `login(owner)`; every other actor, and none, takes the random
  suffix (A2b1 audit M3: inside a system transaction a member's scope is
  masked). A2b2 revisits it when every scoped write carries its scope.
- **The actor SET's values** are checked before they are inlined (actor
  `/^[a-z0-9:._/@-]{1,200}$/i`, write mode `rw|ro`, check mode
  `off|warn|on`), and a statement sent in parallel with a transaction's
  first one reports the SET's own error.

## A2b2 must

- **The write role.** Login, assistant, link and contact writes move to
  `mantle_write_user` (no BYPASSRLS) with the pipelined scope pattern (plan
  20.1). 0277's gate is ready for it.
- **SET LOCAL on the write pool.** Its writes set the scope and the actor
  with `SET LOCAL` in their own short transaction, never a session-level
  SET: a scope left on a pooled connection would be a stale access right.
- **The rollout switch is the box mode.** The write pool is used only when
  `mantle.actor_check` is warn or on; off runs today's path. The mode is
  read from the catalog (`mantle_actor_check_mode`), where a session can
  only make it stricter, so the security note above holds.
- **Heads functions for the write role.** If the write role runs a nested
  `withHeads`, grant it EXECUTE on `mantle_lock_heads_nested` (not on
  `mantle_heads_taken`, which only the definers call). Never a signer
  (`mantle_heads_set`, `_sig`, `_mac`) or a bypass.
- **`mantle_actor_check_mode` stays open to PUBLIC** until the view and
  write roles have an explicit grant: callers that are not definers need it.
  Grant first, then revoke PUBLIC.

## A3a must

- **The ro refusal.** An assistant with no user and a public link write
  nothing (plan 4.1); a write with `mantle.write_mode = ro` is refused in
  A3a, not before.
- **Tables that stay on the system pool until A3a:** `recall_maps`,
  `recall_nodes`, `shares` and `node_snapshots`. They are not `content`
  tables in `ACCESS_MATRIX`; A3a adds their checks and then moves them.
- **`mantle_page_folder_id`** is a SECURITY DEFINER function open to PUBLIC
  (pre-existing). Grant it explicitly to the roles that call it, then revoke
  PUBLIC.
