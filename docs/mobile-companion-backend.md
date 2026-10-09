# Mobile Companion: backend additions

> **Update 2026-10-09:** there are no comment pushes any more (`kind:
'comment'` is never sent): the brain has no comments. Chat replies and review
> results push as before.

_Last updated: 2026-10-02 (contract v1.1: every push names its brain and its login, for devices that hold several logins)._

API + schema added to Mantle to support the **Mantle Companion** mobile app
(Flutter; repo `~/Projects/mantle-companion`). Single-user/self-hosted, so the
only auth scope is the owner. Everything here is **owner-gated via
`requireOwner()`**, which accepts the session cookie _or_ a mobile bearer token,
so each route works unchanged from web and mobile.

> Status: **DEPLOYED TO PROD (2026-06-14, v0.24.0).** Migrations 0089/0090/0091
> applied on prod (drizzle count 89 → 92) via the gated `migrate` one-shot; data
> intact (nodes unchanged). All routes live behind the owner-gate: a no-token
> request 307s to /login (edge middleware), an invalid-bearer request gets a clean
> **401** from `getOwnerOr401`, and `mobile-login` 401s bad creds. Pre-migration
> brain dump taken first (`backups/mantle-20260614-172127.dump`).
>
> Previously: smoke-tested end-to-end on local dev (2026-06-13), all four route
> groups verified with a mobile bearer; the avatar route needed a fix (see its
> section).

## Auth: per-device bearer tokens

- `packages/db/src/schema/mobile-tokens.ts` + migration `0090_…`'s predecessor
  `0089_mobile_tokens.sql`, `mobile_tokens` table (revocable, expiry).
- `server/web/lib/auth.ts`, `buildMobileToken` / `verifyMobileToken` /
  `mobileTokenJti` / `getBearerUser`; `getSessionUser()` falls back to
  `Authorization: Bearer`.
- `jackdaw/middleware.ts`, accepts a valid mobile bearer (stateless verify),
  401s a malformed one (wrapped in try/catch).
- Routes: `POST /api/auth/mobile-login` `{email, password, deviceName}` →
  `{token, expiresIn}`; `POST /api/auth/mobile-logout` (revokes by `jti`).
- **QR sign-in ("Sign in on your phone")** — `server/web/lib/pair-code.ts`,
  table `pairing_codes` (`0157_pairing_codes.sql`). The signed-in web app
  calls `POST /api/auth/pair` (owner session, 10/min per login) → `{id, code,
url, expiresAt, ttlSeconds}` and shows `url` (`<brain>/pair#v=1&code=…`,
  the code in the fragment so no log sees it) as a QR. The phone scans it and
  calls `POST /api/auth/pair/claim` `{code, deviceName?}` (public, 10/min per
  IP) → the `mobile-login` shape plus `email` (and, since contract v1.1,
  `loginId` and `brainId`; see "Three roles on the phone"). Codes are 192 random bits
  stored as SHA-256, live 90 s, and are single-use (one conditional UPDATE);
  every claim failure is one 401 line. `GET /api/auth/pair/[id]` (owner) →
  `{status: pending|claimed|expired, deviceLabel}` for the page's poll.
  `GET /pair` is a public static page for a browser that scanned the QR; it
  never reads the fragment.
- **Client contract:** a revoked/expired token still passes the stateless Edge
  gate (revocation is enforced in the Node layer). The JSON API routes below gate
  with **`getOwnerOr401()`**, which returns a clean **401 `{error:'unauthorized'}`**
  in that case, not a redirect. (HTML _page_ routes still use `requireOwner()` →
  **307 → /login**.) The app treats **401 OR 3xx→/login** as "session invalid".
- **`getOwnerOr401()`** (`lib/auth.ts`) is the gate for programmatic JSON routes:
  it returns `SessionUser | NextResponse`, so the handler does
  `const owner = await getOwnerOr401(); if (owner instanceof NextResponse) return owner;`.
  Used by dashboard-summary, conversations, read, and avatar.

## Dashboard summary

- `GET /api/dashboard/summary` (`app/api/dashboard/summary/route.ts`), mirrors the
  web dashboard KPIs by composing existing `lib/dashboard.ts` / `lib/metrics.ts`
  functions: `{ spend: {last7MicroUsd, prior7MicroUsd}, brain: {nodesTotal,
entitiesTotal, edgesTotal, factsTotal}, vectors: {vectorsTotal, …}, pendingCount }`.
  Spend is **micro-USD** (÷1e6). System vitals come from the existing `/api/health`.

## Conversations inbox + read state

- Schema `packages/db/src/schema/assistant-read-cursors.ts` + migration
  `0090_assistant_read_cursors.sql`, `assistant_read_cursors(owner_id, agent_id,
last_read_at)` (composite PK, FK → agents). Mantle had **no** read/unread concept
  before this.
- `server/web/lib/assistant-inbox.ts`, `getReadCursors`, `markAssistantRead`
  (upsert), `assistantConversations` (per chat-capable agent: latest message
  preview + `unreadCount` = outbound messages newer than the cursor; sorted by
  recency).
- `GET /api/assistant/conversations` → `{ conversations: [{ agentId, slug, name,
avatar, lastMessage: {text, direction, createdAt} | null, unreadCount }] }`.
- `POST /api/assistant/read` `{ agentSlug?, at? }`, marks an agent's thread read
  (clears unread). Omitting `agentSlug` marks the default agent. Body is
  `safeParse`d → **400 `{error:'invalid_body'}`** on a malformed/mistyped body
  (not a 500); unknown agent → 404.

## Live chat (SSE)

- **`GET /api/assistant/stream`** (`app/api/assistant/stream/route.ts`): a
  per-owner Server-Sent Events stream. Each turn (any channel) emits
  `data: {agentSlug, direction}`; the client refetches that thread + the inbox on
  receipt (the same "ping-to-refetch" model as `/api/realtime`). Heartbeat
  comment every 25s. Owner-gated with `getOwnerOr401` → clean 401 before the
  stream opens. Mirrors `/api/realtime` exactly (verified byte-identical
  `: connected` framing).
- **Migration `0091_conversation_changed_notify.sql`**: an `AFTER INSERT` trigger
  on `assistant_messages` that `pg_notify('conversation_changed', …)` with a JSON
  payload `{ownerId, agentSlug, direction}` (the slug via an indexed PK subquery
  on `agents`, so the client needs no id→slug lookup). Distinct from the existing
  `summarize_due` trigger (agent-id only, drives summarization).
