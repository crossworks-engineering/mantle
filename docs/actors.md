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
limits). The protection is the lint, the runtime role (A9,
[runtime-role.md](runtime-role.md): not the owner, so it cannot disable the
check's triggers or change the box mode, and it cannot run the setter
functions either) and the read rule on the write role.

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
timeout-loop server/web/lib/push/login-notice-handler.ts system(worker:push-notify), carried by the batching timer
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

## Request plumbing (A10 part 2, A10 #8, A10 #9)

How a route reads its body (one reader, capped at the route's ceiling by
the loader), how an error becomes its answer, its rate limits, and the one
app tool broker (`server/web/lib/app-tool-broker.ts`, whose configs are the
owner route, a member's run and the link route; the app DB write path that
schedules the export sync):
[request-plumbing.md](request-plumbing.md), with the sweep that proves each
move and the pins that hold it.

The gate's order on a routed request, since A10 #8: the row's switch (its
off answer), the login found once, `enterCall` (the key and Admin steps),
the caller's answer (`answerRouteCaller`), then what the row checks before
its handler (`beforeHandler`, `server/web/server/middleware/gate.ts`): the
cross-site refusal of a public auth post (RouteRow `crossSite`) and the
row's rate limits (RouteRow `rateLimit`, named in
`server/web/lib/route-limits.ts`), answered with the one 429. A public row
that reads its login at the read takes a login's limit at that read
(`publicLoginCaller`). Then the handler.

## Kind lists (A10 #12)

The kind registry (`ITEM_KINDS`, `packages/client-types/src/kinds.ts`, A1)
names every `node_type` value once. Before A10 #12 about ten lists of kinds
were written by hand beside it, and three disagreed with it; now each list
is a filter over one registry field, derived in
`packages/client-types/src/kind-lists.ts` (the `@mantle/client-types/kind-lists`
subpath, additive to the published contract).

**The fields and the lists derived from them** (every list in registry
order; the code asks each one for membership only, except the rank):

| Field           | Means                                                   | Derived list                                        | Read by                                                                                                                  |
| --------------- | ------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `extract`       | the extractor reads it by default                       | `EXTRACT_KINDS`                                     | `DEFAULT_EXTRACT_TYPES` (`server/api/src/agent/extract/gates.ts`), `LANDED_TYPES` (`server/web/lib/integrity/landed.ts`) |
| `corpusMap`     | listed by title in the responder's corpus map           | `CORPUS_MAP_KINDS`                                  | `packages/runtime/src/agent/conversation.ts`                                                                             |
| `contextRef`    | the name a context ref uses (`branch` is `folder`)      | `CONTEXT_REF_KINDS`, `NODE_TYPE_BY_CONTEXT_REF`     | `CONTEXT_KINDS`, `NODE_TYPE_BY_KIND` (`packages/db/src/context-ref-resolve.ts`)                                          |
| `embeds`        | embeds other items (node_embeds)                        | `EMBEDDING_KINDS`                                   | `packages/content/src/embed-closure.ts`, `server/web/lib/maintenance/refold-embeds.ts`                                   |
| `mentionTarget` | a mention chip may name it                              | `MENTION_TARGET_KINDS`                              | `server/web/app/api/mentions/search/route.ts`                                                                            |
| `linkServes`    | its public link serves what it names or embeds          | `LINK_SERVE_KINDS`                                  | `packages/content/src/link-serve.ts`                                                                                     |
| `exportAs`      | default download format, or false                       | `EXPORT_FORMAT_BY_KIND`                             | `EXPORTABLE_TYPES`, `ExportKind` (`packages/content/src/export-node.ts`)                                                 |
| `accepted`      | an accepted item, with the rank that names a bundle     | `ACCEPTED_KINDS`, `acceptedRank`, `forAcceptedKind` | the four accepted item switches (below), `packages/content/src/login-notices.ts`                                         |
| `searchTool`    | a `type` of the search tools (searchable plus `secret`) | `SEARCH_TOOL_KINDS`                                 | `search_nodes` (`packages/tools/src/builtins-search.ts`), the MCP `search` (`packages/mcp-core/src/mcp-defs.ts`)         |
| `peerPick`      | offered by the linked brain grant picker                | `PEER_PICK_EXCLUDED_KINDS`                          | `server/web/app/api/peers/nodes/route.ts`                                                                                |
| `documentTitle` | its title names a document                              | `DOCUMENT_TITLE_KINDS`                              | `packages/content/src/entity-names.ts`                                                                                   |

**One switch over an accepted item.** The same 5-case switch (page, note,
table, draw, file) was copied four times: reading an accepted item back
(`packages/content/src/member-accepted.ts`), the Library item
(`packages/content/src/member-library.ts`), recording the snapshot on accept
(`packages/content/src/member-snapshots.ts`) and making an accepted copy
(`server/web/lib/snapshot-copies.ts`). Each now calls `forAcceptedKind(item,
cases)`, whose `cases` must have one entry per accepted kind: a kind that
turns `accepted` on fails to compile at all four until it has its case, and
a kind that is not accepted answers null.

**Inventory before the move** (main v0.300.46, file:line, what it meant):

- `server/api/src/agent/extract/gates.ts:101` DEFAULT_EXTRACT_TYPES (15): the
  extractor's default allowlist. Now `extract`.
- `server/web/lib/integrity/landed.ts:29` LANDED_TYPES (12): the integrity
  view's kinds. Now `extract` (the named fix below).
- `packages/runtime/src/agent/conversation.ts:224` CORPUS_MAP_TYPES (6). Now
  `corpusMap`.
- `packages/db/src/context-ref-resolve.ts:40` CONTEXT_KINDS (13) and `:88`
  NODE_TYPE_BY_KIND. Now `contextRef`.
- `packages/content/src/embed-closure.ts:22` EMBEDDING_KINDS (3) and
  `server/web/lib/maintenance/refold-embeds.ts:43` Kind and KINDS (3). Now
  `embeds`.
- `server/web/app/api/mentions/search/route.ts:32` (3): mention targets. Now
  `mentionTarget`.
- `packages/content/src/link-serve.ts:200` (5): kinds whose link serves
  their embeds. Now `linkServes`.
- `packages/content/src/export-node.ts:28` ExportKind and `:68`
  EXPORTABLE_TYPES (4). Now `exportAs`.
- `packages/content/src/login-notices.ts:201` TYPE_RANK (5, ordered). Now
  `accepted.rank`.
- The four switches: `member-accepted.ts:250`, `member-library.ts:180`,
  `member-snapshots.ts:176`, `snapshot-copies.ts:194`. Now `accepted` and
  `forAcceptedKind`.
- `packages/tools/src/builtins-search.ts:55` and
  `packages/mcp-core/src/mcp-defs.ts:174`: the search tools' `type` enums
  (17 each, two hand orders). Now `searchTool`.
- `server/web/app/api/peers/nodes/route.ts:11` EXCLUDED (3). Now `peerPick`.
- `packages/content/src/entity-names.ts:31` DOCUMENT_NODE_TYPES (3). Now
  `documentTitle`.
- `packages/db/src/schema/nodes.ts:21` the `node_type` enum itself: kept, the
  one named file (the SQL type the registry mirrors).

**Named changes** (`packages/client-types/src/kind-lists.test.ts` RECORDED
holds every list as main wrote it, proved against the source in the first
commit; CHANGES names each cell that moved):

- **Fixed:** LANDED_TYPES gains `email_thread`, `documentation` and
  `location`, the three kinds the extractor reads that the integrity view
  could not see. Visibility only: the view is read only, and the extract
  set is unchanged (no kind is extracted that was not before).
- **Order only:** the search tools' `type` enums list the same 17 kinds in
  registry order (the tool schema text changes, the accepted values do not).
  In the MCP `search` tool that is `page` moving after `telegram_message`:
  the tools/list snapshots (`packages/mcp-core/src/__snapshots__/tools-list.stdio.json`
  and its siblings) were re-recorded for that one line and the connection
  hashes that follow from it.

**Differences kept, now a field each:** the corpus map lists `app` (not
extracted) and leaves out mail, journal, events and contacts; the context
refs speak the client's vocabulary (`folder`); the search tools accept
`secret` where the search screen's filter (`searchable`) does not; the peer
picker offers any kind but folders, peer records and secrets, wider than the
category grants (`peerShare`); a bundle's naming rank puts tables before
drawings, unlike the Library order.

**Not lists, so not folded:** switches and maps that do a different thing
per kind keep their cases (journey wording in
`packages/client-types/src/journey-format.ts`, the share renderers in
`server/web/lib/shares.ts` and `server/web/server/pages/share.tsx`, derived
node buckets in `packages/content/src/derived.ts` and
`packages/files/src/derived-counts.ts`, kind icons in
`server/web/components/share/contact-shares-menu.tsx`, the scheme types in
`packages/content-core/src/markdown-refs.ts`), and the access oracle
(`packages/db/src/matrix/oracle.ts`) is written from the guide on purpose,
not from the registry.

**The pin.** `eslint-rules/no-hand-kind-lists.mjs` flags a literal list of
3 or more node types (an array, a Set's, a z.enum's, an inline
`[...].includes(`) in product code outside `KIND_LIST_ALLOW`
(`eslint-rules/arch-counts.mjs`). The scoreboard counts the same lists:
`handKindLists` pinned at 0, `handKindListsAllowed` at 1;
`eslint-rules/arch-lints.test.ts` holds the allowed files to exactly the
ones that still hold a list. Turning `extract` on for a kind is a cost
decision (its whole corpus is extracted), never a tidy-up.

**Left:** jackdaw's `CONTEXT_KINDS` (its assistant dock) is still a hand
copy; it can read `CONTEXT_REF_KINDS` from the contract once the ref rides
the wire as a structured block. `library` (and MEMBER_ITEM_KINDS) goes after
its pair release; `accepted` names the same kinds today (pinned).

## Role and area names (A10 #13)

The names that gate access are each written once, in the contract package
(`@mantle/client-types`, zero dependency, so the brain and the client read
the same list), and every type, zod enum, Set and membership test elsewhere
imports it. Each list is a non-empty `as const` tuple, so it is its own zod
enum (`z.enum(LOGIN_ROLES)`; the users routes share `LoginRoleSchema` in
`server/web/lib/login-update.ts`).

| Concept        | Source (list, type, guard)                                                                            | Read by                                                                                                                                                                                                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login roles    | `LOGIN_ROLES`, `LoginRole`, `isLoginRole` (`packages/client-types/src/role-names.ts`)                 | `LoginKind`, `ShellRole`, `AccessKeyRole`, `AuthWhoami.role` (contract); `auth.users.role` (`@mantle/db`); `McpLoginRole`, `McpDataRole`, `LoginMcpChannel.role`; the session, the bearer refresh, the password reset, OAuth consent, access keys, MCP auth, the users routes, workspaces |
| Admin areas    | `WORKSPACE_AREAS`, `WorkspaceArea`, `isWorkspaceArea` (`packages/client-types/src/dto/workspaces.ts`) | `SCOPE_AREAS` (`packages/db/src/viewer.ts`), `adminUserSql` (`packages/db/src/admin-user.ts`), the route classes (`server/web/lib/auth/route-scope.ts`), the shell's `areas`                                                                                                              |
| History actors | `HISTORY_ACTORS`, `HistoryActor` (`role-names.ts`)                                                    | `node_snapshots.actor`, `AppHistoryActor` (`packages/content/src/apps.ts`), `AppSnapshot.actor`, `TableSnapshot.actor`                                                                                                                                                                    |
| Recall actors  | `RECALL_ACTOR_KINDS`, `RecallActorKind` (`role-names.ts`)                                             | `RecallActor.kind` and the revisions list (`packages/content/src/recall-native.ts`), the recall wire types                                                                                                                                                                                |
| Access levels  | `ACCESS_LEVELS`, `AccessLevel` (`packages/client-types/src/dto/access.ts`, highest first)             | `VIEWER_LEVELS` (`packages/db/src/viewer.ts`): the same list reversed, lowest first, on purpose                                                                                                                                                                                           |
| Key areas      | `ACCESS_KEY_AREAS`, `AccessKeyArea` (`packages/client-types/src/dto/access-keys.ts`)                  | `KEY_AREAS` (`packages/mcp-core/src/key-scope.ts`), and through it the API v1 routes and the MCP key scope                                                                                                                                                                                |

The SQL CHECKs hold the same values: `users_role_ck` (migration 0272) and
`recall_revisions_actor_kind_ck` (0203); `role-names.test.ts` reads the
newest migration that adds each and pins it to the source.

**Inventory before the move** (main v0.300.47, file:line):

- Login roles, 28 copies of `LOGIN_ROLES` (`packages/db/src/schema/auth-users.ts:48`,
  imported nowhere): types `client-types` `dto/logins.ts:10`, `dto/shell.ts:13`,
  `dto/access-keys.ts:34`, `dto/workspaces.ts:219`; `content/src/mcp-app-data.ts:22`;
  `mcp-core/src/login-surface.ts:68`; `tools/src/types.ts:186`;
  `server/web/app/api/oauth/authorize/route.ts:94`; `server/web/lib/access-keys.ts:51`;
  `server/web/lib/auth/session.ts:893`, `:2179`, `:2290`; `server/web/lib/login-update.ts:45`;
  `server/web/lib/workspaces.ts:107`, `:956`; `db/src/test-support.ts:123`;
  `server/web/server/a4-guard-sweep.keys.ts:11`, `:44`. Lists and enums:
  `content/src/contacts.ts:274` (`inArray`), `token/refresh/route.ts:58` (Set),
  `users/route.ts:97` and `users/[id]/route.ts:22` (z.enum). Membership
  chains: `access-keys.ts:161` and `mcp-auth.ts:69` (`isRole`),
  `session.ts:2359`, `users/[id]/password/route.ts:51`, `login-update.ts:127`,
  `runtime/src/assistant/run-team-turn.ts:248`. Each is now `LoginRole`,
  `z.enum(LOGIN_ROLES)` or `isLoginRole`.
- Admin areas: `db/src/admin-user.ts:13` (type), `db/src/viewer.ts:619`
  (`SCOPE_AREAS`), `server/web/lib/auth/route-scope.ts:151` (Set).
- History actors: `client-types/src/dto/rows.ts:276`, `:304`,
  `content/src/apps.ts:979`, and the column comment
  `db/src/schema/node-snapshots.ts:55` (no source on main).
- Recall actors: `db/src/schema/recall.ts:183` (the list),
  `client-types/src/types/recall.ts:114`, `content/src/recall-native.ts:75`,
  `:1473`, `:1490`.
- Access levels: `db/src/viewer.ts:47` (`VIEWER_LEVELS`, reversed).
- Key areas: `mcp-core/src/key-scope.ts:16` (`KEY_AREAS`).

**No difference between copies.** `packages/client-types/src/role-names.test.ts`
RECORDED holds every copy as main wrote it, proved against the source text
in the first commit, and every copy already held its source's values (the
access levels in the reverse order, on purpose). The fold accepts the same
values in the same order: the same zod enums, the same Sets, the same SQL
parameters, the same membership tests.

**Not lists, so not folded:** the switches that do a different thing per
role keep their cases (`resolvedFor` in `server/web/lib/auth/session.ts`
names each role and answers no login for any other; the OAuth consent and
the audit switches). Unions with their own meaning that share some names
stay: `AppViewerKind` (`client-types/src/app-viewer.ts`) and
`AppViewerSubject` (`content/src/app-viewer.ts`) still carry `client`;
`NodeCommentAuthorKind`, `MemberItemAuthor.role`, `ExternalAccessRunner`;
the level subsets (`AppAuthorLevel` and its contract mirror, pinned in
`server/web/lib/client-types-drift.test.ts`; `AppToolRules`, `AppToolLevel`,
`TREE_SHARE_LEVELS`). Tests keep their literals (they pin values).

**The pins.** `eslint-rules/no-hand-role-lists.mjs` flags, in product code
outside a concept's source file, a literal list (an array, a Set's, a
z.enum's), a string union or a comparison chain (`r === 'admin' || r ===
'member'`) whose entries are all names of one concept (2 or more login roles
or recall actors, 3 or more areas, history actors or levels, all but one
key area). The names are read from the sources (`ROLE_NAME_SOURCES`,
`eslint-rules/arch-counts.mjs`). The scoreboard counts the same lists:
`handRoleLists` pinned at 0, `handRoleListsAllowed` at 6 (the six source
lists). `server/web/lib/client-types-drift.test.ts` pins every alias to its
source's union and the runtime VALUES of the lists both sides read (the
server lists equal the contract lists in order; the contract values are
written out, since jackdaw holds hand copies of some). A list in SQL text
inside TypeScript (`role in ('admin', 'member')` in
`packages/db/src/test-support.ts`) is not seen.

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

**HTTP, A4 step 3b part 5 (no answer changed).** The member, any-login
and chat answer steps, their readers, and the codemod's fifth batch.

- **The answer step** (`answerRouteCaller`, `server/web/lib/auth/session.ts`)
  runs the guard of the row's caller kind, once, in the request slot,
  before the handler: the owner guard (`getOwnerOr401WithLogin`) as
  before, and now the member guard (`getMemberOr401`), the any-login guard
  (`getLoginOr401`) and the chat guard (`getChatLoginOr401`). It is each
  guard's own function, so the two paths answer alike: the login named, a
  device token stamped once, the scope entered or the rule or system
  reason noted, the audit row each guard writes. A refusal is the gate's
  answer and the handler does not run; an error it throws is thrown in
  the handler's place, so onError answers it with the CORS headers, as
  before.
- **The readers**: `memberCaller()` (what `getMemberOr401` answers),
  `loginCaller()` (what `getLoginOr401` answers, the type `AnyLogin`) and
  `chatLoginCaller()` (what `getChatLoginOr401` answers, `ChatLogin`). Each
  projects the one answer the gate gave, with no lookup and no effect,
  and throws where the pipeline gave no answer of its kind (a row with no
  caller or another kind's, a nested call, outside a routed request), as
  `ownerCaller()` does.
- **The row** (`server/web/lib/auth/route-policy.ts`): `RouteCaller` is
  `owner`, `member`, `login` or `chat`, and a row carries a kind only
  where that kind's guard serves it (`CALLER_LOGINS`): the owner rows
  (self, content, area, open to Admin or to the owner lists), the member
  list, the any-login list, the chat and Telegram chat lists. Any other
  row fails to build, as do a public, link or render row, a page and a
  catch-all. The gate's Admin step stays the owner rows' (no other kind's
  row names an Admin area).
- **The generator** (`server/web/scripts/route-callers.ts`
  `handlerCallers`): the manifest's `reads` maps each method to the kind
  its reader reads, from the code, following the kind through a handler
  the file runs and a route file it re-exports or wraps; a handler that
  reads two kinds is refused, with every rule of part 1 to 3 (code before
  the read, a renamed or object read, a guard beside a read).
- **The one list** (`eslint-rules/session-guards.mjs` `READER_ANSWERS`)
  maps each reader to its kind, the guard it replaced and its sweep entry
  name; the import rule (`eslint-rules/owner-caller-imports.mjs`) holds
  the new readers as it holds `ownerCaller`: imported only in an app/api
  route file, by their own names, from `@/lib/auth`.

Batch 5, the member and chat rows: the handlers whose guard was the
standard two lines as their first statement on main, with no parameter
with a default value (a parser script over every route file: 29 such
handlers; the two of `/api/auth/pair` are public rows, which no kind may
read): 27 handlers in 24 route files.

- **Member** (`memberCaller()`): 10 handlers in 8 files: `GET
/api/member/home`, `GET /api/member/mcp`, `DELETE
/api/member/mcp/clients/:id`, `POST /api/member/push/connect`, `GET` and
  `PUT /api/member/push/preferences`, `GET` and `POST
