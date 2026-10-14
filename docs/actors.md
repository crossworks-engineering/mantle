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
  The gate starts each routed request as `system(http:no-login)` (its
  request slot, opened through enterCall since A4 step 1), the /s page as
  `system(http:share-page)` and a render page as `system(http:render)`
  (their own slots, since A4 step 2). The session guard names the login (a read key: `login(ro)`), the share gate
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
  the RESET has answered; a RESET that fails ends the connection, which
  never goes back (A2b1 audit, Q1), and a connection that died is neither
  sent to nor handed back (`packages/db/src/reserved.ts`, the one way the
  package reserves a connection). No pooled connection keeps an actor;
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

A scoped login write runs on the write role instead (A2b2b, "The login
write gateway" below): there the actor goes in the same SET LOCAL as the
scope, with the transaction's first statement.

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
refusal there follows the check: `warn` runs the write and reports it as a
miss, `on` refuses it. `off` runs it and reports it too (0278): no write
runs on the write role while the box is `off`, so one that does is stray
and must show. Every other session refuses as before. The gate
(`mantle_scoped_write_refuses`) keys on the session's role, never on a
`mantle.*` setting, and runs only on the refusing path. 0278 puts the move
check (0245, `mantle_nodes_acl_path_trg`) and the write role's own checks
behind the same gate.

**Changed in A2b2b (migration 0279):** the 0266 create-in-a-folder and
delete checks and the 0245 move check refuse on the write role in every
mode again, as they do on the system pool. The app holds no check of its
own for some of what they refuse (an Admin user's create, move or delete in
a workspace it is not in: W6a M1), so staging them would let in `warn` what
the system pool refuses today. Only the write role's own checks (0278's
write check: edit, a Moderator of the create home, a grant, a kind change,
an item with no home) are staged by the gate.

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
default documentation collections, a page's missing block ids, and (A3a) a
public link's view counter and the Recall prompt embeddings a reader's
`recall_match` heals. With the edit check on, a read-only caller's own
write is refused ([edit-check.md](./edit-check.md)): a read path that writes
must be one of these.

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
request-slot server/web/server/middleware/gate.ts system(http:gate) for the gate's own lookups (an API key, a token); a routed request's slot, opened by enterCall: system(http:no-login), then what the guard names; a page's own slot (A4 step 2): the /s page as system(http:share-page), then the link or the contact the share gate names; a render page as system(http:render), then the render cookie's login
timeout-loop packages/content/src/app-broker.ts the caller's actor: a drain sleep inside an app database restore
timeout-loop packages/content/src/app-table-exports.ts the scheduling caller's actor, which the debounce timer carries to the export sync
timeout-loop packages/db/src/access-matrix.ts the caller's actor (migrate's): the write role sync's retry sleep
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
| Clearing member Moderator ticks (0286 roll)                                 | `server/web/scripts/ws-clear-member-ticks.ts` (`lib/workspace-ticks.ts`)   | `system(script:ws-clear-member-ticks)`, from the main file (`scriptActor`); each `user.moderator` event it writes has no `actor_id` and `by` "ws:clear-member-ticks"; `ws:team-check` reads only   |
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

## The write role (A2b2a, migration 0278)

`mantle_write_user` exists on every box from A2b2a on. Since A2b2b the
login write gateway sends the scoped login writes to it (next section).
What A2b2a gives it:

- **The role.** The same code path as the workspace role
  (`POOL_ROLES` in `packages/db/src/viewer-roles.ts`): no superuser, no
  BYPASSRLS, NOINHERIT, its password derived from the master key, the per
  database login with a SET-only membership, the owner note. Connection
  limit 20 (`ROLE_CONNECTION_LIMIT`; the workspace role keeps 30). The
  pool is `getViewerDb('write')`, at most 3 per process, and no process
  opens it in A2b2a.
- **Grants, from `ACCESS_MATRIX`.** SELECT exactly as the workspace role.
  On `WRITE_ROLE_TABLES` (the `content` tables the workspace role reads,
  `writeRoleWrites`): DELETE, and INSERT and UPDATE on the columns it reads
  less the ones the database derives (`writeColumnsFor`, the matrix's
  `derived`): the whole table where it reads all; never
  `item_grants.granted_by`, `granted_at` or `bridge`, and never
  `item_grants.via_folder_id` (the folder rows are made by the propagation
  triggers, which run as their owner). The other `content` tables
  (`WRITE_ROLE_SYSTEM_ONLY`) have no read rule, so the role gets no right
  on them.
- **Function rights.** Exactly the workspace role's plus
  `WRITE_ROLE_FUNCTIONS` (each with its reason); `applyViewerGrants`
  revokes any other. Every definer function the role may run is on the
  reviewed list in `write-role.db.test.ts`.
- **Row rules.** `syncWriteRoleRules` calls `mantle_write_role_sync_table`
  per table, each in its own transaction (lock_timeout 3 s, tried 8
  times): every read rule of the workspace role names the write role too;
  each write table has three write rules for the role, each the table's
  read rule (INSERT WITH CHECK, UPDATE USING and WITH CHECK, DELETE USING).
  A row the scope cannot read matches no row, and a write cannot move a
  row out of what the scope reads. A table whose rules match takes no
  lock.
- **Write checks.** Reading is not editing. `mantle_write_check_trg`, on
  each write table with a `writeCheck` in the matrix, fires for the write
  role only (`WHEN current_user = 'mantle_write_user'`) and refuses
  through `mantle_scoped_write_refuses` (so off, warn and on stage it):
  a new item needs a Moderator of its home (the home
  `mantle_default_home` gives it; a login's own private workspace counts
  only when the scope's `mantle.mod_ws` holds it), or its home is its
  folder's and the scope may edit that
  folder; a session can name any workspace as its create home
  (`mantle.create_ws`), so this is what holds a create to a workspace the
  caller moderates (plan v2). An item needs edit (a board rank change
  alone: edit of the item or its folder), and its kind (`type`) never
  changes on the role. A row of an item (a page, a chunk, a fact) needs
  edit of that item; a grant needs manage of the item's home, and a new
  grant, a moved one or one made the home (`is_home` false to true) a
  Moderator of its workspace; an item with no home needs an Admin scope
  to create, delete or manage; a fact with no item stays inside the scope
  and is the caller's own (its login the caller's: one with no login is
  the system's, written on the system pool by the extractor).
- **The move check is staged too.** 0278 sends the three refusals of the
  move check (0245: manage of the home, edit of the new folder, an app
  placed where it adds a workspace the caller does not moderate) through
  the same gate: on the write role `off` and `warn` report and run, `on`
  refuses; every other session refuses as before.
- **Trigger functions.** Every trigger function on a `content` table runs
  as its owner (SECURITY DEFINER, with a search_path), or is on the
  reviewed list in `write-role.db.test.ts` with its reason. 0278 made the
  two reap triggers definers (a delete reaps facts and edges the login
  cannot read). The three guards (`mantle_nodes_acl_guard_trg`,
  `mantle_follow_guard_trg`, `mantle_nodes_login_guard_trg`) stay with the
  caller's rights: they ask `mantle_owner_role()`, which reads
  `current_user`, so as definers they would always pass. No definer
  trigger function is open to PUBLIC. `mantle_page_folder_id` is open to
  the workspace role and so to the write role (whose function rights
  mirror the workspace role's), never to PUBLIC.
- **No INHERIT membership.** The write check fires `WHEN current_user` is
  the write role, so a role that inherited the write role's rights would
  write as itself, past the check. The pool's per-database login is SET
  only; `write-role.db.test.ts` pins that no role on the cluster holds an
  INHERIT membership in it.

## The login write gateway (A2b2b, migration 0279)

One place sends a login's write to the write role: `onLoginWritePool` in
`packages/db/src/client.ts`, behind the three doors a scoped write already
took to the system pool: the `db` proxy's `insert`, `update`, `delete` and a
mutating request's `transaction`, `executeWrite`, and `withSystemTx` (every
heads helper goes through it). One decision, `loginWriteRoute`, when the
write runs:

- the process opened the pool (`openLoginWritePool`): web
  (`server/web/server/main.ts`) and api (`server/api/src/main.ts`) only.
  Workers, the stdio MCP server and scripts keep every write on the system
  pool. `connection-ceiling.test.ts` counts the pool for those two and fails
  on any other caller;
- the actor check is not off (`actorCheckMode`: the box mode read from the
  catalog, `MANTLE_ACTOR_CHECK` raises it for one process). Off is the
  rollout switch: the system pool as before, no statement and no round trip
  added (`a2a-round-trips.db.test.ts`, also against the pre-A2a counts);
- the actor is a login, an assistant, a link or a contact (system work, a
  named repair, an Admin area route and a peer(share) stay on the system
  pool);
- the write carries a scope its reads use too (`loginWriteScope` in
  `viewer.ts`): a login's mutating request scope, or an Admin turn (the Admin
  assistant, the Admin MCP surface). Not an Admin user's write request: its
  reads run on the system pool, unscoped (W6a M1), so a row it read could
  match no row on the role and its write would do nothing, silently. It stays
  on the system pool with its scope on the transaction, as before, until A4
  puts its reads in the scope. A login's write with no scope at all (a run
  item in a worker) stays on the system pool too.

On the role a transaction sets the scope (`mantle.ws`, `mod_ws`,
`login_id`), the actor and the create home with one `SET LOCAL`
(`set_config(..., true)`, `writeRoleSettingsSql`) sent with its first
statement: no round trip of its own, never a session SET. A write outside a
transaction runs in its own short transaction: BEGIN, the SET, the write and
COMMIT pipelined on one connection, the caller waiting as long as with the
check off. Both are tagged as the actor's own for the round-trip test.

- **The create home's Moderator seat.** A login's scope is read once per
  request or turn, often before its first create made its private
  workspace. The create-home intent (`createHomeIntent`, A3c; its fallback
  `createHomeFallback`) notes each login's private workspace as it reads it
  on the system pool; the gateway adds it to the write scope (as a
  workspace and a Moderator one) when the write's create home lands there.
  No query on the write's path.
- **Tables the role has no right on.** A typed write (`db.insert(table)`)
  or a single raw write to a table outside `WRITE_ROLE_TABLES` goes to the
  system pool before it is sent. Inside a transaction a table of
  `WRITE_ROLE_GAP_TABLES` (`access-matrix.ts`: since A3a only `profiles` and
  `app_table_exports`, [edit-check.md](./edit-check.md)) is a "gap":
  a statement whose target is one is never sent, and Postgres's own
  `permission denied for table <t>` for one counts too. The transaction
  rolls back whole (a gap the caller caught in a savepoint as well) and runs
  once more: in warn on the system pool, as before A2b2b; in on **checked**,
  on the system pool with `SET LOCAL ROLE mantle_write_user` and the same
  scope, every statement as the write role (its row rules and write checks)
  except a write whose target is a gap table, a row-locking read (`FOR
UPDATE`, `FOR SHARE` and kin, which need UPDATE) naming any gap table, or
  a read naming one the write role cannot read at all (`secrets`,
  `app_table_exports`), which runs
  as `mantle_gap_writer` (fix round 2) between `set local role` to it and
  the write role set back. That role is NOLOGIN and holds rights on the gap
  tables only (and a row rule that lets it through theirs), made by
  `syncGapWriterRights` from the same list, so an item write in that window
  is impossible by construction; a statement that needs more fails. So in
  on no item write leaves the role's checks through a rerun; a statement
  that needs a gap table and is neither fails. A single statement with a
  `WITH` that writes a gap table is not seen as a gap target
  (`rawWriteTarget` reads only a plain INSERT, UPDATE or DELETE): it is a
  gap Postgres answers, so in warn it runs again on the system pool and in
  on it is a 500 (fail closed; no such statement is known today). Each gap is logged as an actor
  miss (`write-role-gap`). ONE rule decides it, `writeRoleGapTable`, used
  by the gateway and by `vitest.setup.ts` (the suite fails on any other
  denial). Any other denial, a column, a function, a sequence, a table off
  the list, is a bug and stays an error (a 500). A refusal the database
  decided (a check, a row rule) never runs again. The rerun needs a system
  login that may SET ROLE to the write role and to `mantle_gap_writer` (a
  superuser, as on every box today); one that may not fails loudly in on.
- **Rollout: warn under-reports the gap flows** (fix round 2). In warn a
  gap's rerun runs on the system pool unchecked, so for the gap flows (app
  publish, restore, delete, app and table snapshots, Recall maps, share
  links, `secret_create`, the profile row) warn's misses do not show what
  on would refuse. Watch those flows on dev with the box in on before
  another box goes on.
