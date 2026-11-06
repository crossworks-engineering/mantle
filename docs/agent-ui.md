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
  terms (below). See "Turn ids" for whose stream is whose.

## Turn ids

Every streamed turn's id names the login that sent it, minted by
`POST /api/assistant/turn` from the session's login, never from a client
field: `turn-<loginId>.<key>` on the owner engine (an Admin user's turn),
`ws-<loginId>.<key>` on the workspace engine (every login's, an Admin
user's included). The id is the turn's workflow id and its stream id. The
202 always says it: `{ turnId, stream }` (`stream: true` when the turn
streams; a brain before this sent no `stream`, and streamed an Admin user's
turn on its raw Idempotency-Key). The client subscribes, stops and answers
ui calls with the 202's turnId, never the raw key; a re-attach after a
dropped POST re-POSTs with the same key and takes the turnId from that 202
(the same turn: the route's dedup cache and the workflow id).

`GET /api/assistant/turn/:turnId/stream`, `POST .../cancel` and
`POST .../ui/:callId` are chat routes (`open: 'chat'`) and ask one rule
first (`turnOpenTo`, `server/web/lib/turn-access.ts`): a `turn-` or `ws-`
id is open to the login it names only, whatever its role. Any other id
(another login's, or one that names no login, such as a raw key) is a 404
with no detail for everyone, as for a turn that does not exist: Admin B
never opens, stops or answers Admin A's turn. Nothing is stored for it: the
id says whose turn it is, and only the turn route mints one. An
Idempotency-Key that starts `turn-` or `ws-` (any case), or holds a space
or a slash, never becomes a stream id on either engine.

Stop works on a member's turn as on an owner turn: the runner registered
the turn's abort (`run-team-turn.ts`), the cancel route publishes the
cancel, the runner's listener aborts the model call, the reply keeps what
had streamed, the turn ends with `done`, and its open ui calls answer
`stopped`.

A member's stream opens, Stops and ui answers are rate limited
(`chatTurnStream` 60, `chatTurnCancel` 30 and `chatTurnUiAnswer` 60 a
minute, `server/web/lib/route-limits.ts`; an Admin user's are not), and a
member holds at most 4 streams open at once per web process (the fifth is
the one 429).

## Members

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
- **Traces** keep the action and its outcome only, on both engines: the
  tool step its slug and ok or the error code (`traceCodeOnly` on the tool
  definitions: no arguments, no raw arguments of a failed parse, no
  window message), the `ui_action` step the action and ok or the error
  code. Never a target's name, a caption, an option, a path or typed text.
- **Runners** (the Admin screen of the workflow store) shows no reply text
  of a team turn: the team turn workflow returns ids and status only
  (`server/api/src/workflows/team-turn-result.ts`), and a run recorded
  before has `reply` and the rows' `text` dropped from its output
  (`runOutputShown`, `server/web/lib/runners.ts`). A Runners restart or
  fork of a turn (either engine) runs under a new workflow id, which is
  not the turn's stream id, so it runs with no window and is offered no ui
  tools (`server/api/src/workflows/turn-window.ts`).
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
`ui_type {target, text, replace?}` (appends at the end of the field; it
replaces only on `replace: true`, and the window is always sent `replace`
as a boolean), `ui_select {target, option}`,
`ui_point {target, caption}`, `ui_wait {target?, ms?}`, where `target` is
`{ref}`, `{id}` or `{role, name}`. Risk class `write`, never in a recipe, a
run item or a team app (`packages/runtime/src/agent-ui/tools.ts`). Each
returns the window's JSON result; a refusal is a tool failure whose text
starts with its code (`no_session`, `stopped`, `user_took_over`,
`not_found`, `ambiguous`, `stale_ref`, `needs_user`, `secret_field`,
`host_control`, `bad_route`, `unsafe_route`, `unsupported`, `timeout`,
`needs_consent`, `window_gone`, `bad_target` and `too_long` (the brain's
own checks of the arguments), and on a member's turn `ui_budget`). Every result reaches the
model fenced as untrusted data. The wire constants are `packages/client-types/src/agent-ui.ts`.

## One call

1. The tool opens a `ui_calls` row (migration 0363,
   `packages/db/src/ui-calls.ts`): the turn, the login, the window, the
   action (never its arguments), `status` pending, `expires_at` 15 seconds
   on.
   `step_key` (unique) is the turn id and the tool call's id, so a DBOS
   re-run of the same step finds its row again instead of asking twice.
   A tool call id seen again in the same turn (a provider's fallback id, or
   a provider that repeats its ids) gets `#2`, `#3`, ... (`UiStepKeys`), so
   two calls never share a row and both act; a re-run counts again in the
   same order and finds the same rows. The adapters' own fallback, when a
   provider sends no id, is process-unique (`fallbackToolCallId`,
   `packages/voice/src/adapters/fallback-call-id.ts`), no longer
   `call_<name>`.
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
step: the action and ok or the error code, nothing else; the tool step
keeps its slug and the code (see "What a member's agent sees"). A screen,
a target, a caption, an option, a path or typed text is never recorded.

## The brain refuses, the window holds

Every request the page makes during an agent action that the person did not
allow in the window's prompt carries `x-mantle-agent-call: <callId>`, and
every request a lesson causes `x-mantle-agent-call: lesson:<uuid>`; any
value counts as tagged. The gate refuses a tagged request that is not a GET
or HEAD, 403 `{ error: 'agent_refused', reason }`
(`AGENT_REFUSED_ERROR`, `packages/client-types/src/agent-ui.ts`), whatever
the client did (`server/web/lib/auth/agent-call.ts`, asked in the gate's
`beforeHandler`), when any of these holds (the `reason`):

- `delete`: the route is a DELETE;
- `settings`: the row is of an Admin area (settings, users, assistants,
  connectors, keys);
- `admin_only`: the route is open to an Admin user only (`row.open`);
- `listed`: the route is under `AGENT_REFUSED_PREFIXES` (shares and
  grants, workspaces, publishing, messenger sends, calls and typing,
  Telegram pairing, the POSTs that delete, recall maps, entity merges, an
  app's tool broker, and the login's own profile, sign-in, keys and
  devices), is one of `AGENT_REFUSED_EXACT` (a new turn, a thread's
  continue, a chat's PATCH), or restores an earlier version;
- `tree_move`: it moves an item or a folder (`POST /api/tree/:kind/move`,
  `POST /api/pages/:id/move`);
- `declared_read`: the route is declared a read (a POST that computes, a
  call, a frame ticket): no early return for those;
- `sharing_field`: its body (JSON whatever its content type, or a form)
  has a `share`, `visibility`, `published`, `public`, `access`, `members`
  or `owner` field at any depth (matched without case, `_` or `-`, with
  `shares`, `shared`, `sharing`, `publish` and `isPublic` too);
- `body_unchecked`: its body is over 8 MB, too large to check.

The window's own answer (`POST .../ui/:callId`) and a turn's Stop are never
refused (`AGENT_OPEN_EXACT`). The same request untagged passes as it would.
The window holds a refused request like a risky write ("Allow once" re-sends
it once, untagged; "Not now" drops it). A new route of the listed kinds
that is not a DELETE, an area row or Admin-only is added to the list. The
header is in the gate's CORS `Access-Control-Allow-Headers`, so a split
client's preflight passes.