/api/member/push/subscriptions`, `DELETE
/api/member/push/subscriptions/:id`, `GET /api/member/realtime`. With
  their HEADs, 15 rows carry `caller: 'member'`.
- **Chat** (`chatLoginCaller()`): 17 handlers in 16 files: the assistant
  chat rows (`conversations`, `messages`, `read`, `stream`, `thread`,
  `threads` GET and POST, `threads/:id`, its `continue` and `summarize`,
  `transcribe`) and the Telegram chat rows part 4 classed `self` (`pair`,
  `my-chats` and one, `moderated-chats`, a chat's `block` and `unpair`).
  With their HEADs, 25 rows carry `caller: 'chat'`.
- **Any login**: none. Every any-login handler reads its guard inside a
  wrapper, not as its first statement: `ruleInQuery(handleGET)` (`GET
/api/shell`, `GET /api/v1/whoami`, `GET` and `POST /api/access-keys`,
  `DELETE /api/access-keys/:id`) and the workspace and grants helpers
  (`workspaceCaller()` in `server/web/lib/workspaces.ts`, behind `wsRoute`
  and `grantsRoute`, 17 route files). The answer step and `loginCaller()`
  are in place and pinned by the parity cells below; the rows wait for the
  hand batch.

Rows carrying a caller: 649 owner, 15 member, 25 chat (689 of 1043).

The proof is the guard sweep. The two recorded files and the owner
decision's file are byte for byte; a moved entry is named by its reader
(`pipeline:member`, `pipeline:chat`; `pipeline:login` when one reads it)
and the recorded files compare it under the guard it replaced. The moved
snapshot holds 8777 cells (8297 after part 4: 180 member cells, 300 chat
cells, no old cell changed) and 117 answers (79 after part 4). The 38 new
ones, each for GET and HEAD (a HEAD has no body):

- `pipeline:member`: a member let through by cookie and by device token
  (stamped once), in its own rule (self rows) or its scope (the member
  home); an Admin user's 403 `admin-login` (the anchor, an Admin user and
  one with no area by cookie, an Admin user by device token, stamped
  once); the 401;
- `pipeline:chat`: the anchor, an Admin user and one with no area by
  cookie, an Admin user by device token (stamped once), and a member by
  cookie and by device token, let through: a read in the login's scope (a
  HEAD, whose row is in no login list, on the system pool as `login-self`,
  as before), an Admin user's write on the system pool (`admin-write`), a
  member's write in its scope; the 401.

The moved writes file holds 3775 cells (3607 after part 4; 60 member, 108
chat) and 743 answers (716): a member's own session writes no audit row,
as before; each of the 27 new answers is an Admin user's one `api.write`
row of a chat or Telegram write.

`server/web/server/middleware/gate-caller.test.ts` serves real rows of
each list twice, through the reader and through the guard: a member read
(self and content), a member write and delete, an any-login read and write
(`/api/shell`, `/api/access-keys`), a chat read and write and a Telegram
chat read and write, for every credential (the anchor, an Admin user, one
with no area, a member, a gone login, by cookie and by device token, a
revoked token, no login, a write key, a member key) and HEAD, comparing
the status, headers, body (the login, the actor, the scope), the audit
rows and the device token's stamp; a device token stamped once on each
kind's row; an error the chat answer throws answered with CORS; each
reader's throw; and each kind refused on a row its guard does not serve.

Pins: guard calls 43 to 16, still a ceiling; files with a guard call 39
to 15; reads of the caller 432 to 459, in 303 to 327 files; live routes
calling no guard stays 60.

**The gateway lens.** Two checks repeat across the handlers left, and the
gate could do each once:

- **The rule-in-query exit.** The any-login handlers leave the request
  scope the guard entered by name (`asSystem(..., 'rule-in-query')`), in
  two shapes. Five route files go through `ruleInQuery`
  (`server/web/lib/auth/rule-in-query.ts`; four any-login, and the public
  `GET /api/auth/whoami`): the whole handler, guard
  included, runs inside the exit, so the guard's refusal is logged as
  `system:rule-in-query`; read at the gate it would be logged as
  `system:http:no-login` (the sweep's recorded files would change there,
  though nothing on the wire does). The 17 workspace and grants files go
  through `wsRoute` (`server/web/lib/workspaces.ts`) and `grantsRoute`
  (`server/web/lib/grants.ts`), which call `workspaceCaller()` BEFORE
  `asSystem`: their guard runs in the request slot, as the gate's answer
  would, and their refusal is logged as it would be at the gate. What
  holds those 17 back is not the exit: their guard lives in a lib helper
  (no route file calls it, so the codemod cannot see it), and the audit
  row is written by hand after it.
- **The any-login audit.** `getLoginOr401` writes no audit row; its
  callers write it by hand after it (`auditLoginMutation`:
  `workspaceCaller()`, `POST /api/auth/pair`), where the member and chat
  guards write theirs inside. The any-login answer step can write it, once,
  when those rows convert.

**The hand batch, the recommended plan** (fix round 1):

1. **First, the baseline** (in place since fix round 1): the guard sweep
   records every write cell a guard still answers, its audit rows and the
   create home noted, keyed by the guard's name
   (`server/web/server/__snapshots__/a4-guard-sweep-guard-writes.txt`),
   with the row `workspaceCaller()` and `POST /api/auth/pair` write by hand
   after the guard (the sweep lets that call run before it stops the
   handler). A row that moves keeps its cells there under the guard its
   reader replaced, and the test holds each to the guard path's record, by
   cell, before it compares the file: a lost or a doubled row fails.
   `gate-caller.test.ts` serves `POST /api/workspaces` and `POST
/api/grants/move` through `loginCaller()` and through
   `workspaceCaller()`, comparing the answer, the audit rows and the stamp.
2. **Fold the audit** into the `login` answer step: it writes
   `auditLoginMutation`'s row, and the same commit deletes the hand call
   from `workspaceCaller()` and from `POST /api/auth/pair`. The baseline
   above shows the fold writes each row once, where the guard path did.
3. **No gate flag.** Do not add a row flag that runs the handler on the
   system pool after the answer: a gate that leaves the scope it entered
   for a whole class of rows is a second, wider exit. Restructure instead:
   the five any-login handlers of the four `ruleInQuery` files (`GET
/api/auth/whoami`, the fifth file, is a public row and goes with the
   public rows) become
   `const login = loginCaller(); return asSystem(() => handle(login), 'rule-in-query');`
   (the read before the exit, the exit as narrow as it is now), and the
   `wsRoute` and `grantsRoute` handlers read `loginCaller()` first and pass
   it in (`workspaceCaller()` becomes a projection of it, with no guard).
4. **The one recorded change**: the refusal actor of those four
   `ruleInQuery` files (`GET /api/shell`, `GET /api/v1/whoami`, `GET` and `POST
/api/access-keys`, `DELETE /api/access-keys/:id`), `system:rule-in-query`
   to `system:http:no-login`, now that the refusal is the gate's. Record it
   as an explicit sweep change (a file of its own naming those cells, as
   the owner decision's is), so the two recorded files change there and
   nowhere else. The 17 wrapper files change no recorded cell.

**Carried** (fix round 1, open):

- **HEAD rows have no logins** (LOW 5; `server/web/lib/auth/route-policy.ts`,
  the open question M3): no list names HEAD, so a chat row's HEAD runs the
  GET handler on the system pool (`login-self`) for a member, with no row
  security holding it to the login; only the handler's own query does.
  Needs an owner decision before A4 exit: should a HEAD row take its GET's
  logins (and so its scope)?
- **Two private functions were named `loginCaller`** (`server/web/lib/mcp-auth.ts`,
  the member MCP caller; `packages/runtime/src/heartbeats/fire.ts`, the
  fire's scope wrapper), the reader's name: renamed in fix round 1
  (`memberMcpCaller`, `fireInLoginScope`), private to their files.

**Step 3b, what is left** (the hand batch; the sweep held equal after
each, its moved entries recorded). The 16 guard calls the count sees, and
the guards it does not:

- the any-login rows (`getLoginOr401` in a wrapper): `GET /api/shell`,
  `GET /api/v1/whoami`, `GET` and `POST /api/access-keys`, `DELETE
/api/access-keys/:id` (`ruleInQuery`), and `server/web/lib/workspaces.ts`
  `workspaceCaller()` (the workspace and grants rows, `POST
/api/workspaces/:id/archive` among them): the gateway lens and the
  recommended plan above;
- `POST /api/assistant/turn` (`getChatLoginOr401` after a response helper
  it declares first);
- the public rows that read the login (`getLoginOr401`): `GET
/api/auth/whoami`, `POST /api/auth/logout`, `POST
/api/auth/change-password`, `POST /api/auth/pair` and `GET
/api/auth/pair/:id`, `oauth/authorize` (the consent), and `POST
/api/auth/sso` (`getCookieUpgradeLoginOr401`);
- the asset guards (`getOwnerForAsset`, `getReaderForAsset`,
  `getMemberForAsset`: the draw svg, the file bytes, the export of batch
  2's rows and `GET /api/attachments/:id`);
- `server/web/lib/gone.ts` (the 410 stubs: `/api/apps/members`,
  `/api/admin/space`, the 37 of the area rows of part 4's list, and the
  member list's: every member row left but the frame document);
- the two turn routes with a flag check first (`/api/assistant/turn/:turnId`
  cancel and stream) and `POST /api/dev-tools/queue-approval` (a flag
  check first);
- `GET /api/updates/check` (`getSessionUser`, the owner's carve-out);
- `GET /api/apps/:id/frame` and `GET /api/member/apps/:id/frame` (the
  frame documents, which read no guard);
- `PATCH /api/pages/:id` with its v1 wrapper, and `GET
/api/v1/files/:id/download` with its base.

Then `getOwnerOr401` goes and the count is 0 (A4 exit).

**HTTP, A4 step 3b hand batch part A (no answer changed; two recorded
changes the owner decided).** The owner's decisions of 2026-10-14 (plan
section 27): 1a, the any-login rows move by restructuring, with no gate
flag that runs a handler on the system pool; 2a, a HEAD row takes its GET
row's logins (the open question M3). And the hand cases that call a guard
the gate can answer: the gone stubs, the flag-first routes, the update
banner.

- **The any-login audit** (1a): `getLoginOr401` writes the generic
  `api.write` row inside, once it lets the login through, when its caller
  asks (`audit`), as the member and chat guards write theirs; the `login`
  answer step asks. The hand calls after the guard went in the same
  commit (`workspaceCaller()`, `POST /api/auth/pair`, which asks too);
  `auditLoginMutation` is private to session.ts. The guard writes baseline
  held every cell to the guard path's rows: one row per Admin user's
  write, none for a member's own session, none doubled.
- **The workspace and grants rows** (1a): 23 handlers in 17 route files
  read `loginCaller()` first and pass the login to `wsRoute` and
  `grantsRoute`; `workspaceCaller(login)` (lib/workspaces.ts) is a
  projection with no guard, the one projection (GET /api/shell and
  lib/login-workspaces.ts take it; `wsCallerOf` went). The exit stays
  inside the two helpers, as narrow as before, through `inRuleInQuery`
  since fix round 1 (the one exit site).
- **The ruleInQuery files** (1a): the five any-login handlers of GET
  /api/shell, GET /api/v1/whoami, GET and POST /api/access-keys and DELETE
  /api/access-keys/:id read `loginCaller()` first and run only their body
  in the exit: `return inRuleInQuery(() => handle(login))`
  (lib/auth/rule-in-query.ts, `asSystem(body, 'rule-in-query')`, the one
  exit site). `ruleInQuery` stays for GET /api/auth/whoami (part B).
- **HEAD logins** (2a): a HEAD row has its GET row's logins
  (route-policy.ts `buildRouteRow`). The HEAD of an any-login, chat or
  Telegram GET row ran on the system pool (login-self) for every login; it
  runs under the login's own rule now, as its GET does. The member list's
  HEADs have its logins too; the member guard reads the row's scope, so
  none of their answers changed. Only where the GET handler answers the
  HEAD (fix round 1, L3): a route that exports its own HEAD has a HEAD row
  of its own, as the lists name it, with no logins, read or switch of its
  GET's (buildRoutePolicy passes `ownHead`; no route exports one today).
- **The gone stubs**: the 144 `gone()` handlers in 125 route files (62
  owner, 47 member, 35 any) call no guard. The gateway lens chose one
  mechanism over a reader in each stub: the generator reads `export const
GET = gone('owner', ...)` as a handler that reads the caller of the
  stub's kind (`GONE_KINDS`, lib/gone-kinds.ts, the one table of stub
  kinds that lib/gone.ts, the generator and the guard sweep read since fix
  round 1; `any` is the any-login caller) and marks the method in the
  manifest (`gone`). Its
  row is a gone row (`RouteRow.gone`) with that caller, so the gate's one
  answer step runs the stub's guard before the handler: no second answer
  path at the gate, and the 410 stays the one `goneResponse`. A gone row
  takes the stub's kind whatever list it is in (the member guard on a
  retired member route no member list names, the any-login guard on the
  client portal's rows), the guard the stub called; the any-login answer
  writes no audit row there, as the stub's call wrote none. The stub reads
  the answer of its kind and throws where there is none (lib/gone.ts is
  the one lib file the reader import rule lets read: the generator reads
  its stubs). 212 rows are gone rows (the 144 and 68 HEADs). Since fix
  round 1 the generator refuses a route file that imports or uses `gone`
  in any form it does not read (a relative or other spelling of the
  module, the module whole or by default, `gone` renamed or re-exported,
  or called anywhere but a method's export): such a stub would be served
  with no gone row and its read would throw.
- **The flag-first routes**: POST /api/assistant/turn/:turnId/cancel and
  GET /api/assistant/turn/:turnId/stream (MANTLE_TURN_STREAMING) and POST
  /api/dev-tools/queue-approval (never in production) answered their 404
  before their guard, so while the switch is off a member, a revoked token
  or an Admin user without the dev tool's settings area got the 404, not a
  refusal. Moving the flag after the read would change that, so the switch
  is the row's (`RouteRow.switch`, a HEAD the GET handler answers takes
  its GET's), declared in the route file beside its handler (`export const
routeSwitches = { POST: 'not-production' }`, lib/auth/route-switches.ts;
  fix round 1: it was a string-keyed map in route-policy.ts, which a
  rename would have left behind), read into the manifest by the generator
  (route-callers.ts `handlerSwitches`, which refuses any other form and a
  switched handler taken by another route file without its switch), and
  buildRoutePolicy refuses at boot a switch for a method the route does
  not serve. The gate answers its off answer first (`routeSwitchedOff`,
  in the gate middleware, before the login's answer and the Admin step),
  in the handler's words; the handlers read `ownerCaller()` first. POST
  /api/assistant/turn declared a response helper (a closure with no
  effect) before its guard: it moves after `chatLoginCaller()`.
  `gate-caller.test.ts` proves it per credential, with the switch on and
  off.
- **The update banner**: GET /api/updates/check (the owner's carve-out,
  `getSessionUser`: any Admin user, or null) reads `sessionUserCaller()`,
  a fifth caller kind (`session`): the gate's answer step runs
  `getSessionUser` once and refuses nothing; the handler answers a null
  401 as before. Only a row of `ADMIN_OPEN_ROWS` may read it.

**The two recorded changes**, each in its own commit and recorded as
driven in a file of its own, as the owner decision of part 4 is:

1. **1a, the ruleInQuery rows** (`__snapshots__/a4-guard-sweep-rule-in-query.txt`,
   all 172 cells of the 8 rows: the 5 handlers and the 3 HEADs). The guard
   ran inside the exit, so the actor the sweep notes after it was
   `system:rule-in-query`; the gate answers outside it. In those rows'
   cells of the two recorded files, and only there, the guard entry's
   actor changed and nothing else (status, headers, body and the request
   outcome are as recorded): a refusal to `system:http:no-login`, 48 cells
   (8 in the first sweep, 40 more credentials); a login let through on
   GET, POST and DELETE to the login's own actor (`login:rw:<id>`, a read
   key's `login:ro:<id>` on /api/v1/whoami), 35 cells; a login let through
   on the 3 HEADs to `system:http:login-self`, 23 cells (then the 2a
   change below). The plan named only the refusals; the other two kinds
   are the same change (the note moved out of the exit).
2. **2a, HEAD logins** (`__snapshots__/a4-guard-sweep-head-logins.txt`,
   all 340 cells of the 17 HEAD rows of the any-login, chat and Telegram
   GET rows). 107 cells of the first sweep changed, each a HEAD cell of
   those rows: the anchor, an Admin user, one with no area and a member by
   cookie, an Admin user and a member by device token on each of the 17,
   and the 5 keys on HEAD /api/v1/whoami. In each, the actor and the
   request outcome noted after the login's answer changed from
   `actor=system:http:login-self out=system:login-self` to the login's
   (`login:rw:<id>`, a read key's `login:ro:<id>`) and `out=user:false`,
   each now what its GET cell notes; status, headers and body are as
   recorded. The more credentials file did not change (every cell there is
   a refusal). Since fix round 1 `a4-head-logins.db.test.ts` runs the real
   handler bodies of the 17 rows on a scratch database and holds each HEAD
   to its GET (the same status and headers, no body) for the owner, another
   Admin user, a member and no login.

Everything else is byte for byte: the two recorded files outside those
cells, the owner decision's file and the guard writes baseline (every
moved write cell held to the guard path's audit rows and create home). The
moved snapshot holds 11863 cells (8777 after part 5) and 171 answers
(117); the moved writes file 4951 cells (3775) and 881 answers (743).
Correction (fix round 1): 48 cells already in the moved snapshot did
change, the 2a change on rows moved in part 5: the HEADs of the 6
assistant chat rows (/api/assistant/conversations, messages, stream,
thread, threads, threads/:id) and the 2 Telegram rows
(/api/telegram/my-chats, moderated-chats), 6 credentials each in the
first sweep, the actor and the request outcome only (the same cells as in
the 2a file). An earlier version of this section said no moved cell
changed.

Since fix round 1 the two decision files are held mechanically, not only
recorded: each cell line keeps its answer on main (`main=`, a table under
`# answers on main`, written once from the recorded files on main and
never from a run), and the sweep holds the set of cells to the set kept
and each answer to its main answer with `actor=… out=…` masked before it
compares the file (`decisionFile`, a4-guard-sweep.test.ts). A rerun with
`-u` records the cells as driven but fails on any other change on those
rows (the 172 and 340 cells of the two files; 190 of them differ from
main, 106 for 1a and 107 for 2a with 23 in both, and only there). The two
files changed only by the main answers they now keep.

