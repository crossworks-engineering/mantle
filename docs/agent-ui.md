# The agent UI channel: an in-app agent drives the window

An in-app agent can show a person around their own window: read what it
shows, open a page, click, type, choose an option, point at a control, wait
for something to load. The person turns it on for their login, and the
window asks before the agent acts (see "Consent"). This page is the
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
- **Runners** (the Admin screen of the workflow store, open to the
  Settings area) shows a chat turn's input and output, on either engine
  and whether or not it used a ui tool, whole only to the login that ran
  it (its input's `options.loginId`; `runShown`, `server/web/lib/runners.ts`).
  Any other viewer, another Admin user with Settings included, reads
  metadata only: the owner and the options' login, stream and window ids,
  the inbound and outbound rows' ids, status, model, trace and times, and
  the result's numbers and marks (`usedUi`, `replyChars`); never the
  question, the reply, a row's text, thoughts or tools, an attachment, a
  transcript or an artifact. No Admin role sees more: the run's status,
  timings, step names (never a step's arguments or result) and the
  engine's error messages show to every viewer as the screen's diagnostics,
  and nothing else of a turn does. A turn that names no login (a run
  recorded before turns carried one) is nobody's: metadata to everyone.
  The team turn workflow returns ids and status only
  (`server/api/src/workflows/team-turn-result.ts`), and an owner-engine
  turn's result says `usedUi` when it used a ui tool or its history holds
  a reply that did (its reply row `data.used_ui`, so the turn after it is
  marked too: `turnUsedUi`, `packages/runtime/src/assistant/run-turn.ts`).
  Every action on a turn is its own login's: a restart or fork re-runs it
  as the login it served, a resume drives its window again, a cancel ends
  it; anyone else is answered 404, as for a run that is not there
  (`rerunRefused`, `server/web/app/api/runners/[id]/route.ts`). An
  allowed restart or fork runs under a new workflow id, which is not the
  turn's stream id, so it runs with no window and is offered no ui tools
  (`server/api/src/workflows/turn-window.ts`).
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

### Consent

Consent to act is per turn (the window's, mantle-client):

- The first `ui_click`, `ui_type` or `ui_select` of each agent turn asks
  the person once: "Allow <agent name> to act in this window for this
  turn?" (Allow / Not now). The prompt is a host control, armed after the
  same delay as the window's other prompts, and the call waits for the
  answer.
- **Allow**: that turn's later click, type and select calls run without
  asking, within the person's own rights; the brain's own rules for that
  login still apply to every request it causes. A member's turn is the
  same.
- **Not now**: the call answers `needs_user` ("The user said Not now to
  acting in this window for this turn."), and so does every later acting
  call of that turn, without asking.
- A new turn asks again. Two acting calls in flight together share one
  question. A Stop while it is open counts as Not now. A call that expires
  while the person decides answers `window_gone`.
- Reads (`ui_screen`, `ui_look`, `ui_navigate`, `ui_point`, `ui_wait`) do not ask:
  they keep the consent given once per page ("Allow for this session"),
  which still comes first for every kind of call.
- A lesson never asks: the person's Start counts as the yes for that run.

What a read still shows: on a turn of a workspace assistant, any login's
(an Admin user's included), `ui_screen` and `ui_navigate` show the agent
the login's whole window, its direct messages, its other workspaces and
its private items included, beyond the workspace whose assistant runs the
turn; and text read off the screen does not mark the turn client-sourced.
So a member can plant text in a workspace that steers an Admin user's turn
there to read their screens, and the turn's ordinary tools can write what
it read into the workspace, with that login's rights. Acting in the window
takes the person's yes on that very turn.

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
offers the eight tools only when the turn named a window, streams, serves a
signed-in login, and that login's setting is on, read on the brain when the
turn starts (`agentUiWindowFor`, `packages/runtime/src/agent-ui/offer.ts`),
on either engine (`run-turn.ts`, `run-team-turn.ts`; a member's tools act
with that member's rights, in its own window and session).
They are a per-turn affordance (`agentUiTools` in
`packages/runtime/src/assistant/assemble-turn.ts`), and the turn's surface
(`web`, or `team` for a member's turn) carries the window (`uiWindowId`), set
by the runtime, never by the model. `ui_look` is offered only when the
agent's model sees images (`modelSupportsVision`, `agentUiToolSlugsFor`).

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
person acts themselves (`execute-call.ts`). `ui_screen`, `ui_look`,
`ui_navigate`, `ui_point` and `ui_wait` change nothing a client reads and
stay free.

The tools stay in-app: a tool group never holds one (`POST` and
`PATCH /api/tool-groups` and `tool_group_ensure` refuse a `ui_*` slug,
`isAgentUiToolSlug` in `packages/client-types/src/agent-ui.ts`), an agent's
stored grant leaves one out where a group names it anyway (`skills.ts`
`resolveAgentToolGroups`, `agent-grants.ts`), and `invoke_agent` never
hands a delegated agent the window (`childSurface` drops `uiWindowId`).

## The tools

`ui_screen {}`, `ui_look {scope?, ref?}`, `ui_navigate {path}`, `ui_click {target}`,
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

### Look

`ui_look` gives the model a picture of the window, for "what do I do
here?" and "does this look right?". `ui_screen` stays the tool for what is
on the screen and what to press; `ui_look` is for how it looks.

- Scope: `work` (default, the `<main>` work area without the sidebar),
  `window`, or `ref` (one element from the last `ui_screen`; a `ref` wins).
  The brain always sends the window `{scope}` or `{scope: 'ref', ref}`.
- The window (client `lib/agent-ui/look.ts`) takes the pixels (desktop:
  Electron `capturePage`; web: the page redrawn by modern-screenshot), paints
  a box over every secret field (`data-secret`, passwords, one-time codes),
  scales to a long side of at most 1568 px and 1.15 MP (never up), and
  answers `{ok, route, title, scope, width, height, blanked, blankFrames,
image: {mimeType, base64}}`: a PNG, or a JPEG at 0.85 when the PNG is over
  1 MB. The agent bar says "Looking at your window" meanwhile.
- App frames: the page redraw cannot read inside a sandboxed app frame, so
  on the web the window asks each app frame in the box over the app bridge
  (`{kind: 'look', id, scale}`, one `look.res` back) and paints its picture
  into the frame's box. The frame document's listener (`LOOK_LISTENER`,
  `packages/share-ui/src/app-frame-html.ts`) imports
  `/share-runtime/frame-look.js` (`server/web/server/share-page/frame-look.ts`),
  so every app answers with no rebuild. Its CSP keeps `connect-src 'none'`:
  the frame's text draws in a fallback font and an image the redraw would
  fetch comes out blank. A frame that does not answer in 2 s stays blank and
  counts in `blankFrames`; the model is told.
- The answer route takes a result with `image` up to
  `AGENT_UI_LOOK_MAX_BYTES` (1.5 MB); every other result keeps 64 KB. The
  tool checks the picture (PNG or JPEG, at most 1 MB) and hands it to the
  model as a tool picture (`modelImages`, `tool-loop/tool-images.ts`): shown
  after the batch's results, at most 4 tool pictures a turn, swapped for a
  note on a text-only failover. The text output carries no base64.
- Where it lives: the row's result until the turn ends (cleared, then reaped
  after 24 hours) and the loop's messages for that turn. Never a file, the
  DBOS journal, the tool-result store, a trace or Runners. The next turn
  looks again.
- An older window has no `look`: it answers `unsupported: Unknown action
"look".` and the agent goes on in text.

## One call

1. The tool opens a `ui_calls` row (migration 0363,
   `packages/db/src/ui-calls.ts`): the turn, the login, the window, the
   action (never its arguments), `status` pending, `expires_at` 15 seconds
   on.
   `step_key` (unique) is the turn id and the tool call's id, each with
   its length before it (`uiStepKey`: no id, an Idempotency-Key's ':' or
   '#' included, makes one key read as another), so a DBOS re-run of the
   same step finds its row again instead of asking twice.
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

## The agent acts with the person's rights

The brain holds no agent-driven request apart: a request the window makes
for an action is the person's own request, answered by the same rules as
if the person had clicked (the login's scope, its Write switches, the
item rights, the Admin areas). There is no refusal or hold system for it,
and no header marks it. What stands between the agent and an action is the
person: the window asks before the first click, type or select of each
turn ("Consent").

Two of the brain's own rules meet the ui tools on the way:

- **The client-sourced rule.** On a turn that has read text a client
  wrote (client-sourced, tainted), the acting ui tools (`ui_click`,
  `ui_type`, `ui_select`) follow that rule's write rule, as any write tool:
  where it would hold a write for approval, the ui tool is refused at once
  with `needs_user` (an approval cannot reach the window later), and the
  person acts themselves (`execute-call.ts`). The reads are free.
- **In-app only.** The ui tools are never in a tool group, a recipe, a run
  item, a team app or the MCP surface, and never handed to a delegated
  agent.

## Lessons

A lesson is read from the top-level "Lessons" folder of the pages tree.
The brain adds no rule of its own for lessons: who may edit a lesson page
is who may edit any page there, and a lesson run starts with the person's
Start (its consent).

## Accepted risk

Logins in a brain are trusted (Jason 2026-11-07). The brain does not hold
these apart, and they are accepted as they are:

- **Shares and grants of per-login items.** An Admin user, or a Moderator
  where the item sits, may share another login's own item (a per-login
  item, `nodes.login_id`) with a contact or a link, or grant it to a
  workspace, as any item; a share made of one stays live.
- **Folder moves carrying another login's private item.** A move or
  delete of a folder that holds another login's own item takes it along,
  as it does any item in the folder.
- **Peers acting as a member.** A peer brain bound to a member login acts
  with that member's rights, per-login items included.
- **Entity links built from per-login rows.** The entity graph may link
  facts taken from one login's own items, and those links are read as any
  entity's.
- **What a read shows a workspace turn** ("Consent", above).
- **What an app copies into its database** (owner decision 2026-11-09:
  apps follow the Pages rights model). An app reads with the rights of the
  user who runs it, and everyone who may open the app reads its database
  (`host.db`). So:
  - a user in two workspaces can, through the app, copy data from one
    workspace into `host.db`, where users of the other workspace read it;
    they can do the same by hand (copy it into a shared page);
  - an app's code runs with the rights of whoever opens it: a Moderator of
    the app's home can write code that, when an Admin user opens it, puts
    an item only Admin reads into `host.db`, where the author reads it (the
    team tool set still holds: no Admin-only tool group, no paid work);
  - a connector's answer can land in `host.db`, read by a workspace that
    does not hold the connector;
  - an app's open link or contact share serves `host.db`, so what a run
    put there is on that link too, as a page's content is on its link.
- **Admin holds every task file** (files on tasks, 2026-11-09). A file on
  a task sits in the task's own Auto-filed folder, so Admin users see it in
  Files, also for a task in a login's private workspace. The task's
  workspace holds it too (its home). Who reads the task opens it through
  the task.
- **A new item takes its folder's sharing, unasked** (owner's word,
  2026-11-12). A file or page made, uploaded, copied or exported into a
  folder is read by the folder's workspaces at once, with no confirm, for
  a person, an agent and an API key alike. A copy of an item one workspace
  reads into a folder another reads makes it readable there; a trusted
  member could do the same by hand (download, upload). A move of an
  existing item still asks.
- **More than 5 files from parallel uploads.** One trusted editor who sends
  several uploads to a task at the same moment can pass the 5-file cap.
- **The gateway's idle sockets.** A socket from a services subnet stays open
  until it sends a request, and counts toward the connection limit. It takes a
  compromised service, costs only availability, and no request passes
  ([gateway.md](gateway.md)).
