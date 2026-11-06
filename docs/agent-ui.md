# The agent UI channel: an in-app agent drives the window

An in-app agent can show a person around their own window: read what it
shows, open a page, click, type, choose an option, point at a control, wait
for something to load. The person turns it on for their login, and the
window asks before the first action of each session. This page is the
brain's half; the window's half (the hands, the consent prompt, the header
below) lives in the mantle-client repo.

## Who gets it

- **Opt-in, per login.** `GET /api/profile/agent-ui` answers `{ enabled }`
  (off by default); `PUT /api/profile/agent-ui` takes `{ enabled, loginId }`,
  the login's own value only (403 `login-mismatch` otherwise, as
  `/api/profile/sounds`). Stored as `agentUi` on the login's profile row.
- **In-app agents only.** The tools are never on the MCP surface: they are
  registered in the runner's process only (`server/api/src/agent/runtime.ts`),
  as the heartbeat tools are, and no tool group names them.
- **Both turn engines.** An Admin user's in-app agents run on the owner turn
  engine; a member's chat runs on the workspace engine
  (`server/web/lib/workspace-turn.ts`, `runTeamTurn` on the member turn queue
  in server/api, the same runner). Both stream to the window on the same
  events, buffer and replay, and both are offered the tools on the same
  terms (below). See "Members" for whose stream is whose.

## Members

