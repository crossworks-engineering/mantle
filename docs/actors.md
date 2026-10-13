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
  workspace. `resolveCreateHome` notes each login's private workspace as it
  reads it on the system pool; the gateway adds it to the write scope (as a
  workspace and a Moderator one) when the write's create home lands there.
  No query on the write's path.
- **Tables the role has no right on.** A typed write (`db.insert(table)`)
  or a single raw write to a table outside `WRITE_ROLE_TABLES` goes to the
  system pool before it is sent. Inside a transaction a table of
  `WRITE_ROLE_GAP_TABLES` (`access-matrix.ts`: `node_snapshots`, the Recall
  tables, `shares`, `secrets`, `app_table_exports`, `profiles`) is a "gap":
  a statement whose target is one is never sent, and Postgres's own
  `permission denied for table <t>` for one counts too. The transaction
  rolls back whole (a gap the caller caught in a savepoint as well) and runs
  once more: in warn on the system pool, as before A2b2b; in on **checked**,
  on the system pool with `SET LOCAL ROLE mantle_write_user` and the same
  scope, every statement as the write role (its row rules and write checks)
  except a write to a gap table or a read that names one, which runs as the
  system between `set local role none` and the role set back. So in on no
  item write leaves the role's checks through a rerun; a statement that
  needs a gap table and is neither fails. Each gap is logged as an actor
  miss (`write-role-gap`). ONE rule decides it, `writeRoleGapTable`, used
  by the gateway and by `vitest.setup.ts` (the suite fails on any other
  denial). Any other denial, a column, a function, a sequence, a table off
  the list, is a bug and stays an error (a 500). A refusal the database
  decided (a check, a row rule) never runs again. The rerun needs a system
  login that may SET ROLE to the write role (a superuser, as on every box
  today); one that may not fails loudly in on.
- **Running a gap's flow twice is safe** (audit, 2026-10-13): of the flows
  that meet one (app publish, restore, delete, snapshots, table snapshots,
  Recall maps, contact share links, `secret_create`, the profile row), none
  sends a job, a fetch, a model call or a message inside the transaction;
  the app and table snapshots copy a file to a fresh path and delete the
  copy when the transaction fails, so the first attempt leaves nothing; a
  `withSystemTx`'s commit hooks of the failed attempt are dropped, its
  rollback hooks run. The cost: each such flow runs twice while its table
  is a gap (A3a moves them).
- **The visibility confirm reads in the write's own transaction.**
  (`packages/content/src/tree/visibility.ts`) It names every workspace a
  change reaches, those the caller is not in too. What a scoped read
  cannot see goes through definers of 0279, held to the scope: a
  destination folder's grant rows (`mantle_folder_grant_rows`, only for a
  folder the scope reads) and the workspaces (`mantle_ws_names`,
  `mantle_ws_live`, `mantle_ws_admin_id`; a name only of a workspace in the
  scope, one with a grant on an item the scope reads, or any for an Admin
  scope). No second connection, and the transaction's own changes count.
- **Writes inside an open write transaction join it.** A login's write
  (a top-level `db.insert`, `executeWrite`, a `withSystemTx`) made while
  its own write transaction is open in the same request, with the same
  actor, scope and create home, runs in that transaction as a savepoint,
  never on a second connection (3 per process: three such requests at once
  waited on each other for ever). A statement gets its own savepoint (it
  fails alone, as on its own connection); a joined `withSystemTx`'s hooks
  run when the outer transaction ends. So in warn and on such a write
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
  `mantle_workspace_event`: a workspace of the scope, or a grant on an item
  whose home the scope manages) are exercised only by the direct-SQL cells
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
  in A3a (below).
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
  login's private workspace, read by `resolveCreateHome` (above).
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
  workspace comes from `resolveCreateHome`. L5: `mantle_workspace_event`
  is held to the scope. L6: a gap caught in a savepoint still runs the
  transaction again and is logged.
- **The system-only content tables** stay on the system pool: by table up
  front for a single write, by a logged gap for a transaction
  (`WRITE_ROLE_GAP_TABLES`).
- **The raised max_connections.** `connection-ceiling.test.ts` (2026-10-13,
  A2b2b): 345 of 405 on the full shape (the write role 6), 305 with
  `MANTLE_RUNS` off, 181 on the core shape.

## A3a must

- **The ro refusal.** An assistant with no user and a public link write
  nothing (plan 4.1); a write with `mantle.write_mode = ro` is refused in
  A3a, not before.
- **Tables that stay on the system pool until A3a:** `recall_maps`,
  `recall_nodes`, `shares` and `node_snapshots`. They are not `content`
  tables in `ACCESS_MATRIX`; A3a adds their checks and then moves them.
- **The heads locks filter by the scope.** In `mantle_lock_heads` and its
  siblings, when the caller is not the owner role, drop the ids whose
  `read_ws && mantle_scope_ws()` is false.