- **Rollout: any other denial is a 500 in warn and in on** (fix round 1,
  H1): a right the write role does not hold, outside the gap tables (a
  column, a function, a table off the list), was run again on the system
  pool before and is an error now. It is a bug to fix in the matrix or the
  caller; the suite fails on it, a box shows it as a 500 and a
  `write-role-gap` miss.
- **Running a gap's flow twice is safe** (audit, 2026-10-13): of the flows
  that meet one (app publish, restore, delete, snapshots, table snapshots,
  Recall maps, contact share links, `secret_create`, the profile row), none
  sends a job, a fetch, a model call or a message inside the transaction;
  the app and table snapshots copy a file to a fresh path and delete the
  copy when the transaction fails, so the first attempt leaves nothing; a
  `withSystemTx`'s commit hooks of the failed attempt are dropped, its
  rollback hooks run. The cost: each such flow runs twice while its table
  is a gap (A3a moved all but `profiles` and `app_table_exports`).
- **The visibility confirm reads in the write's own transaction.**
  (`packages/content/src/tree/visibility.ts`) It names every workspace a
  change reaches, those the caller is not in too. What a scoped read
  cannot see goes through definers of 0279, held to the scope: a
  destination folder's grant rows (`mantle_folder_grant_rows`: not
  excluded, only for a folder the scope reads) and the workspaces
  (`mantle_ws_names`, `mantle_ws_live`, `mantle_ws_admin_id`, an id only).
  A workspace is named only when it is in the scope, the scope holds
  Admin, or it holds a grant on the change's own `via` node, read by the
  scope: the destination folder for what is gained, the moved item for
  what is lost (fix round 2, L4). No second connection, and the
  transaction's own changes count.
