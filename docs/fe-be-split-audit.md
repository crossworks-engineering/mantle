# Frontend / Backend Split — Audit (v0.64.0)

**Question:** is `apps/web`'s frontend now fully separated from the server, talking only over
HTTP `/api/**`? **Short answer: no — not yet.** A well-built *core* is cleanly converted and the
client bundle is pure, but a substantial tail of screens is still server-coupled, server actions
remain, and the detached-client (Electron / DB-less) plumbing has real gaps.

Method: five parallel code audits + direct greps, 2026-06-26, branch `feat/dedicated-api-runners`.
Litmus tests are from `docs/frontend-backend-split.md` §9 (definition of done).

## Verdict against the §9 definition of done

| DoD criterion | Status |
|---|---|
| No page/component/server-action imports `@mantle/db` (value) outside `/api` | ⚠️ **db itself: met** (all such imports are type-only) — but the *data packages* (`@mantle/content/email/files/calendar/tools`) ARE called in pages → coupling persists |
| No server actions | ✅ **DONE (v0.65.x)** — all 9 action files removed; `grep "'use server'"` is empty |
| `revalidatePath` gone | ✅ **DONE** — 0 calls remain |
| Every screen reachable over HTTP | ❌ **~24 `(app)` routes still server-render against the DB**; several have no endpoint |
| Bearer auth across all `/api` incl. SSE | ✅ **JSON `/api` done (v0.65.0)** — middleware 401s unauthenticated `/api`, all 138 routes use `getOwnerOr401`, opt-in CORS added. ⚠️ SSE `/api/realtime` still not bearer-ready (item #5) |
| DB-less dev works | ⚠️ **mechanism built, 1 screen adopts it** — every other screen errors in remote mode |
| Phase 1 durable assistant path intact | ✅ unchanged |

## What is genuinely well implemented (don't re-do this)

- **The converted core is clean and consistent.** The 17 screens + `/inbox` named in the handover
  (content: pages/notes/todos/events/contacts/tables/lifelog; settings:
  skills/tools/tool-groups/ai-workers/agents/heartbeats/profile/discover/microsoft/accounts) all
  follow the same shape: data-free server page (auth gate only) → client component → `apiFetch`/
  `useQuery` → `/api/**`. Cross-verified, no leaks.
- **The client bundle is pure.** Zero client components value-import server-only code. Every
  `@mantle/*` import in a `'use client'` file is either `import type` (erased) or a deliberately
  browser-safe subpath (`@mantle/voice/client`, `@mantle/content/{contacts-format,lifelog-options,
  table-model,page-diff,page-toc,markdown,…}`) whose transitive graph never reaches Postgres /
  drizzle / `node:*` / Buffer. No Node built-ins, no `server-only`, no private `process.env` in
  client code.
- **The data layer is the right shape.** `lib/api-fetch.ts` (`apiFetch`/`apiSend`) supports both
  same-origin cookie auth and a configurable base-URL + bearer (`NEXT_PUBLIC_MANTLE_API_BASE` /
  `NEXT_PUBLIC_MANTLE_API_TOKEN`) for the detached case, and sniffs the redirect-to-`/login`
  failure. Wire DTOs live in zero-dep `@mantle/client-types` with server-alias drift checks.
- **Phase 1 runner** (`apps/api`, DBOS) and the absorbed agent runtime are intact.

## The gaps (what "not separated" actually means)

### A. ~24 `(app)` routes never converted — still SSR-against-DB (the biggest gap)
The conversion targeted a *named* list; these were outside it and still `await` DB reads in
`page.tsx` and pass props. 12 import data packages directly; the rest read via `@/lib/*` helpers.

- **No endpoint yet (build the API first):** ~~`/traces`(+`[id]`)~~ ✅ (v0.66.13, new
  `GET /api/traces` + `…/[id]`), ~~the `/debug/*` family~~ ✅ (v0.66.14–0.66.17: overview, agents,
  context, digests, facts, journey(+`[traceId]`), spend, telegram, topics — each got a new
  `GET /api/debug/*`; `/debug/integrity` was already done). **Still TODO:** `/studio` (graph read).
  (settings/{calendar,config,network,embedding,backups} + `/docs` were the #3 batch / are static.)
- **Endpoint exists, page still SSR-loads (just wire it):** ✅ **DONE (v0.66.1–0.66.12).**
  `/apps`(+`[id]`), `/pending`, `/heartbeats/[id]` (new `…/detail`), `/files`, `/secrets`(+`[id]`),
  `/models` (new `…/explore`), `/nodes/[id]/history` (new endpoint), `/dev-tools`,
  settings/{accounts/[id]/edit, keys (#3), peers, entities, pdf-passwords, updates (#3)}. A few
  needed a small new GET to bundle what the page computed (`/heartbeats/[id]/detail`,
  `/models/explore`, `/nodes/[id]/history`) or a pagination extension (`/secrets`, `/apps`).
- **Partial endpoints (extend to cover the page):** `/` dashboard (`/api/dashboard/summary`),
  `/assistant` (`/api/assistant/messages`).
- **Legitimately server-only (exclude):** `/n/[id]` (redirect router), `/changelog` (static md).

### B. Server actions + `revalidatePath` still present
9 `'use server'` files, **31 actions, all reachable from client components** (onboarding ×11, docs
×4, calendar ×3, config ×2, network ×4, embedding ×3, updates ×2, keys ×1, backups ×2). Most have
**no `/api` equivalent**; a few have read-only endpoints but the write/trigger path is still an
action. Two `<form action={serverAction}>` submits remain (`settings/calendar/calendar-row.tsx:67`,
`add-form.tsx:23`). **8 `revalidatePath` calls** (calendar/config/embedding/backups actions) — no
meaning for a detached client.

### C. The app shell reads the DB on every route — ✅ FIXED (v0.65.1)
~~`app/(app)/layout.tsx` calls `loadProfilePreferences` + `countPending` (+ `isOnboarded`)
in-process.~~ The layout is now data-free (auth + collapse cookies only); the avatar, the
pending-approvals badge, and the onboarding gate are fetched client-side by `AppShell` via a new
`GET /api/shell`, and the onboarding redirect moved into `AppShell`. The `UsageCard` already
self-fetched (`ownerId` prop).

### D. Detached-client blockers (Electron / cross-origin / DB-less)
- **Redirect-instead-of-401:** ~138/162 `/api` routes gate via `requireOwner`/`requireOwnerWithSource`,
  which `redirect('/login')` on failure — wrong for a programmatic client (it gets login HTML, 200).
  Only 11 use `getOwnerOr401`. `api-fetch.ts` papers over it for the browser; a bare Electron/CLI
  client without that shim won't. Flip API routes to `getOwnerOr401`.
- **No CORS on `/api`.** ACAO/`OPTIONS` exist only for `/app-runtime/*`. A cross-origin client is
  blocked at preflight on any JSON POST / `Authorization` request.
- **SSE not detached-ready.** `/api/realtime` uses `requireOwner` (redirect) and is consumed via
  browser `EventSource`, which can't send an `Authorization` header or honor `MANTLE_API_BASE`
  (hardcoded relative URL in `components/realtime/use-realtime.ts:25`). `assistant/stream` is the
  one bearer-correct SSE route. Needs a fetch-based SSE reader (or token-in-query) + `getOwnerOr401`.
- **Middleware bearer is mobile-only.** `middleware.ts` accepts only `k:'m'` tokens; a general
  detached token kind won't pass the Edge gate.

### E. DB-less seam built but unadopted
`lib/remote-data.ts` (`isRemoteData`/`remoteGet`) + `docs/db-less-dev.md` are correct, but only
`lib/data/email-accounts.ts` (→ `settings/accounts`) adopts it. Every other screen errors in remote
mode. Adoption shares work with the client-fetch conversion (A) — do them together via `lib/data/*`.

## Is it well implemented? 

**Yes for what's done — the patterns are sound and the converted core is leak-free.** The remaining
work is mostly *more of the same* (screens A + the shell C, each a mechanical conversion against the
proven 9-step recipe) plus a handful of *systemic* infra fixes (B server-action removal, D auth-gate
/ CORS / SSE, E seam adoption) that are one-time and unlock the actual Electron + DB-less goals.

## Recommended remediation order

1. ~~**Systemic auth fix (D):** API routes `requireOwner` → `getOwnerOr401`; add CORS + `OPTIONS` to
   `/api/**`.~~ ✅ **DONE (v0.65.0).** Middleware 401s unauthenticated `/api` + opt-in CORS
   (`MANTLE_API_CORS_ORIGINS`); all 138 routes gate via `getOwnerOr401`. (Bearer kind stays
   mobile-only — the documented Electron/DB-less reuse path; revisit at Task 5 token issuance.)
2. ~~**App shell (C):** make `(app)/layout.tsx` data-free.~~ ✅ **DONE (v0.65.1)** — new
   `GET /api/shell`; layout is auth + cookies only; `AppShell` fetches chrome + owns the
   onboarding redirect.
3. ~~**Server actions (B):** for each of the 9 action files, add the `/api` endpoint + convert the
   client.~~ ✅ **DONE (v0.65.x).** All 9 converted (config, backups, updates, calendar, network,
   docs, embedding, keys, onboarding) — server pages are data-free, mutations go through new
   `/api/**` endpoints via `apiSend`, every `'use server'` file + `revalidatePath` deleted. The
   key-probe logic was extracted to `lib/api-key-test` (shared by keys + onboarding). This also
   closed #4 for those 9 screens.
4. **Unconverted screens (A):** *in progress.* The **"endpoint already exists" sub-bucket is ✅ done**
   (v0.66.1–0.66.12): apps(+[id]), pending, heartbeats/[id], files, secrets(+[id]), models,
   nodes/[id]/history, dev-tools, settings/{peers, entities, pdf-passwords, accounts/[id]/edit}.
   **Build-endpoint bucket:** ~~`/traces`(+`[id]`)~~ ✅ (v0.66.13), ~~the `/debug/*` family~~ ✅
   (v0.66.14–0.66.17). **Remaining:** `/studio` (graph read), plus extend the partial endpoints for
   `/` (dashboard) and `/assistant`.
5. **SSE (D):** fetch-based reader honoring base-URL + bearer, so `/api/realtime` works detached.
6. **DB-less (E):** route the converted pages through `lib/data/*`; expand `docs/db-less-dev.md`
   coverage as screens land.
7. **Cosmetic:** relocate the 3 type-only `@mantle/db` client imports (persona-notes-editor,
   calendar-row, drives-list) into `@mantle/client-types`.

After 1–4 the frontend is functionally separated for the converted surface; 5–6 complete the
Electron/DB-less story; the §9 grep (`@mantle/db` outside `/api`) is already effectively clean —
the real signal to watch is "`@mantle/{content,email,files,calendar,tools}` value-called in a
`page.tsx`/`layout.tsx`", which should reach zero.
