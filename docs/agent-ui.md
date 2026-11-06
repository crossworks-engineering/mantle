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
- **Owner-engine turns only, for now.** An Admin user's in-app agents run on
  the owner turn engine, whose turns stream to the window. A member's turn
  runs on the workspace engine, which has no live stream to its window yet
  (the stream routes are Admin only), so a `ui-call` event could never reach
  it. Members follow once their turns stream; the workspace engine is
  unchanged until then.

## The turn names its window

`POST /api/assistant/turn` takes an optional `windowId`
(`^[A-Za-z0-9_-]{8,64}$`, JSON body field or multipart field; a bad one is
400). The client sends it only while the login's setting is on. The runner
offers the seven tools only when the turn named a window, streams, serves a
signed-in login, and that login's setting is on, read on the brain when the
turn starts (`agentUiWindowFor`, `packages/runtime/src/agent-ui/offer.ts`).
They are a per-turn affordance (`agentUiTools` in
`packages/runtime/src/assistant/assemble-turn.ts`), and the turn's surface
carries the window (`uiWindowId`), set by the runtime, never by the model.

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
`window_gone`). The wire constants are `packages/client-types/src/agent-ui.ts`.

## One call

1. The tool opens a `ui_calls` row (migration 0363,
   `packages/db/src/ui-calls.ts`): the turn, the login, the window, the
   action and its arguments, `status` pending, `expires_at` 15 seconds on.
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
sends and calls, Telegram pairing, the POSTs that delete, and the login's
own profile, sign-in, keys and devices). A new route of those kinds that is
not a DELETE or an area row is added to that list. The header is in the
gate's CORS `Access-Control-Allow-Headers`, so a split client's preflight
passes.