- **Writes inside an open write transaction join it.** A login's write
  (a top-level `db.insert`, `executeWrite`, a `withSystemTx`) made while
  its own write transaction is open in the same request, with the same
  actor, scope and create home, runs in that transaction as a savepoint,
  never on a second connection (3 per process: three such requests at once
  waited on each other for ever). A statement gets its own savepoint (it
  fails alone, as on its own connection); a joined `withSystemTx`'s hooks
  run when the outer transaction ends. Every savepoint at one level, a
  join's or drizzle's nested transaction, runs one after another (fix
  rounds 2 and 3): two at once would interleave, and a rollback to the
  second would take the first's statement after its caller was told it
  succeeded. Each savepoint is a level of its own; a statement of a level
  waits for the savepoints queued before it (unless it runs inside one),
  and the transaction waits for joins left running before it commits. When
  a transaction or a savepoint fails, it ends first: what it left running
  settles before the ROLLBACK, and any statement of an ended level (or one
  under it) is refused before it reaches the driver
  (`JoinedWriteEndedError`), so nothing is sent on a connection after its
  transaction ended, on the write pool or on the checked rerun's system
  connection. Refusing a parallel join instead was weighed (round 3): it
  is not simpler (it still needs the ended-level refusal and the same hooks
  on every savepoint path) and it would turn a caller's `Promise.all` of
  writes inside a transaction into an error. Each savepoint counts toward
  `NESTED_SAVEPOINT_WARN` (one warning past 32; one count per transaction,
  a nested `withSystemTx`'s too): postgres.js never releases a savepoint,
  and releasing would not help, as Postgres keeps a subtransaction's id to
  the end. So in warn and on such a write
  commits and rolls back with the transaction around it (off keeps the old
  separate connection). Any wait for a write-pool connection is bounded
  (15 s, `WritePoolBusyError`, a busy answer, logged); the suite fails on a
  second write-pool connection taken inside an open write transaction.
- **A kind's root folder** is the brain's: every kind's `ensureRoot` makes it
  as `system(repair:kind-root)` (`packages/content/src/kind-root.ts`).
- **Grants** go through definers (0279): `mantle_grant_change` (add,
  exclude, hand, write, remove, restore, by the grants panel's rules),
  `mantle_grant_move_home` (one call: manage of the old home and a Moderator
  of the new one; the old home row cleared first, never one UPDATE of both
  rows, which `item_grants_one_home_uq` would refuse by row order) and
  `mantle_workspace_event`. The role never writes `via_folder_id`,
  `granted_by`, `granted_at` or `workspace_events`. Each checks only while a
  scope is set, staged on the role. `server/web/lib/grants.ts` itself still
  runs as `system(rule-in-query)`: its panel reads workspaces past the scope.
  So in the app those definers run on the system pool with no scope set,
  where they check nothing: their checks (and the scope rule of
  `mantle_workspace_event`: a workspace of the scope, or one holding a grant
  row on the subject's item whose home the scope manages; a removal is
  logged before its row goes) are exercised only by the direct-SQL cells
  (`a2b2b-write-gateway.db.test.ts`, `write-role.db.test.ts`) until the
  grants panel moves to the role.

**Known asymmetries (2026-10-13), each until its phase:**

- **Workers stay on the system pool.** The write pool opens in web and api
  only, so the same member turn is checked when api runs it and not when a
  worker does (a run item, a queued job): the system pool with the
  app's checks and the 0266/0245 checks, as before A2b2b.
- **Admin HTTP stays on the system pool until A4.** An Admin user's write
  request reads unscoped, so it keeps the system pool with its scope on
  the transaction: it meets only the 0266 and 0245 checks, never the write
  role's row rules or write checks. A4 puts its reads in the scope.

`server/web/server/a2b2b-write-gateway.db.test.ts` runs each actor kind, off,
warn and on, the gaps and the two grant definers. `pnpm test:actor-on` runs
the write-path cells (the member writes, the workspaces cells, the write
role's, the grants) with the check on.

## A2b2b must

Open, each an owner question (A2b2b keeps today's working behaviour):

- **(open, owner question) An Admin-only kind made by an Admin user who is
  not a Moderator of Admin.** On the write role (an Admin turn) the create
  needs a Moderator of its home, Admin: refused in `on`, reported in `warn`.
  Kept: the database says no. An Admin user's HTTP write stays on the system
  pool, where this rule does not run.
- **(open, owner question) Assistant, link and contact creates.** No flow
  sends one with a write scope today (a workspace assistant's turn with no
  user writes nothing, a link and a contact write through named system
  work). Kept the write check's rule: a Moderator of the home, or a folder
  they may edit whose home is the create's. A create there with an empty
  `mantle.mod_ws` is refused in `on`.
- **(open, owner question) An app's placement on create.** Decided for now:
  a folder's Write is enough (as before). The move check refuses an app
  placed where it adds a workspace the caller does not moderate; a create
  does not. Adding it means an app-side refusal and its UI message too.
- **`mantle_actor_check_mode` stays open to PUBLIC** until the view and
  write roles have an explicit grant: callers that are not definers need it.
  Grant first, then revoke PUBLIC.
- **The trust model.** `mantle.ws`, `mantle.mod_ws` and `mantle.login_id`
  are settings any session can set. The write role keeps an app bug from
  reading or writing past the scope it set; it does not stop SQL that runs
  as the role and sets its own scope. Its password is as sensitive as the
  system pool's.
- **Lock only what the scope reads.** The heads lock functions are definers
  and lock any id they get (the write role now runs
  `mantle_lock_subtree_heads` too). The app reads the ids it locks on the
  system pool and never returns them; the lock functions filter by the scope
  since A3a ([edit-check.md](./edit-check.md)).
- **Derived columns** are kept by two ways: column grants (`derived` in the
  matrix, `item_grants.via_folder_id` only) and the guard triggers
  (`nodes.home_ws`, `read_ws`, `write_ws`, the chunk and fact copies). The
  guard triggers are the canonical way; `derived` is for a table whose
  columns are not all readable.

## Closed in A2b2b

- **Route the writes.** The login write gateway, above: one decision, one
  runner, behind the three doors a scoped write took to the system pool.
- **SET LOCAL on the write pool**, never a session SET: one statement with
  the transaction's first.
- **The rollout switch is the box mode.** Off: the system pool, byte for byte
  (`a2a-round-trips.db.test.ts` with `MANTLE_RT_BASELINE=1`).
- **Keep every app-side permission check.** None removed. And the checks
  that refused before A2b2b refuse on the role in every mode (0279, "The
  0266 checks on the write role" above): only the role's own new checks are
  staged.
- **The create home's Moderator seat is in the scope**: the gateway adds the
  login's private workspace, read by `createHomeIntent` (above).
- **The creates that are the brain's.** Every kind's root folder is made as
  `system(repair:kind-root)` through `kind-root.ts` (the Admin-only kind
  rule: open above).
- **A home move is one step on the role**: `mantle_grant_move_home` (0279).
- **grants.ts writes no derived column**: `mantle_grant_change` and
  `mantle_workspace_event` (0279).
- **The refusal messages.** `isScopeWriteRefusal` knows 0278's and 0279's
  write check messages, the row rule's own (`new row violates row-level
security policy`) and `mantle_default_home`'s, so each is a 403
  (`pg-error.test.ts`). A missing grant (`isPermissionGap`) is not.
- **One helper for the manage rule** (0279): `mantle_may_manage_home`
  (manage of the home, or Admin when there is none), `mantle_may_add_to_folder`
  (the 0266 folder rule) and `mantle_may_create_item` (the write check's
  create rule). `mantle_default_home` (0267, released) keeps its own folder
  test: it picks a home, it refuses nothing there.
- **Heads functions.** The write role runs `mantle_lock_heads`,
  `mantle_lock_heads_more`, `mantle_lock_heads_nested` and now
  `mantle_lock_subtree_heads` (a folder's move or grant change); never
  `mantle_heads_taken`, a signer or a bypass.
- **No `RETURNING *` and no other columns on the column-limited tables.**
  A write that names one is a gap the suite fails on (`vitest.setup.ts`).
- **Open the write pool only in web and api**: 3 each, 6 of the role's 20.
- **Fix round 1 (2026-10-13).** H1: only a gap table's denial runs again,
  by one rule (`writeRoleGapTable`), the same in tests and on a box. M1: in
  on the rerun is checked (above). M2: writes join an open write
  transaction; a bounded wait. M3: the confirm reads in its own transaction
  through definers (`guardRead` is gone). L2: a member app's private
  workspace comes from `createHomeIntent` (then `resolveCreateHome`). L5: `mantle_workspace_event`
  is held to the scope. L6: a gap caught in a savepoint still runs the
  transaction again and is logged.
- **Fix round 2 (2026-10-13).** Joins run one after another and count
  toward the savepoint warning; the checked rerun's gap window runs as
  `mantle_gap_writer`; an event in a workspace outside the scope needs that
  workspace's grant row on the item; a workspace is named only through the
  change's own folder or item; the event's subject is the caller's object
  (no unwrap).
- **Fix round 3 (2026-10-13).** A transaction or savepoint that fails ends
  first and nothing of it reaches the driver after; drizzle's nested
  transactions are in line with the joins; one savepoint count per
  transaction; a row-locking read of a gap table runs as the gap writer in
  the checked rerun (Recall's map lock); the gap writer's attributes are
  set on every migrate; the Admin workspace is named in the confirm; a
  migrate that cannot lock a gap table says to run it again.
- **Fix round 4 (2026-10-13).** Nothing of an ended write transaction
  reaches the driver, its settings SET neither; a nested `withSystemTx` on
  the write role is counted once (only when that system transaction is the
  write transaction itself: a system-pool one inside a live write
  transaction counts its own, round 5).
- **Known LOW (2026-10-13): a failed write transaction waits for its joins,
  uncapped.** When a write transaction or a savepoint fails, it waits for
  the joins it left running before its ROLLBACK (or `rollback to`). A join
  stuck in JS (a joined `withSystemTx` awaiting a fetch) or on a database
  lock holds its write-pool connection until it settles. A cap was tried
  (round 4) and reverted (round 5): after it the connection went back to
  the pool while postgres.js could still send that savepoint's own
  `rollback to` on it, into whatever transaction it served next. The
  follow-up (task 907c6793: a busy flag per level instead of the join
  queue) removes it.
- **Rollout: a write left running after its transaction ended now
  fails.** A same-route write (a top-level `db.insert`, `executeWrite`, a
  `withSystemTx`) started inside a write transaction that has since ended
  or failed throws `JoinedWriteEndedError` instead of taking a connection
  of its own (round 3, A). Such a write was a detached call. After the
  roll, grep the dev logs for `JoinedWriteEndedError` and fix each caller
  (await it inside the transaction, or start it after).
- **The system-only content tables** stay on the system pool: by table up
  front for a single write, by a logged gap for a transaction
  (`WRITE_ROLE_GAP_TABLES`).
- **The raised max_connections.** `connection-ceiling.test.ts` (2026-10-13,
  A2b2b): 345 of 405 on the full shape (the write role 6), 305 with
  `MANTLE_RUNS` off, 181 on the core shape.

## Closed in A3a

The database checks writes, behind its own switch, `mantle.edit_check`
(`off`, `warn`, `on`; every box starts `off`): [edit-check.md](./edit-check.md).

- **The read-only refusal.** A write with `mantle.write_mode = ro` is
  refused on every item table but the heads rows, on every session: an
  assistant with no user, a public link, a read key, a peer and a contact
  share without Can write write nothing.
- **The gap tables.** `node_snapshots`, `recall_maps`, `recall_nodes`,
  `recall_revisions` and `shares` are write tables with their checks; a
  secret's sealed value and a renamed map's cross-map options go through
  definers. `profiles` and `app_table_exports` stay on the gap list,
  decided.
- **The heads locks filter by the scope** on the write role, through the
  edit check's gate.
- **The per-table checks of plan 5.2**, the derived keys and the
  presentation key, the array forms of the edit rule, D4 (app code: a
  Moderator of the home), D5 (the app switches: Admin users) and D6 (app
  data under Informational: Admin users), all behind the switch.

## Closed in A3b (part 1)

The store brokers: the database checks a write before its disk changes
([store-brokers.md](./store-brokers.md)). One broker per store, one helper
(`packages/db/src/store-broker.ts`), plan 20.3: the bytes staged under a new
revision name, one short transaction checks the row as the caller (exactly
one row; none is a 404) and points it there, one sweep removes what no row
points at. The tables, app databases and app builds are brokered; the docs
store writes no disk; file bytes and snapshot files are part 2.

## The one gate (A3c)

Plan section 2: every way in runs the same eight steps, in one order,
through `enterCall(caller, policyRef, fn)` (`packages/db/src/gate.ts`). A3c
builds the core and proves it; the HTTP routes move onto it in A4, MCP
registration and dispatch in A5.

**HTTP, A4 step 1 (no access changed).** `ROUTE_POLICY`
(`server/web/lib/auth/route-policy.ts`) has one row per route of the
manifest and method: its class, area, who it is open to, read or write,
whether it creates, the item a write names, a v1 row's key area and alias.
Each field is folded from the route list that decided it before
(`route-policy.test.ts` pins every field against its list, for every
route and method). The route loader builds the rows once; the gate
middleware finds a request's row once (`servedRoute`) and runs the handler
through `enterCall` with it, under the `route` policy source. The caller is
the credential the gate judged (`via`: cookie, bearer, key, token, public);
its login is still resolved by the session guard, so the caller runs as
`system(http:no-login)` with `admin: null`. The gate sets the row on the
request context, not on the bound caller, so a call nested inside the
request with a caller of its own (an MCP tool, a turn) still reads it; each
session guard and both API key checks (the gate's `gateAccessKey`, the
login lookup's `findKeyLogin` since step 3a, both through `keyOnRow`) read
the row (`currentRoute()`), never a list.
A key is judged on the row only where the raw path spells the row's
pattern (`requestKeyRoute`): Hono decodes the path before routing, and an
encoded spelling stays a 404 for a key, as before A4. Those two checks judge a
key's areas: the HTTP caller sets no key areas, so the key narrower does
not run on HTTP. A
request slot with no row is refused (`unclassified`), never taken for
outside a request. The handler's request slot is the caller's
`enterScope`.

**HTTP, A4 step 2 (no access changed).** The /s page and the render
surfaces (/print/pages, /print/draws, /render/draws) are ROUTE_POLICY rows
too, of class `link` and `render`: the route loader registers them
(`registerPages`, `server/web/server/route-loader.ts`) and the gate runs
them through `enterCall` like any route. A page has no session guard to
fill a request slot, so it runs in an actor slot of its own, starting as
its row's `startsAs`: `system(http:share-page)` for the /s page (the share
gate then names the link or the contact), `system(http:render)` for a
render page (the render guard then names the cookie's login). The /s
brokers keep starting as `system(http:no-login)`: each runs its flood
limit before the share gate looks the token up, so the gate does not
resolve the link itself. A page's row is on the request context too, and a
broker's request slot has its row, so the `unclassified` refusal (a request
slot with no row) never meets either (`link-render-sweep.test.ts`). For a
routed request the gate reads its credential answers from the row
(`gateRouteView`): `public`, `cors` (the /s routes a client page calls
cross-origin; was `SHARE_BROKER_RE`) and
`renderCookie` (was `isRenderPath`). The path checks answer only a request
no route answers, and a routed one whose path spells a static segment with
escapes (`/s/x/%76iew`: the router decodes it, the checks never did). A
request no route answers (a 404, a 405, the stubs) runs as before.
`server/web/server/link-render-sweep.test.ts` pins every /s and /print
answer on the wire, written on the step 1 code.

**The routed row is the request's only row.** The row the router found
for the request's method (`requestRow` in the gate middleware) is the one
`enterCall` runs with and the one on the request context; the key scope
(`requestKeyRoute`) and the item a write names (`routeItemTarget`) read it.
A check on the raw path as sent only filters that row, never picks another:
the gate's credential view (`gateRouteView`, `byRow`) and the key check
both ask one question, whether the raw path spells the row's pattern
(`spellsPattern`), and where it does not, the path checks answer the
credential questions and a key is not in the API. Each pattern's spelling
matcher is compiled when its rows are built and when the loader registers
it (`compileSpelling`), so a pattern the test cannot spell (an optional
param) fails at boot, never on a request.

**HTTP, A4 step 3a (no access changed).** The gate resolves the login,
once per routed request, and the session guards read it. Step 1 of a
routed request (`resolveHttpLogin`, `server/web/lib/auth/session.ts`)
makes the request's logins (`RequestLogins`): each credential the guards
read (the login: an API key, the session cookie, a device token; the
device token on its own, for the cookie upgrade; an `?at=` asset token,
admin or member; the render cookie) is found once, with no effect, by the
functions the guards ran before, and kept for the request. Where the gate
judged a credential (a row that is not public), the login is found now and
bound on the caller: `loginId`, `role`, its actor (`login(rw)`, a read key
`login(ro)`), the request's logins in its facts, and, for an Admin login on
a row that manages an area, what it holds of that area (requireArea's
answer). A public row judges its own credential: its login is found on the
first guard read, once. The login's read seeds the login's scope into the
memo the request slot is opened with (`withRequestScopeMemo`), so the guard
looks nothing up twice.

Every guard (`getOwnerOr401` and its variants, `getMemberOr401`,
`getLoginOr401`, `getChatLoginOr401`, `getCookieUpgradeLoginOr401`, the
three `*ForAsset` guards, `getSessionUser`, `requireOwner*`) keeps its name,
its signature and its answers, and reads the bound logins (`currentCaller()`):
each read applies what its own lookup applied before (a device token's
last-used stamp, a rotated token's reuse check, the actor named on the
request slot), so a route that reads two guards stamps twice, as it did.
What changed: a login's row is read once per request, not once per guard
call. A request that changes a login forgets what it found
(`forgetRequestLogins`, audit L1): `endLoginSessions` (sign out
everywhere, a password change or reset, a stolen token presented again),
`updateLogin` after its commit (a role change, a disable), and the revoke
of a key or a device token the request may have come in on. A later guard
read in the same request, or work it started and did not await, finds the
login afresh and sees the change, as each guard call did before; the gate's
Admin view of the row's area is not read again. A revoked key is the
exception, as on main: the login lookup (`findKeyLogin`) reads the gate's
grant and never checks the key again, so a request that came in on the key
it revokes keeps the key's login (re-audit L-b). The scope the request
entered stays (a second guard enters the same one, as before). Outside a
routed request (a test calling a handler, a script) and inside a call
nested in one with a caller of its own, each read finds the login afresh:
today's behaviour. A find that fails (the database) is not kept: the first
guard read answers with the gate's failure, so the request looks the login
up once, as before (audit L4); a read after it asks again. The sandbox
frame documents (`GET /api/apps/:id/frame`, `GET
/api/member/apps/:id/frame`, and their HEADs) read no guard: the gate finds
no login for them (L4).

The request still runs as its row's first actor (`system(http:no-login)`)
until a guard reads the login, so a route that reads no guard runs as it
did; the bound caller's actor is the login's. A public row that writes
names the actor it runs as (`row.actor`, plan 7 and 20.3): the one it ran
as before, `system(http:no-login)`, on every such row (signup, invite
accept, sign in, the token routes, OAuth, the /s brokers; the connector
OAuth callbacks and the onboarding seed are not public and run as the login
their guard names). Step 3 binds it (`routeGatePolicy`) and the request
slot starts as it. Step 6 names no create home on HTTP (`createHome: null`):
the guard does, on its own rules, until step 3b.

The Admin step's answer is resolved at the gate, but the gate does not
refuse with it yet (`admin: null` on the HTTP caller): the owner guards
read it (`adminRouteGate`, `holdsArea`). The sweep found area rows whose
handlers never ask the area: `GET`/`POST /api/updates/check` and `GET
/api/updates/status` (class settings, read by `getSessionUser`) answer any
Admin user, and the Telegram chat routes (class connectors, open to every
login through `TELEGRAM_LOGIN_ROUTES`) are served by `getChatLoginOr401`.
Refusing at the gate would change those 13 answers (nine rows: GET and
POST `/api/updates/check`, GET `/api/updates/status`, and the six Telegram
chat rows; 13 cells with the HEADs); step 3b decides them with the codemod.

An API key is judged on a row in one place (`keyOnRow`, route-policy.ts):
the gate's `gateAccessKey` answers its refusal, and the login lookup lets a
key's login in only where it passes (it was `accessKeyLogin`'s second check
by path). `runRoute(login, method, path, body)`
(`server/web/server/run-route.ts`) runs one request through the full
pipeline (the gate, the row, enterCall, the guard, the handler) for a login
id's session cookie, an API key or nobody; a test with no database stands
its logins in with `server/web/server/run-route-stand-ins.ts`. The proof
that nothing on the wire changed is `server/web/server/a4-guard-sweep.test.ts`,
recorded on v0.300.28 before the change and unchanged after it: every
route of the manifest and every page, every method, seventeen kinds of
credential, and per request its status, the headers a client reads, a
refusal's body and, per guard call, the guard's answer, the actor after it
and the scope it entered. Its second sweep (audit L2,
`__snapshots__/a4-guard-sweep-more.txt`, also recorded on v0.300.28) adds
seven credentials (a disabled login's cookie, a cookie from before an
epoch bump, a deleted login's cookie, a rotated device token presented
again, a device token past its expiry, an unknown and a revoked key) and
drives again, with the guard's item and scope reads stood in, the 391
cells of the first sweep where a guard threw for want of a database: none
still does.

**Step 3b must-dos (from the 3a audit, L5).**

- The connector OAuth callbacks are classed `effect: read` but write (they
  store the connector's tokens). Step 3b classes them as writes, with the
  actor they write as, before the gate refuses by effect.
- The Telegram chat rows are class `connectors` and open to every login
  (`TELEGRAM_LOGIN_ROUTES`, served by `getChatLoginOr401`). Enforcing the
  row's area at the gate would refuse an Admin user with no connectors area
  while letting a member in. Step 3b gives them a class that says what they
  are (a login's own chats, a Moderator's bot chats) before the gate
  refuses by area.
- **Owner question:** `GET /api/updates/status` and `POST
/api/updates/check` answer any Admin user today though their row names
  the settings area. The auditor suggests requiring settings for those two
  and keeping `GET /api/updates/check` open to any Admin user as a
  carve-out; the builder suggested a class of their own for all three. The
  owner decides before step 3b enforces the area.
- **Owner decision (2026-10-14), landed in A4 step 3b part 4:** `GET` and
  `HEAD /api/updates/status` and `POST /api/updates/check` need the
  settings area: their handlers read the caller the pipeline answers, so
  an Admin user without the area gets the gate's 403 `area`, a member the
  403 `member-login` (it got the handler's 401), no login the 401; an Admin
  user's forced check writes the `api.write` audit row, as every settings
  write does. `GET` and `HEAD /api/updates/check`, the cached update
  banner, stay open to every Admin user as a named carve-out
  (`ADMIN_OPEN_ROWS`, route-policy.ts: their rows are the login's own,
  `self`); the handler still reads `getSessionUser` (the hand batch). The
  cells are recorded in `__snapshots__/a4-guard-sweep-owner-decision.txt`
  and pinned by `app/api/updates/updates-owner-decision.test.ts`.

**HTTP, A4 step 3b part 1 (no answer changed).** The codemod's
prerequisite and its first batch. A route file reads the caller the
pipeline answers instead of calling a guard:

    const owner = ownerCaller();

- **The row says so, from the code.** A ROUTE_POLICY row has `caller`:
  `'owner'` where the route file's handler for the method reads
  `ownerCaller()` (a HEAD row has its GET's), else null. The manifest
  generator reads that from each route file with the TypeScript parser
  (`server/web/scripts/route-callers.ts`, the manifest's `reads`), never
  from a list kept by hand. It follows a handler a route file takes from
  another route file (the /api/v1 files re-export, import or wrap their
  base route's). It goes by bindings, not names, and refuses what it
  cannot answer for: a handler that reads the caller and also calls a
  session guard (the guard's effects would run twice); a read outside an
  exported handler; the reader renamed, read off an object, or named other
  than in a plain call; a reading handler that is not a plain function; a
  handler that runs code before its read, or wraps another route file's
  reading handler with code before the call (the gate answers before the
  handler, so a 404 the handler gave before its guard would come after
  the gate's 401; the v1 pages PATCH is the case), unless marked
  `// route-callers: hand case` once checked by hand; and, beside a read,
  a guard renamed or called outside a handler. Only a route file under
  `app/api` imports `ownerCaller`, by its own name (ESLint,
  `eslint-rules/owner-caller-imports.mjs`), so a helper of lib cannot
  read it unseen. The guard and reader names are one list
  (`eslint-rules/session-guards.mjs`, pinned to session.ts's exports) that
  the generator, the sweep and the scoreboard read. A row the owner guard
  does not serve (public, link, render, a page, the any-login, chat,
  Telegram and member lists) cannot
  carry it, nor a catch-all route (its bare prefix may be the loader's
  404): their rows fail to build.
- **The gate answers it.** On such a row the gate runs the owner guard's
  answer once, in the request slot `enterCall` opened, before the handler
  (`answerRouteCaller`, `server/web/lib/auth/session.ts`): the actor named
  and a device token stamped, the system reason noted or the scope
  entered, the item a write names checked, the create home named, the
  audit row of a write. It is the function the guard runs
  (`getOwnerOr401WithLogin`), so the two answer alike. A refusal is the
  gate's answer and the handler does not run. An error the answer throws
  (the database down, busy) is thrown in the handler's place, where the
  guard threw it, so onError answers it with the gate's CORS headers, as
  before. Otherwise the answer is kept
  on the request's logins and `ownerCaller()` reads it, with no lookup and
  no effect. `ownerCaller()` throws where the pipeline answered no owner (a
  row with no `caller`, a call nested in the request with a caller of its
  own, outside a routed request: a test goes through `runRoute`). A request
  that changes its login after the gate answered (a forget) keeps the
  answer: a converted handler reads it once, at its start.
- **The guards stay.** A row with no `caller` is answered by its handler's
  guard, as before, so the batches land one at a time.
  `server/web/server/middleware/gate-caller.test.ts` serves the same rows
  through both paths and compares, for eight credentials, the status,
  body, owner, actor, scope, audit row and device token stamp.

Batch 1, the self rows (class self, the owner guard's): 29 handlers in 23
files, each the standard two lines `const x = await getOwnerOr401(); if (x
instanceof NextResponse) return x;` as its first statement: `/api/profile`
and its brand and preference writers, `/api/push` (connect, preferences,
reset, subscriptions), `/api/realtime`, `/api/health`, `/api/changelog`,
`/api/help/:topic`, the turn stage poll and the turn suggestion. Their 39
rows (with the HEADs) carry `caller: 'owner'`. Left for the hand batch:
POST cancel and GET stream of `/api/assistant/turn/:turnId` (a flag check
runs first: a refusal at the gate would answer 401 where they answer 404),
GET `/api/profile/photo` (`getOwnerForAsset`), and the eight
`/api/admin/space` 410 stubs (`gone()`).

The proof is the guard sweep: both recorded files are byte for byte. A
moved entry is logged where it now runs, at the gate (`pipeline:owner`),
and the recorded files compare it under the guard it replaced
(`getOwnerOr401`, the one call the codemod converts). The entries as
logged are recorded in `__snapshots__/a4-guard-sweep-moved.txt`: 468 cells
(273 of the first sweep, 195 of the more-credentials sweep), 14 answers:
for GET and HEAD, an Admin login's owner (the anchor, an Admin user, one
with no area; by cookie and by device token, stamped once) with the
request on the system pool as `login-self`; a member's 403 `member-login`
(by cookie and by device token) running as the member; a 401 for a
credential that resolves to no login. Each has the status, headers, body,
owner, actor and scope the guard gave.

Pins: guard calls 468 to 439, now a ceiling (the lint and the
scoreboard); files with a guard call 334 to 311; a route file that reads
the caller counts as guarded (live routes calling no guard stays 65), and
the scoreboard counts the reads (29 in 23 files, may grow).

**HTTP, A4 step 3b part 2 (no answer changed).** The part 1 re-audit's
low findings, the two readers left, and the codemod's second batch.

- **The generator** (`server/web/scripts/route-callers.ts`) refuses a
  reading handler whose parameters run code: a default value
  (`GET(req, ctx, x = audit())`, `GET(req, { params = sideFx() })`) or a
  computed key runs before the first statement, so before the read, and is
  refused like code before the read unless the handler is marked as a hand
  case. A handler that runs a reading handler of its own file (POST's
  `return GET(req)`) reads what that one reads, as a wrapped handler of
  another route file does: its row carries the caller (before, POST's row
  had none and GET's read threw, a 500). Running it with code first,
  passing it on, or running it from a helper is refused.
- **The loader** (`server/web/server/route-loader.ts`) takes an owner
  answer the gate threw off the request before it loads the handler, and
  throws it only where a handler runs. Where none runs (a stale manifest
  naming a method the module lacks: the 405; the bare prefix of a
  catch-all: the 404) no guard ran before either, and that answer stands
  with the gate's CORS headers (before: a 500 without them).
- **The import rule** (`eslint-rules/owner-caller-imports.mjs`) reads a
  template literal key with no expression in it as a literal
  (``auth[`ownerCaller`]``), and runs on every script file under
  server/web (.mts, .cts, .js, .jsx, .mjs and .cjs too), tests aside.
- **The readers** of the other two owner answers:
  `ownerCallerWithSource()` (what `getOwnerOr401WithSource` answers: the
  owner and how the request authenticated) and `ownerCallerWithLogin()`
  (what `getOwnerOr401WithLogin` answers: also the login's kind, `member`
  set for a member). Each projects the one answer the gate gave, with no
  lookup and no effect, and throws where the pipeline answered no owner,
  as `ownerCaller()` does; they are in the one list. No handler reads them
  yet: every handler that calls those two guards writes (the app brokers
  and frame ticket, batch 3; a user's password, batch 4).

Batch 2, the content reads: the GET handlers of the content read rows
(class content, open to Admin users, or to logins through the owner list),
each the standard two lines of `getOwnerOr401` as its first statement and
no parameter with a default value: 57 handlers in 57 route files (the
activity feed, the Apps sidebar, the apps: list, deleted, one, bundle and
its stylesheet, export, snapshots and a snapshot's download; contacts:
list, one, its shares; the docs reader and a doc; draws: list and one; the
entity candidates; events, formulas, journal, notes, pages and tasks: list
and one; the files list and the folders list and one; home; the mention
search; a node and its history; a page's backlinks and descendant count;
recall maps: list, one, its revisions, a card; search; shares: list and
all; tables: list, one, rows, export, history and a revision's download;
the tree of a kind, its marks, search and tags). With their HEADs and the
16 /api/v1 rows that re-export them (the generator follows), 146 rows carry
`caller: 'owner'`. Tests that stand in the owner guard and call a
converted GET directly stand in its reader the same way.

Left from batch 2's rows, each for the hand batch: `GET /api/draws/:id/svg`
and `GET /api/files/files/:id` (`getReaderForAsset`; the v1 file and its
download wrapper go with the latter), `GET /api/export/:id`
(`getOwnerForAsset`), the five `/api/apps/members` 410 stubs (`gone()`),
and `GET /api/apps/:id/frame` (the sandbox frame, which reads no guard).
The one read POST of the content rows, `POST /api/formulas/:id/evaluate`,
goes with batch 3: its guard answers it as a write (the audit row runs by
method).

The proof is the guard sweep: both recorded files are byte for byte. The
moved snapshot (`__snapshots__/a4-guard-sweep-moved.txt`) holds 2326 cells
(468 after part 1; 1401 of the first sweep, 925 of the more-credentials
sweep) and 28 answers (14 after part 1). The 14 new ones, for GET and
HEAD: an Admin user's content read running as its login in its own scope
(`login(rw)`, the scope entered: the anchor, an Admin user and one with no
area by cookie, an Admin user by device token, stamped once); a member's
open read running as the member in its scope (by cookie and by device
token); a read key's read as `login(ro)`. A member on an Admin-only read
gets the gate's 403 `member-login` and a credential with no login its 401,
answers part 1 already recorded. Each has the status, headers, body,
owner, actor and scope the guard gave. The sweep now stops a handler at
any reader of the one list; a batch that converts a
`getOwnerOr401WithSource` or `getOwnerOr401WithLogin` call must name its
rows' moved entries by the guard each replaced (the recorded files check
the name) and log the projection its reader reads.

Pins: guard calls 439 to 382, still a ceiling; files with a guard call 311
to 286; reads of the caller 29 to 86, in 23 to 80 files; live routes
calling no guard stays 65.

**Step 3b, what was left after part 2** (the batches by row class; the
sweep held equal after each, its moved entries recorded; part 3 below
says what is left now):

3. Content writes: the owner rows of class content that write, and the
   read POST `formulas/:id/evaluate`. The item a write names and the create
   home are already inside the owner guard's answer; the sweep's second
   file drives them with the reads stood in. The handlers of
   `getOwnerOr401WithLogin` (the app db and tool brokers, the frame
   ticket) read `ownerCallerWithLogin()`; the sweep names their moved
   entries by that guard. Two /api/v1 wrappers run code before their call
   and fail the generator once their base route reads:
   `PATCH /api/v1/pages/:id` (a key's 404 and 403 before `patchPage`) and
   `GET /api/v1/files/:id/download` (it rewrites the request to
   `?raw=1`; its base is an asset route of the hand batch). Their base
   handlers stay on their guards and the two go to the hand batch, unless
   each is checked by hand and marked `// route-callers: hand case`.
4. Area rows, with the gate refusing: the owner guard's area refusal
   moves to the gate with its answer (`POST /api/users/:id/password` reads
   `ownerCallerWithSource()`). The 13 cells whose handlers never ask the
   area (`/api/updates/check`, `/api/updates/status`, the Telegram chat
   rows) wait for the owner question above and the must-dos.
5. Member, any-login and chat routes: answer steps and readers of their
   own (`getMemberOr401`, `getLoginOr401`, `getChatLoginOr401`); the
   must-dos above (the Telegram chat rows' class, the OAuth callbacks'
   effect) land with this batch.
6. Hand cases: `oauth/authorize`, `auth/logout`, `auth/change-password`,
   `updates/check` (two) and `updates/status`; the asset guards
   (`getOwnerForAsset`, `getReaderForAsset`, `getMemberForAsset`: among
   them the draw svg, the file bytes and the export of batch 2's rows);
   `getCookieUpgradeLoginOr401`; `lib/gone.ts`; `lib/workspaces.ts`; the
   public rows that read the login (whoami, logout, sso, pair, OAuth
   consent); the two turn routes with a flag check first; the two v1
   wrappers above; the 13 area cells. Then `getOwnerOr401` goes and the
   count is 0 (A4 exit).

**HTTP, A4 step 3b part 3 (no answer changed).** The part 2 audit's low
findings, and the codemod's third batch.

- **The generator** (`server/web/scripts/route-callers.ts`) resolves a
  name to its binding with the TypeScript binder (a program of the one
  file, nothing resolved), not by its text: a parameter, a local or a catch
  variable that shadows a handler of the file (`POST(req, GET) { return
  GET(); }`) or a reading handler it imports is its own binding, and is
  neither a run of that handler nor a wrap of it. A name in a type (`type T
  = typeof GET`) runs nothing and is no use of a name; `typeof GET` in a
  value still is.
- **The loader**: a catch-all entry whose row carries the caller (only a
  hand-built policy can make one: `buildRoutePolicy` refuses it) and whose
  owner answer threw at the gate answers its bare prefix with the loader's
  404 and the gate's CORS headers, as the guarded route does; below the
  prefix the answer is thrown in the handler's place
  (`server/web/server/middleware/gate-caller.test.ts`).

Batch 3, the content writes: the write handlers (POST, PUT, PATCH, DELETE)
of the content rows open to Admin users or to logins through the owner
list, and the read POST `POST /api/formulas/:id/evaluate`, each with the
standard two lines of an owner guard as its first statement and no
parameter with a default value: 101 handlers in 81 route files. 98 called
`getOwnerOr401` and read `ownerCaller()`; the three that called
`getOwnerOr401WithLogin` (`POST /api/apps/:id/db-broker`,
`/tool-broker` and `/frame-ticket`, the runners W7e opened to members)
read `ownerCallerWithLogin()`. Before each was converted its file on main
was checked: nothing runs before the guard (no rate limit, flag check,
body parse, early 404 or 400, zod parse). With the 8 /api/v1 rows that
re-export them (the generator follows), 109 rows gain `caller: 'owner'`
(294 rows carry it). The gate's owner answer is the guard's own function
(`getOwnerOr401WithLogin`), so a write's side effects are the guard's,
once, at the gate: the item a write names checked (`itemWriteGate`, the
encoded-id 404 of the security fix included), the create home named
(`createHomeFor`), the audit row, the actor named and the scope entered.
Tests that stand in the owner guard and call a converted write directly
stand in its reader the same way; the app identity test's 401 runs through
the pipeline (`runRoute`), where the refusal now is.

Left from batch 3's rows: `PATCH /api/pages/:id` (its v1 wrapper,
`PATCH /api/v1/pages/:id`, answers a key's 404 and 403 before it calls the
base; the two go to the hand batch together) and the nine handlers of the
`/api/apps/members` 410 stubs (`gone()`, not plain functions). The member
list's content rows (`logins: 'member'`, `getMemberOr401`) are batch 5's.

The proof is the guard sweep: both recorded files are byte for byte. A
moved entry is now named by the reader its handler reads, and logs the
projection that reader reads: `pipeline:owner` (`ownerCaller()`),
`pipeline:ownerWithSource` and `pipeline:ownerWithLogin`; the recorded
files compare each under the guard it replaced (`getOwnerOr401`,
`getOwnerOr401WithSource`, `getOwnerOr401WithLogin`). The reader comes
from the route file's own code (the one reader of the one list the file
calls, an /api/v1 alias followed to its base route:
`server/web/server/a4-guard-sweep.readers.ts`); a file that calls two
readers throws. The moved snapshot holds 4037 cells (2326 after part 2;
2186 of the first sweep, 1470 of the more-credentials sweep, and 381 of
the first sweep's cells that wanted a database, driven again with the
reads stood in) and 56 answers (28 after part 2). The 28 new ones:

- an Admin user's content write let through (the anchor, an Admin user and
  one with no area by cookie, an Admin user by device token, stamped
  once), running as its login with the system reason `admin-write` noted;
  the same four for `pipeline:ownerWithLogin`, logging the login's kind
  (`admin`, `member: null`) and source;
- a member's open write let through (by cookie and by device token),
  running as the member in its scope, writing (`user:true`); the same two
  for `pipeline:ownerWithLogin`, logging the member;
- the owner answer throwing for want of a database in the first sweep (the
  item-write check or the create home asks it: the six credentials that
  resolve a login), a 500, the actor named before it threw, no scope; the
  same six for `pipeline:ownerWithLogin`;
- `pipeline:ownerWithLogin`'s 401 for a credential that resolves to no
  login;
- the item-write refusal in the driven-again cells, 403 `item-workspace`
  ("You cannot change this item in your workspaces."), for an Admin user
  and one with no area by cookie and an Admin user by device token, on
  `DELETE /api/apps/deleted/:id` and `POST /api/apps/deleted/:id/restore`
  (a deleted app with no home stored: only the brain's owner may), running
  as the login, no scope.

A member on an Admin-only write gets the gate's 403 `member-login` and a
credential with no login its 401, answers part 1 already recorded. Each
has the status, headers, body, owner, actor and scope the guard gave. The
write path the sweep's stand-ins do not reach is pinned by
`gate-caller.test.ts`, which serves `PATCH` and `DELETE /api/notes/:id`,
`POST /api/notes` and `POST /api/formulas/:id/evaluate` through the
pipeline and through the guard and compares, for eight credentials, the
status, body, owner, actor, scope, create home, audit row and device
token stamp: an item the login may edit; may not (403 "You cannot change
this item"); a read-only copy (403 `readOnly`); one not in the login's
scope (an Admin user: 403 "Add yourself to it first"; a member: the 404);
no such item; an encoded item id (checked as the id it decodes to); a
segment that decodes to no item id or not at all (the 404, every login);
and a create whose `?ws=` the create-home intent refuses (403 `workspace`,
400 `invalid`) or lands (the create home the handler sees).

Pins: guard calls 382 to 285, still a ceiling (97 counted: the 98th
`getOwnerOr401` is in `server/web/app/api/apps/[id]/build/route.ts`, under a
`build/` folder the counts skipped until part 4, which counts route
segments of that name; `getOwnerOr401WithLogin` is not counted);
files with a guard call 286 to 210; reads of the caller 86 to 186, in 80
to 128 files; live routes calling no guard 65 to 62 (the three runner
files called only `getOwnerOr401WithLogin`, which the counts do not see,
and now read).

**Step 3b, what is left** (the batches by row class; the sweep held equal
after each, its moved entries recorded):

4. Area rows, with the gate refusing: the owner guard's area refusal
   moves to the gate with its answer (`POST /api/users/:id/password` reads
   `ownerCallerWithSource()`). The owner decided the question above on
   2026-10-14: `GET` and `HEAD /api/updates/status` and `POST
   /api/updates/check` require the settings area, as their rows say;
   `GET /api/updates/check` stays open to any Admin user. The Telegram
   chat rows wait for batch 5's must-do.
5. Member, any-login, chat and Telegram routes: answer steps and readers
   of their own (`getMemberOr401`, `getLoginOr401`, `getChatLoginOr401`),
   with the two must-dos above: the Telegram chat rows get a class that
   says what they are before the gate refuses by area, and the connector
   OAuth callbacks are classed as writes, with the actor they write as,
   before the gate refuses by effect.
6. Hand cases: `oauth/authorize`, `auth/logout`, `auth/change-password`;
   the asset guards (`getOwnerForAsset`, `getReaderForAsset`,
   `getMemberForAsset`: among them the draw svg, the file bytes and the
   export of batch 2's rows); `getCookieUpgradeLoginOr401`; `lib/gone.ts`
   (the `/api/apps/members` and `/api/admin/space` 410 stubs);
   `lib/workspaces.ts`; the public rows that read the login (whoami,
   logout, sso, pair, OAuth consent); the two turn routes with a flag
   check first; `GET /api/apps/:id/frame`; `PATCH /api/pages/:id` with its
   v1 wrapper and `GET /api/v1/files/:id/download` with its base. Then
   `getOwnerOr401` goes and the count is 0 (A4 exit).

**HTTP, A4 step 3b part 4 (no answer changed but the owner's decision).**
The part 3 audit's low findings, the two step 3b must-dos, the codemod's
fourth batch with the gate's Admin step, and the owner's decision on the
update routes.

- **The counts** (`eslint-rules/arch-counts.mjs`) skip an archive, build,
  public or dist folder only outside `server/web/app/`, where such a
  folder is a route segment: `POST /api/apps/:id/build` (it reads the
  caller) and `POST /api/workspaces/:id/archive` (it calls no guard) are
  counted now.
- **The write parity test** (`gate-caller.test.ts`) also serves an API
  key's create on `POST /api/v1/notes` (a key with every area, a read-only
  key, one without the notes area, a member's; with and without `?ws=`), an
  item the login may edit but not manage, `POST /api/pages/:id/move`,
  `DELETE /api/shares/:id` (a page's and an app's link), `POST
  /api/recall/revisions/:id/restore`, `DELETE /api/apps/deleted/:id` (no
  home stored, a home managed or not, deleted by someone other than the
  owner, no snapshot) and an app's data write (`POST
  /api/apps/:id/db-broker`: the gate's part is the app read; D6's
  Informational switch is the database's, after it), each with the encoded
  id and the ids that are no item id.
- **The moved writes** are pinned per cell: the sweep keeps the audit rows
  a request writes and the create home the pipeline's answer named, and
  records them for every moved cell of a write in
  `__snapshots__/a4-guard-sweep-moved-writes.txt` (3607 cells). A write
  is what the audit hook takes for one (`auditsAsWrite`, route-scope.ts):
  a mutating method, or a row whose effect is a write.
- **The connector OAuth callbacks** (`GET /api/mcp-connectors/oauth/callback`,
  `GET /api/microsoft/oauth/callback`, and their HEADs) are writes
  (`WRITE_GETS`, route-scope.ts): they store the tokens they are given.
  They are not public and run as the login their guard names. Their row's
  effect makes them audited too: an Admin user's callback writes the
  `api.write` row (fix round: before, the audit hook went by the method
  and wrote none).
- **The Telegram chat rows** (`TELEGRAM_LOGIN_ROUTES` and the HEADs their
  GET handler answers) are class `self`, in no area (`rowScope`,
  route-policy.ts), like the assistant chat rows: their own gate
  (`getChatLoginOr401`) never asks an area, and the gate's area check
  would refuse an Admin user without the connectors area while letting a
  member in. The owner routes under `/api/telegram` (`PATCH
  /api/telegram/chats/:id`) stay connectors rows. Their answers are
  unchanged; batch 5 gives them a reader.

**The gate's Admin step.** On a row whose handler reads the pipeline's
caller and that manages an Admin area, the HTTP caller carries the Admin
login's view of the area the login lookup resolved (`admin`, from
`resolveHttpLogin`), and the gate's step 5 refuses a login without it, in
the guard's words (403 `area`, the one mapper). Elsewhere the caller stays
unscoped (`admin: null`) and the guard decides, as before; so are a member,
a credential with no login and a failed lookup, whose answer is the
pipeline's (403 `member-login`, the 401, the failure in the handler's
place). Before step 5 the login's effects are applied in the request slot
(`enterRouteLogin`, session.ts): a device token's stamp and the login named
as the request's actor, as the guard applied them before its area check; the
pipeline's answer takes them as applied (`RequestLogins.takeApplied`), so a
token is stamped once. A stamp that fails there is thrown in the handler's
place (`RouteLoginError`), so onError answers it with the CORS headers, as
the guard's failure was. The guard's own area check (`adminRouteGate`)
stays for the rows that still call it.

Batch 4, the Admin area rows: the handlers of the area rows (class area,
open to Admin users only: the settings, users, assistants, connectors and
keys routes), each with the standard two lines of an owner guard as its
first statement and no parameter with a default value: 243 handlers in 172
route files. 242 called `getOwnerOr401` and read `ownerCaller()`; `POST
/api/users/:id/password` called `getOwnerOr401WithSource` and reads
`ownerCallerWithSource()`. Each file was checked on main: nothing runs
before the guard. With their HEADs, 352 rows gain `caller: 'owner'` (646
rows carry it); no /api/v1 row re-exports one.

**The owner's decision (2026-10-14).** `GET` and `HEAD
/api/updates/status` and `POST /api/updates/check` need the settings area
their rows name: their handlers read `ownerCaller()`. An Admin user
without the area gets 403 `area` (it got 200), a member 403 `member-login`
(the handler's 401), no login 401 (as before); an Admin user with it runs
on the system pool as every settings route does, and its forced check
writes the `api.write` audit row. `GET` and `HEAD /api/updates/check`, the
cached update banner, stay open to every Admin user: a named carve-out
(`ADMIN_OPEN_ROWS`, route-policy.ts) makes their rows the login's own
(`self`), in no area, and the handler keeps `getSessionUser` (the hand
batch). `app/api/updates/updates-owner-decision.test.ts` drives it through
the full pipeline.

The proof is the guard sweep. The two recorded files are byte for byte
except the lines of the three rows the owner decided, each now the answer
every settings row gives (answers already in the files); those 64 cells are
recorded as driven in `__snapshots__/a4-guard-sweep-owner-decision.txt`,
with a note. The moved snapshot holds 8297 cells (4037 after part 3) and
79 answers (56 after part 3). A step 5 refusal is logged as the pipeline's
entry, in the request slot, by the row's reader. The 23 new ones:

- an Admin user with the area let through (the anchor and an Admin user
  by cookie, an Admin user by device token, stamped once), on the system
  pool with the system reason `area` noted, for GET and for HEAD (no body);
- an Admin user without the area refused by step 5, 403 `area`, running as
  its login, no scope: one per area (users, assistants, settings,
  connectors, keys), for GET and for HEAD;
- `pipeline:ownerWithSource` on `POST /api/users/:id/password`: the anchor
  and an Admin user by cookie and by device token let through, an Admin
  user without the area refused, a member's 403 `member-login` by cookie
  and by device token, the 401.

A member on an area row gets the gate's 403 `member-login` and a credential
with no login its 401, answers part 1 already recorded. Each has the
status, headers, body, owner, actor and scope the guard gave.
`gate-caller.test.ts` pins the view on the caller, the refusal, the one
stamp, a failing stamp with CORS, and every credential's headers and CORS
on an area row through both paths.

Pins: guard calls 285 to 43, still a ceiling; files with a guard call 210
to 39; reads of the caller 186 to 432, in 128 to 303 files (187 and 129
once the counts saw the build route); live routes calling no guard 62 to
60 (the archive route counted, +1; the password route and the two update
route files, which called only guards the counts do not see, now read,
-3).

**Step 3b, what is left** (the sweep held equal after each, its moved
entries recorded):

5. Member, any-login, chat and Telegram routes: answer steps and readers
   of their own (`getMemberOr401`, `getLoginOr401`, `getChatLoginOr401`).
   The Telegram chat rows have their class (above); the OAuth callbacks
   their effect.
6. Hand cases: `oauth/authorize`, `auth/logout`, `auth/change-password`;
   the asset guards (`getOwnerForAsset`, `getReaderForAsset`,
   `getMemberForAsset`: among them the draw svg, the file bytes, the export
   of batch 2's rows and `GET /api/attachments/:id`);
   `getCookieUpgradeLoginOr401`; `lib/gone.ts` (the `/api/apps/members`
   and `/api/admin/space` 410 stubs, and the 37 of the area rows: the
   `/api/access/agents`, `client-report`, its ack and `tool-groups` level
   stubs, `/api/mcp-logins` and its tokens, the `/api/team-admin` clients,
   hub app, member chats, member items, needs-you, notify, requests and
   submissions stubs); `lib/workspaces.ts` (`POST
   /api/workspaces/:id/archive` among them); the public rows that read the
   login (whoami, logout, sso, pair, OAuth consent); the two turn routes
   with a flag check first; `POST /api/dev-tools/queue-approval` (a flag
   check first); `GET /api/updates/check` (`getSessionUser`, the owner's
   carve-out); `GET /api/apps/:id/frame`; `PATCH /api/pages/:id` with its
   v1 wrapper and `GET /api/v1/files/:id/download` with its base. Then
   `getOwnerOr401` goes and the count is 0 (A4 exit).

**The eight steps** of `enterCall`, in order (the pre-run slot between
steps 5 and 6):

1. **Resolve the caller** (`GateCaller`): its actor, how it came in, the
   credential's write switch, what its scope holds of Admin (`admin`: null
   is unscoped, a process; absent is unknown and fails an Admin step),
   the scope it runs in, its entry's create-home rule, and what the
   narrowers read.
2. **Bind the caller**: a frozen copy, deep enough for what the steps read
   (the Admin areas, the scope's workspaces, the facts' lists). The
   surface's own object is never frozen in place, and its later changes do
   not reach the call. `currentCaller()` reads it. Work the call starts and
   does not await (a detached promise, a timer) keeps the caller, as it
   keeps the actor.
3. **The declared policy** (`GatePolicy`: effect, Admin step, spends,
   creates, makes items, an actor of its own), from the source registered
   for the ref's kind; none is refused (`unclassified`). A job's reason is
   the gate's own source (`{ kind: 'job', name: reason }`,
   `system(reason)`). Then the actor and the scope are bound: the policy's
   actor if it names one (a public route that writes, a job), else the
   caller's, **either one read only for a read** (plan 4.1: the database
   knows the write mode, so a call declared a read cannot write an item; a
   read path's own writes stay the named `READ_PATH_WRITES`). A scope no
   call can run in (no workspace, or a malformed one: `turnScopeProblem`,
   the check `withTurnScope` runs; `withScope` asks the same check in its
   own words) is refused here, listing and calling alike (`no-scope`, in
   the words the owner MCP surface says today: one constant,
   `NO_SCOPE_ERROR`). That surface still lists its tools for a login in no
   workspace and refuses each call; A5 decides which when MCP lists
   through the gate.
4. **Narrow by surface**, in the fixed order `NARROWERS`: the credential's
   read-only switch (the gate's own), a key's areas, a key's or peer's
   risky tools, the member-app rule, spending on the owner's keys (MCP
   connections only: a workspace assistant's turn keeps the member turn
   ledger), the member turn caps. All but the gate's own register from
   `packages/tools/src/gate-narrowers.ts` (`registerNarrower`), the package
   every process that dispatches a tool loads; none adds a step. **Fail
   closed:** while any of them is not registered, `enterCall` and
   `gateCheck` throw `GateNotReadyError` before any step, and each process
   entry asks `ensureGateReady()` at boot (server/web, server/api, every
   worker through `workers/_runner.ts`, the stdio MCP server; pinned by
   `packages/tools/src/gate-boot.test.ts`). `ensureGateReady()` registers
   them and asserts: a missing one throws and stops the boot, not the first
   call (every routed HTTP request runs through the gate since A4 step 1). A surface where one does not apply registers
   an explicit no-op. Registering another function under a taken name, or
   another source for a taken kind, throws on purpose. The member-app rule
   fails closed too: a team-rules app run calls only an `app-tool` ref
   that carries what `memberAppToolVerdict` said for the call (pinned
   against it by `packages/tools/src/member-app-parity.test.ts`).
5. **The Admin step**: the Admin workspace, an Admin area, or a kind of the
   Admin workspace only.
   **The pre-run slot** (A5 step 3a), between steps 5 and 6, in
   enterCall only (never gateCheck: it reads the call's arguments): the
   checks of `PRE_RUN_CHECKS` in their fixed order, `item-precheck` then
   `key-shared-content`, registered from
   `packages/tools/src/gate-prerun.ts` (missing ones fail closed, as the
   narrowers). A refusal is the kind `item`, in the check's own words, and
   comes before the create home: a refused call never makes a private
   workspace.
6. **The create-home intent** (`createHomeIntent`,
   `packages/db/src/create-home.ts`), for the login's own actor and only
   when nothing around named a home. The entry's `CreateHomeRule` says the
   rest: its `ownWork`; a workspace it asks for on every call (an assistant
   turn: its own), else the call's own ask, read only when the policy
   creates; whether reads name a home; whether a refusal refuses or names
   none (soft); and a memo. The HTTP guard's rule and the assistant turn's
   are pinned against `createHomeFor` and `turnCreateHome`
   (`server/web/lib/auth/create-home-parity.test.ts`,
   `server/web/lib/auth/turn-gate-parity.test.ts`).
7. **Run.**
8. **Map** a refusal with the one mapper (`mapAccessError`,
   `packages/std/src/access-error.ts`): the HTTP status and body and the
   tool text, each as the surfaces answer today.

Listing equals calling: `gateCheck` is steps 3 to 5 without running, and a
tool list shows what it lets through. `@mantle/db` exports only `enterCall`,
`gateCheck`, `gateLists`, `currentCaller`, the two register functions and
the boot check `assertGateReady` (and the types): no surface runs a step
on its own.

The sources registered today: `tool` (a builtin called through dispatch,
by its handler ref: `packages/tools/src/tool-gate-policy.ts`, A5 step 3a),
`runtime-tool`, `sandbox-mcp-tool` and
`peer-tool` (`packages/tools/src/runtime-policy.ts`), `app-tool`
(`packages/tools/src/member-app-tools.ts`), and `mcp-tool`
(`packages/mcp-core/src/gate-policy.ts`: each tool's declared policy since
A5 step 2). Every narrower registers from
`packages/tools/src/gate-narrowers.ts`. `route`
(`server/web/lib/auth/route-policy.ts`, A4 step 1) reads the ROUTE_POLICY
row the ref carries.

## A policy on every builtin (A5 step 1)

Plan sections 8 and 23: what a built-in tool is, for every check that
asks, is declared once on its definition, `policy: ToolPolicy`
(`packages/tools/src/tool-policy.ts`), required on `BuiltinToolDef`: its
effect (read or write), what it spends, its Admin step (`any`, `admin`,
`admin-kind`, or an area, which may run whole on the system pool), the
kind it creates, what it reaches outside the database, the items its
write names (transitional, `items`: deleted per tool once the database's
edit check is on everywhere), its key area, its key and peer marks, the
recipe and run-item rules, whether a call lowers content to clients or
the public, and the team app rule. The definition's `readOnly` and
`spends` are accessors of the policy (`effect`, `startsModelWork`), never
set by hand. No behaviour changed.

The builtin registry is the policy table, and each `@mantle/tools`
access list is a view of it, with its name and type as before: the four
lists of `admin-gate.ts`, `CREATE_TOOL_SLUGS`, `ITEM_WRITE_TARGETS`,
`LOWERING_TOOL_SLUGS` (and `isLoweringCall`), `RECIPE_FORBIDDEN_SLUGS`,
`MEMBER_APP_REFUSED_SLUGS`, `BANNED_ITEM_TOOLS`,
`UNTRUSTED_CONTENT_TOOL_SLUGS`, the app data lists, and
`HEARTBEAT_EGRESS_SLUGS` (`packages/runtime/src/heartbeats/fire.ts`); the
app tools' author ceiling reads each tool's own policy. Two views keep
names that are not builtins, named where the view is: the two
hand-written responder MCP tools (until step 2: now the MCP surface's own
definitions) and three team tool names of the system manifest. A view is read live, so a builtin registered at
boot (the heartbeat tools) is in it, and it throws
(`PolicyTableNotLoadedError`) when read before the registry loaded, never
answering from an empty table.

Proof: `packages/runtime/src/tool-policy-snapshot.test.ts` holds every
list's literal value, committed before the policies existed, and each view
equals it; `packages/mcp-core/src/tool-policy-sweep.test.ts` pins that
`toGatePolicy` of every builtin's policy equals the `mcp-tool` policy the
gate gets today, and that the owner MCP surface's own lists agree with
the policy (step 2 derives them). A builtin row named with another
builtin's slug does not run (`builtinRowSlugError`, in dispatch): some
checks still match a row's slug as well as its builtin ref.

## The MCP tools are definitions (A5 step 2)

Plan section 23.3, step 2, no behaviour change. The sixteen tools the
owner MCP surface writes itself (`tree_list`, `search`, the five file and
folder verbs, the page and table reads, the four responder tools) are
definitions in one table, `packages/mcp-core/src/mcp-defs.ts`: each with
a required `ToolPolicy`, a group (its place in the surface's order) and
its body, moved as it was. `register/*.ts` register a group from the
table, and the builtin bridge skips a builtin a definition names, so the
page and table skip lists are gone. Eleven share a builtin's name and
carry that builtin's policy (`packages/mcp-core/src/mcp-defs.test.ts`).
Each definition takes its policy by its name from
`packages/tools/src/mcp-surface-policies.ts` (fix round 1, below), the
surface table `@mantle/tools` loads in every process, where
`ADMIN_ONLY_TOOL_SLUGS` reads the two responder writes. Registration
opt-ins are a builtin definition field, `optIn: 'toolsmithWrite' |
'terminal'`, on the Toolsmith writes and `run_terminal`; a hand-written
definition declares none (A5 step 3a, LOW-A: one copy decides), and the
family sweep holds every tool that opts in to `peerRisky` (LOW-B).

The owner MCP surface's lists are views of the builtin policy table and
the definitions (`packages/mcp-core/src/mcp-policy.ts`, `mcpPolicySet`),
under their names: `ADMIN_KIND_CREATE_TOOL_SLUGS`, `LIST_TOOLS`,
`KEY_SHARED_CONTENT_TOOLS`, `MCP_HANDWRITTEN_READ_ONLY`,
`TOOLSMITH_WRITE_SLUGS`, and the policy's whole answer for
`PEER_RISKY_TOOL_SLUGS` (`peerRisky`) and `OWNER_KEY_SPENDING_TOOLS`
(`spends: 'ownerKey'`), each of which used to name some tools while rules
named the rest. `isPeerRiskyTool`, `isMcpToolReadOnly`, `spendsOwnerKeys`
and `toolKeyArea` read the policy (`mcpToolPolicyOf`); a name no table
holds (a connector's tool, `mcp_*`, or no tool) is answered by its family,
as before (`familyKeyArea` in `packages/mcp-core/src/key-scope.ts`, which
stays a leaf, and the risky families). The audit of a key's MCP write
reads the policy's effect (`server/web/lib/mcp-auth.ts`).

The gate's `mcp-tool` policy is the declared one (`toGatePolicy`), with no
`handWritten` mark on the ref. The peer side channel is gone
(`registerPeerToolRule`, `PEER_TOOL_RULE`): the `peer` narrower reads the
policy's `fields.peerRisky` and effect. A tool whose policy declares no
peer mark is refused for a key or a peer, whatever the owner named (fail
closed). A connector's policy declares itself not risky, and its `mark`
keeps it a write for a key or a peer until step 5 (owner decision Q1 b).

The bound caller's Sets are read-only views over a private Set (A3c audit
LOW-3): `Set.prototype.add.call` cannot reach them
(`packages/db/src/gate.test.ts`).

Proof: `packages/mcp-core/src/mcp-surface-snapshot.test.ts`, committed
before the change: tools/list over the real SDK (names, order,
descriptions, schemas with the `workspace` argument) for stdio and HTTP in
full and for every connection of the gate-policy matrix by hash, every
decision the surface's lists made per registered name and per probe name,
and the exported list values; the change left every file under
`packages/mcp-core/src/__snapshots__/` as it was.
`packages/mcp-core/src/tool-policy-sweep.test.ts` pins the new `peer`
narrower against `ownerPeerAllows` for every registered tool, two
connector rows and every key and peer caller.

### Fix round 1 (audit 8.5)

- **The family safety net (MEDIUM-1).** Before step 2 a tool was risky
  for a key or a peer by its family whatever it declared (a `web_`,
  `telegram_`, `sandbox_` or `peer_` name, an `app_` write, a tool that
  starts model work or waits for the owner's confirm), and a `_from_`
  tool had no key area whatever it declared (M2 audit F2). Since step 2
  the policy decides, so a tool that forgot `peerRisky` would be open to
  keys and peers with Write on. `packages/mcp-core/src/tool-policy-sweep.test.ts`
  ("every declared tool keeps its family") holds every builtin and every
  MCP definition to its family: risky by those rules means `peerRisky`;
  a family of `AREA_PREFIXES` means that area (an `app_data_` tool its
  own, `app_data`); a `_from_` tool means no area. It reads the kept
  `PEER_RISKY_TOOL_PREFIXES` and `AREA_PREFIXES` (now exported from
  `key-scope.ts`), not a copy, and a case in it fails when one tool's
  `peerRisky` flips or a conversion declares an area.
- **The responder policies in every process (LOW-1).** The sixteen
  policies moved to the leaf `packages/tools/src/mcp-surface-policies.ts`
  (type imports only); `tool-policy.ts` loads it as the surface table at
  module load, and `mcp-defs.ts` takes each definition's policy from it
  by name (a name with no policy does not type-check). So
  `ADMIN_ONLY_TOOL_SLUGS` holds `responder_turn_input` and
  `responder_turn_record` in server/api too, as before A5:
  `packages/runtime/src/tool-policy-snapshot.test.ts` is back to its
  literal from before step 2, and `packages/tools/src/gate-boot.test.ts`
  pins it with no mcp-core loaded. `loadSurfaceTools`,
  `surfaceToolsLoaded`, `surfaceTool` and `SurfaceTableNotLoadedError`
  are gone (the nit: the two exports only tests used).
- **Views of the definitions are read only (LOW-2).** `mcpDefinitionSet`
  returns `@mantle/db`'s `readOnlySetView` (the bound caller's view,
  LOW-3 above), not a frozen Set, so `Set.prototype.add.call` throws
  (`packages/mcp-core/src/mcp-defs.test.ts`).
- **A sweep case renamed (LOW-3).** "toGatePolicy equals today's gate
  policy" compared `toGatePolicy` with itself since step 2. It is now
  "the gate's mcp-tool source reads each builtin's and definition's
  declared policy": the wiring only; the values from before step 2 are
  the snapshot's.

**Owner decisions.** `PEER_RISKY_TOOL_PREFIXES` and `AREA_PREFIXES` stay
until A5 step 4, with the family sweep above (both are kept past step 4:
they answer a name no policy table holds, a connector's tool or no tool). The responder-names gap is
closed by LOW-1.

**Must do in A5 step 3a or 4 (LOW-4).** In a process without mcp-core a
connector's tool is now declared not risky (`connectorToolPolicy`); before
step 2 the peer narrower there refused it for a key or a peer unless the
owner named it (fail closed). Not live today: no tool ref reaches the gate
in such a process yet. Before one does, either declare a connector risky
on its row or keep the old fail closed answer there, with a test in
`packages/tools/src/gate-boot.test.ts`.

**Noted, not changed.** The `@mantle/tools` views (`PolicySlugSet`,
`PolicySlugMap` in `tool-policy.ts`) extend Set and Map, so
`Set.prototype.add.call` reaches their storage until the table next
changes; the same fix as LOW-2 fits them in step 4.

## Dispatch through the gate (A5 step 3a)

Plan section 23.3, step 3a, no behaviour change. `dispatchTool`
(`packages/tools/src/dispatch.ts`) runs a call through `enterCall` when its
entry names its caller (`ToolHandlerContext.caller`,
`packages/tools/src/gate-callers.ts`): the assistant turn (`turnCaller`,
`packages/runtime/src/agent/tool-loop/execute-call.ts`: the web and
Telegram turns, heartbeats, invoke_agent's child, the run workflows'
turns), a run item (`runCaller`, `server/web/lib/runs/execute-item.ts`)
and a pending approval (`pendingCaller`, `packages/tools/src/pending.ts`).
A nested call (a recipe's step, the Toolsmith's `recipe_tool_test` and
`api_tool_test`) passes its caller on, and one with none in its context
reuses the caller of the dispatch it runs in (`currentToolCaller`).
`ownerWebCaller` is for the dev console (step 3b). The entries that name
none yet run dispatch's own checks as before (`dispatchUngated`): the app
tool brokers and the dev console (step 3b) and the owner MCP surface's
connector rows (step 4). `packages/tools/src/dispatch-entries.test.ts`
sweeps every call site: each passes a caller but those, listed with the
step that moves them. It sweeps the direct calls of a builtin's handler
too (`def.handler(...)`, getBuiltinHandler), which skip dispatch and the
gate: dispatch's own and the app tools' author-ceiling wrapper only, and
two entries until step 4, the /api/v1 builtin routes
(`server/web/lib/api-v1-builtin.ts`) and the owner MCP surface's builtins
(`packages/mcp-core/src/register/context.ts`). A new direct call fails
there (low round, LOW-3).

- **The ref.** A builtin is `{ kind: 'tool', name: <handler ref>, slug }`:
  its declared policy (`toGatePolicy`) with the Admin step `adminToolGate`
  asked (`packages/tools/src/tool-gate-policy.ts`: an area by slug or ref,
  else adminOnly by `isAdminOnlyTool`, else none), so gate step 5 refuses
  what dispatch refused, in its words. A create of an Admin-only kind is
  not refused there (the `mcp-tool` source's `admin-kind`): on a turn the
  database refuses that row, as before. A runtime row is
  `{ kind: 'runtime-tool', row }`; step 3 refuses one with no policy, in
  `NO_RUNTIME_POLICY_ERROR`'s words.
- **The caller.** Built per call from the state the entry set already: the
  actor bound now (none is a bug, logged once: the call runs with no actor,
  as before, so the actor check refuses its item writes; `GateCaller.actor`
  is null and enterCall binds none: low round, LOW-2), the Admin view the
  policy's Admin step reads (`scopeHoldsAdmin` and the asked area in a
  workspace scope; the login's own areas in the rollback switch's gate
  scope; unscoped outside any), read only when the policy names a step and
  on every call, as adminToolGate read it, so an area turned off mid-turn
  refuses the turn's next call (only `scopeHoldsAdmin` keeps its answer per
  scope, as before: low round, LOW-1), and the create-home rule
  of an assistant scope that names its login (the turn rule) for a builtin
  only: a runtime row names no home (`createHome: null`), so a recipe's
  steps each name their own. It sets no scope: the turn, the run and the
  request entered theirs (no double scope entry).
- **The steps that moved.** `adminToolGate` is step 5, the runtime policy
  check step 3, `turnCreateHome` step 6 with the turn rule. The
  preconditions and `toolItemWriteRefusal` are the `item-precheck` check,
  before the create home: a refused call makes no private workspace (owner
  decision, section 22). An `AREA_SYSTEM_TOOLS` tool still runs whole on
  the system pool after its area check (`runGated`), in a workspace scope.
- **The MCP-only steps, dormant until step 4.** Keyed on `caller.via`:
  confirm stripping and the `key-shared-content` check for a key or a peer
  (`packages/tools/src/key-shared-content.ts`, the one copy the MCP bridge
  reads too; `othersCanRead` moved to `packages/tools/src/shared-item.ts`,
  and `@mantle/mcp-core/shared-item` re-exports it), and the one masking of
  a database error's text for an MCP via (`maskToolDatabaseErrors`,
  `packages/tools/src/tool-error-mask.ts`), which the tool loop's masking
  calls too.
- **A read runs read only.** `callActor` gives a read tool login(ro), and
  system work it starts stays read only (`systemUnder`). The database
  refuses only a change of an item table (0280), so
  `packages/tools/src/read-tool-writes.test.ts` pins every write the sweep
  found in a read tool: the app data reads' provisioning of
  `app_databases` runs only on a login's own MCP connection (A5 step 4
  must name or move it); every other write is to a table that is no item
  table (`sandbox_mcp_tools`'s last-used touch on `sandboxes`, the app
  access log, a peer's last contact, embed's cache (`embedding_cache`),
  failover stamp (`embedding_config`) and outage alert
  (`provider_alerts`), a worker's usage, an API key's last use, a tool
  result's chunked flag and chunks) and runs as before; the page block ids
  and the Recall prompt embeddings were named read-path writes already.
  The test classifies every read builtin of the policy table, so one added
  without a look at its writes fails there (low round, LOW-4). The peer
  reads' last-contact stamp (`markPeerContacted`) is best-effort since the
  low round, as `verifyInboundToken`'s last-seen stamp: a refused write is
  skipped, never a failed peer call. `read_result`'s chunking still fails
  the call when it fails (non-item tables, so a read-only actor is not the
  cause).
- **Inside a read tool the actor is narrower.** login(owner) (a heartbeat
  with no answering login) runs a read as login(ro), so the two readers of
  the owner mode answer differently there: `scopeLacksAdmin`
  (`packages/db/src/scope-readable.ts`), outside an active scope, says the
  caller lacks Admin, and `scopeActor` (`packages/db/src/viewer.ts`), for a
  scope that names no login, binds assistant(none) instead of the owner.
  An assistant or a peer actor is not narrowed (`readOnlyActor` and
  `systemUnder`'s `narrowsSystemWork` leave them: an assistant does its own
  system work), so `asSystem` inside a read tool under one writes. Today
  that reaches no Admin-area read: a workspace assistant's scope holds no
  Admin, so the Admin step refuses every Admin-area read (each
  `AREA_SYSTEM_TOOLS` read among them) before it runs, and no gated entry
  of step 3a binds a peer. `packages/tools/src/gate-callers.test.ts` pins
  both (low round, LOW-5). So `sandbox_mcp_tools` stays a read and its touch stays
  as it is (prerequisite 0a: marking it a write would hide it from a
  read-only connection; naming the touch would pin a write nothing
  refuses).
- **LOW-4 kept.** In a process without the owner MCP surface (no
  `mcp-tool` source: server/api), a connector's tool is risky for a key or
  a peer unless the owner named it, as before A5 step 2 (`hasPolicySource`,
  read by the `peer` narrower; `packages/tools/src/gate-boot.test.ts`).
- **Carried LOWs.** LOW-A: a hand-written MCP definition declares no
  `optIn`; LOW-B: the family sweep holds an opt-in to `peerRisky`.

Proof: `packages/tools/src/dispatch-parity.test.ts`, committed on main
before the change: every builtin and every runtime row type, for an owner
turn, a member turn, an Admin turn without an area, a turn on the rollback
switch, a run item, a pending approval, work outside any scope and a recipe
step, with no input, its item targets, a failing precondition and a
throwing handler; one hash per tool of the answer (the `{ok:false,error}`
text), whether the handler ran, its create home, whether it ran whole on
the system pool, the trace meta and the create-home intents. The pending
rows and the run item rows are written from that answer. The change left
`packages/tools/src/__snapshots__/dispatch-parity.json` as it was; a third
case there holds every builtin's call to the gate's caller and a read to
write mode `ro`. `server/web/lib/auth/turn-gate-parity.test.ts` runs
dispatch itself: its Admin refusals equal `adminToolGate`'s for every
builtin and scope, and its create homes `turnCreateHome`'s, call by call.

**Known edge, accepted (owner Q2).** A pending call approved from inside an
assistant turn (the Admin assistant's `pending_approve`) whose queued login
is another login: before step 3a the call named the approving turn's home;
now step 6 names none (the call runs as the queued login, not the turn's).
The outer `pending_approve` call's home, when it named one, stays in force
and decides; with none, the database's default home applies, and
`mantle_default_home` names only the asked workspace (`mantle.create_ws`),
the private one (`mantle.private_ws`), the folder the item is made in, or
the Admin workspace: never a non-Admin workspace the call did not ask for.
`packages/tools/src/gate-callers.test.ts` pins both.

**Step 4 must-dos** (from the step 3a audit and its low round), done in
step 4 (below): the app data reads' provisioning is a named read-path
write; the direct handler entries and the connector rows dispatch through
the gate (`DIRECT_HANDLER_YET` is empty). The one item table write a read
tool makes is proven on a real database
(`server/web/server/a5-app-data-read-only.db.test.ts`); the guard of every
other read tool is still a source classification
(`read-tool-writes.test.ts`): running each read builtin read only with the
edit check on needs a fixture per tool, carried to the A8 matrix.

## MCP registers through the gate (A5 step 4)

Plan section 23.3, step 4. One function registers every tool of the owner
MCP surface, `registerGatedTool` (`packages/mcp-core/src/gated-tools.ts`):
a builtin, a hand-written definition (`mcp-defs.ts`) and a connector row
of the login's workspaces. A tool is listed only when
`gateLists(caller, ref)` is true, by the ref it is called by: a builtin's
`mcp-tool` ref names the builtin it runs (`mcpBuiltinToolRef`), a
definition's its own name, a connector's `runtime-tool` ref its row. A call
runs through `enterCall`: a builtin and a connector row through
dispatch's gated path with the MCP caller (`mcpToolCaller`,
`packages/tools/src/gate-callers.ts`), a definition's body directly. It
replaces `filteredServer`, `ownerScopedServer` and `runInOwnerMcpScope`
(owner-scope.ts is gone), `createHomeServer`, `callBuiltin`'s own checks,
the catch in `addTool`, `preparedAllows`, the connector filter of
`prepareCallerTools` and the write check of `callConnectorTool`.

- **The caller.** An HTTP connection's is `mcpGateCaller(prepared)`
  (`packages/mcp-core/src/gate-policy.ts`): login(rw), or login(ro) for a
  read-only connection, the Admin view the listing read, the key's areas
  and the risky tools named, its scope entry and its create home rule. One
  request lists and calls, so each call runs as the listing read it. stdio
  is `defaultMcpGate`: login(owner), via `stdio` (no narrower applies; the
  one masking does), every tool listed as before, and each call's Admin
  view read in the scope at the call (`mcpAdminView`, the reads
  adminToolGate made).
- **The scope entry** is the caller's `enterScope`
  (`packages/mcp-core/src/mcp-scope.ts`): the login's scope per call, as a
  turn scope that writes; refused on a brain not on workspaces unless an
  Admin user; refused for a login in no workspace; the rollback switch's
  gate scope for an Admin user that holds Admin now. Inside it the actor
  is the gate's: a read tool runs as login(ro), so its system work stays
  read only.
- **Every HTTP MCP call runs as the login** (fix round 1, M2), not only on
  the rollback switch: the gate's `callActor` (`gate-policy.ts`
  `mcpGateCaller`) gives a write tool login(rw) and a read tool login(ro),
  where before step 4 every call ran as the request's
  system(http:no-login). Inside the login's turn scope (`withTurnScope`,
  writes on) a write goes to the write role, with the per-table edit check
  where the box's actor check is on (dev), and a read's system work stays
  read only (`systemUnder`). On the rollback switch the call runs as the
  login on the system pool, under the gate scope. The owner's decision
  (fix round 1): the rollback switch keeps MCP running as the login
  (option a); it restores only the old read path, never the old actor.
  `server/web/server/a5-mcp-writes-smoke.db.test.ts` proves it on a real
  database with the actor check and the edit check on, through
  `registerPreparedTools`: for an Admin OAuth rw login and a member rw
  login granted Write, a builtin create and write (`note_create`,
  `note_update`), the definitions (`folder_rename`, `folder_describe`,
  `file_rename`), `responder_turn_record` (the Admin user), a connector's
  write row (the member, a Moderator of the connector's workspace), and the
  reads that write on the side as login(ro): `read_result` in query mode
  (its chunks), `page_get` on a page with no block ids (the backfill),
  `recall_match` (a prompt's missing vector) and `app_data_query`. The same
  file run on main (v0.300.32) gives the same outcome for every call: no
  MCP write changed outcome. A member's folder rename with Write but not
  manage is refused on both (the subtree rewrite asks manage, 0282); its
  reply carried the SQL and its params on both, and now reads the one
  mapper's words (`mcp-defs.ts` folder_rename and file_rename). A peer read
  is not run (it needs a second brain; its last-contact stamp is
  best-effort).
- **The create home** is gate step 6 with the MCP rule
  (`mcpCreateHomeRule`): the fallback the connection resolved
  (`createFallback`), `first` (step 6 runs before the pre-run checks: it
  makes nothing at call time, and a create's `workspace` argument is
  refused before the item it names, as before: page_split,
  page_extract_section and app_duplicate answer in today's order),
  `namedOnly` (a home that names no place is not set), `reads` for a login
  with a private workspace (every call under it) and `refuseCreates`
  (`NO_WORKSPACE_CREATE_ERROR`) for one outside Admin with none, whose
  creates advertise no `workspace` argument, as before.
- **The pre-run slot** takes the caller's own check first
  (`GateCaller.preRun`, `packages/db/src/gate.ts`): the key email guard's
  `before` for a key without Search, a connector row's workspace check and
  its `mcp.connector.*` audit row. Then the item pre-check (a builtin's
  preconditions and item targets; an `mcp-tool` ref that names a builtin
  reads them, a hand-written tool checks its own) and the key shared
  content check. The guard's list filter and the create's `landedIn` run
  after the call, in the call's scope.
- **The MCP-only steps are live** for an MCP via (oauth, key, peer,
  stdio): confirm stripping for a key or a peer (a builtin only: a
  connector row takes the arguments its schema lists), the key shared
  content check, the one masking of a database error's text
  (`maskToolDatabaseErrors`) and, for an error the call throws, the
  surface's own answer: a database error in the one mapper's words
  (`thrownToolDatabaseError`), any other by the SDK, a connector row's own
  error as its reply text. Dispatch throws on for an MCP call
  (`itemPrecheck` too) instead of reading the error as the call's text.
- **Nested calls** (a recipe's steps, the Toolsmith's tests, `search`
  running search_nodes) reuse the connection's caller less the call's own
  parts (`nestedToolCaller`: its ask, its pre-run check, the refusal of
  its creates). Before step 4 a call nested in an MCP call ran dispatch's
  own checks.
- **The /api/v1 builtin routes** (`server/web/lib/api-v1-builtin.ts`) run
  their builtin through dispatch as `apiV1Caller()` (via `process`: the
  request's own gate judged the key), so the gate's item pre-check runs
  for them too. An error the handler or a pre-run check throws goes on to
  `app.onError` (`server/web/server/app-error.ts`), as before the route ran
  through dispatch (fix round 1, M1): an edit check refusal its 403 or 404,
  a database or any other error the opaque 500, never a 400 that reads the
  error's text. A refusal (the tool's, a gate step's) stays the tool's 400
  (`server/web/lib/api-v1-builtin.test.ts`). One answer is new and stays:
  an item the owner's scope reads but may not change is refused by the item
  pre-check in its words (400), where the handler's write met the edit
  check's 403 before.
- **A definition's call names its ask and its owner** (fix round 1,
  LOW-1): the gate gets a create's `workspace` argument and the owner the
  pre-run checks read, as a builtin's call does; no definition creates or
  changes shared content today (`packages/mcp-core/src/gated-tools.test.ts`).
- **The app data reads' provisioning** (`app_data_schema`,
  `app_data_query`: the registry row, its schema, the viewer salt in
  `app_databases`) is a named read-path write, `repair:app-db`: only the
  provisioning, never the caller's SQL (fix round 1, LOW-4: the app
  broker's `provision` wrapper)
  (`packages/tools/src/builtins-app-data.readpath.test.ts` pins both actors
  under a read-only login; `server/web/server/a5-app-data-read-only.db.test.ts`
  runs both reads on a member's read-only OAuth connection with the actor
  and edit checks on, an app nobody used yet, and the same provisioning
  without the name refused `ro_actor`).
- **Tests of the scope and the Admin step** call `runMcpCall(login, tool,
fn)` (gate-policy.ts), where they called `runInOwnerMcpScope`.

Proof: `packages/mcp-core/src/mcp-call-snapshot.test.ts`, committed before
the change: over the real SDK, for stdio and each kind of connection (an
Admin user, the rollback switch, a brain not on workspaces, a member with
and without a private workspace, read only, a key without Search, peers, a
login in no workspace), the instructions, tools/list and per call the
reply (each block, isError, the `Error: ` prefix), what the handler saw
(its input, surface and create home), `landedIn`, the image blocks, the
connector's remote call and the audit rows. The change left it and every
step 2 snapshot (`tools-list.*.json`, `surface-*.json`) as they were.
`gate-policy.test.ts` pins that the registered list is exactly the gate's
listing for every tool and connection, `packages/db/src/gate.test.ts` the
new rule fields and `preRun`, `packages/tools/src/dispatch-mcp.test.ts` the
MCP caller in dispatch.

**A login in no workspace lists no tools** (owner decision A, plan 23.5;
its own commit): the connection's caller names the scope it read
(`prepared.scope`), and the gate's scope step holds a caller that names
its scope to it even when the caller enters its own (`scopeStep`), so
tools/list is empty and every call is an unknown tool. The server
instructions say why (`MCP_NO_WORKSPACE_INSTRUCTIONS`: the no-scope words,
then that the connection lists no tools). A login that loses its last
workspace mid-session lists nothing on its next request, so its next call
is the SDK's "Tool X not found", not the no-workspace words. Before, such a login listed
every tool and each call was refused with the same words. Only those cells
of the snapshot changed (`login-surface.test.ts` pins it).

Two answers changed on purpose, outside a refusal's text: a key's
`api.write` audit row is written only for a tool its connection lists
(`preparedLists`), where a name the surface never had could leave one; and
the actor of a call, as above.

## The owner's behaviour changes (A5 step 5)

Plan section 23.3, step 5, and the owner's answers b b b (section 22). Each
change below is its own commit with its own test.

**Carried LOWs from the step 4 re-audit** (no behaviour change for a
masked caller):

- **LOW-C.** The row tools (`packages/tools/src/tables/rows.ts`) answer a
  database error that `applyTableOps` throws (a deadlock, a lock timeout)
  in the one mapper's words (`publicErrorMessage`), for every caller; an
  error that is not the database's keeps its text. Before, the /api/v1
  rows routes, which run no masking of their own, answered its "Failed
  query ... params" as their 400 body
  (`packages/tools/src/builtins-tables-rows-db-error.test.ts`).
