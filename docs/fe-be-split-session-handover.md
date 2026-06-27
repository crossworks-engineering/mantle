# FE/BE Split — Session Handover (for a fresh context)

**Read this, then [`docs/fe-be-split-audit.md`](fe-be-split-audit.md)** (the living remediation
checklist) and [`docs/client-data-fetching.md`](client-data-fetching.md) (the conversion recipe).

- **Branch:** `feat/dedicated-api-runners` · **Version:** `0.66.0` · **PR:** crossworks-engineering/mantle#1 (open, all work pushed) · **working tree clean.**
- The whole arc is the **frontend/backend split**: make `apps/web` a pure client that talks to the
  server only over HTTP `/api/**`, so an Electron desktop client and DB-less local dev become
  possible. Definition of done: `docs/frontend-backend-split.md` §9.

---

## What this session did (top of stack → down)

1. **Task 6 — absorbed `apps/agent` into `apps/api`** (Phase-1 carryover), v0.64.0.
   - Moved `apps/agent/src/*` → `apps/api/src/agent/*`; `main()` → `startAgentRuntime(opts)` +
     `stopAgentRuntime()`; `apps/api/main.ts` calls them after DBOS launch. Deleted `apps/agent`;
     dropped the compose `agent` service; root `dev` script drops the `agent` pane.
   - **Re-modeled the Telegram responder turn as a durable DBOS workflow**
     (`apps/api/src/workflows/telegram-turn.ts`) — runs `handleTelegramMessage` under
     `withDurableSteps`, enqueued with `workflowID = messageId`. Journaled the two replay hazards
     via `runDurableStep` (the atomic processed-claim + the inbound `recordTurn`).
   - **NOT live-smoked** (needs a configured Telegram account + agent + key in a dev DB); reasoned
     to mirror the live-verified assistant-turn pattern. Recorded in memory `api-service-phase1.md`.