Rows carrying a caller: 742 owner, 90 login, 26 chat, 85 member, 2
session (945 of 1043; 689 after part 5).

Pins: guard calls 16 to 7, still a ceiling; files with a guard call 15 to
7; reads of the caller 459 to 492, in 327 to 352 files; live routes
calling no guard 60 to 43 (the 17 workspace and grants files read now).

**Part B, what is left** (the hand batch; then `getOwnerOr401` goes and
the count is 0, A4 exit):

- the public rows that read the login: GET /api/auth/whoami (with
  `ruleInQuery`), POST /api/auth/logout, POST /api/auth/change-password,
  POST /api/auth/pair (`getLoginOr401` with `audit`) and GET
  /api/auth/pair/:id, `oauth/authorize` (the consent), and POST
  /api/auth/sso (`getCookieUpgradeLoginOr401`);
- the asset guards (`getOwnerForAsset`, `getReaderForAsset`,
  `getMemberForAsset`: the draw svg, the file bytes, the export of batch
  2's rows, GET /api/attachments/:id, and the two member byte stubs,
  `goneForMemberAsset`);
- the frame documents (GET /api/apps/:id/frame, GET
  /api/member/apps/:id/frame);
- PATCH /api/pages/:id with its v1 wrapper, and GET
  /api/v1/files/:id/download with its base;
- then delete `getOwnerOr401`.

**HTTP, A4 step 3b hand batch part B (A4 step 3b exit).** No answer
changed. The last guards a handler called, and the ones the count did not
see. After it no route handler calls a session guard: the gate answers
every caller a route reads, and `getOwnerOr401` is gone.

**What moved.**

- **The byte routes** (eager, answered before the handler as every kind
  of part 5 is): `GET /api/attachments/:id`, `GET /api/export/:id` and `GET
/api/profile/photo` read `ownerAssetCaller()` (what `getOwnerForAsset`
  answers: the session, an `?at=` asset token, the render cookie); `GET
/api/draws/:id/svg` and `GET /api/files/files/:id` (with its /api/v1
  alias and `GET /api/v1/files/:id/download`) read `readerAssetCaller()`
  (`getReaderForAsset`: an Admin user, or a member on a read open to it);
  the two retired member byte routes (`/api/member/files/:id`,
  `/api/member/draws/:id/svg`) are `gone('member-asset')` stubs whose gone
  row the gate answers with `getMemberForAsset` (`goneForMemberAsset`
  went). The caller kinds are `ownerAsset`, `readerAsset` and
  `memberAsset` (a gone row only).
- **The frame documents** (`GET /api/apps/:id/frame`, `GET
/api/member/apps/:id/frame`), which read no guard: they read
  `frameTicketCaller()`, the `?t=` frame ticket the gate verified, or null
  (kind `frame`, only on `FRAME_ROWS`, route-policy.ts; no login is looked
  up for them, as before). It refuses nothing: what the ticket may open
  (this app, a live Admin user or member) is still checked by the handler,
  in the order it was.
- **The public rows that read the login** (answered at the read, below):
  `GET /api/auth/whoami`, `POST /api/auth/logout`, `POST
/api/auth/change-password`, `POST /api/auth/pair` (with the `audit` row)
  and `GET /api/auth/pair/:id`, `GET` and `POST /api/oauth/authorize` read
  `publicLoginCaller()` (what `getLoginOr401` answers; kind `publicLogin`);
  `POST /api/auth/sso` reads `cookieUpgradeCaller()`
  (`getCookieUpgradeLoginOr401`, kind `cookieUpgrade`), passed to
  `handleOwnerSso` (lib/owner-sso.ts) as the read it runs after its
  throttle and origin check. `ruleInQuery` went: whoami runs its body in
  `inRuleInQuery`, the one exit site, and reads the login inside it, where
  its guard ran.