- **`lib/realtime.ts`** gained a `conversation_changed` LISTEN on its shared
  bridge connection + `subscribeConversations()` (parallel to `subscribeRealtime`).
  Since `assistant_messages` aren't `nodes`, they don't flow through the existing
  `node_ingested` path; this is a separate channel on the same bridge.
- Verified live: trigger→NOTIFY→bridge→subscriber delivers `{ownerId, agentSlug,
direction}` end-to-end (fresh-eval). Note: a _running_ dev server's bridge is a
  `globalThis` singleton that survives HMR, so a newly-added LISTEN needs a server
  restart to register, a dev-only artifact; prod evaluates the module once.

## Agent avatar image

- `GET /api/agents/[id]/avatar?size=` (`app/api/agents/[id]/avatar/route.ts`),
  server-renders the agent's avatar SVG so non-web clients can show the same
  avatar. `runtime = 'nodejs'`. Returns `image/svg+xml`; **404** when the agent
  has no `avatar` (client falls back to initials). The key resolves as a **uuid
  when it looks like one, else as a slug**, so the companion's
  `/api/agents/<slug>/avatar` calls work unchanged.
- It calls the SHARED generator, `@mantle/web-ui/avatar`, the very same module
  the browser renders with, so the companion and the web app cannot drift.
- The **style** is the brain's (Settings → Appearance), not the agent's: the
  per-agent `avatar.style` is legacy and ignored. The **seed** is what makes each
  agent's avatar its own.
- Palette is the **hex** Clean-Slate chart ramp, applied to the BACKGROUND only.
  Hex because DiceBear validates colours as hex and rejects anything else, which
  also keeps SVG consumers like `flutter_svg` happy, since they can't parse
  `oklch()`.
- **Two gotchas hit during smoke-testing, one still live, one now designed out:**
  1. **Segment-name conflict (still live).** The route was first added at
     `[slug]/avatar`, but `agents/[id]/…` already exists. Next forbids two
     different dynamic slug names at one level and silently 404s _both_. Fix:
     nest under the existing `[id]`.
  2. **`react-dom/server` couldn't render the old boring-avatars component.** It
     calls `useId()`, and in a Next route the bundled React runtime and an
     imported `react-dom/server` are **two different React instances**, so the
     hook dispatcher is null → `Cannot read properties of null (reading 'useId')`.
     That forced `lib/avatar-svg.ts`, a 300-line hand-port of boring-avatars v2
     kept honest by a byte-for-byte parity test. **Both are gone** since the move
     to DiceBear v10, whose styles are plain JSON and whose renderer is a plain
     function — no React, nothing to port, one implementation for both tiers.

## Migrations

The repo hand-writes migrations (drizzle-kit snapshots collide). Added:
`0089_mobile_tokens.sql`, `0090_assistant_read_cursors.sql`, each with a
`meta/_journal.json` entry. Apply with `pnpm db:migrate`. **0089–0091 applied on
prod (2026-06-14, v0.24.0);** `assistant_read_cursors` verified: composite PK
`(owner_id, agent_id)`, `last_read_at timestamptz default now()`, FK →
`agents(id) ON DELETE CASCADE`.

## Push notifications (M2)

`0092_push.sql` + `lib/push/*` + `workers/push-notify.ts` (Mantle v0.25.0) add the
backend half of **Mantle Push**: owner-gated `POST /api/push/connect` (lazily
generates this install's instance token, registers it with the relay, mints an
enrollment ticket), `POST|GET /api/push/subscriptions`, `DELETE
/api/push/subscriptions/:id`, `POST /api/push/reset`; and `worker_push`, which
LISTENs `conversation_changed` (migration 0091) and forwards each outbound turn's
**libsodium-sealed** teaser to the relay's `/notify`. Full design +
relay/app halves: `../../mantle-companion/docs/push-notifications.md`. The relay
is live at `https://push.crossworks.network` and **now on real providers** —
`/healthz` reports `{"ok":true,"provider":"live"}` (checked 2026-08-06); the
"mock provider until APNs/FCM creds" caveat this line used to carry is retired.

The split left this path alone: `worker_push` still runs from the server image
(`server/web/workers/push-notify.ts`) and the relay URL is per-instance state
in `push_instance`, not env. Nothing here is keyed by app package or bundle id
— `push_subscriptions` stores `platform` + `routing_token` only — so a client
rename never reaches the server. What is not portable is the relay's FCM
service account, which is scoped to one Firebase **project**.

## Location (v0.27.0)

The app can attach a device **location** to each chat turn; there's no new
endpoint; it rides on `POST /api/assistant/turn` (JSON `location` key, or a
`location` form field on multipart). The server stores it on the inbound message,
makes the agent location-aware, and lazily reverse-geocodes (Mapbox) into a cached
`location` node. Full mobile integration contract (fields, Flutter mapping,
permissions, verify steps): **[`handover-companion-location.md`](_archive/handover-companion-location.md)**.
Shipped + deployed in v0.27.0.

## Navigation: routes + inline maps (next release)

Building on Location: the assistant can now **find a route** to a place and
**plot it on an inline map** with a short driving/walking overview (not live
turn-by-turn). **No new endpoint and no app changes**: the map comes back as an
ordinary **image artifact** on the existing chat-turn response, which the
companion already renders. The companion keeps sending location exactly as before.
Full contract + how it works server-side:
**[`handover-navigation.md`](_archive/handover-navigation.md)**. Dormant until a `mapbox`
key is added; lands in the next release.

## Companion v1.4–1.6: streaming + knowledge surfaces (2026-07)

Companion **1.4.0–1.6.0** (shipped 2026-07-19, verified against dev v0.147.0)
consume **existing** owner-gated routes; no new backend was added this cycle.
For the app-side architecture see
`../../mantle-companion/docs/architecture.md`. What the app now relies on:

- **Live turn streaming (1.3/1.4).** `GET /api/assistant/turn/:id/stream` (SSE
  `TurnEvent`s; the turn id = the client idempotency-key) and `POST
/api/assistant/turn/:id/cancel`. The client pins
  `TURN_EVENT_SCHEMA_VERSION` (= 1): it ends the stream on a higher `v`
  rather than mis-parse, **bump `v` only on breaking shape changes** so old
  clients degrade to refetch instead of breaking. The thought trail renders
  `status` events (upsert by `stepId`) and, with trail-persistence on, the
  persisted `thoughts`/`toolStats` on the outbound row.
