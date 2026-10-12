# Actors: who every statement runs as

Every statement the brain sends to Postgres carries its **actor**: who the
work is done as. A process entry (an HTTP request, a worker job, a turn, a
timer) names its actor once, where it starts. Everything it awaits carries
it. This is the workspaces architecture plan v2, section 4, phase A2a.

In this release the check **only logs**. A statement with no actor is a
"miss": it is written to `actor_check_misses` and runs as before. Nothing is
refused. Refusing comes in the next phase (A2b).

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
  statement, and any verb it cannot name) in its own short pipelined
  transaction: BEGIN, the SET and the write in one send. The COMMIT waits
  until a write with parameters is done, so it is one more round trip per
  such write;
- sends a read (SELECT, WITH ... SELECT, VALUES, SHOW, EXPLAIN without
  ANALYZE or ANALYSE) plain, exactly as with the check off.

`server/web/server/a2a-round-trips.db.test.ts` pins the cost on six hot
paths: with the check off no statement sets or reads the actor (the actor's
own statements carry a `/* mantle:actor */` tag: its lookups and the
wrapper's BEGIN and COMMIT), and warn sends the same statements as off plus
the actor's own, in the same number of round trips apart from the round
trips that send only the actor's own statements.

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
a timer, never in a statement's path; until the first read lands a process
uses `MANTLE_ACTOR_CHECK` alone. The client sets the settings with plain
`set_config` (it works on every role and on a database before 0275);
`mantle_set_actor` is the checked form for psql and tests. The workspace
role (`mantle_view_user`) cannot run the setter functions.

This is not a secret: any role can set a `mantle.*` setting (see Known
limits). The protection is the lint, the runtime role (A9) and the read rule
on the write role.

## The check

`mantle.actor_check` is `off` (the default), `warn` or `on`, set per box in
the database. A session can only make it stricter (the rule of
`mantle.heads_check`). `MANTLE_ACTOR_CHECK` raises it for one process.

- **TypeScript**: every statement through `db` or `systemDb`, and every
  `withSystemTx`, with no actor bound is a miss.
- **SQL**: a write on an item table (nodes, pages, draws, tables, apps,
  app_databases, the recall tables, node_embeds, app_table_exports, shares,
  node_snapshots, item_grants, peer_shares, contact_share_codes,
  node_comments) with no `mantle.actor` raises a NOTICE. It writes nothing
  in that transaction, so it never takes a transaction id before
  `mantle_lock_heads`. The app reads the notice and logs the miss later, on
  another connection.

Misses are capped at 100 rows an hour per check. `on` still only logs in
A2a. An operator's psql names itself with `mantle_operator_actor('reason')`
(docs/update-prod.md).

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

- **The trigger's mode read.** The item-table trigger takes a fast path
  when the check reads off in `current_setting` (no catalog read).
  Otherwise a write with no actor reads the box setting through a SECURITY
  DEFINER catalog lookup (`mantle_actor_check_mode`), on each such write and
  also on a box whose check is off: a small cost, noted for A3a. A session
  that sets its own value to off skips a warn in A2a, so A2b's refusal must
  read the catalog first.
- **An approved pending call** runs as the login that asked, on the owner
  surface, with the approver named in the audit. Open for A2b: whether it
  should run as the approver instead.
- **The settings are not a credential.** `set_config('mantle.actor', …)`
  and `set_config('mantle.write_mode', …)` are callable by any role,
  `mantle_view_user` included, so revoking `mantle_set_actor` is cosmetic.
  No untrusted SQL reaches Postgres today, so that is fine for A2a. A2b and
  later must never decide access from `mantle.actor` or `mantle.write_mode`
  on a role that can run caller-shaped SQL.

## A2b must

Found in the A2a audits; A2a changes no behaviour for them, A2b must close
them before it refuses anything.

- **The first statements of a process.** Until the pool's first mode read
  lands, a process uses `MANTLE_ACTOR_CHECK` alone, so its first statements
  go out as off. A2b must wait for the first read before it refuses, or
  use the environment value as a floor.
- **Narrowing to read only.** `systemUnder` narrows the write mode to `ro`
  under every actor whose write mode is `ro`, the `assistant` kind
  included. Before A2b refuses a write on `mantle.write_mode`, it must
  narrow only for `login(ro)`, `link` and `contact` without write.
- **The Recall slug with no scope.** When no workspace scope surrounds a
  Recall write, `scopeLacksAdmin` reads `currentActor()`, so the slug
  answer depends on the check's mode and on the entry: a `login(rw)` turn
  gets a random slug, where stdio (`login(owner)`) and main counted up. A2b
  makes it one answer.
