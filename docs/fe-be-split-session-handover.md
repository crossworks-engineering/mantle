# FE/BE Split — Session Handover (for a fresh context)

**Read this first**, then [`docs/fe-be-split-audit.md`](fe-be-split-audit.md) (the living remediation
checklist #1–#7) and [`docs/client-data-fetching.md`](client-data-fetching.md) (the per-screen
recipe).

- **Branch:** `feat/dedicated-api-runners` · **Version:** `0.66.20` · **PR:**
  crossworks-engineering/mantle#1 (open, all work pushed) · **working tree clean.**
- **The arc:** make `apps/web` a pure client that talks to the server only over HTTP `/api/**`, so an
  Electron desktop client and DB-less local dev become possible. Definition of done:
  `docs/frontend-backend-split.md` §9.

---

## Where things stand: #1–#7 are CLOSED. The arc is done (one tracked email-types follow-up).

The remediation list (full detail in the audit doc) is a 7-item plan — **all seven are done**. The
only loose thread is a cosmetic follow-up split out of #7 (the email `Email`/`EmailAttachment` client
types — see #7 below).

| # | What | Status |
|---|------|--------|
| #1 | Detached-client `/api` auth: middleware 401s (not 307-redirects) unauthenticated `/api/**`; opt-in CORS (`MANTLE_API_CORS_ORIGINS`); all route handlers gate via `getOwnerOr401()` | ✅ v0.65.0 |
| #2 | Data-free app shell: `GET /api/shell`; `(app)/layout.tsx` is auth+cookies only; `AppShell` fetches chrome + owns the onboarding redirect | ✅ v0.65.1 |
| #3 | Eliminated **all 9** `'use server'` files (config, backups, updates, calendar, network, docs, embedding, keys, onboarding); `revalidatePath` gone | ✅ v0.66.0 |
| #4 | **Every dynamic `(app)` screen is now client-fetched** (24 screens, v0.66.1–0.66.20) | ✅ v0.66.20 |
| #5 | SSE bearer for `/api/realtime` — new fetch-based `apiEventStream` (base-URL + bearer) replaces `EventSource` in `useRealtime` | ✅ v0.66.21 (raw-asset `src`s + assistant stream internals remain) |
| #6 | DB-less dev — superseded by #4; client-fetch path is the mechanism, local auth gate made DB-less (`detachedDevUser`), orphaned seam removed | ✅ v0.66.22 |
| #7 | Cosmetic: relocate type-only `@mantle/db` client imports → `@mantle/client-types` | ✅ v0.66.23 (calendar/drives/persona done; email cluster `inbox`+`reading-pane` tracked separately) |

**Verification sweep (v0.66.20) is clean:** the only non-type `@/lib`/`@mantle` data imports left in
any `(app)/**/page.tsx` are `/n/[id]` (a `redirect()` router), the static-markdown readers
(`@/lib/docs-reader` for `/docs/[...slug]`, `@/lib/changelog`), and `COLOR_THEMES` (a static
constant). All of those are server-only by design. Everything dynamic is client-fetched.

### What #4 delivered (the screens converted this arc)

All typecheck-clean, one commit per screen, `v0.66.1 → v0.66.20`:

- **"Endpoint already existed, just wired it"** (v0.66.1–0.66.12): `/apps`(+`[id]`), `/pending`,
  `/heartbeats/[id]` (new `…/detail`), `/files` (+`file-editor`), `/secrets`(+`[id]`; paginated
  `GET /api/secrets`), `/models` (new `…/explore`), `/nodes/[id]/history` (new endpoint),
  `/dev-tools` (seeds via `/api/tools`), settings/{`accounts/[id]/edit`, `peers`, `entities`,
  `pdf-passwords`}.
- **"Built the endpoint first"** (v0.66.13–0.66.20): `/traces`(+`[id]`) → `GET /api/traces`+`…/[id]`;
  the whole **`/debug/*`** family (overview, agents, context, digests, facts, journey+`[traceId]`,
  spend, telegram, topics) → a `GET /api/debug/*` each; `/studio` → `GET /api/studio`; `/` dashboard
  → new full `GET /api/dashboard` (kept separate from the compact mobile `…/summary`); `/assistant`
  → `GET /api/assistant/thread`.