- **Pages (read-only, 1.5).** `GET /api/pages` (tree/list modes),
  `GET /api/pages/:id`, `GET /api/pages/:id/backlinks`, and (key choice)
  **`GET /api/export/:id?format=md`** for content, so the app renders markdown
  and needs no ProseMirror. In-page images fetch through the authed files
  route with the Bearer header.
- **Tasks (1.5).** `GET/POST /api/tasks`, `PATCH /api/tasks/:id`, `DELETE`.
  Since the Kanban upgrade `status` is `open|in_progress|blocked|done`
  (+ filter values `active`/`all`); the companion's binary done-toggle still
  works (any not-done → done → open), and it flattens the two new states to
  "not done" until it grows a status picker. Server order is not-done →
  done, then board rank, due asc, recency.
- **Journal (1.5).** `GET/POST /api/journal`; server derives the title.
  Voice capture reuses `POST /api/assistant/transcribe`.
- **Events (1.6).** `GET/POST /api/events` (`window=upcoming|past|all`),
  `GET/PATCH/DELETE /api/events/:id`. **Contract quirks the app depends on:**
  1. "Done" is the reserved **`done` tag**, persisted via `PATCH {tags: […]}`
     (full replacement); there is **no event status field**. A first-class
     status column + worker skip would be a clean follow-up; until then the
     tag is load-bearing for the app.
  2. The app **mirrors `startsAt` + `remindAt` into on-device OS alarms**
     (exact, offline, boot-persistent) and reconciles them after every
     fetch/mutation, the same fields the events-reminders worker pings on.
     Changing `remindAt` computation or rolling behaviour for recurring
     events (server advances the row to the next occurrence) changes what
     rings on phones.

## Companion v1.8: `GET /api/search` (added v0.148.0, 2026-07)

The one backend addition of the v1.7–v1.11 companion cycle: an owner-facing
HTTP twin of the `search_nodes` / `search_chunks` MCP tools, so the app can
offer a real search screen without routing queries through a chat turn.

- **Route:** `server/web/app/api/search/route.ts`, gated by `getOwnerOr401`
  (mobile bearer works unchanged). Param parsing is pure and unit-tested in
  `packages/client-types/src/search-query.ts`.
- **Params:** `q` (required, ≤500 chars) · `mode=nodes|chunks` (default
  `nodes`) · `type` (node-type filter; same enum the `search_nodes` tool
  advertises) · `branch` (ltree prefix, regex-validated so the `::ltree`
  cast can't 500) · `tags` (comma-separated, ≤10) · `limit` (1–50,
  default 20).
- **`mode=nodes`** → `searchNodes` with the query embedded via
  `@mantle/embeddings` (vector-led hybrid; **a failed embed silently
  degrades to FTS**, same as the tool). Response:
  `{mode, results: [{id, type, title, path, tags, summary, updatedAt, url,
supersededBy?}]}` — `summary` from `data.summary` when present, `url` via
  `nodeUrl` (open-on-web), `supersededBy {id, title, url}` names the living
  successor so clients can prefer it.
- **`mode=chunks`** → `searchChunks` (passage-level). Vector-first, so a
  failed embed is an explicit **503** here, not degraded results. Response
  rows: `{nodeId, nodeTitle, nodeType, ordinal, heading, text, url,
supersededBy?}` (`heading` is nullable; `supersededBy {id, title, url}`
  carries the living successor, same as nodes mode, v0.148.1).
  `type`/`tags` are ignored in this mode.
- **Client contract:** results are relevance-ranked, NOT date-sorted (use
  the list endpoints for time-windowed queries); treat `supersededBy` as
  "show the successor"; expect FTS-quality results when the embedding
  worker is down rather than an error (nodes mode).

## The frontend/server split (v0.200.0–v0.202.0) — what it means here

`apps/*` became `server/*`, the owner UI was carved into `jackdaw`, and the
routes moved off Next onto Hono. **The companion's contract is unchanged**, and
that is deliberate rather than lucky: the mobile bearer was the mechanism the
split was designed around (`frontend-backend-split.md` §Auth). Specifically:

- **Every route above still exists at the same path**, served by `server/web`.
- `server/web/server/middleware/gate.ts` is a faithful port of the old Edge
  middleware. It accepts `Authorization: Bearer <mobile token>`, and an
  `/api/**` request without (or with an invalid) credential gets a clean
  **401 `{error:'unauthorized'}`** — never an HTML redirect. The app's
  "401 OR 3xx→/login" rule still holds; in practice only the 401 arm fires now.
- **CORS does not apply to the app.** It engages only when a request carries an
  `Origin` header, which a native client doesn't send. `MANTLE_API_CORS_ORIGINS`
  is for the detached web/Electron client.
- **`POST /api/auth/mobile-login` is frozen** — path, response shape and the
  original 1-year TTL — because every shipped companion build depends on it.
  The web client got `/api/auth/token` (30-day + `/refresh`) instead; the
  companion deliberately does not use it.
- **`TURN_EVENT_SCHEMA_VERSION` is still `1`.** The app's `v` tripwire is
  untouched by the seam swap.

**Two vhosts, and which one the app wants.** The shipped Caddyfile serves the
server on `MANTLE_SITE_ADDRESS` and the owner UI on `MANTLE_CLIENT_SITE_ADDRESS`
(`app.<domain>`). **The companion must point at the SERVER address** — the
client origin carries no `/api` at all. The setup screen detects a client origin
and recovers the right one: `jackdaw` serves `/env.js` (public) advertising
`serverOrigin`, so the app names the brain instead of just failing.

A **single-host** install — one hostname path-routing `/api` to the server and
everything else to the client, which is how `dev` and `jason-prod` run — needs
none of this: `/api/version` answers on the address the user typed. Note those
boxes still set `MANTLE_SERVER_ORIGIN` to their own hostname, so `/env.js`
advertises the same origin it is served from; the app rejects a self-pointing
(or empty) `serverOrigin` rather than re-probing an address it just found dead.

**`/n/<id>` links.** `nodeUrl()` builds against `MANTLE_PUBLIC_URL` (the server
origin), but `/n/[id]` lives in the client app — so `server/web` forwards
`/n/*` to `MANTLE_CLIENT_ORIGIN`. This matters to the companion twice: the `url`
on every `/api/search` hit (the "Open in Mantle" action) and every node link the
assistant writes into a chat reply. **Set `MANTLE_CLIENT_ORIGIN` on any box
running a separate client vhost**, or both go nowhere.

