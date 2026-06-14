# Mobile Companion — backend additions

_Last updated: 2026-06-13._

API + schema added to Mantle to support the **Mantle Companion** mobile app
(Flutter; repo `~/Projects/mantle-companion`). Single-user/self-hosted, so the
only auth scope is the owner. Everything here is **owner-gated via
`requireOwner()`**, which accepts the session cookie *or* a mobile bearer token —
so each route works unchanged from web and mobile.

> Status: **smoke-tested end-to-end on local dev (2026-06-13)** — migration 0090
> applied, and all four route groups verified with a mobile bearer (dashboard
> summary, conversations, read cursor, avatar all 200; owner-gate 307s without a
> token). The avatar route needed a fix during that pass — see its section.

## Auth — per-device bearer tokens

- `packages/db/src/schema/mobile-tokens.ts` + migration `0090_…`'s predecessor
  `0089_mobile_tokens.sql` — `mobile_tokens` table (revocable, expiry).
- `apps/web/lib/auth.ts` — `buildMobileToken` / `verifyMobileToken` /
  `mobileTokenJti` / `getBearerUser`; `getSessionUser()` falls back to
  `Authorization: Bearer`.
- `apps/web/middleware.ts` — accepts a valid mobile bearer (stateless verify),
  401s a malformed one (wrapped in try/catch).
- Routes: `POST /api/auth/mobile-login` `{email, password, deviceName}` →
  `{token, expiresIn}`; `POST /api/auth/mobile-logout` (revokes by `jti`).
- **Client contract:** a revoked-but-unexpired token passes the Edge gate but gets
  **307 → /login** from `requireOwner()` handlers (not 401). The app treats **401
  OR 3xx→/login** as "session invalid".

## Dashboard summary

- `GET /api/dashboard/summary` (`app/api/dashboard/summary/route.ts`) — mirrors the
  web dashboard KPIs by composing existing `lib/dashboard.ts` / `lib/metrics.ts`
  functions: `{ spend: {last7MicroUsd, prior7MicroUsd}, brain: {nodesTotal,
  entitiesTotal, edgesTotal, factsTotal}, vectors: {vectorsTotal, …}, pendingCount }`.
  Spend is **micro-USD** (÷1e6). System vitals come from the existing `/api/health`.

## Conversations inbox + read state

- Schema `packages/db/src/schema/assistant-read-cursors.ts` + migration
  `0090_assistant_read_cursors.sql` — `assistant_read_cursors(owner_id, agent_id,
  last_read_at)` (composite PK, FK → agents). Mantle had **no** read/unread concept
  before this.
- `apps/web/lib/assistant-inbox.ts` — `getReadCursors`, `markAssistantRead`
  (upsert), `assistantConversations` (per chat-capable agent: latest message
  preview + `unreadCount` = outbound messages newer than the cursor; sorted by
  recency).
- `GET /api/assistant/conversations` → `{ conversations: [{ agentId, slug, name,
  avatar, lastMessage: {text, direction, createdAt} | null, unreadCount }] }`.
- `POST /api/assistant/read` `{ agentSlug?, at? }` — marks an agent's thread read
  (clears unread). Omitting `agentSlug` marks the default agent.

## Agent avatar image

- `GET /api/agents/[id]/avatar?size=` (`app/api/agents/[id]/avatar/route.ts`) —
  server-renders the agent's boring-avatars SVG so non-web clients can show the
  same avatar. `runtime = 'nodejs'`. Returns `image/svg+xml`; **404** when the
  agent has no `avatar` (client falls back to initials). The key resolves as a
  **uuid when it looks like one, else as a slug** — so the companion's
  `/api/agents/<slug>/avatar` calls work unchanged.
- Palette is the **hex** Clean-Slate chart ramp (`#6366F1 …`), not the theme's
  oklch tokens, because SVG consumers like `flutter_svg` can't parse `oklch()`.
- **Two gotchas hit (and fixed) during smoke-testing:**
  1. **Segment-name conflict.** The route was first added at `[slug]/avatar`, but
     `agents/[id]/…` already exists. Next forbids two different dynamic slug names
     at one level and silently 404s *both*. Fix: nest under the existing `[id]`.
  2. **`react-dom/server` can't render the boring-avatars component here.** It
     calls `useId()`, and in a Next route the bundled React runtime and an
     imported `react-dom/server` are **two different React instances**, so the
     hook dispatcher is null → `Cannot read properties of null (reading 'useId')`.
     Fix: **`lib/avatar-svg.ts`**, a pure-string port of boring-avatars v2 (no
     React, no hooks; works in any runtime). Byte-for-byte colour+geometry parity
     with the library is pinned by `lib/avatar-svg.test.ts` (every variant × 8
     seeds) so it can't drift on a `boring-avatars` upgrade.

## Migrations

The repo hand-writes migrations (drizzle-kit snapshots collide). Added:
`0089_mobile_tokens.sql`, `0090_assistant_read_cursors.sql`, each with a
`meta/_journal.json` entry. Apply with `pnpm db:migrate`. **Both applied on local
dev (2026-06-13);** `assistant_read_cursors` verified: composite PK
`(owner_id, agent_id)`, `last_read_at timestamptz default now()`, FK →
`agents(id) ON DELETE CASCADE`.