---

## The proven conversion recipe (use it for #6 and any future screen work)

Per screen (mirrors `docs/client-data-fetching.md`):

1. **Build the endpoint(s)** under `app/api/<area>/`:
   - `GET` returns *exactly* the bundle the page computed (replicate its server logic; move
     server-side date-formatting / derived fields into the GET so the client needs no server libs).
   - One `POST`/`PATCH`/`DELETE` per mutation; move the old handler's *body* into the route.
   - Every route: `const user = await getOwnerOr401(); if (user instanceof Response) return user;`
   - Mutations the UI branches on return **200 + `{ ok, message }`** (not a 4xx) so `apiSend` resolves.
2. **Data-free the page**: `await requireOwner()` (pages keep `requireOwner` — a browser *should* get
   the login screen), parse URL params/cookies if needed (neither is a DB read), render the client
   with **no data props**. Add `<Suspense>` only if the *client* calls `useSearchParams`.
3. **Convert the client**:
   - **Outer query-gate + inner view** when the inner seeds `useState`/refs from the data — the inner
     must mount *after* the fetch (e.g. peers, entities, apps, secrets, files, studio).
   - **Single component with `useQuery`** when there's no seeded form state.
   - URL-driven lists: page parses searchParams → passes as **props** → client `useQuery` keyed on
     them with `placeholderData:(prev)=>prev`; `useListNav`/`<Link>` filters keep driving the URL, so
     nav → new props → refetch. (Forwarding params as props avoids `useSearchParams`/Suspense.)
   - Replace raw `fetch`/server-action calls with `apiFetch`/`apiSend('/api/...', 'POST'|…, body)`.
   - Replace `router.refresh()` / `revalidatePath` with `queryClient.invalidateQueries({ queryKey })`.
4. **Verify:** `pnpm --filter @mantle/web run typecheck` (the gate). Commit (one per screen) + bump
   (`pnpm version:bump patch`; `minor` to close a whole item) + push when asked.

---

## Work log + remaining (#7 is all that's left)

### #5 — SSE bearer for `/api/realtime` ✅ DONE (v0.66.21)
- **Route side was already fine:** `app/api/realtime/route.ts` gates via `getOwnerOr401()`, so it
  already accepted a bearer.
- **The client gap is closed:** new `apiEventStream(path, onMessage, opts?)` in `lib/api-fetch.ts` is
  a fetch-based SSE reader — it carries the same base-URL + bearer + auth-failure/`bounceToLogin`
  logic as `apiFetch`, parses `data:` frames off the `ReadableStream`, and auto-reconnects with capped
  backoff (the EventSource semantics we relied on). `components/realtime/use-realtime.ts` now calls it
  instead of `new EventSource(...)`. Typecheck-clean; not browser-smoked (2nd dev server collides).