## `GET /api/assistant/thread?withMessages=0` — the app's launch bundle

The route returns `{agents, agent, messages, assigned}`. `?withMessages=0`
suppresses only `messages` (opt-out, so existing callers are unaffected); the
companion uses it at launch for the two rules it must not re-implement:

- **`agents`** is `listAssistantAgents` — conversational roles **and**
  `enabled`. `GET /api/agents` filters roles but **not** `enabled`, so an agent
  disabled in the web picker would otherwise still appear on the phone. The app
  keeps the rich `/api/agents` rows (avatar) and intersects on these slugs.
- **`agent`** is `resolveAgentForActor`, which since v0.224 prefers the agent
  bound to this login (`agents.assigned_user_id`, migration 0143) over the
  brain-wide priority default. The web needs the `assigned.assignedAt`
  watermark because it holds a sticky `mantle_assistant_agent` cookie; the app
  holds no such cookie, so the resolved agent is simply its default — and a
  turn that omits `agentSlug` resolves the same way server-side.

## Three roles on the phone: members and clients (contract v1.1)

The Jackdaw mobile app serves all three roles: admin, member and client. This
section is the contract the app mirrors by hand (no OpenAPI exists). Paths,
bodies, error bodies, deep links and token lifetimes below are stable; a change
is announced to the app session before it lands.

