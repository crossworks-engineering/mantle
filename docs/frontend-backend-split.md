# Frontend / Backend Split — Status & Phase 2 Handover

> ✅ **DONE & MERGED (v0.66.x, PR #1).** Both phases shipped: Phase 1 (durable
> runners) and Phase 2 (the FE/BE separation — `apps/web` is now a pure client,
> no `@mantle/db` in the browser bundle). This file is preserved as the **design
> + plan**; for what actually shipped and what remains (mostly Electron-scoped),
> read the completion record
> [`fe-be-split-session-handover.md`](./fe-be-split-session-handover.md). A
> current, condensed summary lives in
> [`architecture.md` §3a](./architecture.md#3a-durable-runners-the-febe-split-and-live-turn-streaming).

Status (as written): **Phase 1 complete** (durable runners). **Phase 2 not
started** (the actual FE/BE separation). This doc is the handover for Phase 2.

Branch for Phase 1: `feat/dedicated-api-runners`. Project memory:
`api-service-phase1.md`.

---

## 1. Why we're doing this

Two originating goals, neither yet delivered by Phase 1:

1. **A desktop (Electron) client** that reuses the *same* UI as the web app.
2. **DB-less local development** — stop needing direct Postgres access (over
   Tailscale) just to run the frontend.

The blocker for both is the same: **`apps/web` is not a frontend, it's a
full-stack app.** It server-renders against the database in-process (React
Server Components + Server Actions), so even "just the UI" needs DB credentials,
and there is no client bundle an Electron shell could load and point at an API.

Phase 1 addressed a *different*, adjacent problem (LLM work dying when you
navigate away) by making execution durable on a dedicated runner. That work
hardened the backend but did **not** split the frontend from it. Phase 2 is the
split.

---

## 2. What Phase 1 delivered (the starting point for Phase 2)

- **`apps/api`** — a dedicated, always-on Node service running durable LLM/agent
  work as **DBOS** workflows (journaled to a `mantle_dbos_sys` Postgres database).
  Assistant turns now execute here, off the web request, and survive web-process
  restarts. Per-step idempotency is proven (crash-recovery test:
  `apps/api/src/crash-test.ts`).
- **`@mantle/assistant-runtime`** — the turn-execution package (lifted out of
  `apps/web/lib/assistant.ts`), importable by any process. Holds `runAssistantTurn`,
  `resolveAssistantAgent`, and the cross-process runner **contract**
  (`contract.ts`: `ASSISTANT_TURN_WORKFLOW`, `RUNNER_QUEUE`, `AssistantTurnInput`,
  `AssistantTurnRunResult`, `resolveSystemDatabaseUrl`).
- **`@mantle/tracing` durable-step seam** (`durable.ts`) — an ALS-injected
  executor so existing `step()` boundaries become durable journal points when a
  workflow is active; inert (passthrough) otherwise.
- **The web route `/api/assistant/turn`** now enqueues the workflow via
  `DBOSClient` and awaits the result, relaying the **same response shape** — so
  the chat UI was unchanged. (`apps/web/lib/dbos-client.ts` = cached client.)
- Compose has an `api` service; the `migrate` one-shot provisions the DBOS system
  DB.

Net effect for Phase 2: **all business logic is in reusable packages**, there is
a **proven durable backend**, and there is **precedent** for non-Next consumers
of the same logic (`apps/api`, `apps/mcp`, `apps/agent`). What's missing is the
HTTP boundary as a *contract* and a frontend that consumes it.

---

## 3. Current architecture (be precise about the starting line)

> ⚠️ The counts below are from the pre-Phase-1 audit and **will have drifted**.
> Phase 2 task 0 is to **re-inventory** (commands given in §6). Treat these as
> order-of-magnitude.

**`apps/web` (Next.js 15, App Router):**
- ~**72 server pages** (`app/**/page.tsx`) — most `await` data functions
  *in-process* during render (RSC). This is the core coupling.
- ~**20 server actions** (`actions.ts`, `'use server'`) — mutate the DB in-process
  on form submit. ~5 import `@mantle/db` directly.
- ~**121 API route handlers** (`app/api/**/route.ts`) — already a substantial
  HTTP surface; consistent shape (Zod validate → call package fn → JSON).
- ~**81 client components** (~37 `*-client.tsx`); ~37 already `fetch('/api/*')`.
- ~**34 files import `@mantle/db` directly** (10 API routes, ~11 pages,
  ~8 components, ~5 server actions). These are the holes — code that touches the
  DB with **no HTTP endpoint** in front of it.
- ~**48 `revalidatePath` calls** — Next's server-cache invalidation, which has no
  meaning for a detached client.

**Shared packages (the backend logic, already extracted):**
`@mantle/db` (Drizzle schema + client), `@mantle/content` (notes/events/todos/
pages/tables/contacts/lifelog/peers), `@mantle/search`, `@mantle/files`,
`@mantle/tools`, `@mantle/agent-runtime`, `@mantle/assistant-runtime`,
`@mantle/email`, `@mantle/microsoft`, `@mantle/calendar`, `@mantle/heartbeats`,
`@mantle/tracing`, `@mantle/api-keys`, `@mantle/storage`, `@mantle/embeddings`.

**Auth (`apps/web/lib/auth.ts`, `auth-constants.ts`):**
- Stateless HMAC **session cookie** `mantle_session` (`{uid, exp}` payload).
- **Mobile bearer tokens** already exist (`getBearerUser`, `buildMobileToken`,
  `Authorization: Bearer …`) — the companion app uses them. **This is the auth
  path Electron and DB-less dev should reuse.**
- `requireOwner()` / `requireOwnerWithSource()` gate routes/pages; single-owner
  system (`resolveSingleOwnerId`).

**Realtime:** Postgres `LISTEN` → SSE. `/api/realtime` and
`/api/assistant/stream` emit `conversation_changed` etc. The chat client already
reconciles via `syncLatest`.

**Process topology (prod):** one Docker image, many compose services (`web`,
`api`, `agent`, `worker_*`, `migrate`, `caddy`, infra). Adding/extracting a
service is cheap (same image, different command).

**Other API-shaped consumers (proof the seam works):** `apps/mcp` (stdio MCP
exposing the same package functions), `apps/agent` (Telegram responder — slated
to be absorbed into `apps/api`, see §7 "Step 6").

---

## 4. The target architecture (after Phase 2)

```
┌─────────────────────────┐         HTTP (bearer auth, CORS)        ┌──────────────────────────┐
│  Client (one bundle)     │  ───────────────────────────────────▶  │  Backend                  │
│  - Web (browser)         │   GET/POST /api/*  + SSE /api/realtime  │  - HTTP API (the contract)│
│  - Electron (desktop)    │  ◀───────────────────────────────────  │  - apps/api durable runner│
│  client-side data fetch  │              JSON / events              │  - workers                │
│  (React Query/SWR)       │                                         │  - owns @mantle/db        │
└─────────────────────────┘                                         └──────────────────────────┘
```

- The **frontend is a pure client**: no server-side DB access, no RSC data
  fetching, no server actions. It renders from data fetched over HTTP and
  mutates via HTTP. An Electron shell loads the same bundle and points it at an
  API base URL.
- The **HTTP API is the only contract**. Whether it stays as Next route handlers
  or moves to a standalone service is a decision (§5) — but every screen's data
  must be reachable through it.
- **DB-less dev** falls out for free: run the client against a deployed/remote
  API with a bearer token; no local Postgres needed.

Non-goal for Phase 2: changing the data model, the durable runner, or the
single-tenant assumption.

---

## 5. Key decisions to make before/early in Phase 2

1. **RSC-everywhere vs client-rendered SPA.** The honest tension: Electron wants
   a client bundle, which pushes toward client-side data fetching for the screens
   Electron needs. But a full SPA rewrite of ~72 pages is large. **Recommended
   middle path:** convert screens to **client data-fetching against `/api`**
   incrementally (keep Next for routing/build, drop server-side DB access),
   rather than a big-bang SPA. This makes the same components Electron-loadable
   and removes the DB-from-web coupling page by page.

2. **HTTP surface: keep in Next vs standalone service.** Phase 1 chose
   "runners-first, keep HTTP in Next." For Phase 2, the cheapest correct move is
   to **treat `app/api/**` as the formal contract** and *not* immediately extract
   a separate HTTP service — extraction (e.g. a Hono app in `apps/api`) can come
   later once the frontend is fully client-side. Decide based on whether Electron
   talks to a *deployed* web (fine) or needs the API decoupled from the Next
   server (then extract).

3. **Cache/mutation strategy.** Pick one client data layer (React Query or SWR)
   and a convention for cache invalidation to replace the ~48 `revalidatePath`
   calls. This is a cross-cutting decision — set it before converting many pages.

4. **Auth for cross-origin clients.** Standardize on **bearer tokens** (already
   built for mobile) for Electron + DB-less dev. Decide token issuance/console
   UX. Cookies still work same-origin for the browser; bearer is additive.

5. **Single-tenant scoping.** Everything is `resolveSingleOwnerId`. Confirm this
   stays for Phase 2 (it should) — it keeps the API simple, but note it before
   exposing the API more broadly.

---

## 6. Phase 2 work breakdown (recommended sequencing — strangler, not big-bang)

**Task 0 — Re-inventory (do first; the §3 numbers are stale).**
```bash
# server pages
find apps/web/app -name 'page.tsx' | wc -l
# server actions
grep -rl "'use server'" apps/web/app | wc -l
# API routes
find apps/web/app/api -name 'route.ts' | wc -l
# direct DB access OUTSIDE api routes + lib (the holes to close)
grep -rl "@mantle/db" apps/web/app --include='*.tsx' --include='*.ts' | grep -v '/api/'
# revalidatePath call sites (the cache-invalidation migration)
grep -rn "revalidatePath" apps/web/app | wc -l
```
Produce a living checklist: every page/component/server-action that touches the
DB without an endpoint = an **API gap** to close.

**Task 1 — Close the API gaps.** For each direct-DB page/component/server-action,
add (or route it through) an `app/api/**` endpoint that calls the same package
function. After this, the API is *complete* — a prerequisite for any external
client. (~19 pages + ~5 server actions + attachment/mention routes from the
audit.) This is independently valuable and low-risk.

**Task 2 — Bearer auth across all of `/api`.** Ensure every endpoint accepts the
mobile-style bearer token (the mechanism exists; verify coverage, incl. the SSE
endpoints which were cookie-only). Now dev/Electron can authenticate without
cookies. Add CORS for the eventual separate origin.

**Task 3 — Solve DB-less dev immediately (high ROI, low effort).** Point local
frontend dev at a *deployed/remote* API via a bearer token instead of giving
every dev DB creds. Two ways: (a) full client-fetch screens hit the remote API;
(b) interim — even RSC pages can `fetch()` the remote API instead of importing
`@mantle/db`, removing local DB creds while keeping SSR. This delivers one of the
two originating goals before the full conversion is done.

**Task 4 — Convert screens to client data-fetching, page by page.** Replace
server-side `await getData()` + server actions with client fetches against `/api`
using the chosen data layer; replace `revalidatePath` with client cache
invalidation; add loading/error/empty states (SSR hid these). Use `/pages` (the
list/detail reference screen) as the first conversion and template. Order by
Electron priority (the screens the desktop app needs first).

**Task 5 — Electron shell.** Thin shell that loads the client bundle, injects the
API base URL + bearer token, and consumes SSE over HTTP. Realtime already works
over HTTP once Task 2 makes SSE bearer-auth'd.

**Task 6 — (carryover) Absorb `apps/agent` into `apps/api`.** Telegram +
heartbeat/reflector/extract runners move into `apps/api`, the Telegram loop
becomes a durable workflow, and `apps/agent` is deleted. This is a Phase 1
remainder; do it whenever convenient (independent of the FE work). Compose: drop
the `agent` service, the `api` service already exists.

---

## 7. Risks & gotchas

- **Realtime/SSE auth:** `/api/realtime` + `/api/assistant/stream` authorize by
  cookie today. A detached client needs them to accept bearer tokens — easy to
  miss.
- **Server actions are invisible coupling:** they're not in the `/api` count but
  are real mutations. Each must become an endpoint (Task 1/4).
- **`revalidatePath` everywhere:** ~48 sites. Don't convert pages without a
  client-cache invalidation convention in place (Decision 5.3).
- **Loading/error states:** SSR currently hides "no data yet" and error paths.
  Client fetching surfaces them — budget UI work per screen.
- **Connection pooling:** more processes (web + api + workers + DBOS system pool)
  = more Postgres connections. `max_connections=200` today; watch it, consider
  PgBouncer if the API scales out.
- **CORS + cookie SameSite:** once the client is a different origin (Electron
  custom scheme / different dev port), same-origin cookie assumptions break —
  bearer + CORS is the path.
- **Don't regress Phase 1:** the chat's durable-runner path
  (`/api/assistant/turn` → DBOS) and the `{inbound, outbound, reply, artifacts}`
  response contract must stay intact. The runner (`apps/api`) must be running for
  the assistant to work — it's in `pnpm dev` and compose.

---

## 8. Reference points (where to look)

- Auth + bearer tokens: `apps/web/lib/auth.ts`, `apps/web/lib/auth-constants.ts`.
- API route conventions: any `apps/web/app/api/**/route.ts` (Zod → package fn →
  JSON); `requireOwner()`.
- List/detail screen reference (URL-driven SSR, the conversion template):
  `apps/web/app/(app)/pages/`.
- Realtime client + SSE: `apps/web/components/realtime/use-realtime.ts`,
  `apps/web/app/api/realtime/route.ts`, `apps/web/app/api/assistant/stream/route.ts`.
- The durable-runner contract (model for any future cross-process API):
  `packages/assistant-runtime/src/contract.ts`, `apps/web/lib/dbos-client.ts`.
- Deploy topology: `docker-compose.yml` (one image, many commands).
- UI conventions (must-read before any UI work): `apps/web/CLAUDE.md`,
  `docs/ui-style-guide.md`.

---

## 9. Definition of done for Phase 2

- An Electron build loads the Mantle UI, authenticates with a bearer token, and
  is fully functional against a remote API — no bundled Next server, no DB access.
- Local frontend dev runs with **no Postgres credentials**, against a remote API.
- No `apps/web` page/component/server-action imports `@mantle/db` (the grep in
  Task 0 returns empty for non-API code), and `revalidatePath` is gone.
- The Phase 1 durable assistant path still works unchanged.