2. **The audit** ([`docs/fe-be-split-audit.md`](fe-be-split-audit.md)) — 5 parallel sub-agents +
   greps. Verdict: the *converted core* (the 17 screens + `/inbox`) and *client bundle purity* are
   clean; the gaps were the unconverted tail, server actions, the app shell, and detached-client
   auth/CORS/SSE. The doc has the prioritized remediation list (#1–#7) and is kept updated as items
   land.

3. **#1 — detached-client `/api` auth** (v0.65.0):
   - `apps/web/middleware.ts`: unauthenticated `/api/**` now returns **401 JSON, not a 307 login
     redirect**; opt-in CORS via `MANTLE_API_CORS_ORIGINS` (off by default, bearer-only, handles
     `OPTIONS` preflight). One file fixes the common case for every route.
   - **Swept all 138 `/api` route handlers (213 call sites) from `requireOwner()` →
     `getOwnerOr401()`** + an `if (x instanceof Response) return x` guard (the global `Response` —
     `NextResponse extends Response` — so no new import). Pages keep `requireOwner` (a browser
     *should* get the login screen). Added `getOwnerOr401WithSource` for `assistant/turn`.

4. **#2 — data-free app shell** (v0.65.1):
   - New `GET /api/shell` → `{ onboarded, avatar, pendingApprovals }`. `app/(app)/layout.tsx` is now
     auth + collapse-cookies only; `AppShell` (client) fetches `/api/shell`, sources the avatar +
     badge, and **owns the onboarding redirect** (`router.replace('/onboarding')` when `!onboarded`).

5. **#3 — eliminated ALL server actions** (v0.65.x → v0.66.0). Converted + deleted all **9**
   `'use server'` files, one screen per commit: **config, backups, updates, calendar, network,
   docs, embedding, keys, onboarding**. After this: `grep -rl "'use server'" apps/web` is **empty**
   and **`revalidatePath` is gone**. Because #3 and #4 are the same screens, this also closed #4 for
   those 9. Notables:
   - **Calendar** removed the last two `<form action={serverAction}>` submits.
   - **Keys**: extracted the key-probe logic to **`lib/api-key-test.ts` (`probeApiKey`)**, shared by
     `POST /api/keys/test` and onboarding's sanity checks.
   - **Onboarding** (11 actions): one `/api/onboarding` route — `GET` resume-state + `POST`
     dispatcher over `action`; the already-onboarded redirect moved client-side (`?force` via
     `useSearchParams`, so the page is wrapped in `<Suspense>`).

**Status now:** ✅ #1 · ✅ #2 · ✅ #3 (+ #4 for those 9 screens). `/api` routes: 184 total, **172
`getOwnerOr401`**, 4 stray `requireOwner` (see Loose ends).

---

## The proven conversion recipe (used for all of #3; use it for #4)

Per screen (mirrors `docs/client-data-fetching.md`):

1. **Build the endpoint(s)** under `app/api/<area>/`:
   - `GET` returns exactly the bundle the page used to compute (replicate its server logic; move any
     server-side date-formatting / derived fields into the GET).
   - One `POST`/`PATCH`/`DELETE` per mutation. Move the old server action's *body* into the route.
   - Every route: `const user = await getOwnerOr401(); if (user instanceof Response) return user;`
   - For mutations that returned a `{ ok, message }`-style result the UI branches on, return it with
     **200** (not a 4xx) so `apiSend` resolves and the client branches — matches the old action.
2. **Data-free the page**: `await requireOwner()` then render the client component with **no data
   props**. Add `<Suspense>` if the client uses `useSearchParams`.
3. **Convert the client**:
   - **Outer query-gate + inner view** when the inner seeds `useState` from the data (profile/
     config/backups/updates/network/embedding/keys/onboarding all use this): outer runs
     `useQuery(['key'])` + loading/error gate → inner takes the loaded data as props and mounts only
     once it exists (so `useState` initializers are correct).
   - **Single component with `useQuery`** when there's no seeded form state (docs, calendar list).
   - Replace each server-action call with `apiSend('/api/...', 'POST'|'PATCH'|'DELETE', body)`.
   - Replace `router.refresh()` / `revalidatePath` with
     `queryClient.invalidateQueries({ queryKey: ['key'] })`.
   - `<form action={serverAction}>` → `<form onSubmit={...}>` (or keep `action={localFn}` where the
     local fn calls `apiSend`).
4. **Delete the `actions.ts`** (`git rm`); grep for stray importers (clients + cross-imports — e.g.
   onboarding imported keys' `testApiKeyAction`).
5. **Verify:** `pnpm --filter @mantle/web run typecheck` (the gate). Commit (one per screen) + bump
   (`pnpm version:bump patch`; `minor` to close a whole item) + push when asked.

---

## Remaining work (in priority order)

### #4 — the unconverted screens that never had server actions (the biggest remaining chunk)

**✅ "Endpoint already exists, just wire it" — DONE (v0.66.1–0.66.12).** Converted: `apps`(+`[id]`),
`pending`, `heartbeats/[id]` (built `GET /api/heartbeats/[id]/detail`), `files` (+`file-editor`),
`secrets`(+`[id]`; extended `GET /api/secrets` to paginate), `models` (built `GET /api/models/explore`),
`nodes/[id]/history` (built `GET /api/nodes/[id]/history`), `dev-tools` (seeds via `GET /api/tools`),
settings/{`accounts/[id]/edit`, `peers`, `entities`, `pdf-passwords`}. `n/[id]` stays server-only
(redirect router). Pattern notes:
- URL-driven lists (`apps`, `secrets`, `models`): page parses searchParams (no DB) → passes as
  props → client `useQuery` keyed on them with `placeholderData:(prev)=>prev`; `useListNav` still
  drives the URL. **No `useSearchParams`/Suspense needed** when the page forwards params as props
  (only `/files` reads `useSearchParams` in the client → wrapped in `<Suspense>`).
- A few needed a small new GET that bundles what the page computed (heartbeats detail / models
  explore / nodes history) or a pagination extension (`/secrets`, `/apps`).
- `/dev-tools` only data-frees the page (seeds `DevToolsShell` from `/api/tools`); the console's
  internal per-request fetches (`/api/dev-tools/*`, raw `fetch`) are a **separate larger pass** if a
  detached client needs them.
- Raw-asset element `src`s (`/api/files/files/[id]?raw=1` in `<img>`/`<iframe>`/download) were left
  same-origin — a detached-asset-auth follow-up, same class as the SSE bearer (#5).

**"Build the endpoint first" — mostly done:**
- ✅ `/traces`(+`[id]`) (v0.66.13): new `GET /api/traces` + `…/[id]`; SSR list → `TracesClient`
  (filters/sort/pager stay URL-driven `<Link>`s). Repointed `TraceDetailView`'s formatter import
  to the pure `@/lib/traces-format` so it bundles client-side.
- ✅ the whole `/debug/*` family (v0.66.14–0.66.17): overview, agents, context, digests, facts,
  journey(+`[traceId]`), spend, telegram, topics — each got a `GET /api/debug/*` + a client; pages
  keep `DebugTabs`/`SetPageTitle`. `ChatAgentOverride` now PATCHes via `apiSend` + invalidates.
  `ActiveNow` already self-polls. Debug formatters import from `traces-format`, not `@/lib/traces`.

**REMAINING:** `/studio` (graph read — build a GET), extend partials for `/` dashboard
(`/api/dashboard/summary`) + `/assistant` (`/api/assistant/messages`). `/docs/[...slug]` +
`/changelog` are static markdown — leave server-only. Each: build a GET returning the page's bundle,
then run the recipe.

### #5 — SSE bearer for `/api/realtime`
`/api/realtime` is consumed by `components/realtime/use-realtime.ts` via raw `EventSource`, which
**can't send an `Authorization` header or honor `NEXT_PUBLIC_MANTLE_API_BASE`** — so it's cookie/
same-origin only, unusable from a detached client. Also still `requireOwner` (redirect) — flip to
`getOwnerOr401`. Fix: replace `EventSource` with a fetch-based SSE reader (or token-in-query).
`assistant/stream` is already the bearer-correct reference.

### #6 — DB-less seam adoption
`lib/remote-data.ts` (`isRemoteData`/`remoteGet`) is built but adopted by exactly one module
(`lib/data/email-accounts.ts`). It's a fast-follow to the client-fetch conversion — route converted
pages' server reads through `lib/data/*`, or rely on the pure client-fetch path. See
`docs/db-less-dev.md`.

### #7 — cosmetic
Relocate the 3 type-only `@mantle/db` client imports (`persona-notes-editor`, `calendar-row`,
`drives-list`) into `@mantle/client-types` so the Task-0 grep is 100% empty. Pure tidiness.

---

## Loose ends / small follow-ups

- **4 `/api` routes still use `requireOwner` (redirect-on-fail), not `getOwnerOr401`:**
  `app/api/assistant/messages/route.ts`, `app/api/activity/route.ts`,
  `app/api/secrets/[id]/reveal/route.ts`, `app/api/dev-tools/proxy/route.ts`. The #1 sweep regex
  only matched `const user = await requireOwner()`; these use a different call shape and slipped
  through. Convert them for contract consistency (a detached client hitting them on an expired token
  gets an HTML redirect, not a 401). 3 routes also use a hand-rolled `getSessionUser` + 401
  (`auth/change-password`, `updates/status`, `updates/check`) — those are fine (already 401).
- **`agent-os/`** — an unrelated embedded git repo appeared in the working tree mid-session and got
  swept into a commit by `git add -A`; untracked + gitignored in `ec58d45`. If you see it again,
  it's ignored now. **Beware `git add -A`** in this repo for that reason — prefer `git add <paths>`.

---

## Hard-won gotchas (don't relearn)

- **`getOwnerOr401` guard uses the global `Response`**, not `NextResponse` — `NextResponse extends
  Response`, so `if (x instanceof Response) return x` narrows `SessionUser | NextResponse` →
  `SessionUser` with **no import**. (Routes here use the global `Response.json`, not `NextResponse`.)
- **Mutations the UI branches on should return 200 + `{ ok, message }`** (not a 4xx), so `apiSend`
  (which throws on non-2xx) resolves and the existing client branch works (network/embedding/docs/
  onboarding all rely on this).
- **Outer-gate + inner-view** is the pattern whenever the inner seeds `useState`/refs from data —
  the inner must mount *after* the fetch. Don't try to re-seed an already-mounted form.
- **`useSearchParams` (and `useRouter().replace` off query data) needs `<Suspense>`** around the
  client in the server page, or `next build` fails with a CSR-bailout.
- **JSON dates**: `Date` columns arrive as ISO strings over HTTP. `formatDateTime`/`new Date(...)`
  handle strings; watch `.toISOString()` on a value that's now a string (wrap in `new Date()`).
- **Client bundle purity**: never *value*-import `@mantle/db` / server packages in a `'use client'`
  file (drags `postgres`/Node in). Type-only imports are erased and fine; use `@mantle/content/*`
  **subpath leaves** (contacts-format, lifelog-options, table-model, page-diff, …) not the barrel.
- **`apiFetch`/`apiSend`** (`lib/api-fetch.ts`) already inject base-URL + bearer when
  `NEXT_PUBLIC_MANTLE_API_BASE`/`_TOKEN` are set, and bounce to `/login` on 401 — don't re-implement.
- **Can't run a 2nd `next dev`** — it collides on `.next` with the user's running `pnpm start`
  stack. So everything is **typecheck-verified, not browser-smoke-tested** (see below).

---

## Verification status (honest)

Every commit is **`@mantle/web` typecheck-clean** and the **91 agent tests pass**. **Nothing is
browser/runtime-smoke-tested** (a second dev server collides with the user's stack). After a dev
restart, the highest-value things to eyeball:
- The data-free **app shell** (avatar + pending badge load; onboarding redirect for a fresh install).
- The **`/api` 401 contract** (hit an `/api` route logged-out → 401 JSON, not a redirect).
- Each converted screen: list/form loads (brief spinner) → mutate → it reflects.
- **Telegram durable turn** (Task 6) — needs a configured account + agent + key; crash-resume is
  reasoned, not tested.

## Cadence (from project memory)

- One commit per discrete change (per screen). Bump version by extent (`pnpm version:bump
  patch|minor`); **don't tag** (tag-push is the publish event). **Push** updates PR #1 — the user
  has been fine with continuous pushing but **offer/confirm** rather than assume.
- Version history this arc: Task 6 → 0.64.0 · #1 → 0.65.0 · #2 → 0.65.1 · #3 → 0.65.2/0.65.3/0.65.4
  → **0.66.0** (#3 complete).

## Key files / reference points

- Audit + remediation checklist: `docs/fe-be-split-audit.md`. Original plan + DoD:
  `docs/frontend-backend-split.md`. Conversion recipe + per-screen notes: `docs/client-data-fetching.md`.
- Auth: `apps/web/lib/auth.ts` (`getOwnerOr401`, `getOwnerOr401WithSource`), `apps/web/middleware.ts`.
- Client data layer: `apps/web/lib/api-fetch.ts`, `components/query-provider.tsx`,
  `components/ui/spinner.tsx`. Shared wire types: `packages/client-types`.
- Worked #3 examples to copy: `/settings/config` (RPC mutations), `/settings/backups` (FormData
  form), `/settings/updates` (gate + preserved polling), `/settings/network` (run() wrapper),
  `/docs` (list + dialog), `/settings/embedding` (big seeded form), `/settings/keys` (optimistic
  list + extracted lib fn), `/onboarding` (multi-step + POST dispatcher).
- UI conventions (read before UI work): `apps/web/CLAUDE.md`, `docs/ui-style-guide.md`.
- Project memory: `api-service-phase1.md` (Phase 1 / Task 6), `commit-and-version-cadence.md`,
  `no-concurrent-next-builds.md`, `deploy-cadence.md`.
