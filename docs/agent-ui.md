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
  steps, so the window's result never lands in the workflow store (a
  resumed turn asks again: its `ui_calls` row is found by its step key).
  The turn's durable `llm_call` steps do keep the model's own replies and
  its tool calls' arguments there (the text it types, its captions, the
  paths it opens), as for every tool: the store holds what the agent said
  and asked, not what the window showed it.
- **Not spilled:** a large result stays inline, never in the tool-result
  store, whose handle a trace would carry.
- **Traces** keep the action and its outcome only, on both engines: the
  tool step its slug and ok or the error code (`traceCodeOnly` on the tool
  definitions: no arguments, no raw arguments of a failed parse, no
  window message), the `ui_action` step the action and ok or the error
  code. Never a target's name, a caption, an option, a path or typed text.
- **Runners** (the Admin screen of the workflow store) shows no inbound,
  outbound or reply text of a team turn, nor of an owner-engine turn that
  used a ui tool (its result says `usedUi`), to anyone but the turn's own
  login (`runShown`, `server/web/lib/runners.ts`): the input's text and
  the output's rows' text and reply are dropped. The team turn workflow
  returns ids and status only
  (`server/api/src/workflows/team-turn-result.ts`). A Runners restart or
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

**Open design point, waiting on the owner's decision.** On a turn of a
workspace assistant, any login's (an Admin user's included, not only a
member's), `ui_screen` and `ui_navigate` show the agent the login's whole
window: its direct messages, the other workspaces it is in and its private
items, beyond the scope of the workspace whose assistant runs the turn.
And text read off the screen does not mark the turn client-sourced
(tainted): a page a client wrote, read through the window, leaves the
turn's acting tools free. Neither is decided yet; the owner chooses
whether a workspace turn's ui tools are held to the assistant's workspace,
and whether screen text marks a turn.

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

One window-driving turn per login: a turn takes its login's window seat
when its window is decided (`seatedUiWindow`,
`packages/runtime/src/agent-ui/seat.ts`), on every run, and gives it back
at its end (`endTurnUiCalls`). A second turn of the login while one holds
the seat runs with no window: it is offered no ui tools, so it never holds
a member queue slot waiting on a window. In the runner's memory, as the ui
budget.

On a turn that read text a client wrote (the client-sourced mark), the
acting tools (`ui_click`, `ui_type`, `ui_select`) follow the write rule:
they are refused at once with `needs_user` (an approval could not reach
the window later, and a queued call would keep its typed text), and the
person acts themselves (`execute-call.ts`). `ui_screen`, `ui_navigate`,
`ui_point` and `ui_wait` change nothing a client reads and stay free.

The tools stay in-app: a tool group never holds one (`POST` and
`PATCH /api/tool-groups` and `tool_group_ensure` refuse a `ui_*` slug,
`isAgentUiToolSlug` in `packages/client-types/src/agent-ui.ts`), an agent's
stored grant leaves one out where a group names it anyway (`skills.ts`
`resolveAgentToolGroups`, `agent-grants.ts`), and `invoke_agent` never
hands a delegated agent the window (`childSurface` drops `uiWindowId`).

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

- `delete`: the route is a DELETE, or throws a draft away (`/discard-draft`);
- `settings`: the row is of an Admin area (settings, users, assistants,
  connectors, keys);