- **Remaining "needs a non-fetch transport to carry auth" follow-ups** (separate, not blocking #6/#7):
  raw-asset element `src`s — `/api/files/files/[id]?raw=1` in `<img>`/`<iframe>`/download links
  (file-editor), avatar images, etc. — are browser-native sources that can't carry a bearer. And the
  **assistant turn/stream** internals (`assistant-dock.tsx` → `/api/assistant/turn`, plus the
  unconsumed `/api/assistant/stream`) still use raw same-origin `fetch`. These work same-origin
  (cookie) today; a fully detached client needs a token-in-query or signed-URL approach for the asset
  `src`s and an `apiFetch`/`apiEventStream` pass over the assistant transport.

### #6 — DB-less dev ✅ DONE (v0.66.22)
Resolved by **pivoting to the client-fetch path** (decision: #4 made the original server seam
obsolete). The seam (`lib/remote-data.ts` + `lib/data/email-accounts.ts`) was already orphaned — its
one adopter, `/settings/accounts`, became client-fetched in #4 — so it was **removed**. The DB-less
mechanism is now simply `apiFetch` + `NEXT_PUBLIC_MANTLE_API_BASE`/`_TOKEN`: the browser fetches the
remote directly, so the local Next server needs no DB for screen data. The only residual server-side
DB read on a data-free page — the auth gate (`requireOwner`→`getSessionUser`→`authUsers`) — is now
handled by `detachedDevUser()` (`lib/auth.ts`), which **decodes** (not verifies) the bearer for the
identity instead of querying the DB. `docs/db-less-dev.md` describes this model.

**Post-audit fix (v0.66.24):** a deep audit found the first cut was *runtime-broken* despite being
typecheck-clean — the Edge `middleware.ts` 307'd every page nav to `/login` BEFORE the page render's
`requireOwner()`→`detachedDevUser()` could run (no local cookie; a nav can't carry a bearer) → an
infinite redirect loop, and `/login` then hit `countUsers()`. Fixes: (1) middleware now lets page
navs render when `isDetachedDev()`; (2) the activation gate moved to a **server-only** master switch
`MANTLE_DETACHED_DEV` (new `isDetachedDev()` in `lib/auth-constants.ts`; never a `NEXT_PUBLIC_` var)
that is hard-disabled in production — so the decode-without-verify bypass can't activate in a prod
build; (3) `isFirstRun()` short-circuits in detached mode so `/login` can't 500. **Still only
typecheck-verified — smoke it before relying on it** (see `docs/db-less-dev.md` "Not runtime-verified").

### #7 — cosmetic ✅ DONE (v0.66.23)
Relocated the type-only `@mantle/db` client imports into `@mantle/client-types`:
`persona-notes-editor` → existing `PersonaNoteDTO`; `calendar-row` + `calendar-client` → new
`CalendarAccountDTO`; `drives-list` → new `MsDriveDTO`. (The old handover said "3 files" but
`calendar-client` was a 4th using the same type.) The `GET /api/calendar` and
`GET/POST /api/microsoft/accounts/[id]/drives` routes now **map rows to those DTOs**, so the sealed
`feedUrlEnc` credential + the Graph `deltaLink` cursor stop reaching the browser, and the `: …DTO[]`
return annotation makes a row↔wire drift a compile error.

**Split-out follow-up (the email cluster):** `inbox-client` + `components/reading-pane` still import
`Email`/`EmailAttachment` from `@mantle/db`. That needs a full `EmailDTO`/`EmailAttachmentDTO` (the
`emails` row is large) plus a `ReadingPane` prop cascade — bigger than the cosmetic set, so it was
deferred (spawned as its own task). **Until it lands the §9 grep isn't 100% empty** — two client
files remain.

### Tiny follow-ups (optional, non-blocking)
- A few route files have **stale doc-comments** saying "owner-scoped via `requireOwner`" while the
  code actually calls `getOwnerOr401()` (assistant/messages, activity, secrets/[id]/reveal,
  dev-tools/proxy). Functionally correct — just comment drift. *(The old handover listed these as
  "stray requireOwner routes to convert" — that's resolved; they already 401.)*
- `/dev-tools`: the page is data-free, but the console's internal per-request fetches
  (`/api/dev-tools/*`, raw `fetch` inside `DevToolsProvider`) weren't converted — a separate pass if a
  detached client needs the console itself.

---

## Hard-won gotchas (don't relearn)

- **`getOwnerOr401` guard uses the global `Response`**, not `NextResponse` — `NextResponse extends
  Response`, so `if (x instanceof Response) return x` narrows `SessionUser | NextResponse` with no
  import. (Some routes still check `instanceof NextResponse` — both work; prefer `Response`.)
- **Client bundle purity** — the #1 trap when moving a render into a client: never *value*-import
  `@mantle/db` or a server lib into a client-bundled file (drags `postgres`/Node in). Type-only
  imports are erased and fine. Watch shared presentational components that get pulled client-side:
  `TraceDetailView` had to repoint `formatDuration`/`formatMicroUsd` from `@/lib/traces` (server) to
  the pure `@/lib/traces-format`. `@/lib/journey-format`, `@/lib/traces-format` are the pure
  siblings of their server libs. Use `@mantle/content/*` **subpath leaves**, not the barrel.
- **A "server component" with no `'use client'` and no server-only API (no `async`, no DB) bundles
  fine inside a client** — that's how `NodeBiography` / `TraceDetailView` / the dashboard cards got
  reused. Just make sure *their* imports are all client-safe.
- **`useSearchParams` in the client needs `<Suspense>`** around it in the server page, or `next build`
  fails with a CSR-bailout. Avoid it entirely by having the page parse searchParams and pass them as
  props (the URL-driven-list pattern).
- **JSON dates**: `Date` columns arrive as ISO strings over HTTP. `formatDateTime`/`new Date(...)`
  handle strings; watch `.toISOString()` on a value that's now a string. Most DTOs here already type
  dates as `string` (e.g. `TraceSummary.startedAt`, `AssistantTimelineRow.createdAt`).
- **Outer-gate + inner-view** whenever the inner seeds `useState` from data — mount the inner *after*
  the fetch. For master-detail screens that mutate a local list (peers, secrets, entities), the inner
  seeds from the loaded data and mutates locally; the outer's query is just the seed.
- **Mutations the UI branches on return 200 + body** (not a 4xx) so `apiSend` (throws on non-2xx)
  resolves and the client branch runs.
- **`apiFetch`/`apiSend`** (`lib/api-fetch.ts`) already inject base-URL + bearer when
  `NEXT_PUBLIC_MANTLE_API_BASE`/`_TOKEN` are set, and bounce to `/login` on a 401 or a followed
  redirect-to-/login — don't re-implement.
- **Can't run a 2nd `next dev`** — it collides on `.next` with the user's running `pnpm start` stack
  (see [[no-concurrent-next-builds]]). So everything is **typecheck-verified, not browser-smoked.**
- **`git add -A` is dangerous here** — an embedded `agent-os/` repo once got swept into a commit
  (gitignored since `ec58d45`). Prefer `git add <explicit paths>`. The shell cwd also drifts between
  Bash calls — `cd /Users/jasonschoeman/Projects/mantle` before `pnpm version:bump`.

---

## Verification status (honest)

Every commit is **`@mantle/web` typecheck-clean**. **Nothing this arc is browser/runtime
smoke-tested** (a 2nd dev server collides with the user's running stack). After a dev restart, the
highest-value things to eyeball:
- A converted screen end-to-end: loads (brief `<Spinner>`) → mutate → reflects.
- URL-driven lists (`/apps`, `/secrets`, `/models`, `/traces`, `/debug/*`): filter/sort/page nav
  refetches and the detail pane tracks selection.
- The `/api` 401 contract: hit an `/api` route logged-out → 401 JSON, not an HTML redirect.
- `/studio` + `/assistant`: client selection / agent state survives a refetch (the keyed-remount /
  stable-instance logic).

## Cadence (from project memory)

- One commit per discrete change (per screen). Bump by extent (`pnpm version:bump patch|minor`);
  **don't tag** (tag-push is the publish event). **Push** updates PR #1 — the user has been fine with
  continuous pushing this arc but **offer/confirm** rather than assume.
- This arc's version history: #1 → 0.65.0 · #2 → 0.65.1 · #3 → 0.66.0 · #4 → 0.66.1…0.66.20 ·
  #5 → 0.66.21 · #6 → 0.66.22 · #7 → **0.66.23**.

## Key files / reference points

- Checklist: `docs/fe-be-split-audit.md`. Plan + DoD: `docs/frontend-backend-split.md`. Recipe:
  `docs/client-data-fetching.md`. DB-less: `docs/db-less-dev.md`.
- Auth: `apps/web/lib/auth.ts` (`getOwnerOr401`, `getOwnerOr401WithSource`), `apps/web/middleware.ts`.
- Client data layer: `apps/web/lib/api-fetch.ts` (`apiFetch`/`apiSend`), `components/query-provider.tsx`,
  `components/ui/spinner.tsx`. Shared wire types: `packages/client-types` (`@mantle/client-types`).
- Fetch-based SSE reader (the #5 deliverable): `apiEventStream` in `lib/api-fetch.ts`, used by
  `components/realtime/use-realtime.ts`. Bearer-correct SSE *route* reference: `app/api/assistant/stream/route.ts`.
- Pure formatter siblings (client-safe): `@/lib/traces-format`, `@/lib/journey-format`.
- UI conventions (read before UI work): `apps/web/CLAUDE.md`, `docs/ui-style-guide.md`.
- Project memory: `api-service-phase2.md` (this arc's state), `api-service-phase1.md` (Phase 1 /
  Task 6 durable runners), `commit-and-version-cadence.md`, `no-concurrent-next-builds.md`,
  `deploy-cadence.md`.