A member's turn streams on its own turn id, `ws-<loginId>.<key>` (the
workflow id), which `POST /api/assistant/turn` mints from the session's
login, never from a client field. The 202 says it: `{ turnId, stream: true }`
(on every turn that streams, either engine; a brain before this sent no
`stream`, and a member's client then reads the finished reply as before).
The member's client subscribes after the 202 with that turnId; the replay
buffer holds what was published before.

`GET /api/assistant/turn/:turnId/stream`, `POST .../cancel` and
`POST .../ui/:callId` are chat routes (`open: 'chat'`) and ask one rule
first (`turnOpenTo`, `server/web/lib/turn-access.ts`): a `ws-` id is open to
the login it names only, whatever its role, an Admin user's included; any
other id is an Admin user's turn, open to an Admin user as before. Anything
else is a 404 with no detail, as for a turn that does not exist. Nothing is
stored for it: the id says whose turn it is, and only the turn route mints
one. An Idempotency-Key in the `ws-` namespace never names a stream on
either engine, so no turn publishes onto a member's stream. An Admin user's
turns keep streaming on their Idempotency-Key (both engines): the owner
chat's client subscribes and stops on the key it minted, before the 202
(`assistant-client.tsx`), and the dock re-attaches by it, so its stream id is
not pinned to the login; one Admin user who reused another's in-flight key
could publish on that stream.

Stop works on a member's turn as on an owner turn: the runner registered
the turn's abort (`run-team-turn.ts`), the cancel route publishes the
cancel, the runner's listener aborts the model call, the reply keeps what
had streamed, the turn ends with `done`, and its open ui calls answer
`stopped`.

A member's stream opens and Stops are rate limited (`chatTurnStream` 60
and `chatTurnCancel` 30 a minute, `server/web/lib/route-limits.ts`; an
Admin user's are not), and a member holds at most 4 streams open at once
per web process (the fifth is the one 429).

### What a member's agent sees, and where it goes

A ui tool's result is what the member's window shows: it can hold the
member's own private items, its direct messages and the other workspaces it
is in. So it is the member's private output, kept to the turn
(`PRIVATE_OUTPUT_TOOL_SLUGS`, `packages/tools/src/private-output.ts`, the
same rule on an Admin user's turn):

- **The model** reads it in this turn only, fenced as untrusted data
  (`outside.untrusted` on the tools' policy, both engines): a screen shows
  text other people wrote, never instructions.
- **Not journaled:** the tool step and its `ui_action` step are not durable
  steps, so the result never lands in the workflow store (a resumed turn
  asks again: its `ui_calls` row is found by its step key).
- **Not spilled:** a large result stays inline, never in the tool-result
  store, whose handle a trace would carry.
- **Traces** keep no result: the tool step its redacted input, the
  `ui_action` step the action, a short target summary and ok or the error
  code.
- **The reply** of a member's turn that used a ui tool is marked
  `used_private`, as is every later reply whose history holds it
  (`replyUsedPrivate`, `run-team-turn.ts`); the admin readers of member chats
  show a placeholder. The thread itself is the member's own (row security,
  0269).
- **The `ui_calls` row** holds the result only while the turn runs (a
  re-run of a ui step reads it back), for that login's own reads only (row
  security, 0363). When the turn ends, on every path (done, a failure, Stop,
  a supersede, a used ui budget; either engine: the turn runners' outermost
  `finally`, `agent-ui/end.ts`), its results are cleared and what is still
  pending is given up (`clearTurnUiCalls`); the row keeps its status and
  step key, so a later re-run never asks the window again. The row never
  holds the arguments (`{}`): they reach the window on the stream event
  only, whose replay buffer is swept after 15 minutes. The nightly
  `ui-calls-reap` sweep deletes rows older than 24 hours, so a turn that
  never ended leaves nothing behind either.

No rule today stops a member's agent from writing what it read into a
shared workspace with its other tools: the member may do the same by hand
(its own Write switches), and the agent has the member's rights only.

### The ui budget of a member's turn

A member's turn holds a slot of the member turn queue (a few per brain)
while each ui call waits. So a workspace turn makes at most 12 ui calls and
waits on its window 3 minutes in all (`packages/runtime/src/agent-ui/budget.ts`);
a wait is cut to what is left. Past either, every ui tool answers at once
with `ui_budget: ui budget used for this turn ...`, and the turn's open
calls are given up. Per turn id, in the runner's memory: a delegated child
shares it. An owner turn has no ui budget.

## The turn names its window

`POST /api/assistant/turn` takes an optional `windowId`
(`^[A-Za-z0-9_-]{8,64}$`, JSON body field or multipart field; a bad one is
400). The client sends it only while the login's setting is on. The runner
offers the seven tools only when the turn named a window, streams, serves a
signed-in login, and that login's setting is on, read on the brain when the
turn starts (`agentUiWindowFor`, `packages/runtime/src/agent-ui/offer.ts`),
on either engine (`run-turn.ts`, `run-team-turn.ts`; a member's tools act
with that member's rights, in its own window and session).
They are a per-turn affordance (`agentUiTools` in
`packages/runtime/src/assistant/assemble-turn.ts`), and the turn's surface
(`web`, or `team` for a member's turn) carries the window (`uiWindowId`), set
by the runtime, never by the model.

## The tools

`ui_screen {}`, `ui_navigate {path}`, `ui_click {target}`,
`ui_type {target, text, replace?}`, `ui_select {target, option}`,
`ui_point {target, caption}`, `ui_wait {target?, ms?}`, where `target` is
`{ref}`, `{id}` or `{role, name}`. Risk class `write`, never in a recipe, a
run item or a team app (`packages/runtime/src/agent-ui/tools.ts`). Each
returns the window's JSON result; a refusal is a tool failure whose text
starts with its code (`no_session`, `stopped`, `user_took_over`,
`not_found`, `ambiguous`, `stale_ref`, `needs_user`, `secret_field`,
`host_control`, `bad_route`, `unsupported`, `timeout`, `needs_consent`,
`window_gone`, and on a member's turn `ui_budget`). Every result reaches the
model fenced as untrusted data. The wire constants are `packages/client-types/src/agent-ui.ts`.

## One call

1. The tool opens a `ui_calls` row (migration 0363,
   `packages/db/src/ui-calls.ts`): the turn, the login, the window, the
   action (never its arguments), `status` pending, `expires_at` 15 seconds
   on.
   `step_key` (unique) is the turn id and the tool call's id, so a DBOS
   re-run of the same step finds its row again instead of asking twice.
2. It emits a `ui-call` turn event `{ callId, action, args, expiresAt }`
   (`emitTurnUiCall`, on the turn lifecycle observer, so it is published in
   seq order and buffered for a reconnect).
3. The window acts and answers
   `POST /api/assistant/turn/:turnId/ui/:callId` with `{ windowId, result }`
   (at most 64 KB). The answer is one UPDATE whose WHERE is the rule: the
   session's login, this turn, this window, pending, before `expires_at`.
   Then status done, the result, and `NOTIFY ui_result '<callId>'`. Another
   login's, turn's or window's call is 404 with no detail; a second answer
   or an expired call 409; a result over the cap 413.
4. The tool waits: it reads the row every 200 ms, and the runner's LISTEN
   on `ui_result` (`server/api/src/turn-cancel.ts`) wakes it at once. No
   answer by `expires_at` is `window_gone`.
5. Stop (the turn's cancel route) marks the turn's open calls expired; each
   wait answers `stopped`.

Each call writes a `ui_action` trace step (migration 0362) under its tool
step: the action, a short target summary, and ok or the error code. Typed
text and captions are cut to 40 characters there, `ui_type`'s `text` is
redacted from the tool step's input, and a screen is never recorded.

## The brain refuses agent-driven risky writes

Every request the page makes during an agent action that the person did not
allow in the window's prompt carries `x-mantle-agent-call: <callId>`. The
gate refuses a non-GET carrying it, 403 `{ error: 'needs_user' }`, when the
route deletes, sends, shares, publishes or changes a setting, whatever the
client did (`server/web/lib/auth/agent-call.ts`, asked in the gate's
`beforeHandler`). The route declarations say read or write, not which kind
of write, so the kinds are read from the row: every DELETE, every row of an
Admin area (settings, users, assistants, connectors, keys), and the routes
under `AGENT_REFUSED_PREFIXES` (shares and grants, publishing, messenger
sends, calls and typing, Telegram pairing, the POSTs that delete, and the
login's own profile, sign-in, keys and devices), and the exact routes of
`AGENT_REFUSED_EXACT` (a new turn, a thread's continue, a chat's PATCH). A new route of those kinds that is
not a DELETE or an area row is added to that list. The header is in the
gate's CORS `Access-Control-Allow-Headers`, so a split client's preflight
passes.