- `copy`: it duplicates or copies an item (`/duplicate`, `/copy`);
- `publish`: it commits a draft (`/commit`: a page's, a table's, a
  drawing's);
- `admin_only`: the route is open to an Admin user only (`row.open`), or
  writes the journal or the contacts, or its body sets an app's
  `mcpAccess`, `dataReadOnly` or `trustTools` (`PATCH /api/apps/:id`);
- `listed`: the route is under `AGENT_REFUSED_PREFIXES` (shares and
  grants, workspaces, publishing, messenger sends, calls and typing,
  Telegram pairing, the POSTs that delete, recall maps, entity merges, an
  app's tool broker, and the login's own profile, sign-in, keys and
  devices), is one of `AGENT_REFUSED_EXACT` (a new turn, a thread's
  continue, a chat's PATCH, a new chat thread, and the model calls a
  click would pay for: a thread's summary, a voice clip's transcript, a
  Tables import), or restores an earlier version;
- `tree_move`: it moves an item or a folder (`POST /api/tree/:kind/move`,
  `POST /api/pages/:id/move`);
- `declared_read`: the route is declared a read (a POST that computes, a
  call, a frame ticket): no early return for those;
- `workspace_target`: its query names the workspace it lands in (`ws`);
- `sharing_field`: its body (JSON whatever its content type, or a form)
  has a `share`, `visibility`, `published`, `public`, `access`, `members`
  or `owner` field at any depth (matched without case, `_` or `-`, with
  `shares`, `shared`, `sharing`, `publish` and `isPublic` too);
- `move`: its body has a `move`, `copy_to`, `parentId`, `parent_id`,
  `folderId`, `folder_id`, `parentPath` or `parent` field at any depth;
- `sharing_field` too: a `confirm` or `seen` field (the approval of a
  write into a shared place, the tree's files guard);
- a route's own fields (`ROUTE_FIELDS_OF`): a canvas's `source`
  (`publish`), a file's or folder's `indexing` (`settings`), an upload's
  `replace`, an overwrite (`delete`), an app's `mcpAccess`, `dataReadOnly`
  and `trustTools` (`admin_only`);
- `body_unchecked`: its body is over the route's own ceiling (1 MB on a
  `/s/` route) or a JSON body's 8 MB: it is not read past that; or it is
  multipart (any content type that holds `multipart/`): refused at once,
  unread, on every route, an upload's included. The window holds an
  upload for the person, who sends it untagged;
- `sharing_field` too, an embed by id: a note's `media:`, `draw:` or
  `present:` reference, a page doc's image, file embed, embedded drawing
  or child page, a drawing draft's file map, when it adds an embed the
  host does not hold and others can read the host (`othersCanRead`, the
  rule an API key's page write meets), or on a create
  (`server/web/lib/auth/agent-embeds.ts`). An edit that keeps the host's
  embeds passes.

A body is checked as JSON whenever it parses as JSON, whatever its content
type says (a route's `readJson` parses it all the same); a form's fields
are checked by name and by any JSON value. The
check runs after the route's rate limits, so a request over its limit is
never read.

The check reads a body once, from the request itself, and hands the
handler a request rebuilt from those bytes (`checkAgentCall`; the gate
swaps it in): a clone is not relied on, as Bun's leaves the original
empty.

Every non-GET row is refused by its row or named, with why the agent may
write it, in the reviewed list `server/web/lib/auth/agent-call.allowed.ts`
(48 rows: content edits, drafts, creates, an app the person opens, the
person's own marks, the turn's own channel; a folder's custom order is
refused, it is everyone's who reads the folder); `agent-call.test.ts` fails on
a new non-GET row that is neither.

The window's own answer (`POST .../ui/:callId`) and a turn's Stop are never
refused (`AGENT_OPEN_EXACT`). The same request untagged passes as it would.
The window holds a refused request like a risky write ("Allow once" re-sends
it once, untagged; "Not now" drops it). A new route of the listed kinds
that is not a DELETE, an area row or Admin-only is added to the list. The
header is in the gate's CORS `Access-Control-Allow-Headers`, so a split
client's preflight passes.

## Lesson trust

A lesson plays only from a page the brain says nobody outside Admin may
change. `GET /api/grants/:nodeId` answers, to every login that reads the
node and with no other detail of the Admin workspace:

- `homeIsAdmin`: the node's home is the Admin workspace;
- `editableOutsideAdmin`: a login that is not an Admin user, or a
  workspace other than Admin, may write the node or a folder above it: a
  home other than Admin (its Moderators), a Write grant to another
  workspace, or a per-login item (`server/web/lib/grants.ts`, read by
  definer up the folders).

The window plays a lesson only when the page and the Lessons folder both
answer `homeIsAdmin: true` and `editableOutsideAdmin: false`.

A lesson is code that runs in members' windows, so no agent writes one,
whoever's turn it is, an Admin user's included: the window's tagged
`PATCH /api/pages/:id` (and its v1 alias) and `PUT /api/pages/:id/draft`
on a page of the Lessons folder are refused `publish`
(`server/web/lib/auth/agent-lessons.ts`), and on every agent turn a page or
draft tool (`page_*` with a write effect) naming a page of that folder, or
the folder, is refused with a plain message that lessons are edited by
people (`lesson_page`, `packages/runtime/src/agent/tool-loop/execute-call.ts`,
the rule in `packages/tools/src/lessons.ts`: the top-level pages folder
titled "Lessons" homed in Admin, and everything under it). A commit, a
discard, a move into the folder and a create there are refused for an
agent anyway. So the two fit together: `editableOutsideAdmin: false` says
no person outside Admin may write the page or its folders, and these
refusals say no agent may; what is left is the Admin users themselves, by
hand. Other server-side tools that write a node by id (a tree move, a
generic node write) are not held to the lesson rule yet.

## App drafts an agent edited

A draft save the window's agent made (`PUT /api/apps/:id/draft` carrying
the header) marks the app's draft agent-edited (`apps.draft_agent_edited`,
migration 0365); a save the person made, a publish and a discard clear it.
While it is set, the app tool broker refuses every call of the draft's
build (an Admin user's preview), tagged or not, 403
`{ error: <a plain sentence for the builder>, reason: 'agent_edited_draft' }`: code an agent wrote calls no tool, even after the session
ends, until a person saved it. The published build, the one members run,
is not touched, and publishing is refused for an agent anyway.