**Versions.** v1 (2026-10-01): the three roles. v1.1 (2026-10-02, migration
0226): `whoami` and every sign-in answer carry `brainId` (and `loginId`
where they did not), and every push payload carries `brainId` and
`loginId`, so a device holding several logins (on one brain or on several)
opens the right one on a tap (section 2, "Push routing on a device with
several logins"). Additive only: an app built for v1 ignores the new fields,
and the payload's `v` stays `1`.

Everything above this section still holds for admins and for shipped builds.
`POST /api/auth/mobile-login` stays frozen: admins only, 1 year, same shape.

### 1. Sign-in

**Admin or member: `POST /api/auth/device-login`** (public, 10 a minute per
address, one bucket shared with the other token logins: `mobile-login` and
`/api/auth/token`. An IPv6 caller counts by its /64).

    body   { email, password, deviceName? }
    200    { token, expiresIn, expiresAt, deviceId, role, loginId, brainId }
    401    { error: "Invalid email or password." }   (every failure, same line)
    429    { error }  + Retry-After

`role` is `admin` or `member`. The token lasts 30 days and rotates through
`POST /api/auth/token/refresh` (below). A client email always answers 401: a
client has no password. The answer is sent with `Cache-Control: no-store`.

`deviceName` is a label, not a credential. The brain trims it and cuts it to
80 characters. A missing, empty or wrong-type name gets a default label. It
never fails a sign-in (here and on the client verify).

Why a new route and not `/api/auth/token`: the answer names the role (the app
must know which shell to call before it calls one), the audit line says
`mobile` and not `web-client`, and one route serves the admin and the member
with the same 30-day rotating token. `mobile-login` cannot change, because
shipped builds read its 403 for a member.

**Client: the emailed code, device mode.** A client has no password. The app
asks for a code, the person reads it from their email, the app trades it for a
token. No cookie is set or read in device mode.

    GET  /api/auth/client-code
    200    { enabled }            codes are on for this brain, or not

    POST /api/auth/client-code
    body   { email, device: true }
    200    { ok: true, requestId }   always, whatever the email
    429    { error } + Retry-After

    POST /api/auth/client-code/verify
    body   { email, code, requestId, deviceName? }
    200    { ok: true, token, expiresIn, expiresAt, deviceId, role: "client", loginId, brainId }
    401    { error: "That code did not work. Ask for a new one." }
    429    { error } + Retry-After

`requestId` ties the code to the app that asked for it, as the request cookie
does for a browser. The app keeps it in memory until the verify. A body with
`requestId` is device mode: the answer carries a token and sets no cookie
(a cookie on the request is not read at all). A body without it is the
browser flow, unchanged. When the person asks for the code again, send the
`requestId` you hold (`{ email, device: true, requestId }`): the code already
mailed keeps working, and no second mail goes out while it is open.

Device mode is for the app only. A device-mode request that carries an
`Origin` header or any `Sec-Fetch-*` header came from a web page, and both
routes answer it before any work:

    403    { error: "Device sign-in is for the phone app.", reason: "device-only" }

A native HTTP client sends none of these headers. Do not add them. The brain
stores a device code under an id derived from the app's `requestId`, never
under that id itself. So a browser's request cookie cannot redeem a device
code, and a device `requestId` put in a cookie finds no code. The verify
answer is sent with `Cache-Control: no-store`.

**Token rotation: `POST /api/auth/token/refresh`** (Authorization: Bearer).
All three roles. When it rotates, the old token dies in the same transaction.

    200    { token, expiresIn, expiresAt, deviceId, role, loginId, brainId }
    401    { error: "unauthorized" }
    401    { error: "unauthorized", reason: "sign-in-expired" }   client only
    429    { error } + Retry-After

Every answer carries `Cache-Control: no-store`. `loginId` and `brainId` are
v1.1, on all three 200 answers (too early, a rotation, a lost answer
retried). `brainId` in a sign-in answer (here, `device-login`, the client
verify and `pair/claim`) is the same value whoami answers; like there, it is
left out only while the database is behind the code. The frozen
`mobile-login` and the web client's `/api/auth/token` answer as before.
Rules:

- **Too early is a no-op.** While more than 23 days remain, the answer is the
  SAME token with its own `expiresAt` and `deviceId`. Nothing rotates and no
  row is written. So the app may call it at every launch. A new token comes
  back only in the last 23 days. Always store the `token` of the answer.
- **A client's 90-day cap.** Refresh keeps a client's device token alive for
  at most 90 days from the emailed code that signed the phone in. After that,
  refresh answers 401 with `reason: "sign-in-expired"`. The app shows the
  sign-in screen and the person asks for a new code. Each new client token
  lasts at most 30 days and never past the cap.
- **A lost answer is safe to retry.** If the answer to a rotating refresh is
  lost, the app retries with the token it still holds. Until the new token
  is used for the first time, that retry gets the SAME new token again (the
  same `deviceId`, the same expiry). No time limit, no row written. The first
  real use of the new token (any route, or a refresh with it) closes that
  door.
- **Reuse ends everything.** The app must keep only the newest token, and
  use it. A rotated token presented again AFTER its successor was used is a
  copy in someone else's hands. On a refresh or on any other route, the
  brain then ends every session and device token of the login (the phone
  and the browser), removes the login's push devices, and writes the audit
  row `auth.token_reuse`, once. The person signs in again. The same old
  token presented later is a plain 401 and ends nothing more.
- **Every other 401** (revoked, expired, ended sessions, a disabled login) is
  final for this token: show the sign-in screen. Each one writes the audit
  row `auth.token_refresh_failed` with the reason.
- The limit is 30 a minute per address (an IPv6 caller by its /64).

Lifetimes:

| Role   | Minted by                        | Lifetime | Rotation                                                       |
| ------ | -------------------------------- | -------- | -------------------------------------------------------------- |
| admin  | `mobile-login` (old builds)      | 1 year   | none                                                           |
| admin  | `device-login`                   | 30 days  | refresh                                                        |
| member | `device-login`                   | 30 days  | refresh                                                        |
| client | `client-code/verify` device mode | 30 days  | refresh, each new token at most 30 days, 90 days from the code |

A client token also carries the login's session epoch. It ends at once when
the client signs out anywhere (web or phone), when an admin ends the client's
sessions, disables the login or changes its role. A client token never lasts
longer than `CLIENT_SESSION_TTL_SECONDS` (30 days); one that claims more is
refused.

**Who am I: `GET /api/auth/whoami`** (any bearer or session).

    200    { role, loginId, email, displayName, shell, pushBase, brainId }
    401    { error: "unauthorized" }

For example, a member's phone token:

    {
      "role": "member",
      "loginId": "5d1f0c2a-7b4e-4f61-9a0d-2c8e6b3f1a77",
      "email": "member@example.invalid",
      "displayName": "Mia Member",
      "shell": "/api/member/shell",
      "pushBase": "/api/member/push",
      "brainId": "0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f"
    }

`brainId` (v1.1) names this brain: a random uuid, made once when migration
0226 ran, the same for every login and every role, unchanged by restarts and
upgrades. It is not a secret and says nothing about the brain (not its
address, not its owner). The app calls whoami right after every sign-in and
files the session under the pair (`brainId`, `loginId`), which the sign-in
answer already carries; it calls whoami again at launch and replaces a
stored `brainId` that differs (a brain made from another brain's dump is
given its own id, see section 6). `loginId` is the same id the sign-in
answers carry. `brainId` is missing only on a brain
whose database is behind its code (migration 0226 not applied) and on brains
older than v1.1: treat that session as having no `brainId` (below).

| role   | shell               | pushBase           |
| ------ | ------------------- | ------------------ |
| admin  | `/api/shell`        | `/api/push`        |
| member | `/api/member/shell` | `/api/member/push` |
| client | `/api/client/shell` | `/api/client/push` |

**Sign-out: `POST /api/auth/mobile-logout`** (Authorization: Bearer). Always
200 `{ ok: true }`. It revokes this device's token and removes the push
devices that token enrolled, and only those (the web and desktop client
signs out here too; it must not take a phone's pushes). For a client it ends every session of the login,
the browser ones too (a client sign-out always did). A token that is already
dead ends nothing, and neither does a client token whose session epoch has
moved on (those sessions are already over).

**Devices.** Every device token is a `mobile_tokens` row under its login. An
admin sees and revokes it in Settings > Logins > Devices
(`GET /api/users/:id/devices`, `DELETE /api/users/:id/devices/:jti`).

**What a token reaches.** A member token reaches only `MEMBER_ROUTES`, a
client token only `CLIENT_ROUTES` (`server/web/lib/auth/*-routes.ts`). Every
other route answers 403 with `reason` = `member-login` or `client-login`, or 401. A wrong-role call on a member or client route answers 403 with the
caller's role in `reason` (`admin-login`, `member-login`, `client-login`).

### 2. Push for members and clients

**Who gets what (the targeting rule).** A push goes only to devices of the
login it concerns, and only while the token that enrolled the device is live.

| Event                                    | Goes to                                                                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner assistant message                  | Devices of active ADMIN logins. If the agent is assigned to one login, only that login's devices.                                              |
| Approval waiting                         | Devices of active admin logins.                                                                                                                |
| "Needs you" (review queue, team request) | Devices of active admin logins.                                                                                                                |
| Reply in a member or client chat         | Devices of that ONE login.                                                                                                                     |
| Review result on an item                 | Devices of the item's author.                                                                                                                  |
| Comment on an item                       | Devices of the item's author (not when the author wrote it). On a client-level item's client thread: every active client login but the writer. |

A member or client device never gets an owner teaser. A device whose token was
revoked, expired or rotated away without the app gets nothing.

**Routes.** Same shapes as the admin routes, under the role's `pushBase`.
All need a bearer (a browser session answers 400 `bearer_required` on the
enrol step).

    POST   {pushBase}/connect         { platform: "ios"|"android", osPushToken }
           200 { ticket, relayUrl }
           409 { error: "push_not_set_up" }   client only: no admin or member
                                              has switched push on yet
           502 { error: "relay_unreachable" }
           429 { error: "too_many_requests" } + Retry-After
    POST   {pushBase}/subscriptions   { routingToken, publicKey, platform, label?, deviceId? }
           200 { id }
           400 { error: "bearer_required" }   no live device token of this login
           429 { error: "too_many_requests" } + Retry-After
    GET    {pushBase}/subscriptions   200 { devices: [{ id, platform, label, current }] }
    DELETE {pushBase}/subscriptions/:id   200 { ok: true } | 404 { error: "not_found" }
    GET    {pushBase}/preferences     200 { chatReplies, reviewResults }
    PUT    {pushBase}/preferences     partial patch, same answer

A member or client lists and removes only its own devices. Enrolling a routing
token again replaces the old row (one row per routing token), so one routing
token belongs to one login. The relay mints a new routing token on every
enrol, so each Connect of each login is its own row (see "Push routing on a
device with several logins"). `POST /api/push/reset` stays admin only. Preferences are
per login and all default to true. The `comments` toggle is gone (there are no
comment pushes): a PUT that names it is ignored like any unknown field.

**Limits.** Connect and enrol share one bucket: 10 a minute per login, above
that 429 `{ error: "too_many_requests" }` with `Retry-After`. A login holds at
most 10 push devices: the 11th enrol removes the oldest. These limits hold for
the admin routes (`/api/push/connect`, `/api/push/subscriptions`) too.

**The admin enrol needs the bearer.** `POST /api/push/subscriptions` answers
400 `{ error: "bearer_required" }` unless the request carries a live device
token of the signed-in admin. The app always sends it. A device enrolled from
a browser session would be a device nothing can revoke.

**Admin devices from older releases.** An admin device enrolled before
migration 0213 had no token on record. The migration binds it to the login's
phone token when the login holds exactly one live phone token (the web
client's token does not count). Then it goes with that token, as a new
device does. The others stay unbound and keep getting owner pushes until a
revoke of the login's device tokens, End sessions, a password change or a
disable. Then the brain removes them, because it cannot tell which phone
they are. A sign-out does not remove them. That phone must tap Connect again
in Settings > Push (the app enrols only on a tap of Connect, never on its
own).

**When the brain removes a device by itself.** Only when the relay says the
device is gone: 410, or 404 with the relay's body
`{ "error": "unknown_device" }`. A bare 404 (a proxy, a wrong relay address)
removes nothing. Also when the stored public key is not a key (not base64 of
32 bytes): it can never be sent to. A failure to seal for any other reason
skips the device for that push and is logged; the device stays.

**Payload** (sealed to the device, as today). New fields are additive.

    { v: 1, t, b, deepLink, ts, kind, itemId?, state?, brainId, loginId, itemLink? }

`brainId` (v1.1) is this brain, the same value whoami answers. `loginId` (v1.1)
is the login the receiving device was enrolled for (the login whose bearer
called `{pushBase}/subscriptions`). Both are on every push of every role,
owner pushes included. The payload is sealed per device, so when one owner
teaser goes to two admins, each admin's device reads its own `loginId` and
never the other's. A field the brain cannot name is left out, never guessed:
`brainId` while migration 0226 is not applied, `loginId` on an admin device
row that has no login on record (from before migration 0173; no send list
returns one).

A member's chat reply, before and after v1.1:

    v1    { "v": 1, "t": "Tess", "b": "Here is the answer.", "deepLink": "/portal/chat",
            "ts": 1790845200000, "kind": "chat" }
    v1.1  { "v": 1, "t": "Tess", "b": "Here is the answer.", "deepLink": "/portal/chat",
            "ts": 1790845200000, "kind": "chat",
            "brainId": "0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f",
            "loginId": "5d1f0c2a-7b4e-4f61-9a0d-2c8e6b3f1a77" }

An owner assistant reply to an admin's device:

    v1    { "v": 1, "t": "Ada", "b": "The pump spec is ready.", "agentSlug": "ada",
            "deepLink": "/chat/ada", "ts": 1790845200000 }
    v1.1  { "v": 1, "t": "Ada", "b": "The pump spec is ready.", "agentSlug": "ada",
            "deepLink": "/chat/ada", "ts": 1790845200000,
            "brainId": "0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f",
            "loginId": "9c3e5a10-4d2b-4e8f-b1a6-7f0d2c9e4b13" }

An approval (`/pending`) and a "needs you" notice gain the same two fields
and nothing else.

| kind      | t (title)                                                                       | b (body)                                                                                                        | deepLink                                                                       | extra                                              |
| --------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------- |
| `chat`    | the agent's name; for an admin's note the brain's site name, else `New message` | the reply, pictures removed, 140 chars (`New message` when it is a picture only)                                | `/portal/chat`                                                                 |                                                    |
| `review`  | `Accepted`, `Returned`, or `With an admin`                                      | the item's title; for `Accepted`, the title it was accepted under                                               | `/portal/items/<id>`, or `/portal/items` when taken                            | `itemId`, `state`: `accepted`, `returned`, `taken` |
| `comment` | `New comment`                                                                   | on the author's own item: `<name> on "<title>": <comment>`; on a client thread: `<name> commented on "<title>"` | `/portal/items/<id>` (own item) or `/portal/shared/<id>` (a client-level item) | `itemId`                                           |

Owner pushes keep their links (`/chat/<slug>`, `/pending`, `/team-admin?...`)
and carry no `kind`.

An event reminder delivered on the mobile channel is an owner assistant turn,
so its push is an owner reply (`deepLink: "/chat/<slug>"`) that also names the
event: `itemLink: "/events/<id>"`. An app that knows the route opens the
event; an older app ignores the field and opens the chat as before. Only the
reminders worker sets it (it marks its turn `data.reminder = { kind, id }`);
`/tasks/<id>` is reserved for a task reminder, which no brain sends yet. A teaser never holds text its reader cannot open: the
chat text is the reader's own thread as their chat route returns it, an item
title is the author's own item, a client-thread comment goes out only while
the item is at client level. A client-thread comment push carries no comment
text: every client of the brain gets it, and a lock screen is not the place
for another person's words. Open the item to read it.

**Push routing on a device with several logins (v1.1).** A phone or a
desktop may hold several sessions (a session is a brain origin, a login and
that login's device bearer; one is active), on one brain or on several. The
device has one OS push token for all of them, so a push alone does not say
which session it is for; `brainId` and `loginId` do. On a tap the app:

1. Opens the payload with the device's key, as today.
2. Looks for the session whose stored (`brainId`, `loginId`) equals the
   payload's pair. Both must match; a `loginId` alone is not enough (two
   brains made from one dump share login ids).
   **Ambiguous:** when the sessions the device holds with that `brainId`
   are at more than one origin (two brains share an id: a copy that was not
   given its own, or one brain reached under two addresses), the push is
   ambiguous. The app does not switch sessions and follows no deep link: it
   opens on the active session, or offers the session list. It should also
   say so when a sign-in's `brainId` is already held under another origin.
3. Found: makes that session the active one, if it is not already, and then
   follows `deepLink` in it. The deep link is a path on THAT brain, under
   that session's role (`/portal/...` for a member or a client, `/chat/...`,
   `/pending`, `/team-admin?...` for an admin).
4. Not found (the login signed out on this device, or the session was
   removed): opens that brain's sign-in screen when the app still knows the
   brain's origin for that `brainId` (from a session it held before), with
   the login's email filled in when it knows it; otherwise opens the app on
   its active session with no deep link. It never follows the deep link
   anywhere until the person has signed in as that login.
5. Never shows, sends or follows anything of the payload in another
   session: not the text, not the item id, not the deep link. No call goes
   to another brain or under another login's bearer because of this push.

A payload with no `brainId` comes from a brain older than v1.1 (or one whose
database is behind its code). If the device holds exactly one session, the
app behaves as in v1. If it holds more, it does not guess: it opens on the
active session without following the deep link (or offers the session list).
A payload with a `brainId` but no `loginId` is matched only when the device
holds exactly one session on that brain.

**Several logins of ONE brain on one phone each get their own pushes.** The
relay mints a new routing token on every `/enroll` (32 random bytes; it does
not look the device up by its OS push token), and the app runs the whole
Connect (connect, enroll, subscriptions) per login. So an admin, a test
member and a test client signed in on one phone are three device rows, with
one OS push token and one device key between them: each gets its own
pushes, each payload names its own `loginId`, and a sign-out of one takes
only its own row. A member's or a client's row never gets an owner teaser
(the send lists name logins, not phones). The phone shows one notification
per login an event concerns. Logins on DIFFERENT brains each enrol with that
brain, and each brain pushes its own. App side: keep the push subscription
id per session, and do not clear the shared device key when ONE session
disconnects while others still use it.

`collapseKey`: the brain names a member's or client's push by `chat`,
`review:<id>` or `comment:<id>`, but sends it to the relay as a keyed hash
(32 hex characters) of the login id and that name. The key of the hash is
derived from the brain's `SESSION_SECRET` and never leaves the brain. The
relay and the push provider see neither the kind of event nor an item id,
cannot compute the hash themselves, and cannot match one login's keys to
another's. The app must not parse the collapse key; read `kind`
and `itemId` from the sealed payload. Owner pushes keep their plain keys.

**Teasers are plain text.** Every body (`b`) that comes from markdown is sent
as plain words: an owner assistant reply, a run's question in an approval, a
member or client chat reply. Headings, bold and
italic, list markers, block quotes and code fences lose their marks; a link
and a reference chip (`page:`, `media:`, `mention:`, `folder:`, `draw:`)
keep the label and drop the target; a table keeps its cell text; code keeps
its text (a short command is the useful part); math keeps its source without
the `$`. An image keeps its alt text in an owner teaser; in a member or
client chat teaser pictures go whole. The cut to length happens after the
marks are gone. A teaser is never empty: a reply with no words reads
`New message`. Item titles and people's names are names, not markdown: they
are sent as they are (the "needs you" notice holds only those). The helper is
`markdownPreview` in `packages/content-core/src/markdown-to-text.ts`
(`@mantle/content-core/markdown-to-text`), so a client can use the same one;
the app keeps its own strip as a fallback for older brains.

**Version 1 is push plus refetch.** On a `chat` push the app refetches
`GET /api/member/chat` or `GET /api/client/chat`. There is no token stream for
these roles yet.

### 3. Unread for the member and client chat

    GET  /api/member/chat/unread     200 { unread, lastReadAt }
    POST /api/member/chat/read       { at? }   200 { unread, lastReadAt }
    GET  /api/client/chat/unread     same
    POST /api/client/chat/read       same

`unread` counts finished replies in the login's own thread newer than
`lastReadAt`. A login starts with nothing unread: the first call sets
`lastReadAt` to now. `POST read` moves the cursor to `at` (an ISO time; the
future counts as now) or to now, and never backwards. A malformed `at` is
400 `{ error: "invalid_body" }`. A reply that is still being written when the
thread is read is not marked read: it counts when it lands. The cursor runs
on the database's clock; pass `at` = the `createdAt` of the newest message
you showed, or nothing. An `at` with millisecond precision covers that whole
millisecond: the database keeps microseconds, so the message you name is
marked read even when it was written later in the same millisecond.

### 4. Pictures in a member or client thread

A reply is markdown. Image links are relative paths to the reader's own
routes: `/api/member/files/<id>`, `/api/member/draws/<id>/svg`,
`/api/client/files/<id>`, `/api/client/draws/<id>/svg`. Images the reader may
not read are already removed. Two ways to load one:

1. Send the bearer: `Authorization: Bearer <token>` on the image request.
   Preferred in a native app.
2. Append `?at=<assetToken>` (the shell's `assetToken`) when the renderer
   cannot set headers. A member's asset token lasts 2 hours, a client's 10
   minutes: call the shell again for a fresh one. It opens byte routes only.

### 5. Not in version 1 (deferred)

- A live token stream for member and client chat. Version 1 is push plus
  refetch.
- QR pairing from a signed-in member or client web session. Design note: a
  payload version 2 (`/pair#v=2&code=`) so shipped builds, which accept only
  version 1, never claim a code that would hand them a non-admin token.
- A push when a reply fails.
- The forum (retired) and apps on the phone.

### 6. How the brain does it (server notes)

**Migration 0213 `mobile_roles_push`.** `push_subscriptions.token_id` (the
device token that enrolled the device), a unique index on
`push_subscriptions.routing_token` (enrol is an upsert), `push_login_prefs`
(per-login toggles), `login_chat_read_cursors` (per-login read cursor),
`mobile_tokens.signed_in_at` (when the emailed code signed a client's phone
in; copied through every rotation) and `mobile_tokens.rotated_to` (the token
a rotated row was replaced by; reuse detection), and the `login_notice`
NOTIFY channel with three notify-only triggers: a finished outbound row in a
login's thread (`team_messages`), a review state becoming accepted, returned
or taken (`space_items`), a new comment (`node_comments`). The payload
carries ids only. Cost safety: the triggers write nothing and the only
listener is the push worker, which sends pushes and starts no LLM work.

If the migration is not applied, every push fails (the admins' too). The
worker says so once per process in one loud log line (`THE DATABASE IS
BEHIND THE CODE`, `lib/push/login-notice-handler.ts`), not one quiet line
per event.

**Migration 0226 `brain_identity`** (v1.1). One row: `brain_id`, a random
uuid made by the migration itself (`gen_random_uuid()`), guarded to one row
(the primary key is a boolean that can only be true). The code reads it and
never changes it (`server/web/lib/brain-identity.ts`, cached per process), so
it holds across restarts, upgrades and a restore of this brain's own backup.
A plain `scripts/db-restore.sh` keeps the dump's id, and says which: that is
the same brain (its own backup, the way back from a roll, a move that
replaces the old box). A NEW brain made from another brain's dump, one that
will run beside it (dev data seeded into a new prod box, one generated demo
dump seeded onto several boxes), is restored with
`scripts/db-restore.sh --new-brain <dump>`: the restored brain gets an id of
its own before the app starts. After the fact (the app already ran):
`update brain_identity set brain_id = gen_random_uuid()`, then restart the
server and the push worker; phones that held a session on it re-learn the id
at their next launch through whoami. A dump from before 0226 carries no id:
the next migrate gives the brain a fresh one either way. If the table cannot be read, whoami
and every push leave `brainId` out and the process says so once in one loud
log line; nothing else fails. No trigger, no job.

The send path sets the routing pair per device: `sendToDevices` reads the id
once per send, and `payloadForDevice` (`server/web/lib/push/notify.ts`) adds
it and the device row's `login_id` to the content the caller built. A caller
cannot set either field (the type leaves them out, and a stray one is
dropped).

**Auth** (`server/web/lib/auth/session.ts`, `tokens.ts`, `login-row.ts`).

- `getBearerLogin` checks the token row (present, not revoked, not expired,
  the same login as the token names). A token that carries an epoch is
  refused once the login's `session_epoch` differs. A client token must carry
  one and may not claim more than `CLIENT_SESSION_TTL_SECONDS`.
- `resolvedFor` accepts a client from a bearer. The gates are unchanged: a
  client reaches `getClientOr401` routes only, a member `getMemberOr401`
  routes only. The three sweeps (`role-sweep`, `client-sweep`, `member-sweep`)
  run each role's pass with a cookie AND with a bearer.
- `endLoginSessions` also deletes the push devices the revoked tokens
  enrolled; `token/refresh` moves them to the new token. A revoke of one
  device, End sessions, a password change and a disable also delete that
  login's devices that have no token on record (enrolled before migration
  0213 and not bound by its backfill). A sign-out (`mobile-logout`) deletes
  only its own token's devices.
- Rotation and reuse (`presentRotatedToken` in `session.ts`). A refresh
  mints the successor with no `last_used_at`; `getBearerLogin` stamps it on
  first use. A rotated token presented again: successor unused and live,
  the refresh answers the successor again (re-signed to its own expiry);
  successor used, the rotated row's `rotated_to` is cleared in one guarded
  UPDATE (so two presentations at once end things once), then
  `endLoginSessions`, the relay forgets the devices, and `auth.token_reuse`
  is written. `getBearerLogin` runs the same check on every bearer route. On
  a database that refuses writes the presentation is a plain 401.
- `token/refresh` locks the login row (`for share`) while it rotates, and an
  enrol locks its token row the same way (an enrol that lost the race to a
  refresh binds the device to the successor). End sessions, a password
  change and a disable update the login row first, so a refresh racing one
  of them cannot mint a token that outlives it. Postgres grants `for share`
  only to a role that may also UPDATE the table: the app's database role
  needs ordinary write rights (it has them on every brain); on a read-only
  database the lock is a refused write, so a refresh and an enrol fail there
  and write nothing (`lib/push/enrol-lock-roles.db.test.ts`).
- Device mode writes the token row inside the same transaction that redeems
  the emailed code, and writes the audit row after the insert, with the
  device id.
- The nightly maintenance sweep `device-tokens-reap`
  (`lib/auth/device-token-reap.ts`, plain SQL, no model) deletes a
  `mobile_tokens` row 30 days after it was revoked or expired. The push
  devices it enrolled go with it (FK cascade). By hand:
  `pnpm -C server/web device-tokens:reap` (dry run unless `--apply`).
- Audit rows: `auth.token_refreshed`, `auth.token_refresh_failed` (with the
  reason), `auth.token_reuse`, and `push.relay_registered` when a member's
  Connect registers the brain with the relay for the first time.

**Push targeting** (`server/web/lib/push/store.ts`, `notify.ts`,
`login-notify.ts`, `workers/push-notify.ts`).

- The store has NO list of every device of the brain for the send path.
  `listAdminSubscriptions` (active admin logins; an optional single login)
  serves the owner pushes. `listLoginSubscriptions` (one active member or
  client, live token of that same login) serves a login's own pushes.
- Decision: an agent assigned to one login (`agents.assigned_user_id`) pushes
  its replies to that login's devices only. An agent assigned to nobody
  pushes to every active admin. Approvals and "needs you" go to every active
  admin.
- Decision: a member may be the first to register the brain with the push
  relay (the first Connect). A client may not: it gets 409 `push_not_set_up`
  until an admin or a member has connected once.
- Who is told and with which words is `packages/content/src/login-notices.ts`
  (chat: the text as the reader's own chat route returns it; review: the
  author's own item, by the title it had when taken; comment: the author of
  a personal item in its own space, or every active client but the writer
  for a client-level item's client thread). An event older than 30 minutes
  tells nobody (a backfill must never page people).
- A bundle (Accept and Take over change every item in one transaction) is
  one push: the worker gathers a login's review events for 750 ms.
- The 30-minute freshness check runs on the database's clock, not the
  worker's.
- Bounds on one send: every relay call times out after 10 seconds, one send
  walks at most 100 devices, and the worker handles one notice at a time. A
  device the relay no longer knows (404 or 410) and a device whose public key
  cannot be sealed to are removed.

**Follow-ups (not in this release).**

- A per-account lockout on `device-login`. Today the limit is per address
  (10 a minute, the shared token-login bucket).
- Binding the relay connect ticket to the login. Not done: the relay fixes
  the ticket format. The per-login limit on connect (10 a minute) covers the
  abuse it would stop.

**Tests.** `server/web/lib/push/push-targeting.db.test.ts` is the gate: a
member device and a client device, enrolled and live, never receive an owner
teaser, an approval or a "needs you" notice; each device's payload names this
brain and its own login. `packages/db/src/brain-identity-migration.db.test.ts`
proves the one row and that a second run of 0226 keeps the id;
`packages/db/src/db-restore-run.db.test.ts` that a plain restore keeps it
and `--new-brain` gives a new one; the targeting test also enrols one phone
(one key) as an admin, a member and a client and checks each gets only its
own pushes, naming its own login;
`server/web/lib/brain-identity.test.ts`, `notify.test.ts`,
`login-notify.test.ts` and `needs-you.test.ts` pin the payload fields. `device-tokens.db.test.ts`
drives the three sign-ins, every way a token ends, refresh, the push device
routes and the unread routes through the real app.
`packages/content/src/login-notices.viewer.db.test.ts` proves the triggers
and who is told.
