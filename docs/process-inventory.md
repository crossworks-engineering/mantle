# The process inventory

Every file that starts work on its own (a queue consumer, a worker shell, a
DBOS workflow, a LISTEN, an interval timer, a timeout loop, a process event
handler), by kind, with the actor it binds ([actors.md](./actors.md),
section 4). `eslint-rules/process-entries.test.ts` reads the `entries`
block below: it fails when a file starts work and is not listed, or is
listed and no longer does. Its header says how each kind is found.
`timeout-loop` is every file that calls `setTimeout(` and reaches the
database: text cannot tell a re-arming timer from a sleep or a deadline,
so each is listed and named. A timer carries the actor of the code that
set it. `packages/db/src` is scanned too.

## The entries

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
interval packages/db/src/gateway/check-mode.ts none: the box mode read, on the raw pool outside the actor client (started in runWithoutActor)
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
listen server/parser/src/main.ts none: the parser service has no brain database
listen server/sandboxd/src/egress.ts none: a network listener, no brain database
listen server/sandboxd/src/main.ts none: a network listener, no brain database
listen server/web/lib/realtime.ts system(listen:realtime)
listen server/web/workers/push-notify.ts system(worker:push-notify)
process-on packages/content/src/app-sql-runner.ts none: the SQLite child's message handler, no brain database
process-on server/api/src/main.ts none: a rejection handler that logs; its signal handlers (@mantle/std/shutdown onShutdown) stop DBOS and the runtime, no statement of their own
process-on server/web/server/main.ts none: error handlers that log; its signal handlers (@mantle/std/shutdown onShutdown) close the server
process-on server/web/workers/_runner.ts none: a rejection handler that logs; its signal handlers (@mantle/std/shutdown onShutdown) run the worker's teardown
queue-work server/api/src/agent/extract-queue.ts system(queue:extract) per job
queue-work server/web/workers/calendar-sync.ts system(worker:calendar-sync)
queue-work server/web/workers/email-sync.ts system(worker:email-sync)
queue-work server/web/workers/maintenance.ts system(worker:maintenance)
queue-work server/web/workers/microsoft-sync.ts system(worker:microsoft-sync)
queue-work server/web/workers/runs.ts the run's login as it is now, else login(owner)
request-slot packages/db/src/viewer.ts defines the helper: runInRequestSlot starts a request as system(http:no-login)
request-slot server/web/server/middleware/gate.ts system(http:gate) for the gate's own lookups (an API key, a token); a routed request's slot, opened by enterCall: system(http:no-login), then what the guard names; a page's own slot (A4 step 2): the /s page as system(http:share-page), then the link or the contact the share gate names; a render page as system(http:render), then the render cookie's login
timeout-loop packages/content/src/app-broker.ts the caller's actor: a drain sleep inside an app database restore
timeout-loop packages/content/src/app-table-exports.ts system(app-export) for the export sync, whoever scheduled it (F9: never a contact share's actor)
timeout-loop packages/db/src/access-matrix.ts the caller's actor (migrate's): the write role sync's retry sleep
timeout-loop packages/db/src/gateway/check-mode.ts none: the first box mode read's retry sleep, outside the actor client (started in runWithoutActor)
timeout-loop packages/db/src/gateway/heads.ts the caller's actor: a retry sleep
timeout-loop packages/db/src/gateway/role-tx.ts the caller's actor: the write pool's bounded wait (a timer that fails the wait, no work of its own)
timeout-loop packages/db/src/reserved.ts the caller's actor: every pool's bounded reserve wait (a timer that fails the wait, no work of its own)
timeout-loop packages/db/src/resolve-owner.ts the caller's actor: the wait for the first signup
timeout-loop packages/db/src/test-support.ts none: test helpers' poll and retry sleeps
timeout-loop packages/db/src/viewer-roles.ts the caller's actor: a retry sleep
timeout-loop server/api/src/agent/runtime.ts system(timer:summarize) for the summarize debounce
timeout-loop server/web/lib/push/login-notice-handler.ts system(worker:push-notify), carried by the batching timer
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

## Entries the scan does not see

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