- **`PATCH /api/pages/:id` and its /api/v1 wrapper**: the page route's
  PATCH reads `await ownerCallerAtRead()` (kind `ownerAtRead`). For a key
  the v1 wrapper reads it first, after the hidden email page and before
  its two rules (`key-publish`, `key-shared-item`; the A8 fix round 1,
  L4): the owner's answer, its item check and its audit row come before
  the rules, so a page the key's login may not change gets the item gate's
  answer (404, or an Admin user's 403 `item-workspace`) for every key. The page route's read takes the
  same answer (once per request).
- **`GET /api/v1/files/:id/download` with its base**: the base reads the
  asset reader (above); the wrapper sets the query it hands the base and is
  a marked hand case (`// route-callers: hand case`: it runs nothing and
  answers nothing before the call).

**The optional login of a public row.** A public row judges its own
credential: its handler runs checks of its own before it reads the login
(the cross-site refusal and the body of logout and change password, the
SSO throttle and origin check, the remote MCP switch and the client's
validation of the OAuth consent), and those must not pay a lookup, stamp a
device token or write an audit row. So the gate binds the answer and the
handler's first read runs it, once, where the guard was called (an answer
taken at the read: `AtRead`, session.ts; `ANSWERED_AT_READ`,
route-policy.ts); every later read is the same answer. It never refuses:
no login reads as null, and the handler answers it as it did (the 401 of
`unauthorizedRefusal()`, the one mapper's, its own words, or carrying on).
A public row may read only a public kind, and a public kind is read only on
a public row (`callerServes`, route-policy.ts). The same timing serves
`ownerAtRead`, whose refusal is thrown (`RouteRefusal`) and answered by the
app's onError as the guard's was returned (server/app-error.ts), with the
gate's CORS headers: the handler cannot answer in its place. The generator
asks no read-first order of a kind taken at the read
(`KINDS_AT_READ`, route-callers.ts).

**The asset rows.** The asset guards read the request, not only the
credential: its `?at=` token, its path and method (the render cookie). The
gate runs them before the handler on the request as the handler is handed
it: the request as sent, except `GET /api/v1/files/:id/download`, whose
route file hands the bytes handler `?raw=1` alone, so a `?at=` sent there
was never read and still is not (`ASSET_QUERY_AS_HANDED`, route-policy.ts;
the route file reads its query from the same constant, `V1_DOWNLOAD_QUERY`,
and download-query.test.ts drives it; gate-caller.test.ts drives a member's
session with an Admin user's token on both rows). Their refusal is the gate's, before the handler, as on every
eager row. The two credentials only these rows take, the asset token and
the render cookie, are in the sweep and in the parity cells. A share
link's visitor reads bytes through the /s routes, which judge the token
themselves and read no caller (link-render-sweep, unchanged).

**The proof.** The guard sweep: the two recorded files, the owner
decision's file, the two decision files of part A and the guard writes
baseline are byte for byte (every moved write cell held to the guard
path's audit rows and create home, by cell). An answer taken at the read
is logged at the read, under its reader's entry, as the guard's was; the
frame ticket logs nothing, as nothing was logged there. The moved snapshot
holds 12313 cells (11863 after part A: 248 cells of the 18 byte rows, 202
of the 10 public and page rows; no old cell changed) and the moved writes
file 5065 cells (4951). `gate-caller.test.ts` serves the byte routes, the
frame document and the rows taken at the read twice, through the reader
and through the guard, for every credential (the anchor, an Admin user,
one with no area, a member, a gone login, by cookie and by device token, a
revoked token, no login, a write key, a member key, an Admin user's and a
member's `?at=` token alone and beside a session, the render cookie, an
Admin user's, a member's and a bogus frame ticket), comparing the status,
headers, body, audit rows and the stamp; and a handler that answers before
its read stamps no device and writes no audit row through both.

**A4 exit.** `getOwnerOr401` and `getOwnerOr401WithSource` went, and the
two page guards no one called any more (`requireOwner`,
`requireOwnerWithSource`); `RETIRED_GUARDS` (session-guards.mjs) keeps the
two names the sweep's recorded files spell. The guards that stay are the
gate's (answerRouteCaller runs them) and the render pages' own
(`requireOwnerForRender`, server/pages/print.ts: pages, not routes of the
manifest). `no-guard-calls` is a hard ban now, an ESLint rule on every
script file under server/web (tests and session.ts aside, the render pages
named): a session guard imported, read off an object or destructured is an
error.

Pins: guard calls 7 to 0 and files with a guard call 7 to 0 (held at 0 by
arch-lints.test.ts and the rule); reads of the caller 492 to 508, in 352 to
364 files; live routes calling no guard 43 to 20. The count follows an
alias now (an /api/v1 file that takes a handler from a route file reading
the caller reads where it does, as the generator follows it), and the 20
left are each a public row that reads no login (sign-in, token, signup and
invite routes, the OAuth token and registration, federation, MCP, the
appearance and version routes): arch-lints.test.ts holds each to a public
path.

Rows carrying a caller: 980 of 1043 (945 after part A): 742 owner, 90
login, 26 chat, 85 member, 2 session, 6 ownerAsset, 8 readerAsset, 4
memberAsset, 4 frame, 10 publicLogin, 1 cookieUpgrade, 2 ownerAtRead. The
63 without one are each a public row.

**Left on a guard:** nothing in a route handler. The render pages keep
`requireOwnerForRender` (they redirect to sign-in, and A4 step 2 runs them
through the gate in an actor slot of their own). Test files that stand in
`getOwnerOr401` in a module mock (from before their handlers read the
caller) stand in nothing now; they are left as they are.

**A4 hand batch B, fix round 1.** No answer changed.

- **A row that reads no caller is refused at boot.** `buildRouteRow`
  throws on a row that is not public, not a page and reads no caller
  (route-policy.ts): a new method of a route file that reads on another
  method, but not on its own, would otherwise run behind the gate's
  signature check alone. A test's stand-in routes, whose handlers call the
  guards themselves to compare with the reader, pass `standIn`
  (`registerRoutes(app, routes, { standIn: true })`); arch-lints.test.ts
  holds the word to the two files that define it, and pins the rows row by
  row (980 of 1043 carry a caller, and no row that is not public and not a
  page is without one), beside the file-level count above.
- **The kinds of part B are read on named rows.** As the frame answer
  (`FRAME_ROWS`) and the session user's (`ADMIN_OPEN_ROWS`) were, each
  kind is now read only on the rows named for it, and `buildRouteRow`
  refuses it anywhere else (`callerServes`, route-policy.ts): the owner
  taken at the read on the two page PATCH rows (`OWNER_AT_READ_ROWS`);
  `publicLogin` and `cookieUpgrade` on the public rows that read a login,
  each to its kind (`PUBLIC_LOGIN_ROWS`: never an /s link route, the
  remote MCP, federation or a sign-in route); the asset kinds on a GET or
  HEAD of a byte route the gate takes an asset token on (`isAssetPath`,
  moved to auth-constants.ts so the gate and the rows read one list) and
  the two /api/v1 file rows that run one, so a token minted for a byte src
  can never answer a write. `gate-caller.test.ts` builds a refused row of
  each kind and holds the app's rows of each kind to their names. The
  route list pin of route-policy.ts went up by one (`PUBLIC_LOGIN_ROWS`,
  reviewed: the rows' own check, not a policy beside them).
- **The v1 download's query has one source.** Its route file sets the
  query it hands the bytes handler from `V1_DOWNLOAD_QUERY`
  (route-policy.ts), the constant `ASSET_QUERY_AS_HANDED` reads, and
  download-query.test.ts drives the real route file with an Admin user's
  `?at=` beside a member's session: the handler gets the row's query, not
  the one sent.
- **The consent step and the frame documents through the pipeline.**
  authorize-pipeline.test.ts drives GET and POST /api/oauth/authorize
  through runRoute with the remote MCP switch on (the guard sweep gives
  every credential the switch's off answer, and authorize-route.test.ts
  stands the reader in): an Admin user, a member with MCP off and on,
  nobody and a revoked device token, the login read at the read from a
  real cookie or token. frame-pipeline.test.ts drives the real frame route
  files: a valid ticket opens what it names, a ticket for another app (or
  an Admin user no longer active) is the handler's 401, an invalid ticket
  or none is the gate's 401 before the handler. runRoute takes a raw body
  (`rawBody`, a form) for the consent POST.
- **An answer taken at the read is awaited, and the owner one never in a
  try.** owner-caller-imports.mjs now holds a route file's call of a reader
  answered at the read (`publicLoginCaller`, `cookieUpgradeCaller`,
  `ownerCallerAtRead`: READER_ANSWERS `atRead`) to an `await` where it is
  made, and refuses `ownerCallerAtRead()` inside a try block, where a catch
  could swallow its thrown refusal and run the handler with no owner. POST
  /api/auth/sso hands `handleOwnerSso` an `async () => await
cookieUpgradeCaller()`.
- **Nits.** The docs that still gave `getOwnerOr401` or `requireOwner` as
  the recipe now give the reader (`ownerCaller()`, the caller the gate
  answered); the archive, the changelog and the plans keep their history.
  The stand-ins of `getOwnerOr401` in test module mocks are still left as
  they are (about 30 files, half of them database tests, several stood in
  over many lines): removing them is no mechanical change.

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
  database refuses that row, as before (until step 5, below). A runtime row is
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
  (`server/web/lib/api-v1-builtin.test.ts`). An item the edit check would
  refuse is answered by the HTTP item gate first (`itemWriteGate`,
  `server/web/lib/auth/session.ts`: its own 403 or 404), on main and now;
  one that gets past it (a right lost between the gate and the call) is
  refused by the item pre-check, which throws the database's refusal for
  this entry (fix round 2), so `app.onError` answers it as the edit check
  answers a write: 403 item-workspace, or 404 for an item the scope does
  not read. Never the pre-check's words as a 400 (step 5, LOW-A/B: this
  line said 400 until then).
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
- **LOW-D.** The four responder definitions (`ask_responder`,
  `ask_as_responder`, `responder_turn_input`, `responder_turn_record` in
  `packages/mcp-core/src/mcp-defs.ts`) reply a database error the runtime
  throws in the one mapper's words (`thrownToolDatabaseError`), as
  `folder_rename` and `file_rename` do since step 4 fix round 1; any other
  error keeps its text (`packages/mcp-core/src/mcp-defs-errors.test.ts`).
- **LOW-A/B.** Comments only: the /api/v1 item refusal comments
  (`server/web/lib/api-v1-builtin.ts`, its test,
  `packages/tools/src/gate-prerun.ts` and the step 4 section above) said
  main answered such a write from the database's edit check; the HTTP item
  gate (`itemWriteGate`) answered it first, as it does now, and the step 4
  section still said the pre-check answered 400.
- **A call nested in a /api/v1 route call** names its own entry,
  `api-v1-nested` (via `process`, `nestedToolCaller`,
  `packages/tools/src/gate-callers.ts`): it answers a throw or a database
  refusal as the call's text, which the outer handler reads, as a run's
  nested call does; only the route's own call throws on to `app.onError`.
  Before, a nested call kept `api-v1` and threw past the outer handler. No
  tool the v1 routes run (`table_rows_add`, `table_row_update`) nests
  today, so no answer changes
  (`packages/tools/src/dispatch-api-v1-nested.test.ts`).

**Q1 (owner b): a read-only key or peer reads a marked connector tool.**
The gate's peer narrower (`packages/tools/src/gate-narrowers.ts`) judges a
connector row by its policy's effect, as any tool: one an Admin marked
read-only reads, so a read-only API key or linked brain lists and calls
it, as a read-only OAuth login always has. Before, a connector row counted
as a write for a key or a peer whatever its mark. A stale mark is a write
(`connectorToolPolicy`), so it stays hidden. The marked inputs check, the
connector's own check (`loginConnectorRefused`, in the pre-run slot) and
the key areas still apply: a connector is in no key area, so only an
all-areas key reaches it. Only the matrix cells of a key or a peer with
Write off, every area and a marked connector changed
(`packages/mcp-core/src/gate-policy.test.ts`,
`tool-policy-sweep.test.ts`; `__snapshots__/tools-list.matrix.json` adds
`mcp_crm_contacts_list` to the 30 such cells, and `mcp-calls.json`'s
"member key ro, every area" lists it and its call runs, with its
`mcp.connector.read` audit row).

**Q2 (owner b): shell tools only for users of the Admin workspace.**
`shellToolPolicy` (`packages/tools/src/runtime-policy.ts`) declares scope
`admin`, so the gate's Admin step refuses a shell row in a scope that does
not hold Admin (a member's turn), in `ADMIN_ONLY_ERROR`'s words, before it
runs. An Admin turn, a run and a pending approval in the Admin workspace
run it as before (behind its confirm); a call outside any scope keeps the
surface's own rules. The app tool brokers and the dev console still
dispatch ungated until step 3b (no member app reaches a shell row: only
connectors and External access rows are outside tools there, and a shell
tool can never get External access: `externalAccessIneligible`). Of
`packages/tools/src/__snapshots__/dispatch-parity.json` only
`runtime:shell` changed, and of its cases only the member turn's (it ran;
now the Admin refusal); `runtime-policy.test.ts` and the parity test's
non-vacuous case pin both.

**Q3 (owner b): a refused tool says the mapper's clear reason.** In the
one mapper (`databaseRefusal`, `packages/std/src/access-error.ts`) the tool
text of a read-only refusal (`read_only`, `ro_actor`) and of an
item-workspace refusal (`no_edit`, and a workspace check with no detail,
which the HTTP answer reads the same) is the HTTP body's message, where it
was `DATABASE_ERROR_PUBLIC`: "This app is Informational: its data is read
only.", "This caller only reads: it cannot change anything.", "You cannot
change this item in your workspaces.". `no_read` stays "not found",
`hidden_rows` its own words, any other database error the generic text.
Every surface that reads the tool text follows: a masked turn, an MCP
reply (`maskToolDatabaseErrors`, `thrownToolDatabaseError`) and a row
tool's caught error (LOW-C). The HTTP bodies do not change
(`packages/std/src/access-error.test.ts` pins both, byte for byte).

**An Admin-only kind's create from a turn is refused at the gate.** The
`tool` ref's policy (`builtinToolGatePolicy`,
`packages/tools/src/tool-gate-policy.ts`) keeps the builtin's declared
`admin-kind` scope, as the `mcp-tool` source does: a turn's
`contact_create`, `journal_create` or `location_save` in a scope that does
not hold Admin is refused at gate step 5, in `ADMIN_KIND_CREATE_ERROR`'s
words (the MCP surface's), before the handler runs and before any private
workspace is made. Before, the handler ran and the database refused the
row it wrote. Of `dispatch-parity.json` only those three tools changed, and
of their cases only the member turn's
(`server/web/lib/auth/turn-gate-parity.test.ts` pins the text, the parity
test's non-vacuous case the order).

**Untrusted coverage (plan section 25).** `outside.untrusted` is declared
on `web_search_pro` (the same public-web answer as `web_search`),
`web_map` (a site's own links and titles), `web_crawl` (its reply names the
site's paths), `email_list` and `email_get` (mail from outside the brain)
and `telegram_pending` (inbound messages). A turn fences each result as
data before the model reads it (`UNTRUSTED_CONTENT_TOOL_SLUGS`), and a
recipe that runs one marks its whole result untrusted.
`telegram_pending` is MCP only, so today only a recipe step reads the
mark; the MCP surface fences no result. Of `dispatch-parity.json` only
those six tools changed, each in its recipe step's cases (the result now
carries `untrusted: true`); `tool-policy-snapshot.untrusted.json` holds the
new set. Fix round 1 (owner decision 2a) marks `peer_query`,
`peer_search_chunks` and `peer_node_get` too: what a linked brain's people
wrote is fenced as data, as `peer_call`'s and `peer_tools`' results already
were (their handlers flag each result). Not egress: their one send, the
search text or an id, goes only to a brain the owner linked. Of
`dispatch-parity.json` only those three tools changed.

**Egress coverage (plan section 25).** `outside.egress` is declared on
`web_search_pro` (the query goes to the search provider, as
`web_search`'s), `web_crawl` (the URL goes to the crawler and it fetches
the site), `telegram_send` (a message out), `email_page` (mail out under
the owner's address) and `peer_call` (its arguments go to a linked brain,
which it may change). When the owner turns the heartbeat egress gate on,
an unattended heartbeat fire forces each to confirm, so it parks for
approval instead of running inline (`HEARTBEAT_EGRESS_SLUGS`,
`packages/runtime/src/heartbeats/fire.ts`). `telegram_send` and
`email_page` already ask a confirm by default; the mark holds when an
owner turned a row's confirm off. `peer_query` and `peer_search_chunks`
are not marked: they read, and the one thing they send, the search text,
goes only to a brain the owner linked and named, never to an address the
call chooses, so the gate's case (injected content picking where data
goes) does not arise; marking them would park every unattended
heartbeat's peer read. `tool-policy-snapshot.test.ts` holds the new set;
`dispatch-parity.json` does not change (the mark is read only by a
heartbeat fire). Fix round 1 (owner decision 1a) marks `web_map` too: it
sends a URL the model chose to the crawler, as `web_crawl` does. Release
note: on a box with the heartbeat egress gate on, an unattended heartbeat
fire that calls `web_map` now parks it for approval instead of running it
inline.

**Pick B (owner b): the model sees only what the gate lets through.**
The one tool loop (`runToolLoopInScope`,
`packages/runtime/src/agent/tool-loop.ts`) filters the tools it is handed
with `loopToolRows`, which asks `turnListedTools`
(`packages/tools/src/turn-listing.ts`): each by the ref dispatch calls it
by, `gateLists` for the loop's own caller (`turnCaller`, the one dispatch
uses) in the agent's scope the loop runs in. A tool the gate would refuse
there (an Admin-only or Admin-area tool, a create of an Admin-only kind
or a shell tool in a workspace that does not hold Admin, a row with no
policy) is not offered to the model, where before the model saw it and
its call was refused. The filter sits in the loop, not in the assistant
turn's assembly (fix round 1, M1), so every loop follows: an assistant
turn (web, team, Telegram), a delegated child turn, a heartbeat fire and
a run's worker turn (`tool-loop.listing.test.ts`). `responder_turn_input`
lists through the same `loopToolRows`, and `ask_as_responder` names the
tools the responder would be offered in its scope. An owner loop (an
Admin scope with every area) lists what it listed before; the filter
keeps the grant's order, so the list of an agent in a non-Admin scope
changes once and its prompt cache prefix resets once per agent and
scope, then holds.

**Step 5 fix round 1.**

- **M2: a call that needs approval meets the gate before it is queued.**
  The approved call runs later in the approver's scope
  (`approvePendingCall`, `pendingCaller`), so before the tool loop queues
  a call (`requiresConfirm`, the client-sourced guard, a heartbeat's
  egress gate) it asks `turnCallRefusal`
  (`packages/tools/src/turn-listing.ts`): gate steps 3 to 5 and the
  owner-only check, for the caller dispatch would use. A refusal answers
  the model in the gate's words and no pending row is made
  (`packages/runtime/src/agent/tool-loop/execute-call.ts`). Before, a
  workspace heartbeat outside Admin could queue `telegram_send` (the
  connectors area) and the owner's approval sent it. A call the gate lets
  through still queues (`turn-listing.test.ts`, `tool-loop.test.ts`).
- **M3: an ungated entry never hands a browser a database error's text.**
  The app tool brokers answer dispatch's result as it is
  (`server/web/app/s/[token]/tool-broker/route.ts`,
  `server/web/lib/app-runner.ts`,
  `server/web/app/api/apps/[id]/tool-broker/route.ts`), and an ungated
  builtin answers a caught error with its text (`dispatchUngated`, the
  table tools' `errorMessage`). Until step 3b removes the ungated path,
  `dispatchTool` runs it under `maskToolDatabaseErrors` for every surface
  but the owner's own web (the dev console, an app the Admin workspace
  alone holds), so a member's or a contact's broker call says the one
  mapper's words for a database error and keeps any other error's text
  (`dispatch-ungated-mask.test.ts` then; since step 3b the broker's caller
  masks, `packages/tools/src/dispatch-broker-mask.test.ts`).
- **L2: a read-only connection keeps a marked connector tool to its marked
  inputs.** Dispatch applies a read-only mark's inputs check
  (`connectorMarkRefusal`) below the owner and in a workspace scope, not on
  an owner surface outside one; since Q1 a read-only admin key or peer on
  an unscoped connection reaches a marked tool there. The MCP connector
  check (`connectorCheck`, `packages/mcp-core/src/login-surface.ts`, the
  call's pre-run slot) now applies it for any connection whose `write` is
  off (`packages/mcp-core/src/connector-check.test.ts`).
- **L3: a call nested in a /api/v1 route call masks a database error.**
  `api-v1-nested` is a `process` call, so the MCP masking never applied,
  and the outer handler hands its text to the route as the 400 body.
  `dispatchTool` now runs such a call under `maskToolDatabaseErrors`
  (`packages/tools/src/dispatch-api-v1-nested.test.ts`).
- **L6: a refused create says a create's words in a tool.** The mapper's
  item-workspace branch also reads the create refusals (the create home's
  "this kind of item lives in the Admin workspace only" and "no workspace
  to create this item in", the write role's "not allowed to create an item
  in that workspace", and the row rule's "new row violates row-level
  security policy", which an insert and a move out of what the scope reads
  both meet). Their tool text is now a create's own words
  (`ADMIN_KIND_CREATE_ERROR` for the first); the HTTP answer stays the
  item-workspace 403, its body byte for byte
  (`packages/std/src/access-error.test.ts`).
- **L7: listing equals calling, proven per caller.** For the owner, an
  Admin user, a member who is a user of Admin with no area and a member
  outside Admin, `turn-listing.calling.test.ts` lists the builtins and
  runtime rows, names exactly what each hides (nothing but the row with no
  policy for the first two; the Admin-area tools for the third; the
  Admin-only, admin-kind and Admin-area tools and the shell row for the
  last), calls every tool through `dispatchTool` for the same caller, and
  asserts a listed builtin reaches its handler and a hidden tool is refused
  by the gate in its words. `turn-listing.test.ts` names the member's
  hidden classes exactly too.

**Carried to A5 step 6** (from the step 5 audit; no change here):

- **L1.** The owner-only surface check (`dispatchGated`'s `ownerOnly`
  test in `packages/tools/src/dispatch.ts`) and the connector checks in
  `dispatchMcp` sit outside the gate, so listing and calling can disagree:
  an ownerOnly tool of scope `any` (`tree_folders`) is listed for a
  non-owner surface and refused at dispatch. Move both into gate
  narrowers.
- **L4.** `telegram_pending`'s untrusted mark is never read on MCP (the
  surface fences no result), and a run's items are stored without an
  untrusted flag.
- **L5.** The heartbeat egress gate covers builtins by slug only
  (`HEARTBEAT_EGRESS_SLUGS`), never a runtime row; a run ignores egress.
  Release note: each new egress mark (step 5's five, fix round 1's
  `web_map`) parks that tool on an unattended heartbeat fire on a box with
  `heartbeatEgressGate` on.
- **M2, at approval.** The gate now refuses a call before it is queued,
  in the queuing loop's scope: steps 3 to 5 and, since fix round 2, the
  pre-run checks with the call's own arguments (`turnCallRefusal` runs the
  gate's `gateCallRefusal`, the item pre-check included), so a call that
  names an item the loop's scope may not change (a workspace heartbeat's
  `page_delete` of an Admin-only page) is refused before any pending row
  exists. What remains: the approval itself still runs in the approver's
  scope (`approvePendingCall`, `pendingCaller`), so the originating scope
  is not re-checked at approval (an item whose rights changed while the
  call waited). Re-checking it there needs the row to carry the scope
  whole (its workspace and login are stamped, 0250, but not the scope's
  moderator set or its Admin view), which is a migration.

## App calls and the dev console through the gate (A5 step 3b)

Plan section 23.3, step 3b, no behaviour change. Every tool call now runs
through `enterCall`: the app tool brokers and the dev console were the
last entries that named no caller, and `dispatchUngated` is gone.

The ungated callers before this step (the sweep of
`packages/tools/src/dispatch-entries.test.ts`, then `NO_CALLER_YET`):

- the shared link broker, `server/web/app/s/[token]/tool-broker/route.ts`
  (a contact share's call of an outside tool with External access, on a
  contact surface in the link's scope);
- the member app broker, `server/web/lib/app-runner.ts` (`memberToolBroker`:
  a member's run on the owner route, team rules, a team surface in the
  app's scope);
- the owner app broker, `server/web/app/api/apps/[id]/tool-broker/route.ts`
  (an Admin user's run: admin rules on the owner's web surface for an app
  the Admin workspace alone holds, team rules in the app's scope for any
  other or a member-built one);
- the dev console, `server/web/app/api/dev-tools/execute-tool/route.ts`.

Since A10 #9 the three are configs of one broker,
`server/web/lib/app-tool-broker.ts` (`runAppToolBroker`), which makes the
call for each; see [request-plumbing.md](request-plumbing.md#app-tool-broker-a10-9).

The member test broker (`server/web/app/api/apps/members/[id]/test/tool-broker/route.ts`),
the member route (`server/web/app/api/member/apps/[id]/tool-broker/route.ts`)
and the client route are 410 stubs: they dispatch nothing.

- **The run.** A broker passes `appBrokerCaller(surface)`
  (`packages/tools/src/gate-callers.ts`): entry `app`, via `contact` on a
  contact surface, else `app`. The dev console passes `ownerWebCaller()`
  (via `cookie`). Dispatch builds each call's gate caller as for any other
  entry (`gateCallerFor`): the actor bound at the broker's entry
  (`currentActor()`: the request's login, the member's login in the app's
  scope, the contact share), the Admin view of the scope it runs in, no
  create home outside an assistant turn. So the tool's declared policy, the
  Admin step, the owner-only check, the item pre-check and the runtime
  policy check run in the gate's order, as dispatch ran them before.
- **The refusals.** The brokers keep their verdicts
  (`memberAppToolVerdict` through `appToolVerdict`, `contactAppToolVerdict`)
  and their logging. A missing tool still answers 404 before the gate (no
  row, no ref). Every other refusal is the gate's: `appToolRefusal`
  (`packages/tools/src/app-tool-level.ts`) asks `gateCallRefusal` for the
  call's `app-tool` ref, which carries the verdict, and the member-app
  narrower refuses it in the verdict's words, a 403, at every rules a broker
  judges at (an admin's run and a contact's too, where before it acted at
  team rules only; `packages/tools/src/gate-narrowers.ts`). Same status,
  same body (`packages/tools/src/app-tool-refusal.test.ts`).
- **The masking.** The M3 rule of step 5 fix round 1 is the broker's
  caller's now, not a special case of an ungated path: `appBrokerCaller`
  sets `masks` for every surface but the owner's web, so a member's or a
  contact's call says the one mapper's words for a database error, and an
  app the Admin workspace alone holds and the dev console read it as
  before. A call nested in a /api/v1 route call masks by the same field
  (`API_V1_NESTED`). No masking is weaker than before for any surface
  (`packages/tools/src/dispatch-broker-mask.test.ts` and the parity cases).
- **No caller, no call.** `dispatchTool` refuses a call that names no
  caller and runs in no dispatch that does (`NO_TOOL_CALLER_ERROR`), as the
  gate refuses a caller it cannot resolve; the sweep keeps every entry
  naming one (`NO_CALLER_YET` is empty and stays so). The unit and .db
  tests that called dispatch with none name the caller they stand for: a
  turn's (the turn-scope, W7a and create-home sweeps), a run item's (the
  owner-only gate, the http, OAuth2 and policy checks) or a broker's (the
  connector and member-app viewer tests).

Proof: `server/web/lib/app-broker-parity.test.ts`, committed before the
change (`server/web/lib/__snapshots__/app-broker-parity.json`): the shared
link broker, a member's run, an admin's run of an Admin-only app and of a
team-held app, and the dev console, each for a read, a write, an item write
on an item the caller may and may not change, a missing tool, an owner-only
tool, two Admin-area tools (one whole on the system pool), a shell tool, a
connector's write and marked read, an http tool with External access, an
undeclared tool, a handler that throws and a database error in a read and
in an http tool: the status, the body, the audit rows (the app's Activity,
the share's trail, the app's error log), and what each call touched (the
handler, its input, who it ran as, its scope, its create home, each remote
call). After the change every cell is as it was but one class, named: the
write mode of a call whose policy is a read, `rw` to `ro` (31 cells, every
entry): the gate runs a read read only (step 3, `callActor`; plan 4.1), as
it has for turns, run items and pending approvals since step 3a. Who the
call runs as is unchanged. The read builtins' side writes are the ones
`packages/tools/src/read-tool-writes.test.ts` classifies (none to an item
table but the named app database provisioning), so no answer changes. A
third case pins that every run is bound to the gate with its entry's via.

**Gateway lens.** Folded: the brokers' refusal answer (one function, the
gate's words). Listed, not folded here: the three brokers each parse the
same body (`slug`, `input`), rate-limit and log an allowed or refused call
in their own words; the owner broker and the member broker each wrap the
run in `appToolScope`'s scope (`withViewer` below admin rules), which a
broker caller could enter itself (`GateCaller.enterScope`) so the gate
enters it once; and the verdict is asked before the gate and handed to it
on the ref, where the `app-tool` policy source could ask the live rule
itself (it does not, so a policy lookup reads no database).

**What is left.** The A5 step 6 carry (L1, L4, L5, M2 at approval, above)
is unchanged. The `.db` sweeps now run their calls through the gate as the
callers they stand for, so a read there runs read only; CI runs them.

### Step 3b fix round 1

- **A real handler under the read-only rule (MEDIUM-1).** The parity proof
  runs recorder handlers, so it cannot see what `ro` does to a real one.
  `server/web/server/a5-read-tools-ro.db.test.ts` runs every builtin whose
  policy is a read (the policy table's, `listReadOnlyBuiltinSlugs`), with
  its real handler and the real pre-run checks, on a migrated scratch
  database with the actor check and the edit check on, through the dev
  console's caller (`ownerWebCaller()`, the owner's web surface, in the
  owner's request scope) and an app broker's at admin rules
  (`appBrokerCaller(web)`) and team rules (`appBrokerCaller(team)`, in the
  app's viewer scope, as the broker enters it), plus a recipe whose steps
  are reads (a nested step runs through the gate as the recipe's caller,
  read only). Arguments are made from each schema, with ids of items seeded
  first; a call may fail on its own terms, never as a read-only actor's
  write (42501 `ro_actor`). Two passes: edit check `on` (no answer, and no
  database error a handler turned into text, is the refusal) and `warn`
  (the refusal is a notice, so a handler that swallows the error is caught
  too). A read builtin of the test's own that writes an item is the
  control, caught directly and as a recipe's step in both passes. A real
  read tool caught there is a read-path write to name or move, never one
  to list so the test passes. The parity proof also compares the real
  preconditions in one case (`checkToolPreconditions` not stood in: a
  `page_update` whose id names an item the caller may not change answers
  the precondition's words, before the item rights), recorded on the
  baseline commit's sources and equal after the change.
- **The app caller and the surface agree (LOW-1).** `appBrokerCaller`
  reads `masks` off the surface it is given, while dispatch runs on
  `ctx.surface`. `dispatchTool` refuses an app caller that unmasks (made
  for the owner's web) on any other surface or on none
  (`APP_CALLER_SURFACE_ERROR`), never running it unmasked
  (`dispatch-broker-mask.test.ts`).
- **appToolRefusal can throw (LOW-3).** `GateNotReadyError` (a narrower
  or pre-run check not registered) and an error that is no access refusal
  go up through the broker as a 500: a misconfigured or failing process,
  never a caller's call. Said in its comment.
- **No tool path reads the session (LOW-4).** Inside a gated tool call
  `currentCaller()` is the tool's gate caller, so the session readers of
  `server/web/lib/auth` would throw or answer for the wrong caller.
  `packages/tools/src/tool-paths-no-session.test.ts`: no package source
  imports `@/lib/auth` or any module of server/web, and no server/web
  module registers a builtin handler. A hook server/web hands a package at
  boot is no import and is not seen; none reads the session today.

**Carried to A5 step 6** (from the step 3b audit; no change here):

- **LOW-2.** `gateCallerFor` sets no `facts.appRules` for an app broker's
  allowed call, so the member-app narrower passes every allowed run (the
  broker's verdict judged it first, and `appToolRefusal` sets the rules
  for a refusal only). In step 6, run the allowed call on the `app-tool`
  ref carrying the verdict, with `appRules`, so the gate judges the run
  it lets through by the same rule it refuses with.
- **A future `withViewer` fold into `GateCaller.enterScope`** (the gateway
  lens above). `scopeActor` (`packages/db/src/viewer.ts`, the workspace
  scope's actor) binds `login(member, 'rw')` for a login scope whose outer
  actor is not that login. Entered inside the gate, after step 3 bound the
  read-only actor, it would rebind a read-write one and undo the read-only
  rule. Enter the scope before the gate binds the call's actor (as the
  brokers do today: `withViewer` outside `dispatchTool`), or keep a
  read-only outer actor's mode in `scopeActor`.

**Carried to A8** (the matrix):

- **LOW-5.** `setDrawSvg` (`@mantle/content`, called from
  `server/web/lib/draw-snapshot.ts`) writes a draw's cached SVG from two
  reads, `GET /api/draws/:id/svg` and
  `GET /api/export/:id`, and is not a named read-path write
  (`READ_PATH_WRITES`). Name it (or move it to a worker) with the A8
  read-path matrix.

## Delete the lists; the carried items (A5 step 6a)

Plan section 23.3, step 6a: the derived views and the name-keyed
functions are deleted, and each consumer reads the tool's policy. With it,
the items carried to step 6 from the step 5 and step 3b audits, but the
ones named below as left.

**What was deleted.** In `@mantle/tools`: the view machinery of
`packages/tools/src/tool-policy.ts` (`policySlugSet`, `policySlugMap`,
`policySlugList`), `ADMIN_ONLY_TOOL_SLUGS`, `OWNER_ONLY_IN_SCOPE`,
`isAdminOnlyTool`, `adminGateLists`, `TOOL_ADMIN_AREAS`, `toolAdminArea`,
`AREA_SYSTEM_TOOLS` and `adminToolGate` (`admin-gate.ts`, which keeps the
area docs as comments), `CREATE_TOOL_SLUGS` (its file is gone),
`ITEM_WRITE_TARGETS` and `itemWriteTargetsOf`, `LOWERING_TOOL_SLUGS` and
`isLoweringCall`, `RECIPE_FORBIDDEN_SLUGS`, `BANNED_ITEM_TOOLS`,
`MEMBER_APP_REFUSED_SLUGS`, `UNTRUSTED_CONTENT_TOOL_SLUGS`, the app data
lists and `HEARTBEAT_EGRESS_SLUGS`. In `@mantle/mcp-core`: `mcpPolicySet`,
`mcpDefinitionSet`, `KEY_SHARED_CONTENT_TOOLS`,
`ADMIN_KIND_CREATE_TOOL_SLUGS`, `MCP_CREATE_TOOL_SLUGS`,
`PEER_RISKY_TOOL_SLUGS`, `MCP_HANDWRITTEN_READ_ONLY`,
`OWNER_KEY_SPENDING_TOOLS`, `LIST_TOOLS`, `TOOLSMITH_WRITE_SLUGS`,
`isPeerRiskyTool`, `ownerPeerAllows`, `isMcpToolReadOnly` and
`spendsOwnerKeys`.

**Which consumers moved, and what they read.** The policy table keeps one
lookup by name, `namedToolPolicy` (a builtin's, else an MCP surface
definition's), beside `builtinPolicy`; what a policy says is read with
`policyAdminOnly`, `policyArea`, `policySystemWhole`, `policyLowers`,
`policyMayLower`, `policyRecipeForbidden`, `policyRunItemBanned` and
`policyUntrusted`.

- The `tool` gate source (`builtinToolGatePolicy`) reads the policies of
  the tools a row names (its slug and its handler ref, as the lists
  matched both), the recipe envelope (`classifyRecipeStepTool`, the
  Toolsmith's reserved slugs) `recipe.step`, the run item ban (`parsePlan`
  and `server/web/lib/runs/execute-item.ts`) `recipe.runItem`, the
  member-app rule `memberApp` (`memberAppRefusedName`, with the three
  retired team tools that have no policy), the item pre-check
  (`builtinItems`, and `toolItemWriteRefusal` takes the policy's `items`),
  the untrusted fence (dispatch's recipe steps and the tool loop)
  `outside.untrusted`, the heartbeat egress gate `outside.egress`, the
  client-sourced gate the policy's `lowering` and effect through its
  injected `policyOf`, and the key email guard `keyEmail`.
- The team private-reads gate reads `privateCorpus` on the four mail and
  Journal reads (`assembleResponderTurn`'s `excludePrivateCorpus`: the team
  turn, a workspace run's resume, a workspace Telegram turn).
  `TEAM_PRIVATE_READ_SLUGS` stays exported from
  `packages/content-core/src/profile-projections.ts`, the published
  contract, for one jackdaw pair release, and
  `packages/runtime/src/tool-policy-snapshot.test.ts` pins it to the
  policies.

**The pins.** The tool list pins (`eslint-rules/no-policy-name-lists.mjs`,
the scoreboard's tool policy lists) come down from 5 lists in 5 files, 39
entries, to 1, 1 and 4: the contract list above. The three auto-grant lists
are read off their family's definitions (every tool but its delete), and
the deferred selection's core (`packages/tools/src/selection/deferred.ts`)
is not swept (`eslint-rules/arch-counts.mjs` `toolPolicySwept`): it orders
which granted tools a turn sends in full and never changes a grant, as the
system manifest's lists are grants.

**Proof, no behaviour change.** `tool-policy-snapshot.test.ts` derives
every former list from the policies against its literals, unchanged since
A5 step 1. `dispatch-parity.json`, the MCP snapshots (`tools-list.*.json`,
`mcp-calls.json`, `surface-*.json`) and `app-broker-parity.json` are byte
for byte. The MCP tests read the old names from a helper rebuilt over the
policies (`packages/mcp-core/src/policy-views.test-helper.ts`), and
`server/web/lib/auth/turn-gate-parity.test.ts` keeps `adminToolGate` as its
own oracle over the policies.

**Carried L1, closed: the owner-only and connector checks are narrowers.**
Two narrowers join the one gate's order: `owner-only`, first (the `tool`
source sets `fields.ownerOnly` by the handler ref; the caller says whether
the call's surface is the owner's, `facts.ownerSurface`, from dispatch's
call or the tool loop's own surface), and `connector`, last
(`packages/tools/src/connector-scope.ts`: the connector must be a resource
of the scope's workspace, a stale mark is refused, a write needs the Write
tick and a Moderator, a link scope reaches no connector; `gateCallerFor`
loads the resource rows for a connector row in a workspace scope). A tool
loop lists through the same caller (`loopToolRows` passes its surface and
owner) and the queue-time check reads them too. What stays at dispatch: a
read-only mark's inputs (only the call's arguments show them), a group
that is missing or disabled (its own words, first, as before), and for an
owner MCP connection the whole connector rule after its own pre-run check,
in the order that surface always answered.

No call answer changed (the parity files above). The list cells that
changed are listings of a tool whose call was refused, but for one: a
connector write a turn used to list and queue for the owner's approval
(the connector bullet below):

- An owner-only builtin (every builtin marked `ownerOnly`, `tree_folders`
  among them: scope any, listed before and refused at dispatch) is not
  listed on a loop whose surface is not the owner's (a team turn, a
  heartbeat fire on a team surface, a loop with no surface).
  `packages/tools/src/turn-listing.test.ts` and
  `packages/runtime/src/agent/tool-loop.listing.test.ts` pin both sides;
  a loop on the owner's web surface lists them as before.
- A connector write is not listed for a scope where no workspace holds the
  connector with its Write tick and the login as a Moderator (the listing
  tests' member turn: `crm_lookup`); a stale mark and a connector the
  scope does not hold are not listed either. **A behaviour change pending
  the owner's decision (fix round 1, LOW-1):** such a write used to be
  listed to a member turn and, when the model called it, queued for the
  owner's approval; it is now hidden from that turn, so it is never
  queued. Decided in step 6d (owner decision 1a, below): it is offered
  again only when its call waits for approval anyway.
- `responder_turn_input` and the persona description list through the
  same function, on the owner's web surface since fix round 1 (LOW-4), so
  only the connector cells apply to them.

**Carried LOW-2 of step 3b, closed: an allowed app call meets its
app-tool ref.** `appBrokerCaller` carries the rules its broker judged at
(by the surface `appToolScope` gave it: the owner's web for admin rules, a
contact share's, else team rules), and dispatch runs a broker's top-level
call inside the gate on its `app-tool` ref first, with the verdict that
allowed it and `facts.appRules`, then on its own ref as before. The
brokers did not change. `packages/tools/src/dispatch-app-run.test.ts`.

**Carried round-2 LOW-1 of step 5, closed: references by slug and by
path at queue time.** The queue-time check's context says `queue`. A
Recall map named by a slug that names nothing the queuing scope reads is
refused in the item check's not-in-scope words (the `recallMap` resolver's
unresolved set); a create's target folder named by its path (the new
policy field `createsIn`: `file_create`, `file_upload`, `folder_create`,
`file_copy`, `folder_copy`) that does not resolve in a queuing scope
outside Admin is refused the same way (a kind's root is structure, not
asked). A folder named by its id was already checked there (its
`node_exists` precondition reads in the scope). A call that runs answers as
before. `packages/tools/src/queue-time-refs.test.ts`.

**Carried round-2 LOW-2 of step 5, closed: gateCallRefusal runs no
side-effecting check.** It throws `PreRunSideEffectError` at a caller that
names its own pre-run check (an MCP connector row's check writes its audit
row); its two callers name none. The `GateCaller.preRun` comment no longer
says only enterCall runs it. `packages/db/src/gate.test.ts`.

**Carried L4, closed: a run item's third-party result.** The item's result
is stored with `untrusted: true` when the tool loop would fence it (the
policy's `outside.untrusted`, or dispatch's provenance flag), the compiled
state carries it per item, and `runStateUntrusted` says whether a run holds
any: `run_state` and `run_plan` answer `untrusted` (the loop fences the
whole result), and the resume turn
(`server/api/src/workflows/runs-resume-turn.ts`) fences the state it puts
in its prompt. `packages/runs/src/state-untrusted.test.ts`.
`telegram_pending`'s mark on the owner MCP surface stays unread, by design:
MCP hands a tool result to the login's own client as a tool result, and
the protocol has no place for a fence; the mark is read wherever a
Mantle model reads the result (a recipe step, a run item).

**What remains.**

- **Step 6b, per release:** delete a tool's `policy.items` only when its
  database check exists with a test and `mantle.edit_check` is on on
  every box of the release.
- **Step 6c, the approval re-check (M2 at approval):** re-check the
  originating scope when a pending call is approved; the pending row must
  carry the scope whole (its moderator set and Admin view), a migration.
- **L5, an owner question:** the heartbeat egress gate covers builtins by
  their policy only, never a runtime row, and a run ignores egress. Should
  a run item (and an http or connector row) honour the egress gate?
- **The `withViewer` fold** into `GateCaller.enterScope` (step 3b).
- **Kept by design:** `TEAM_PRIVATE_READ_SLUGS` (the contract, one pair
  release), the three retired team tool names `memberAppRefusedName`
  refuses with no policy, `PEER_RISKY_TOOL_PREFIXES` (the family sweep's),
  and the deferred selection's core.

### Step 6a fix round 1

**M1, the queue-time create check reads what the handler makes.** A
create that makes the missing folders of its path itself (the new policy
field `makesFolders`: `file_create`, whose handler runs `ensureFolderPath`)
is asked of the deepest folder of its path, cut to the depth the handler
cuts it to (`clampFilesFolderPath`), that the queuing scope reads: a new
subfolder under a folder of the scope's queues (and a `folder_create` then
a `file_create` into the new folder, both queued); a path with no folder
the scope reads is refused. Every other `createsIn` tool still needs the
folder itself. A Recall map the queuing scope does not find is not refused
in a scope that holds Admin (as the folder check skips it): a
`recall_map_create` then a `recall_card_put`, both queued, both queue. The
refusals say what to name instead and never send the model to look for a
folder or map that may not exist. The folders are read in the scope
(`foldersReadOf`, `@mantle/db` item-rights.ts), so one the scope does not
read is never told apart from one that does not exist: a subfolder hidden
from the scope under a folder it reads looks new, and the approver sees the
path. `packages/tools/src/queue-time-refs.test.ts`, and end to end through
`turnCallRefusal`, the gate's item pre-check and the folder check:
`packages/tools/src/queue-folder-e2e.test.ts`.

**M2, an app broker's run carries the broker's real verdict.**
`appBrokerCaller(surface, verdict)` takes the verdict the broker judged the
call by, and dispatch puts that verdict on the call's `app-tool` ref, where
it used to make up `{ ok: true }`. A refused verdict is refused by the gate
in its own words even where a broker forgot its own pre-check; a caller
with no verdict, or an allowed one for another tool, is refused
(`APP_VERDICT_MISSING_ERROR`). The three brokers pass the verdict they
already had; their answers are unchanged
(`server/web/lib/__snapshots__/app-broker-parity.json`).
`packages/tools/src/dispatch-app-run.test.ts`.

**LOW-3, one rule for the owner's surface.** The tool loop kept its own
copy of `isOwnerSurface`; it now passes its surface to `turnListedTools`,
which reads it with `surface.ts` `isOwnerSurface`, as `turnCallRefusal`
reads the call's (the loop's masking reads the same function, from the new
`@mantle/tools/surface` subpath). `packages/tools/src/turn-listing.test.ts`
asks the listing and the refusal on the same surface.

**LOW-4, the reported tool list is the sent one.** `loopToolRows` now
requires the surface. `describeResponderTurnInput` lists on the surface its
simulated turn runs on (the owner's web, with the login when it has one),
and `describeResponderPersona` on the owner's web, as
`runSimulatedResponderTurn` runs the responder; neither lists without a
surface any more. `packages/runtime/src/assistant/turn-input.test.ts`.

**LOW-5, the connector narrower fails closed.** Facts loaded for another
connector group than the row's used to let the call through; they are now
refused (`CONNECTOR_FACTS_MISMATCH_ERROR`). The facts are loaded per row
(by the row's own group slug), so no call that ran before meets it.
`packages/tools/src/gate-narrowers-l1.test.ts`.

**LOW-6, a run marks every third-party text it stores.** One rule,
`outcomeIsThirdParty` (`packages/tools/src/third-party.ts`): a result the
tool loop fences, and a failure of an http, connector or recipe row (or of
a tool whose policy says `outside.untrusted`), whose error quotes the
remote answer. A tool_call item's failure is stored marked as its result
is, so the state's outcome line and the resume prompt read it fenced; a
tool loop's call record says `untrusted` when the model read such text,
and a run worker's reply (or its empty-output failure) after one is stored
marked. `packages/tools/src/third-party.test.ts`,
`packages/runtime/src/agent/tool-loop.test.ts`,
`server/api/src/workflows/runs-worker-turn.test.ts`,
`server/web/lib/runs/execute-item.db.test.ts`.

**LOW-7, auto-grant is named tool by tool.** Step 6a read the auto-grant
lists as "every tool of the family but its delete", so a new contact,
journal or formula tool would have been granted to every conversational
agent silently. Each definition now says `autoGrant: true` itself (the
fifteen of today: five contact, five journal, five formula tools), the
lists read that field, and `packages/tools/src/destructive-coverage.test.ts`
pins the set.

**LOW-9, the architecture count leaves out only the deferred core.** The
count left out the whole of `selection/deferred.ts`. `CORE_TOOL_SLUGS` now
lives alone in `packages/tools/src/selection/core.ts` (deferred.ts
re-exports it), and only that file is left out (`toolPolicySwept`), so a
future access list in deferred.ts is counted.
`eslint-rules/arch-lints.test.ts`.

## One egress fetch and the background fence (A10 part 1)

Folds 3 and 4 of the gateway survey, written up in [egress.md](egress.md):
every fetch of a URL a user, a model, a remote server or a linked peer gave
goes through `egressFetch` (`packages/std/src/egress.ts`: the address check
on every redirect hop, secret headers dropped across origins, a deadline, a
streamed byte cap, `allowLan` per caller config), and the background jobs
that read outside text (the extractor, the reflector, the conversation
summarizer, `summarize_text`) fence it as the live turn does
(`packages/std/src/fence.ts`). Proven the way this file proves a move:
the egress tables and the background prompts recorded before, compared
after, every changed cell named. Pins: `mantle-egress/no-bare-fetch` and
the scoreboard's `bareFetchSites` (12 to 5).

## Registries, the tool call audit, owner decision 1a (A5 step 6d)

Plan sections 29 and 30; gateway survey findings 14 and 6.

**Survey 14: the tool-name registries move onto the definitions.** Every
per-tool list keyed by name outside the policies is gone:

- `WRITE_RULES` (`client-sourced-rules.ts`, 185 entries): each builtin
  write declares its client-sourced rule on its policy (`clientSourced`,
  the shapes in `client-sourced-rule.ts`); a lowering tool is the lowering
  rule and a create's `createsIn` path is a destination the guard checks.
  Proof: `packages/tools/src/client-sourced-rules.oracle.test.ts` holds
  main's `WRITE_RULES` and dispatch, and the guard's verdict equals main's
  for every builtin, input shape and stub database answer (over 50,000
  cases).
- `USAGE_TIERS` (deferred selection): each definition carries its
  `usageTier`; the retired `recall_window` is dropped. Proof:
  `packages/tools/src/selection/deferred.usage.test.ts` holds main's list:
  the prior equals it but `recall_window`, so every search ranks as before.
- The heartbeat tools (three copies: `fire.ts`, the responder affordance
  list, the manifest's known externals): one definition field
  (`heartbeat`), each list read off it in its old order, so the sent tool
  lists are byte for byte (`packages/runtime/src/heartbeats/tools.test.ts`).
- `TOOL_FLOWS` names `app-data-mcp` (tables flow); a manifest test fails
  for any group the manifest ships that no flow names.
- `TEAM_RESPONDER_SLUG` has one source (the runtime's).

Pins: `toolPolicyLists` 1, `toolPolicyListFiles` 1, `toolPolicyEntries` 4
(`scripts/arch-scoreboard.pins.json`): the one list left is the
content-core contract list
(`packages/content-core/src/profile-projections.ts`), kept by design. The
deferred core (`selection/core.ts`) stays out of the count, as in 6a.

**Survey 6: one audit row for every tool write, on every surface.** The
gate writes it (`packages/db/src/call-audit.ts`, from `enterCall`). A call
of a tool kind (`tool`, `runtime-tool`, `mcp-tool`: the spec
`packages/tools/src/call-audit.ts` registers with the narrowers) runs in an
audit frame; after it ran, a call whose policy writes and whose result
succeeded leaves one `api.write` row: method `TOOL` (or `MCP` on an MCP
connection, path `/api/mcp` over HTTP), the login (its email; else the
actor kind and entry), the request's ip and user agent in the web server,
and `detail` with the tool, the builtin it runs, the row kind, the entry,
the via, the surface, the item ids it named or made (at most 20), the
writes nested in it (at most 50), a peer or OAuth client id, and for an
approved pending call its `approver` (fix round 1: the row's actor is whose
rights the call ran with, its asker's, or for an elevated call its
approver's; on MCP the row is `pending_approve`'s and names the approver
too). Fire and forget (`callAuditsSettled` for tests), written once the
transaction the call's writes joined commits (`afterOuterCommit`: a request's
write transaction, a scope's), so a rolled-back call leaves no row; outside
one (a turn's per-query transactions, a process's own call), at once. Off
until a process starts it (`startCallAudit` in every process entry, pinned
by `gate-boot.test.ts`; off in detached dev).

- Reads, refusals and failed results leave none.
- A write nested in another audited call (a recipe's step, a delegated
  agent's call, `pending_approve` running the call it approves) is named
  in the outer call's `detail.nested`, never a row of its own: one call,
  one row. A recipe row writes only through its steps; a recipe of reads
  leaves none.
- A write whose policy says it is routine internal state
  (`ToolPolicy.auditRow: false`, read off the policy, never a list:
  `heartbeat_update_state`, a heartbeat's own scratch state, once per
  fire) leaves none, so `audit_log` does not grow per heartbeat fire.
- No surface writes twice. A surface that writes the call's row itself
  says so in one place, the call's audit frame flag: set from inside the
  call by `markCallAudited` (a login's MCP connector call, its
  `mcp.connector.*` row) or by its caller (an API key's MCP call, whose
  route writes the row before it runs, `auditMcpKeyCall`, unchanged: its
  gate caller carries `facts.audit.byRoute`). The gate writes none for
  either, nested writes and all (fix round 1: one mechanism where there were
  two, `packages/db/src/call-audit.test.ts`,
  `packages/mcp-core/src/connector-check.test.ts`). `tool.external_access`
  (opening or closing a tool) is not a call. An HTTP route's own
  `api.write` row (`auditMutation`, `auditsAsWrite`) is unchanged: it
  records the request (its method and path, no tool); the gate's row
  records the tool write the request caused, so a dev console run, an app
  broker write and a `/api/v1` route's write (a key's) leave the route's
  row and one tool row. The gate stays the one writer of tool rows; the
  MCP key route's row is the one exception, kept as main had it.

The table (tool-call rows, `api.write` naming a tool; a real note read with
`note_get` and written with `note_update`, real handlers:
`server/web/server/a5-call-audit.db.test.ts`, which runs the before column
with the gate's row off; `packages/tools/src/call-audit.test.ts` runs every
dispatch entry with a sink):

| entry                | before: read | before: write | after: read | after: write                       |
| -------------------- | ------------ | ------------- | ----------- | ---------------------------------- |
| web turn             | 0            | 0             | 0           | 1                                  |
| Telegram turn        | 0            | 0             | 0           | 1                                  |
| heartbeat (its turn) | 0            | 0             | 0           | 1                                  |
| run item             | 0            | 0             | 0           | 1                                  |
| recipe step          | 0            | 0             | 0           | 1 (the recipe's row names it)      |
| pending approval     | 0            | 0             | 0           | 1                                  |
| app broker           | 0            | 0             | 0           | 1                                  |
| dev console          | 0            | 0             | 0           | 1                                  |
| MCP OAuth login      | 0            | 0             | 0           | 1                                  |
| MCP stdio            | 0            | 0             | 0           | 1                                  |
| MCP key              | 0            | 1 (route)     | 0           | 1 (route, unchanged; gate 0)       |
| `/api/v1` key route  | 0            | 0             | 0           | 1 (gate; beside the request's row) |

Volume: one row per successful tool write, about half a kilobyte each (the
detail is capped). A brain already wrote a row per mutating HTTP request;
an agent that writes in a loop (`table_row_add` per row) now writes a row
per call, where a batch tool (`table_rows_add`) writes one. A heartbeat's
own state write (`heartbeat_update_state`) writes none (fix round 1).
Nothing prunes `audit_log`; a box that writes heavily should watch its size.

**Owner decision 1a (plan section 30).** Since 6a a connector write the
turn's scope may not make itself (the connector's Write tick off in its
workspace, or the login not a Moderator there) was hidden. Now it is
offered only when its call waits for approval anyway: a `requires_confirm`
tool, or any write of a loop whose turn is client-sourced already when it
lists (the loop's taint, `loopToolRows`' `taint`). Queued, the row carries
`pending_tool_calls.elevated` (migration 0287, `{"elevated": true,
"reason": ...}`, set by the server, never by the model). A call that would
run directly stays hidden and refused. Only the write rule is lifted
(`elevatedConnectorFacts`): a link scope, a connector the scope does not
hold and a stale mark are refused as before. The listing
(`turnListedTools`) and the queue-time check (`turnCallRefusal`'s `queue`)
read the same lifted caller, so a waiting call is offered exactly when it
queues (`packages/tools/src/turn-listing.test.ts`,
`packages/runtime/src/agent/tool-loop.test.ts`). What describes a turn's
tools (`responder_turn_input`, the responder persona) derives the turn's
taint the way the turn does (`responderTurnTaint`) and lists with it, so a
client-sourced turn is described with what it is offered (fix round 1).

**Who approves an elevated call (fix round 1, the CEO's rule).** One place,
`approvePendingCall` (`packages/tools/src/pending.ts`) through
`elevatedApproval` (`packages/tools/src/pending-approval.ts`), so every
path that approves gets it with no code of its own: the web's
`PATCH /api/pending/:id`, MCP `pending_approve`, a Telegram card's tap
(`server/web/lib/telegram-approval.ts`, from
`packages/telegram/src/sync.ts`), and any batch that calls it.

- Its asker (`login_id`) never approves it, on any path: refused
  (`ELEVATED_SELF_APPROVAL_ERROR`), and it stays pending. A refusal is
  `ApprovalRefusedError`, a row of the domain error table (403 on the web
  through `app.onError`; its message on MCP and Telegram), so no route
  catches it.
- The owner (the anchor login) approves it, and it runs with the owner's
  rights: the connector's write rule passes; a link scope, a connector the
  workspace the call was asked in does not hold and a stale mark are still
  refused.
- Any other login approves it only when its OWN scope passes the connector
  rule in the workspace the call was asked in (a Moderator there, the
  connector's Write on), read at approval time (`loginScopeFor`), and it
  runs with that login's rights; else it is refused
  (`ELEVATED_APPROVER_ERROR`) and stays pending.
- The rule is judged before the row is claimed, by the gate's own steps
  (`gateCallRefusal`) with the caller dispatch then runs the call as (a
  `pendingCaller` whose `approval` names the scope its connector rule
  reads, whatever scope the approving surface runs in: a Telegram tap runs
  in none). Who decides is read one way everywhere (`deciderOf`: the
  scope's login, else the login the path names, else the owner).
- The row is read and claimed on the system pool
  (`packages/db/src/pending-elevated.ts`): a scope's row rule shows a login
  only its own calls, which by definition an elevated call is not.

A call that is not elevated keeps main's rule of who decides: a login other
than the owner decides only the calls queued for it (`deciderFilter`), and
the call runs as its asker; the owner decides every call. Since step 6c it
is judged again, and run, in the scope it was asked in (below). The tests: every path
and approver on a real database
(`server/web/server/a5-elevated-approval.db.test.ts`), the rule through the
real gate (`packages/tools/src/pending-approval.test.ts`), the claim
(`packages/tools/src/pending.test.ts`).

What the approver is told: the pending summary (`/api/pending`,
`pending_list`, `pending_get`) carries `elevated.reason`, which says an
Admin user must approve it (the owner, or someone with write rights on this
connector) and that the person asking cannot approve it themselves; the
Telegram card says it and goes to the owner's chat, never the asker's
(`pending-notify.ts`); the model's queued message says it. A call queued
by a turn that read text a client wrote carries
`pending_tool_calls.client_sourced` (0287, `{"via": ...}`): the summary,
the card ("approve only if you asked for this yourself") and the trace say
so, so an approver can spot a request a client's text led to.

Snapshots: `dispatch-parity`, the MCP `tools-list` matrix and `mcp-calls`,
`tool-policy-snapshot` and `app-broker-parity` are byte-identical (fix round
1 too: `auditRow`, on `heartbeat_update_state` only, is read by the audit
alone and is in no snapshot). The 1a
listing cells are new rows of the turn listing tests (a `requires_confirm`
connector write: offered to a member turn that is no Moderator, or whose
connector's Write tick is off); the existing cells (`crm_lookup`, no
confirm: hidden) are unchanged.

The data modules stay data (fix round 1): the system manifest reads the
runtime's slugs and heartbeat tool definitions from leaf modules with no
run-time imports (`@mantle/runtime/slugs`, `@mantle/runtime/heartbeats/specs`),
not from the assistant or heartbeat runtime (pinned by
`server/web/lib/system-manifest/manifest.test.ts`).

Jackdaw follow-up: the pending card should show `elevated.reason` as a
badge with its text (an Admin user must approve; the asker cannot), hide
Approve for the asker, and show `client_sourced` as a warning.

**What is left.**

- **Step 6b, after W9, per release:** delete a tool's `policy.items` only
  when its database check exists with a test and `mantle.edit_check` is on
  on every box of the release.
- **Step 6c, the approval re-check:** done, below.
- **Listing for approvers:** on a scoped surface (a login's own MCP)
  `pending_list` shows a login only its own calls, so an Admin user with
  write rights finds an elevated call by its id (the owner's card, the
  web), not in that list.
- **Egress as a gate concept** (owner decision 2b): not in this step.

## The owner's decisions on the A8 findings (plan v2, section 32)

The A8 matrix found three cells where a way in answered other than the
guide (F1 to F3). The owner decided each; this section names what changed,
cell by cell. `server/web/server/a8-findings.db.test.ts` proves it on a
database and prints every cell's answer, so a run on the code before
records the answers it changes.

**F1 (a): a key of a login outside Admin on `/api/v1`.** A v1 route answers
a login as its base route does (D3): the route its file re-exports
(ROUTE_POLICY `aliasOf`), or the key table's `base` for a v1 file with a
handler of its own (`PATCH /api/v1/pages/:id` is `PATCH /api/pages/:id`,
the download is `GET /api/files/files/:id`). `buildRouteRow`
(`server/web/lib/auth/route-policy.ts`) takes the v1 row's login list from
its base, the owner lists only (`v1BaseLogins`): a member reads and writes
through a v1 row exactly where the base row admits it, in its own scope,
with the base's item write gate. No base (the table row writes, which run a
builtin on the owner's surface): Admin users only, as before. The owner's
and every Admin user's key is unchanged (but for `?ws=` and the page PATCH
below, fix round 1).

- Changed cells: a member key (and a member session or device token) on
  `GET` and `HEAD` of `/api/v1/{search, nodes/:id, notes, notes/:id, tasks,
tasks/:id, pages, pages/:id, tables, tables/:id, tables/:id/rows, files,
files/:id, files/:id/download, events}` and `POST /api/v1/{notes, tasks,
pages, events, files, tables/:id/commit}`, `PATCH /api/v1/{tasks/:id,
pages/:id}`: 403 `member-login` before, the base route's answer now (its
  read, its 403 `item-workspace` for an item the login may not change).
  Reason: the guide's "a key acts as the login that made it".
- Unchanged: `/api/v1/contacts`, `/api/v1/journal` (their base routes are
  Admin only), `POST /api/v1/tables/:id/rows` and `PATCH
/api/v1/tables/:id/rows/:rowId` (no base), 403 `member-login`.
- `?ws=` on a v1 create (fix round 1, L3, owner decision: yes): a v1 row
  takes `creates` from its base too (`buildRouteRow`), so `POST
/api/v1/{pages, notes, tasks, files, events}?ws=<id>` reads `?ws=` as
  its base route does, for every key (the owner's and every Admin user's
  too). Changed cells: each of those five with `?ws=`, for every key: the
  item landed by the login's default home rule before (`?ws=` ignored),
  in the named workspace now, or the base route's refusal of it. Without
  `?ws=`: unchanged. `route-policy.test.ts` checks every v1 row's base, a
  member's reach and `creates` against lists written by hand, not against
  the code.
- The page PATCH's own key rules read the page (a shared page's content
  is refused to a key): every key first meets the page route's item gate
  (`ownerCallerAtRead()`, read by the v1 wrapper before its rules; fix
  round 1, L4, which replaced a second query of its own), so a page its
  login does not read gets the base route's answer to that login and the
  rule tells it nothing about it. Changed cell: an Admin user's key on a
  shared page outside its scope, 403 `key-shared-item` before, the item
  gate's 403 `item-workspace` ("Add yourself to it first", as the page
  route answers an Admin user) now.
- The A4 sweeps record it: only member credentials on v1 rows changed
  (`a4-guard-sweep*.txt`), and the member sweep and the field check read a
  v1 row's member admission from its ROUTE_POLICY row.

**F2 (a): a workspace assistant's turn writes.** An assistant of a
workspace other than Admin writes with the rights of the user it answers,
in its own workspace (plan 4.2). A create from such a turn lands where the
home rule puts it (A0, F12; `turn-create-home.ts`): in the workspace for a
Moderator of it, in the user's private workspace for a plain user. One rule, `turnScopeWrites`
(`packages/db/src/viewer.ts`): a turn that answers a login writes; one that
answers none writes only when it acts for the owner (the Admin assistant).
`withAgentScope` (`packages/runtime/src/agent/agent-viewer.ts`) enters every
assistant turn with it, and an approved pending call (`originRunFor`,
`packages/tools/src/pending-origin.ts`) asks the same rule, so the direct
turn and the approval share one write scope builder. A turn with writes on
runs each write as a short transaction of the login write gateway with the
turn's scope set on it (`loginWriteRoute`; `withSystemTx` on the write role
or the system pool with the scope's settings), as a login's mutating
request does. No transaction is held across a model call. The scope is the
assistant's workspace and the user's Moderator seat there only: a seat in
any other workspace never counts (the A8 cells the guide is silent on stay
deny).

- Changed cells (each refused before, with a raw text): the edit and delete
  of an item a Moderator of the assistant's workspace may change, the edit
  of an item granted to it with Write on (any user of it), a create (a
  Moderator's in the workspace, a plain user's in their private
  workspace), and a move into a folder of the workspace (on an owner-side
  surface: the web, Telegram, a recipe in a turn), on the web turn, the
  team turn, Telegram, a run item and a recipe step. Reason: the guide's
  "it writes only for a user who could do it by hand".
- The web turn (fix round 1, finding 8): the tool loop enters a turn's
  scope with the login its surface names (`surfaceLoginId` for a team or
  Telegram chat, `ownerSurfaceLogin` for a web chat). A workspace
  assistant read only the first, so on the real web path it answered no
  login and only read (the A8 cell had passed the login itself).
  `withAgentScope` now answers a web chat's signed-in login when it is a
  user of the workspace; any other web login's turn answers none and only
  reads, as before. Changed cell: a web chat with a workspace assistant,
  by a user of that workspace: read only before, the user's rights now.
  The A8 cells enter every surface's scope as the tool loop does.
- The Moderator seat (fix round 1, L5): a turn's scope carries the seat
  read when the turn began. Before each write call of a turn or a run item
  that holds a seat, the item pre-check reads it again (one indexed read of
  `workspace_users`, `packages/tools/src/moderator-seat.ts`); a seat taken
  away since refuses the call (`MODERATOR_SEAT_CHANGED`), and the next turn
  reads the seats afresh. Changed cell: a write in a turn whose seat was
  taken away during it, written before, refused now.
- Unchanged: an item with Write off, an item not granted to the
  workspace, a delete or move that needs a seat outside it, and every
  write of a plain user of the workspace on an item homed there: refused,
  now in the mapper's words. A turn with no user (a heartbeat) only reads.
  `tree_item_move` stays an owner-side tool (refused on the team turn and a
  run item, which names no surface).
- The A8 surface cells of F2 (`a8-known-failures.ts`) pass.
- Every write a workspace turn reaches (scope `any`) declares the items it
  changes (`policy.items`, read by the item pre-check), what it creates, or
  a reason it changes none (`item-write-gate.test.ts`, fix round 1, L6).
  `a8-findings.db.test.ts` also runs with the actor check and the edit
  check on (`pnpm test:edit-on`).

**The raw text.** No turn hands a model, or the person, the database's or
the runtime's own text. Dispatch masks every assistant turn, run item and
approved pending call (`MODEL_ENTRIES`, `packages/tools/src/dispatch.ts`),
the owner's turn too, and the tool loop masks every call again (it skipped
the owner's unscoped turn before). Besides a database error (the one
mapper's words), a runtime fault says `RUNTIME_ERROR_PUBLIC`, the detail
in the server log. A runtime fault is known by its class, never by its
text (fix round 1, M2): `RuntimeFaultError` (`packages/std/src/index.ts`),
which the scope and transaction guards of `@mantle/db` throw
(`withSystemTx`, the scope runners, `ScopeLostError`,
`NestedSystemTxError`, `TurnScopeExitError`, `ActorMissingError`, the
gate's own); `errorMessage` collects its text during a call as it does a
database error's, so a reply that repeats it is caught too. A third
party's output passes through as before, so the model can fix its call: a
shell tool's stderr with a stack, an MCP connector's, a peer's or an API
tool's answer from an outside Postgres ("violates not-null constraint").
An MCP call's thrown fault says the same (`thrownToolDatabaseError`). The
dev console (the owner's own web, `ownerWebCaller`) still reads the text,
as before.

What a person reads of a failed turn (fix round 1, M1): an assistant turn
that throws outside a tool call (web, Telegram, the owner's too) stores
and streams `publicProviderErrorMessage(err, 'assistant-turn')`, as the
team turn does; a heartbeat's fire row and its pause reason keep the same
public text (`firePublicText`, `packages/runtime/src/heartbeats/fire.ts`).
The detail stays in the server log.

**F3: app delete (the owner's decision of 2026-10-15, plan section 34).**
Delete an app: its home Moderator, Admin users and the owner. It goes to
Recently deleted with a snapshot; an app a non-owner deleted waits there
until the owner deletes it for good. A
delete is an archive (a non-owner's delete is never purged by itself), as a
Moderator's delete of a page is. This is what the product does. The guide
says so (docs/workspaces.md, "Apps", **Delete**).

**Approval (fix round 1, finding 8).** `a8-findings.db.test.ts` queues a
call of a workspace turn through the tool loop's queue path and approves
it: a Moderator's and a plain user's `task_update` (requires confirm)
approved by the owner run in the scope they were asked in and write; a
plain user's connector write is elevated, and its asker never approves it,
another plain user without the connector's write rights in the workspace
cannot either (it stays pending), the workspace's Moderator (the
connector's Write on) and the owner can (plan section 31).

## The approval re-check (A5 step 6c)

Plan step 6c (M2 at approval): a call queued for approval is judged again
when it is approved, in the scope it was asked in, and runs there. Before
it, an elevated call's connector rule was re-checked (6d); every other call
ran with its asker's rights now, in whatever scope the approving path ran
in: none at all on the web, a Telegram tap and a batch (the system pool, as
its asker's login), the approver's own scope over MCP.

**The stamp (migration 0288).** `pending_tool_calls.origin` (jsonb,
nullable) holds the scope the asking turn ran in, set by the server at
queue time (`pendingOriginNow`, `packages/tools/src/pending-origin.ts`),
never from model arguments: by the tool loop's queue path
(`execute-call.ts`) and the agent queue helpers (`pending-queue.ts`, the
Toolsmith's group tools). Its shape (`PendingOrigin`, version 1):

| field     | what                                                                                                     |
| --------- | -------------------------------------------------------------------------------------------------------- |
| `scope`   | the turn's scope whole: `kind`, `loginId`, `ws`, `modWs` (its Moderator set); null: the turn ran in none |
| `enter`   | how the turn held it: `turn` (a turn scope) or `gate` (the rollback switch's gate scope)                 |
| `writes`  | the turn scope wrote as an Admin turn does                                                               |
| `admin`   | the Admin view it had: `holds` (Admin) and `areas` (the Admin areas it could do)                         |
| `surface` | the surface it ran on: `kind`, an owner path's `via`, the `loginId` it names (no chat or account id)     |
| `link`    | the turn ran in a public link's scope (its scope is then not stamped: see fix round 1)                   |
| `actor`   | the actor the turn ran as (an assistant's, a login's, the system's), for a row that names no asker       |

A row queued before 0288, or by no turn (a run's question or budget pause,
the dev console's test row), has none: it is approved by **the legacy rule**,
its asker's rights now in the scope of the path that approves, as before.

**The re-check rule.** In `approvePendingCall` (the one place: every path
that approves, the web's `PATCH /api/pending/:id`, MCP `pending_approve`, a
Telegram tap, a batch, with no code of its own), for every row that is not
elevated and carries a stamp, before the row is claimed
(`originApproval`, `packages/tools/src/pending-approval.ts`):

0. The row is read on the system pool (`pendingCallToDecide`,
   `packages/db/src/pending-elevated.ts`), not in the approving path's
   scope, whose row rule (0254) shows a login only its own rows of the
   workspaces it holds now: the owner's MCP, an Admin assistant's turn and
   an asker who left the workspace would read nothing, and the call would
   go unjudged (fix round 1). Who may decide it is `deciderFilter`'s rule,
   applied to the row read (`decidesRow`); a login that may not decide it
   judges nothing, and its claim matches nothing.
1. The scope is the stamp met with the asker's rights now (`originRunFor`):
   its workspaces are the stamp's the asker still holds (`loginScopeFor`;
   a turn that answered no login, a workspace assistant's heartbeat: the
   stamp's its assistant still runs in, while live, and the Moderator seats
   the stamp named there), its Moderator workspaces the same. A right
   the asker gained since (another workspace, a Moderator seat) is not the
   call's: it never runs wider than where it was asked. No workspace left:
   refused (`PENDING_SCOPE_LOST_ERROR`).
2. Its Admin view is what the scope holds now, capped by the stamp's
   (`capAdminView` in `gateCallerFor`, off the approval's `adminCap`).
3. In that scope (`withOriginScope`: a named exit, `pending-approval`, from
   the approving path's scope, straight into the asked one), as the call's
   actor (its asker as it is now; a row with no asker the actor its turn
   ran as, the stamp's, never the approving path's),
   the queue-time check runs again (`approvalCallRefusal`, the same steps
   `turnCallRefusal` ran: the gate's steps 3 to 5, the narrowers, the
   pre-run checks with the item pre-check and the queue's reference rule),
   for the call's arguments and the surface it was asked on (a Telegram
   chat's as an owner path naming its login: the chat id is not stamped),
   with the
   caller dispatch then runs it as (`pendingCaller`, its approver, the cap,
   what was narrowed).
4. A refusal throws `ApprovalRefusedError` (the domain error table: 403 on
   the web, its message on MCP and Telegram), the gate's words after
   `PENDING_RECHECK_ERROR`. **The row stays pending, untouched**: who
   approves does not change the answer (the re-check judges the call, not
   the approver), the asker's rights may come back, and an approver can
   reject it. Marking it refused would decide for the approver.
5. Passed, the row is claimed as before (`deciderFilter`: who decides is
   unchanged) and the call runs in the same scope as the same actor, on
   the surface it was judged on: a handler that reads its author or an
   owner-only rule off the surface (`ownerSurfaceLoginId`, `isOwnerSurface`:
   `app_create`'s author, a share's, a workspace listing's login) sees the
   asker, never the approver, who is named on the caller (the audit row's
   `approver`). A stamped call whose tool is gone or disabled is refused
   before the claim (`PENDING_NO_TOOL_ERROR`), never run by the legacy rule;
   one claimed without being judged (decided between the read and the
   claim) is put back, pending, and refused (`PENDING_NOT_RECHECKED_ERROR`).
   An
   approved call of a login is that login's write request in the asked
   scope: it writes as a login's mutating request does there (the login
   write gateway, the scope on its transactions, the database's checks
   against it), whatever the turn's own mode (a workspace turn other than
   Admin's writes none itself). A turn that answered no login keeps its
   mode.

An elevated row keeps 6d's rule unchanged (`elevatedApproval`). The audit
row (6d) still names its approver and, when the re-check narrowed anything,
what (`detail.narrowed`: `workspaces`, `moderator`, `admin`, `areas`: what
the asker had when it asked and has no more).

**6d's lows, closed.**

- L1: an elevated call whose tool is gone, disabled or has no policy is the
  owner's alone to approve (`ELEVATED_NO_TOOL_ERROR`): no gate step can
  judge it.
- L2: an elevated call that names no asker (`login_id` null) is the owner's
  alone (`ELEVATED_NO_ASKER_ERROR`).
- L3, the reject rule: whoever decides a call by `deciderFilter` may reject
  it (the owner every call, any other login the calls queued for it, so an
  elevated call's asker withdraws its own), and whoever may approve an
  elevated call may reject it too (`elevatedRejection`; the owner always,
  a call it could not run included), flipped on the system pool
  (`rejectElevatedPendingCall`). A rejection runs nothing, so it is not
  re-checked.
- L4: the owner is asked first, so "the owner may always approve" is
  literally true, a call the owner asked itself included.
- L5: which tools carry `ToolPolicy.auditRow: false` is pinned
  (`packages/runtime/src/audit-row-allowlist.test.ts`: only
  `heartbeat_update_state`).
- L6: the 0287 header says what the approver's rights are.

**Record, move, compare.** `server/web/server/a5-approval-recheck.db.test.ts`
queues each call through the real queue path (the tool loop's
`executeToolCall` in a Team assistant's turn, through the gate's queue-time
check), changes the asker's rights, and approves it on every path (the web
through the real app and its gate middleware with a session cookie, MCP
`pending_approve` on the approver's own OAuth connection, a Telegram tap, a
batch), for 3 askers (an Admin user and a member who moderate Team, a member
who does not: its connector write is elevated) x 3 approvers (the owner, the
asker, another Admin user) x 4 paths x 5 rights (none, lost workspace, lost
Moderator, lost item, gained) x 2 tools (a connector write, `note_update`):
360 cells, recorded on main first
(`a5-approval-recheck.main.json`; recorded again on main 7ba1afc95 in fix
round 1, byte-identical). 108 changed, each named with its reason in
`a5-approval-recheck.changes.json`:

| reason                | cells | what changed                                                                                                                                                                   |
| --------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runs-where-asked`    | 15    | runs in the asked Team turn scope as its asker, not unscoped or in the approver's MCP scope (where the owner's MCP approval of a Team call was claimed and then failed at run) |
| `gains-not-the-calls` | 15    | the same, with rights gained since: still only the asked scope                                                                                                                 |
| `lost-workspace`      | 26    | refused before the claim, left pending (main ran it unscoped, or over MCP claimed it in the approver's scope)                                                                  |
| `lost-moderator`      | 26    | refused by the connector write rule or the item rule again, left pending                                                                                                       |
| `lost-item`           | 26    | refused by the item pre-check or the connector rule again, left pending                                                                                                        |

Fix round 1 added 22 of them, all on MCP: the first record left the owner's
MCP approvals (`adminUser|owner|mcp|*`, `member|owner|mcp|*`) and an Admin
user's own MCP approval after it left Team (`adminUser|self|mcp|lostWorkspace|*`)
as on main, because the row was read in the approver's scope, which hid it.
Read on the system pool now, the owner's MCP approval runs the call in the
asked Team scope (none, gained) or refuses it before the claim (lost
workspace, Moderator seat, item); the Admin user's is refused (lost
workspace). Two more tests on a real database: the owner's MCP approval of a
member's call after the member left Team, while Admin holds the connector
with Write, is refused and left pending (it ran in the owner's scope before
the fix); an approved `app_create` names its asker as the app's author, not
its approver.

Every elevated cell is unchanged (6d's rule), and so is every cell where
the approver may not decide the call. The rule itself, without a database:
`packages/tools/src/pending-approval.test.ts` (through the real gate),
`pending-origin.test.ts` (the stamp, the cap), `pending.test.ts` (before the
claim, left pending, the legacy rule, the reject rule).

**Fix round 1, the lows.**

- A row with no asker runs as the actor its turn ran as (the stamp's
  `actor`; none stamped: the asking assistant), never the approving path's.
- A turn that answered no login keeps, at approval, the workspaces its
  assistant still runs in (`assistantWorkspaceIds`: the assistant's
  workspace now, while live) and the Moderator seats the stamp named there,
  rather than losing every seat; an assistant moved to another workspace
  loses the scope (refused).
- A turn in a public link's scope is stamped with no scope and `link: true`.
  The approval does not rebuild a link's scope: that needs its share (is it
  still live?) and its served list as they are now, which the row does not
  hold. So only the owner may approve such a call
  (`PENDING_LINK_OWNER_ERROR`), and it runs in no scope, as before the
  stamp. The rule is the approval's own, not left to `deciderFilter` (a
  link's row names no asker, so any scope with no login could decide it).

**What is left.**

- **Step 6b, after W9, per release** (above).
- **Listing for approvers** (above).
- **A workspace turn's own writes:** a workspace assistant's turn other than
  Admin's holds no write mode, so a write it makes itself fails
  (`withSystemTx` refuses it there); its approved calls write as their
  asker's write request (above), so an approval now does what the turn
  could not. Whether the turn should write the same way is its own step.
- **Egress as a gate concept** (owner decision 2b): not in this step.

## A8 matrix

The cross-surface matrix (plan v2, section 12 A8): every access rule of the
guide, checked against the database and against each way in, by one oracle
written from the guide alone.

**Run it.** `pnpm test:matrix` with `MANTLE_TEST_DATABASE_URL` set
(`vitest.matrix.config.ts`; the other configs leave `*.matrix.test.ts` out).
Without it every file skips, and the run says so in a banner ("A8 MATRIX
SKIPPED"), so a local `pnpm verify` with no test database does not read as
a pass (CI refuses to start without it). Each file makes its own scratch
database. On the workstation the whole run, the scratch databases
included, takes 1 to 3 minutes with `--maxWorkers=3` (the grid's cells 10
to 25 seconds over 4 workers, `MANTLE_MATRIX_WORKERS`; the surface cells 60
to 120 seconds over the three check modes; fix round 1 took 25 seconds in
all, with one mode and three placements). CI runs it as its own step.

**The oracle** is `expectedAccess(context, role, kind, action)` in
`packages/db/src/matrix/guide-oracle.ts`. It imports nothing: no kind
registry, no access matrix, no SQL, no gate. Each rule names the guide
section it reads (docs/workspaces.md; docs/update-prod.md for snapshot
copies; the plan's section 32 for an owner decision the guide does not
carry yet). The context names the surface, the placement and the actor
kind; the actor carries the narrowing (a turn: the assistant's workspace; a
read key or a peer with Write off: read only; an assistant with no user:
its workspace, read only). `guide-oracle.test.ts` pins it to the guide's
sentences. The grid also pins the registry's workspace class and accepted
kinds to the oracle's lists, so the two readings cannot drift apart unseen.

The guide is read once. A caller's standing on an item (`guideStanding`:
reads it, edits it, a Moderator of its home or of a workspace, an Admin
user, the owner) and the rules of "Items and grants" on it (`GUIDE_RULES`:
edit, delete, an app's code, a link, an app's data) live in
`guide-oracle.ts`; the A1 and A3a oracles in `oracle.ts` read them from
there (`expectedReadCreate` is `expectedAccess`'s read and create, and
`expectedWrite` takes its standing and rules), and their kinds are its
`GUIDE_WORKSPACE_KINDS`. The fold changed no answer: every answer of the
three oracles over every input was compared before and after, and only the
cells added on purpose (the Admin-homed placement, the contact share's
writes) differ. That comparison is a test now
(`packages/db/src/matrix/oracle-answers.test.ts`): every answer of the A1
oracle (read and create, and the folder counts), the A3a oracle (the
writes, and the refusal detail) and the A8 oracle over every input, pinned
by one sha256 per oracle, so a change anywhere fails, not only where a guide
sentence test or a grid cell looks. The inputs are the oracles' own lists,
the kinds the guide's workspace kinds and one of each other class (not the
registry's, so a kind the registry gains moves no hash).
`pnpm -C packages/db oracle:answers <oracle>` prints the answers, one input
a line, and with `--against <file>` the inputs whose answer changed: print
them before the change, diff after, then take the new hashes
(`oracle:answers` with no name prints them). The fixture's kinds and tree roots are one list too
(`A8_KINDS`, `a8RootOf` in `a8-grid.ts`), which the grid, the surface cells
and the grants panel test share.

**The fixture** (`packages/db/src/matrix/test-support/a8-grid.ts`, its header in
`guide-oracle.ts`): Admin; H, the items' home; W, a grant with Write on; R, a
grant with Write off; T, a target with no grant; O, unrelated; each login's
private workspace. Six logins: the owner, an Admin user, the Moderator of H
(and of R and T), a user of W (a Moderator of T, the snapshot copies'
author), a Moderator of R, an outsider. Per workspace kind four
placements: an item at its kind's root (grants by hand), one in folder F
(F's grants), for the accepted kinds the author's snapshot copy in
writeGrant's private workspace, and an item at its kind's root homed in
Admin with no other grant. The fixture's own writes are named system work
(`system:a8-fixture`), so a cell can make a fresh item with the check on.

**The SQL grid** (`a8-grid.matrix.test.ts`): 6 logins x 11 workspace kinds x
4 placements x 13 actions (read, list, search, edit, edit draft, delete,
move, add a grant, remove a grant, the Write switch, a public link, create,
app data) x every actor kind (login, login-ro and turn for each login;
assistant, link, contact-ro, contact-rw, peer and system once each), and
each write of the two Admin users once more as the product sends it today
(`login@system`, below). Each cell is one transaction, rolled back. A read
runs on the workspace role in the caller's scope; a write on a login of
the write role with the caller's scope, actor, write mode and create home
set by the gateway's own statement (`writeRoleSettingsSql`), the heads
first, both checks on; grants and home moves through the definers the
write role calls; system work, and a contact share's write (named system
work after the share's own check), on the system pool with its actor
(`setActorSql`). An Admin user's write request runs on the system pool
today (W6a M1, until A4 puts its reads in the scope), with the login's
scope and create home on the transaction and no `mantle.login_id`
(`withSystemTx`'s `systemPoolTx`): the `login@system` cells send it that
way, built by the same helper. A cell passes only on the row effect read
back through a probe (`a8_probe`, a definer the scratch database gets):
allowed is the change made, refused is no change with 42501 or no row
matched. Any other error fails the cell. The run pins the grid's size
(every combination, from the oracle's own lists) and its not-applicable
cells by reason, so no cell drops out uncounted.

**The surface cells** (`server/web/server/a8-surfaces.matrix.test.ts`): per
way in, a pairwise set of (role, kind, placement, action) over what the
surface can do (`pairwise` in `a8-grid.ts`), a fresh item per write cell:
web (HTTP through `createApp`: item reads and deletes, the grants panel),
`/api/v1` with the login's read-write key, MCP over OAuth, MCP with a
read-only key through the bearer lookup, a peer acting as the login with
Write on, stdio MCP as the owner, the web turn, the team turn, Telegram, a
run item (through the product's own executor, `executeRunItem` in
`server/web/lib/runs/execute-item.ts`: a run of the login as `createRun`
makes it, its workspace left to the stamp trigger (0250: the planning
agent's, none here, so NULL, Admin's), one tool_call item run as the runs
worker runs it, so the item meets the executor's checks, its actor and its
surface; and one always-run cell, an Admin user's run whose login leaves
Admin, its role and its seat, before the item runs: refused, fail closed),
a recipe step, a heartbeat (W's assistant with no user), the Admin assistant with no
user (it acts for the owner: login(owner) in the Admin turn scope, the
owner's turn to the oracle), a pending call queued in a turn and approved,
an open public link's view, and a contact share through the `/s` broker
with the contact's cookie (its view, and its app's data through
`/s/<token>/db-broker`, with Can write on and off; the app's SQLite is
stood in, as `contact-share-gate.db.test.ts` does, and the brain's side of
the write, the client-written stamp, is read back). The two heartbeats
send the surface `heartbeats/fire.ts` gives their turn, asked of the same
function fire.ts calls (`heartbeatSurface`, `heartbeats/surface.ts`): a
workspace assistant's fire a team surface with no login and private reads
off, the Admin assistant's the owner's web surface. Two deny cells stand
beside the pick (`contact-share-deny`), each refused in its own words: an
Informational app's data with Can write on (contact-rw: 403 "This app is
read-only.", "Informational wins over a share's Can write") and the
db-broker of a contact share of a kind that is no app (contact-ro, since
Can write needs an app: 404 "not found", the broker serves an app only). Every cell runs in each
actor check mode, off (the fleet's default), warn and on, the box's mode
and the process's set together, in that order: the process's mode is the
greater of `MANTLE_ACTOR_CHECK` and the box's mode it last read (read once
a minute, `packages/db/src/client.ts`), so a falling order could run a cell
in the mode before. The run asserts the order, sets the process's read of
the box at each step (`noteBoxActorCheckMode`), and checks the process's
and the box's mode before the cells. Allowed is ok and the
change made; refused is no change and an answer that is not a crash: a
5xx, a throw, or a raw text in the reply (`GENERIC`: a JavaScript error, a
query builder's or driver's "Failed query", a Postgres message or SQLSTATE
such as 42501, a relation or a column named, row security, the runtime's
own guards such as "withSystemTx: only outside a viewer scope", a stack
frame). A refused write that changed the row is reported as a change
first, whatever words it answered with. Each cell's actor misses fail it.
The pick is stable: the candidates are taken in the order of a hash of
their own name and the surface's name (so two ways in with the same
candidates spread over other combinations), first fit, never in the
registry's or the tool list's order, so a new kind or tool adds the cells
its new pairs need and leaves the others as they were. A decision's own
case runs whatever the pick (each Admin user's delete of an app homed in
Admin, and the home Moderator's of an app homed in H at its kind's root and
in its folder, on the web and over MCP: F3). Every tool slug a cell calls
must resolve, but the MCP-only ones (`note_delete`), whose cells on a
turn, a run, a recipe and a heartbeat are counted under their own reason.
A deny the oracle cannot see, since it knows no tools, narrows a cell and
the cell runs: a peer's risky tool (`peerRisky`: "Linked brains" lets a
peer call one only when its list allows it, and the fixture's peers allow
none), a tool that waits for approval (`app_delete`) in a recipe step
(`classifyRecipeStepTool`: a recipe calls none) or a run item (the
executor refuses it before dispatch, "Confirm-gated tools never run
headless"), an owner-side tool (`app_delete`, `ownerOnly`) in the team
chat (it calls none, for everyone: "owner-side tool: not available here"),
and every run cell of a login outside Admin ("run_plan is
Admin only": `run_plan` is adminOnly, and the executor refuses a planning
agent outside Admin, `below_admin`, so such a login's only run is one with
no workspace, Admin's, and `withRunScope` refuses it: "not a user of the
Admin workspace"). A narrowed run or recipe cell must be refused in its
own words (the approval wait, or the Admin seat), and the narrowed cells
are counted and pinned per way in and reason. A run item's outcome is
read from its row: done is allowed; failed as `tool_error` is a refusal,
and as `requires_confirm` only on a cell narrowed for it; anything else
(still ready or unclaimed, no item, `internal_error`, `tool_missing`,
`bad_payload`, `agent_missing`, `banned_tool`) is a crash, and
`internal_error` is in `GENERIC`. Those two are approval, not access, for everyone, the owner
too: the call waits for a human, in a turn (the pending cells) or on an
ask_human step of the run. The pending cells set a tool to wait for
approval for their call and leave it as it was. The not-applicable counts
are pinned by reason.

**The grants panel's database rule** (`server/web/server/a8-grants-panel.matrix.test.ts`):
the panel (`server/web/lib/grants.ts`) decides in TypeScript, then calls
`mantle_grant_change` and `mantle_grant_move_home` under the item's heads.
The test makes that decision wrong on purpose (the panel's read of the
caller's seats answers a Moderator seat of H the member does not hold) and
asks whether the database still refuses an add to T and a move to T, by
the route as the product runs it and in the member's own mutating request
scope, with the check off, warn and on. See F7.

**Counts** (F5 withdrawn, plan section 34): the grid 14,608 cells, 9,404
run (2,093 allow, 7,311 deny, of which 66 are the pinned guide-silent
denies), 9,048 pass, 356 known failures, 5,204 not applicable (fix rounds 3
and 4: 2,089 allow, 9,044 pass, 360 known; the home Moderator's 4 app
deletes are allowed now). Against fix round 1 (10,956 cells, 6,972 run,
3,984 not applicable) the difference is only what was added: the
Admin-homed placement (3,652 cells: 2,220 run, 1,432 not applicable) and
the contact share's 212 writes, not applicable before and denies now. The
surface cells 1,126 per check mode, 3,378 in all; 2 known failures in each
mode, both F6 (fix round 4, on v0.300.59: 1,123, 3,369 and 6, 4 of them
F5's; fix round 3: 1,122, 3,366 and 41). The three cells added are the home
Moderator's app delete at its kind's root on the web and over MCP and in
the team chat, run whatever the pick; the demoted run came in fix round 4.
The four run cells of F2 left the list (a run of a login outside Admin has
no workspace of its own now, and is refused cleanly), then F1's 13 and F2's
other 18, and F5's 4. The narrowed cells, pinned: 56 runs of a login
outside Admin, 5 runs and 3 recipe steps of `app_delete` (the approval
wait), 6 peer calls of `app_delete` (a risky tool), 3 team chat calls of
`app_delete` (an owner-side tool: the team chat calls none, for everyone),
the demoted run, and the two contact-share deny cells. The grants panel: 3
cases (one per check mode), pinned as found.

**Not applicable** cells are counted and named in the run's summary: a kind
with no draft, no app data, or no snapshot copy; a snapshot copy and an
Admin-homed item hold no grant but their home, and are no place to create
in (the Admin-homed item sits at its kind's root, where the root
placement's create already makes one); a link, a contact share and a peer
read through their share's own gate, not a scope (the surface cells check
the link and the contact share).

**Known failures** (`packages/db/src/matrix/a8-known-failures.ts`, by cell
and by a piece of the reason it fails with, each a finding for the owner;
a surface cell lists the check modes it fails in when not all three; a
listed cell failing for another reason fails the run like an unlisted one;
the list only shrinks, a listed cell that passes fails the run). The
owner decided F1 to F3 (plan section 32): F1 and F2 are fixed on their own
branch and leave the list when it lands; F3 is the guide's rule now.

- **F1** (fixed, feat/a8-findings, on main since v0.300.59). `/api/v1`
  answered 403 `member-login` to a key of a login outside Admin, where the
  guide says a key acts as its login and only narrows it. Its 13 surface
  cells pass and left the list.
- **F2** (fixed, feat/a8-findings, on main since v0.300.59). A workspace
  assistant's turn other than Admin's could not write an item its user may
  change by hand (the web turn, the team turn, Telegram, a recipe step), and
  answered in raw runtime or database text. Its turn writes with its user's
  rights now, and the raw text is masked. Its 20 surface cells pass and
  left the list (two of them, a home Moderator's `app_delete` in a Telegram
  turn, by way of F5, withdrawn).
- **F3.** `app_delete` is an owner-side tool. Decided (plan section 32),
  then by the owner on 2026-10-15 (plan section 34, which reverses the rule
  set earlier that day): delete an app, its home Moderator, Admin users and
  the owner. It goes to Recently deleted with a snapshot; only the owner
  deletes it for good. The oracle follows the decision and cites it; the
  product already does this (the team chat still calls no `app_delete`,
  an owner-side tool).
- **F4.** An Admin user's write request on the system pool: the database
  checks a move, a create in a folder, a delete and a grant change against
  the scope on the transaction, and nothing else, so an edit, a draft edit,
  a public link and an app's data write of an item outside Admin are made.
  Only the gate's TypeScript (`itemWriteGate`) holds them. 108 grid cells
  (`login@system`). The same writes on the write role are refused.
- **F5** (withdrawn, owner decision of 2026-10-15, plan section 34). The
  home Moderator's app delete, by hand, in a turn, on the web
  (`DELETE /api/apps/:id`), over MCP and in a Telegram turn, is allowed:
  a delete is an archive. Its 4 grid cells and 4 surface cells (in each
  mode) pass and left the list.
- **F6.** A peer acting as its login, Write on, may not change an item
  others read ("this item is shared, so a peer cannot change its content",
  `packages/tools/src/key-shared-content.ts`, access matrix T3), the owner's
  own Admin-homed note with an open link included. The guide's "Linked
  brains" names no such rule. 2 surface cells.
- **F7** (the grants panel test, pinned there, not a cell of the list). By
  the route, as the product runs it, the database makes the add and the
  move in every mode. The gate enters the member's scope, and `grantsRoute`
  leaves it by name (`inRuleInQuery`, `lib/auth/rule-in-query.ts`: asSystem
  `rule-in-query`), so the definers run with no scope and hold nothing
  (`mantle_grant_refuses` asks for an active scope). The panel's rules are
  TypeScript only: a defence-in-depth gap for the owner. In the member's own
  write scope the definers refuse (42501) with the check off and on, and
  make the change in warn: the write role's own pass, its refusals staged
  (the 3 misses logged, "refused when the check is on"), makes it; no rerun
  is involved (a gap's rerun in warn would be unchecked, on the system pool:
  `onLoginWritePool` in `packages/db/src/client.ts`), and the panel's
  `permission denied for table node_embeds` comes after the change. So warn
  holds less there than off. The product fix (`mantle_grant_refuses` in
  0279 goes through the staged `mantle_scoped_write_refuses`) belongs to the
  A6 branch. The panel cannot run in that scope today: its first read, the
  Admin workspace's row, is hidden from a member's scope (409 "not set up"),
  and its answer reads `node_embeds`, which the scope may not.
- **F8** (withdrawn). `DELETE /api/apps/:id` lets an Admin user trash an
  app: allowed by the owner's decision of 2026-10-15 (F3), so no
  longer a failure; the cells of each Admin user's delete of an app homed in
  Admin run on the web and over MCP and pass.
- **F9.** A contact share's write is named system work on the system pool,
  so the database holds a statement it sends to nothing but a snapshot
  copy's read-only rule: an edit, a draft, a delete, a move, a grant change,
  a link and a create of any item are made. Only the `/s` broker holds it,
  by sending nothing but its app's data (the contact-share surface cells
  pass: Can write off refuses the app's data, on writes it, and the deny
  cells refuse an Informational app's data and a share that is no app).
  The guide: a contact share writes only its app's data. 248 grid cells.
  The round 2 re-audit's diagnosis: a defence in depth gap, not reachable
  by a contact today, with one caveat. The debounced export sync
  (`scheduleAppTableExportSync` in `packages/content/src/app-table-exports.ts`,
  a `setTimeout`) inherits the request's `contact:rw` actor, so its writes
  and the dirty stamp run as the contact. The fix point: a statement
  trigger next to `mantle_edit_check_ro` (migration 0280, section 5) that
  refuses a statement on an item table but `app_databases` when
  `mantle.actor` is `contact:rw`, and the dirty stamp and the export sync
  bound to a named system actor. Not fixed here (A8 is test code).
- **F10** (withdrawn in fix round 3). `app_delete` refused an Admin user's
  run item only because the cells skipped the product's run path: they
  called `dispatchTool` with no surface. A real run item meets
  `executeRunItem` first, which refuses every tool that waits for approval
  before dispatch ("never run headless"), for everyone, the owner too: an
  approval gate, intended, not an access rule. The run cells now go through
  the executor, and `app_delete` on a run is a narrowed deny that passes.

**The guide is silent** where the owner should decide:

- whether a turn's write may use a Moderator seat outside the assistant's
  workspace (add a grant, a move, the Write switch for the Moderator of H
  in H's turn: by hand allowed, in the turn's scope refused). The oracle
  pins the narrower answer, a deny named "guide silent, pinned deny
  pending owner", so a loosening fails until the owner decides: 66 grid
  cells;
- snapshot copies: docs/workspaces.md does not describe them; the oracle
  reads docs/update-prod.md;
- F6's rule for a key or a peer and a shared item.

**Cells that check little** (they pass, and say less than their count):

- contact-rw's app data write and every system cell run on the system pool
  with only the actor set: no scope, so the database's scope checks do not
  run; they pin that the write lands, not who may make it (F9 shows the
  same pool holds a contact's other writes to nothing);
- the link, peer (no Acts as) and contact-ro write cells run with write
  mode read-only: the read-only mode alone refuses them, so they do not
  test the actor's own rule apart from it;
- the heartbeat's write cells (W's assistant with no user) are all denies:
  they pin that it writes nothing;
- the contact-share cells with Can write on are all allows (a contact's
  only write is its app's data, and the broker has no route for another).

**Not covered yet:** the owner's and a member's app brokers, `/print`, a
peer without Acts as, an app's public link view (it needs a published
build's bundle, beyond the fixture), and the web item edits.

## No hand-written grant logic (A6)

Plan v2 (page fcc4aee4), A6: the access rules are written once, in the
database, and code outside `packages/db` never names the raw ACL columns
(`home_ws`, `read_ws`, `write_ws`).

**One definition.** The array forms came in A3a (migration 0280):
`mantle_may_edit_in(ws, mod_ws, home, write_ws)` and
`mantle_may_manage_in(mod_ws, home)`; `mantle_may_edit` and
`mantle_may_manage` call them with the scope's settings. A6 adds no
migration. `packages/db/src/item-acl.ts` is the one place outside the
migrations that writes them into a query:

| helper                                                | what it asks                                                                              |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `mayEditSql`, `mayManageSql`                          | the scope forms, for code in a workspace scope (or with the scope set on its transaction) |
| `readsInScopeSql`, `factReadsInScopeSql`              | the row rule on nodes, and on the facts table's own copy                                  |
| `mayReadInSql`, `mayEditInSql`, `mayManageInSql`      | the array forms, for a login asked on the system pool with its workspaces as arrays       |
| `mayManageHomeInSql`                                  | the manage rule for a home that is on no row (a deleted app's, as its snapshot keeps it)  |
| `itemHomeSql`, `itemHoldersSql`, `itemHoldersTextSql` | facts: the home, the workspaces holding the item (shown, or compared with another item's) |
| `heldBySql`, `holdsAllSql`, `missesAnySql`            | facts: one workspace holds it, all of some do, some do not                                |
| `snapshotHomeSql`, `snapshotHomeMeta`                 | a deleted item's home as its snapshot keeps it (`meta.homeWs`)                            |
| `wsArraySql`                                          | workspace ids as a checked `uuid[]` parameter                                             |

Every rule answers false, never null. The facts are never a decision: who
may read, edit or manage is always one of the rules.

**Where the hand logic was.**

- `server/web/lib/grants.ts` (the Grant Access panel, its previews, its
  writes, the moves): `mayManage` was "the caller moderates the home",
  `mayEdit` "that, or a Write grant in one of the caller's workspaces", and
  "the caller reads it" a hand overlap of `read_ws` with the caller's
  workspaces. Each item is now read with `mayReadInSql`, `mayEditInSql` and
  `mayManageInSql` over the caller's workspaces and its Moderator ones (the
  array forms: the panel runs on the system pool through `inRuleInQuery`).
  The embeds the panel lists, the served titles, the hidden count and a
  folder's title ask `mayReadInSql` the same way. The workspaces holding an
  item stay a fact (what a move or a grant adds or removes).
- `packages/content/src/link-serve.ts` (`linkRights`, `assertMayLink`, the
  serve candidates): read, edit and manage were three hand `exists` over
  the login's user rows; now the array forms over the login's workspaces
  and Moderator ones, read in the same query.
- `packages/content/src/member-brain-apps.ts`: a deleted app's home was
  compared by hand with the login's Moderator list; now the manage rule
  (`mayManageHomeInSql`) in the login's scope.
- The rest moved their SQL text into the helpers with the same meaning:
  `list-workspaces.ts` (caps and chips), `session.ts` (the item write gate,
  a deleted app's home), `member-apps.ts`, `tree/visibility.ts`,
  `pages/level-text.ts`, the `?ws=` filters of apps, notes and pages
  (`nodeReadByWorkspace`), `files.ts`, `create-home.ts`, the search scope,
  the facts search, `client-sourced*.ts`, `external-access.ts`,
  `shared-item.ts`, `builtins-nodes.ts`, `builtins-apps.ts`,
  `app-snapshots.ts`, `app-trash.ts`, `snapshot-copies.ts`.

The lint `no-raw-acl-columns` is pinned at 0 (it was 25 files, 86 lines at
A0; comments are exempt): a new read anywhere outside `packages/db` is a
lint error, and `eslint-rules/arch-lints.test.ts` holds the pins empty.

**asSystem: 88 sites in 45 files to 39 in 36 (28 reasons).** A6 moved no
exit into a scope. Where a file left the scope by one reason at several
places, the places now call that file's one door: a function whose body is
the one `asSystem` call with its reason. The exits are the same; each is
reviewed at its door. A door keeps one pinned site, so its calls are
counted too (`asSystemDoorCalls`, 70, pinned in
`scripts/arch-scoreboard.pins.json`; the counter is `asSystemDoors` and
`doorCalls` in `eslint-rules/arch-counts.mjs`): a new call through a door
raises the number, and the check fails.

| door                             | reason                 | defined in                                   | calls                                                                                                                    |
| -------------------------------- | ---------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `inRuleInQuery` (exported)       | `rule-in-query`        | `server/web/lib/auth/rule-in-query.ts`       | 19: grants, workspaces, access keys (3), both whoami routes, shell, and since A6 the assistant routes and libraries (11) |
| `clientSourcedSystem` (exported) | `client-sourced-check` | `packages/tools/src/client-sourced.ts`       | 6: client-sourced.ts (5), client-sourced-rules.ts (1)                                                                    |
| `connectorBindingSystem`         | `connector-binding`    | `packages/tools/src/external-access.ts`      | 2: `connectorGroupOf`, `connectorGroupRow` (dispatch.ts's MCP call and OAuth ref read through it)                        |
| `workspaceResourcesSystem`       | `workspace-resources`  | `packages/tools/src/external-access.ts`      | 6                                                                                                                        |
| `agentWorkspaceSystem`           | `agent-workspace`      | `packages/runtime/src/agent/agent-viewer.ts` | 6                                                                                                                        |
| `appDataSystem`                  | `app-data`             | `packages/tools/src/builtins-app-data.ts`    | 6                                                                                                                        |
| `appDataSystem`                  | `app-data`             | `server/web/lib/app-runner.ts`               | 3                                                                                                                        |
| `telegramLoginSystem`            | `login-telegram`       | `packages/telegram/src/chat-login.ts`        | 4                                                                                                                        |
| `telegramLoginSystem`            | `login-telegram`       | `packages/telegram/src/pairing.ts`           | 3                                                                                                                        |
| `telegramLoginSystem`            | `login-telegram`       | `packages/tools/src/builtins-telegram.ts`    | 3                                                                                                                        |
| `telegramLoginSystem`            | `login-telegram`       | `packages/tools/src/pending-notify.ts`       | 2                                                                                                                        |
| `telegramLoginSystem`            | `login-telegram`       | `server/web/lib/agent-telegram.ts`           | 3                                                                                                                        |
| `appTrashSystem`                 | `app-trash`            | `packages/tools/src/builtins-apps.ts`        | 3                                                                                                                        |
| `adminAreaSystem`                | `admin-area`           | `packages/tools/src/admin-gate.ts`           | 2: `runGated`, `areaSystem`                                                                                              |
| `loginNoticeSystem`              | `login-notice`         | `packages/content/src/login-notices.ts`      | 2                                                                                                                        |

Every other pinned file calls `asSystem` once, by its reason
(`eslint-rules/as-system-allowlist.mjs`).

**Recorded, moved, compared.** `server/web/server/a6-grant-sweep.db.test.ts`
records, on a real database, 966 answers for seven logins (the owner, an
Admin user with every area, an Admin user without the users area, a member
who moderates P and is a plain user of Q, a member who moderates Q and R, a
plain user of Q, a member in no workspace), a public link scope and the
system, over Admin, three shared workspaces and a private one, and items
homed in each, granted with Write on and off, in a folder with a row
"Removed here", an embedding page with an open link, apps held by one and
two workspaces and a deleted app: the panel, its add and remove previews,
the move previews, every panel write on a fresh item, the chips and caps,
the link rules, the member and login apps and their trash, the tree
visibility diffs, the scope's edit check, `othersCanRead`, the scope's
search ids and the workspace list. Recorded on main (v0.300.53) before the
move (`__snapshots__/a6-grant-sweep.txt`).

After the move 937 cells answer as main. 29 changed, all one change: the
member brain-app library (`memberApp`, `listDeletedMemberApps`) names an
app's home `home`, not after the raw column. Nothing outside reads those
fields since the `my_app_*` tools went in W7b, and no HTTP or tool reply
carries them. The test turns the field back and checks the cell then reads
exactly as main, so no rule, row or refusal moved
(`__snapshots__/a6-grant-sweep-changes.txt`). No cell is looser, and no case
was found where the hand logic and the database's rule disagreed.

**What is left.**

- The plan's "the reads move into scope" for `grants.ts` and
  `workspaces.ts`: their decisions now come from the database's rule, but
  they still run on the system pool through `inRuleInQuery`. The panel
  answers about workspaces outside the caller's scope by design (an Admin
  user names every workspace, a manager sees a row of a workspace it is
  not in, a folder's hidden count), so a move into the request scope needs
  definers for those answers and changes what the role reads: a step of
  its own, with the owner.
- No `asSystem` exit was moved into a scope. Which of the 39 doors and
  sites a scope could answer without changing an answer is the next
  ratchet (`asSystemDoorCalls` is pinned so none grows meanwhile).
- `member-brain-apps.ts` has no caller outside tests since W7b.
