# Mobile Companion — backend additions

_Last updated: 2026-06-13._

API + schema added to Mantle to support the **Mantle Companion** mobile app
(Flutter; repo `~/Projects/mantle-companion`). Single-user/self-hosted, so the
only auth scope is the owner. Everything here is **owner-gated via
`requireOwner()`**, which accepts the session cookie *or* a mobile bearer token —
so each route works unchanged from web and mobile.

> Status: built but **not yet verified end-to-end against a running server in the
> session that wrote it.** Apply migrations and smoke-test before relying on it.

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

- `GET /api/agents/[slug]/avatar?size=` (`app/api/agents/[slug]/avatar/route.ts`)
  — **server-renders the boring-avatars SVG** with
  `renderToStaticMarkup(createElement(Avatar, { name: seed, variant: style, size,
  colors }))`, reusing the existing `boring-avatars` dep. `runtime = 'nodejs'`.
  Returns `image/svg+xml`; **404** when the agent has no `avatar` (client falls
  back to initials).
- Palette is the **hex** Clean-Slate chart ramp (`#6366F1 …`), not the theme's
  oklch tokens, because SVG consumers like `flutter_svg` can't parse `oklch()`.
- **Watch this one:** rendering a React component in an API route is the most
  fragile piece — confirm it produces valid SVG and doesn't pull browser-only code.

## Migrations

The repo hand-writes migrations (drizzle-kit snapshots collide). Added:
`0089_mobile_tokens.sql`, `0090_assistant_read_cursors.sql`, each with a
`meta/_journal.json` entry. Apply with `pnpm db:migrate`.
