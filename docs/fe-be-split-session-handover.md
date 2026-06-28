# FE/BE Split — Completion Record & Handover

**Status: the arc is DONE and MERGED to `main`.** This doc is the record of what shipped, what was
fixed after the audit + smoke pass, and what remains (mostly future / Electron-scoped). For deeper
context see [`docs/fe-be-split-audit.md`](fe-be-split-audit.md) (the 7-item checklist),
[`docs/client-data-fetching.md`](client-data-fetching.md) (the per-screen recipe, also inlined below),
and [`docs/frontend-backend-split.md`](frontend-backend-split.md) §9 (definition of done).

- **Merged:** PR crossworks-engineering/mantle#1 → `main` via a **merge commit** (`f79ba436`, history +
  SHAs preserved, no squash). The `feat/dedicated-api-runners` branch is kept as a safety net.
- **Version:** ~`0.66.41` · **Untagged** (tag-push is the publish/deploy event — Jason's call).
- **The arc:** make `apps/web` a pure client that talks to the server only over HTTP `/api/**`, so an
  Electron desktop client + DB-less local dev become possible. **§9 definition-of-done is met:** no
  client-bundled file imports `@mantle/db` — the browser bundle is Postgres-free.
- **Score (re-assessed, Electron deferred far out): ~9/10 for the same-origin web app** (was ~6.5/10
  at the raw audit). See "Score & honest caveats" below.

---

## 1. The 7-item arc — all CLOSED

| # | What | Done |
|---|------|------|
| #1 | Detached `/api` auth: middleware 401s (not 307) unauthenticated `/api/**`; opt-in CORS (`MANTLE_API_CORS_ORIGINS`); all routes gate via `getOwnerOr401()` | v0.65.0 |
| #2 | Data-free app shell: `GET /api/shell`; `(app)/layout.tsx` is auth+cookies only; `AppShell` fetches chrome + owns onboarding redirect | v0.65.1 |
| #3 | Eliminated **all 9** `'use server'` files; `revalidatePath` gone | v0.66.0 |
| #4 | **Every dynamic `(app)` screen client-fetched** (24 screens) | v0.66.1–0.66.20 |
| #5 | SSE bearer for `/api/realtime` — `apiEventStream` (base-URL+bearer) replaces `EventSource` | v0.66.21 |
| #6 | DB-less dev — client-fetch path is the mechanism; local auth gate via `detachedDevUser` | v0.66.22 |
| #7 | Client `@mantle/db` type imports → `@mantle/client-types` | v0.66.23 |

---

## 2. Post-#7: deep audit + remediation (this is the bulk of recent work)

A 5-dimension deep audit scored the raw arc **~6.5/10** — strong at what shipped (bundle purity,
owner-gating, wire mapping) but flagged criticals, two pre-existing auth bypasses, and "nothing
browser-smoked." All of that is now addressed:

### 2a. Criticals + pre-existing auth bypasses — FIXED (v0.66.24–25)
- **[critical] DB-less was runtime-broken** (typecheck-clean but unsmoked): the Edge middleware 307'd
  every page nav to `/login` *before* the page render's `detachedDevUser()` could run → infinite loop,
  and `/login` then hit `countUsers()`. Fixed: middleware lets page navs render when `isDetachedDev()`;
  `isFirstRun()` short-circuits in detached mode.
- **[high] Detached-dev gate hardened**: activation moved to a **server-only** `MANTLE_DETACHED_DEV`
  flag (`isDetachedDev()` in `lib/auth-constants.ts`, edge-safe), hard-disabled in production — the
  decode-without-verify identity shim can never activate in a prod build.
- **[high] Mobile-token-as-cookie revocation bypass**: `verify()` (cookie path) + the middleware
  cookie branch now reject ANY kinded token (`k:'m'`/`k:'a'`). A mobile token placed in the session
  cookie used to authenticate via the DB-lookup path, dodging `mobile_tokens.revoked_at`.
- **[high] Rate-limit XFF spoofing**: `clientIp()` keys on the proxy-appended *rightmost* XFF entry
  (`MANTLE_TRUSTED_PROXIES` hops from the right, default 1), not the forgeable leftmost.

### 2b. Big follow-ups — DONE (v0.66.26–33)
- **Raw-`fetch` → `apiFetch`/`apiSend`** (v0.66.26–28; `94b6af0f`/`d91aa3b5`/`a7faf760`): ~50 sites
  (screens, detail panes, assistant reads, dev-tools panels, shared components). Pattern:
  `catch (e) { if (e instanceof ApiError && e.status===401) return; toast.error(…) }` so expiry bounces
  to /login silently; FormData uses `apiFetch` (not `apiSend`, which would clobber the multipart
  boundary). **Raw-by-design exceptions (left intentionally):** change-password (401 = wrong-password,
  not signed-out), updates status-poll (deploy signal), app-sandbox brokers/bundle (mini-app runtime;
  bundle is JS not JSON), assistant turn/stream (streaming bodies), logout POSTs (401 moot),
  `lib/dev-tools/client.ts` (HTTP-inspection console needs the raw `Response`).
- **`apiEventStream` hardened** (v0.66.29; `0e0fd9b3`→`50d05378`): a throwing `onMessage` → `onError`
  (no reconnect storm); exponential backoff (`2**attempt`, cap 30s) + jitter. *Open: Last-Event-ID
  replay (LISTEN/NOTIFY has no backlog — realtime is best-effort; pair with `refetchInterval` if a
  screen must not miss a reconnect-gap event).*
- **#4 email cluster** (v0.66.30; `8bbdf7ac`): `EmailDTO`/`EmailAttachmentDTO`/`MessageDetailDTO` in
  `@mantle/client-types`; `inbox-client`+`reading-pane` off `@mantle/db`; the message route maps to the
  DTO (raw `bodyHtml`/ids/headers no longer cross the wire). **§9 grep is now EMPTY.**
- **#5 cleanups** (v0.66.31; `dfdf6c7d`): 4 stale `requireOwner` comments → `getOwnerOr401`;
  `useRealtime` documented best-effort. Rate-limiter left as-is (intentional single-instance).
- **#3a content DTO unification** (v0.66.32; `4a16f11f`): task/event/journal/pages re-export the
  canonical `@mantle/content` `*Row` (fixed real drift — event was missing `timezone`, pages `width`);
  drift is now a compile error. **#3b decided:** no blanket response validation (first-party producers
  + compile-time drift checks suffice).
- **#2 assets via signed tokens** (v0.66.33; `a33fc40e`): short-lived owner-scoped asset token
  (`k:'a'`, 2h) in `?at=` — `buildAssetToken`/`getOwnerForAsset` (`lib/auth`), minted by `GET /api/shell`,
  appended by `assetUrl()` (`lib/asset-url`, same-origin unchanged). Middleware accepts `?at=` ONLY for
  GET on the 2 asset paths (`/api/files/files/`, `/api/attachments/`). Wired file-editor / reading-pane /
  assistant-client.

### 2c. Merged to `main`, then browser-smoked
After integrating the above, **PR #1 was merged to `main`** (`f79ba436`). Then **Jason browser-smoked
EVERY screen, same-origin — clean.** This retires the audit's #1 risk ("nothing browser-smoked") for
the same-origin web app. **Five latent bugs surfaced during the smoke pass and were fixed on `main`**
(the raw-`fetch`→`apiFetch` conversions surface pre-existing *swallowed* errors — expect this pattern):
- **Fonts** (v0.66.34–35; `baf290f9`/`b5648d19`): Inter `.ttf`→`.woff2` (1.78MB→734KB) and dropped the
  `<link rel=preload>` (next/font preloads every src incl. the rarely-used italic → "preloaded but not
  used" warning). `woff2_compress` (brew install woff2); sources regen-able.
- **Assistant `/api/assistant/messages` 400** (v0.66.36; `044bc856`): route required a `before`
  cursor, but `syncLatest` omits it to fetch the latest page → default a missing `before` to now.
- **Dev-tools console crash** (v0.66.37; `434c12db`): shared `queryKey: ['tools']` stored two shapes —
  settings/tools & tool-groups unwrap to the array, dev-tools cached the `{tools}` wrapper → `.filter`
  on undefined. Aligned dev-tools to the array + defaulted the provider to `[]`.
- **Header hydration-id mismatch** (v0.66.38; `9386b3ab`): async `UsageCard` passed as the AppShell
  `contextCard` with no boundary → its SSR suspension shifted every radix `useId` in the shell. Wrapped
  it in its own `<Suspense>`.

### 2d. Audit minor items #2 + #4 — DONE (v0.66.39–41)
- **#2 "zod gap" was a grep false-positive** (v0.66.39; `61c79843`): the flagged routes already
  validate (zod via `heartbeat-schema`, strict `typeof` on push/*, allowlist on studio/reset,
  defensive coercion on embedding/studio). The ONE real gap — onboarding's `persona` action took an
  unchecked `body as SavePersonaInput` → `savePersonaAgent`'s `input.assistantName.trim()` 500'd on a
  bad body — fixed with a zod schema.
- **#4 UTC "today" bug** (v0.66.40; `610b8978`): new `localDay()` in `lib/format-datetime`; the debug
  overview spend bar + integrity "recent" cutoff compare local date, not UTC.
- **#4 CORS `'*'` hardened** (v0.66.41; `f0dcc812`): the wildcard no longer reflects onto `/api/auth/*`
  (those return a bearer in the body); auth needs an explicit allowlist entry. Non-auth `/api` keeps `'*'`.
- **#4 deliberately WON'T-FIX** (documented): over-broad `invalidateQueries` (functionally correct;
  broad + risky to scope-narrow for a perf nicety) and a global `MutationCache.onError` sink (would
  double-toast — mutations already toast per-call-site, and raw `apiSend` try/catch paths don't go
  through `MutationCache` anyway).

---

## 3. What's LEFT (priority order)

1. **Automated regression net — the single highest-leverage gap.** Verification is typecheck + a
   one-time manual smoke + the existing unit tests; there's no browser/E2E suite that *re-catches* a
   hydration / cache-shape / swallowed-error regression. A small **Playwright smoke** over the
   converted screens would convert the manual pass into a permanent safety net (and is what would push
   the score past a *durable* 9).
2. **Electron / true-detached path — DEFERRED far into the app's future** (Jason's call). It's
   foundationally built but **unexercised**, so this is deferred *risk*, not closed:
   - **Assistant turn/stream transport** not on the bearer (streaming + FormData) — same-origin only.
   - **Page-embedded image `src`s** bake a relative `/api/files/...?raw=1` into stored docs → need a
     render-time `assetUrl()` rewrite in the image NodeView (**spawned task**).
   - **Smoke the detached-specific behaviors when Electron lands**: the `MANTLE_DETACHED_DEV` gate, the
     asset `?at=` *success* path (cross-origin valid token), CORS against a real remote origin. (Their
     same-origin/cookie behavior + the `?at=` *rejection* path were verified; the detached success
     paths were not.)
3. **`apiFetch<T>` is an unchecked cast** — no runtime response validation. Accepted (first-party
   producers + compile-time DTO drift checks), but it's a trust boundary with no belt. Optional: zod on
   a few hot responses if drift ever bites.
4. **Minor leftovers** (low priority): `keys-client` dual source of truth (local list + query cache);
   secondary-data silent swallow (peers shares / node search); in-memory rate limiter is per-process
   (only a blocker once `apps/api` scales horizontally — see [[api-service-phase1]]).
5. **Publish:** still untagged. Tag → CI builds `titanwest/mantle:latest` → prod registry-pull (a real
   deploy — see [[prod-deploy-is-registry-pull]] / [[deploy-cadence]]). Do only when Jason says.

---

## 4. Score & honest caveats

Re-scored with Electron deferred (so detached-readiness is future work, not a current production gate):

| Dimension | Raw audit | Now |
|---|---|---|
| Wire contract & bundle purity | 9 | **9.5** (§9 empty; content DTOs unified; only the unchecked cast remains) |
| Security & auth | 7 | **9** (all four findings closed; owner-gating always universal) |
| Client-fetch architecture | 7 | **8.5** (raw-fetch converted; UTC fixed; every screen smoked) |
| Production readiness | 6.5 | **9** (smoke pass retires #1 risk; DB-less entry fixed) |
| Detached transport | 6 | **7, reweighted down** (apiEventStream + signed assets done; assistant/page-image deferred) |
| **Overall (same-origin web app)** | **~6.5** | **~9** |

**The honest asterisk:** the grade rests partly on *deferring* the detached frontier rather than
*finishing* it, and on *manual* rather than *automated* verification. Both are fine for the current
goal; both are the first things to revisit when Electron returns or when a regression slips.

---

## 5. The proven conversion recipe (for any future screen / a similar split)

Per screen (mirrors `docs/client-data-fetching.md`):

1. **Build the endpoint(s)** under `app/api/<area>/`:
   - `GET` returns *exactly* the bundle the page computed (move server-side date-formatting / derived
     fields into the GET so the client needs no server libs). **Map rows to a DTO** in
     `@mantle/client-types` and annotate the return `: XDTO[]` so a row↔wire drift is a compile error
     (and server-only/sealed columns don't leak).
   - One `POST`/`PATCH`/`DELETE` per mutation; move the old handler's *body* into the route.
   - Every route: `const user = await getOwnerOr401(); if (user instanceof Response) return user;`
   - Mutations the UI branches on return **200 + `{ ok, message }`** (not 4xx) so `apiSend` resolves.
2. **Data-free the page**: `await requireOwner()` (pages keep `requireOwner` — a browser *should* get
   the login screen), parse URL params/cookies if needed, render the client with **no data props**. Add
   `<Suspense>` only if the *client* calls `useSearchParams`, OR an async server component is rendered
   as a prop/child (see the UsageCard hydration gotcha below).
3. **Convert the client**:
   - **Outer query-gate + inner view** when the inner seeds `useState`/refs from data (peers, entities,
     apps, secrets, files, studio). **Single component with `useQuery`** when there's no seeded state.
   - URL-driven lists: page parses searchParams → passes as **props** → client `useQuery` keyed on them
     with `placeholderData:(prev)=>prev`; `useListNav`/`<Link>` filters keep driving the URL.
   - Replace raw `fetch`/server-action calls with `apiFetch`/`apiSend`. Replace `router.refresh()` /
     `revalidatePath` with `queryClient.invalidateQueries({ queryKey })`.
   - **One queryKey = one shape.** If multiple screens share a key (e.g. `['tools']`), every consumer's
     queryFn MUST return the same shape (all unwrap, or none) — see the dev-tools crash.
4. **Verify:** `pnpm --filter @mantle/web run typecheck` (the gate). Commit (one per discrete change) +
   bump (`pnpm version:bump patch`; `minor` for a feature). Push/tag only when asked.

---

## 6. Hard-won gotchas (don't relearn)

- **Client bundle purity** — never *value*-import `@mantle/db` or a server lib into a client-bundled
  file (drags `postgres`/Node in). Type-only imports are erased and fine. Watch shared presentational
  components pulled client-side. Pure formatter siblings: `@/lib/traces-format`, `@/lib/journey-format`.
  Use `@mantle/content/*` **subpath leaves**, not the barrel. (The §9 grep enforces this — keep it empty.)
- **`getOwnerOr401` guard uses the global `Response`** (not `NextResponse`) — `if (x instanceof
  Response) return x` narrows with no import.
- **A "server component" with no `'use client'` and no server-only API bundles fine inside a client**
  — but an **async** server component passed as a prop/child needs its **own `<Suspense>`**, or its SSR
  suspension shifts every radix `useId` in the parent client tree → a hydration-id mismatch (the
  `UsageCard`/header bug). 
- **`useSearchParams` in the client needs `<Suspense>`** in the server page, or `next build` fails with
  a CSR-bailout. Prefer parsing searchParams in the page and passing as props.
- **JSON dates**: `Date` columns arrive as ISO strings over HTTP. Compare day-bucketed dates with
  `localDay()` (`lib/format-datetime`), NOT `new Date().toISOString().slice(0,10)` (UTC → wrong day
  near local midnight). Watch `.toISOString()` on a value that's now a string.
- **Mutations the UI branches on return 200 + body** so `apiSend` (throws on non-2xx) resolves.
- **`apiFetch`/`apiSend`/`apiEventStream`** (`lib/api-fetch.ts`) inject base-URL + bearer when
  `NEXT_PUBLIC_MANTLE_API_BASE`/`_TOKEN` are set and bounce to `/login` on 401 — don't re-implement.
  Browser-native `src`s can't carry a bearer → use `assetUrl()` (signed `?at=` token) for those.
- **The conversions surface pre-existing *swallowed* errors.** Old raw `fetch` + `if(!res.ok)return`
  hid 400s/500s; `apiFetch` throws → they become visible (the assistant 400, the dev-tools crash).
  When converting, expect to *fix* a latent bug, not just reshape the call.
- **Can't run a 2nd `next dev`** — collides on `.next` with the running stack (see
  [[no-concurrent-next-builds]]). Verify with typecheck + headless `curl` (the 401/redirect/`?at=`
  contracts) + Jason's browser for logged-in screens.
- **`git add -A` is dangerous here** — an embedded `agent-os/` repo once got swept in (gitignored since
  `ec58d45`). Prefer explicit paths. `cd` to the repo root before `pnpm version:bump`.

---

## 7. Verification status (honest)

- **Same-origin web app: browser-smoked clean** — every screen exercised by Jason (this session), plus
  headless `curl` contract checks (logged-out `/api` → 401 JSON; page nav → `/login`; asset routes deny
  no-auth + reject a forged `?at=`). Five latent bugs found & fixed (§2c).
- **NOT covered:** automated/E2E regression tests (none) and the **true detached/Electron paths** (the
  `MANTLE_DETACHED_DEV` gate, the asset `?at=` *success* path, CORS against a real remote) — those are
  typecheck + headless-contract verified only, to be smoked when Electron lands.

---

## 8. Key files / reference points

- Auth: `apps/web/lib/auth.ts` (`getOwnerOr401`, `getOwnerForAsset`, `buildAssetToken`,
  `detachedDevUser`), `apps/web/lib/auth-constants.ts` (`isDetachedDev`, `PUBLIC_PATHS`),
  `apps/web/middleware.ts`.
- Client data layer: `apps/web/lib/api-fetch.ts` (`apiFetch`/`apiSend`/`apiEventStream`),
  `apps/web/lib/asset-url.ts` (`assetUrl`/`setAssetToken`), `components/query-provider.tsx`.
- Wire types: `packages/client-types` (`@mantle/client-types`); content rows re-exported from
  `@mantle/content`. Drift-alias pattern: server aliases its summary to the DTO.
- Realtime: `apiEventStream` ← `components/realtime/use-realtime.ts`; routes `app/api/realtime/route.ts`
  + `app/api/assistant/stream/route.ts`.
- Docs: `docs/fe-be-split-audit.md` (checklist), `docs/frontend-backend-split.md` (DoD §9),
  `docs/client-data-fetching.md` (recipe), `docs/db-less-dev.md` (detached/DB-less setup),
  `apps/web/CLAUDE.md` + `docs/ui-style-guide.md` (UI conventions).
- Memory: `api-service-phase2.md` (this arc), `api-service-phase1.md` (Phase 1 durable runners — the
  actual next destination), `commit-and-version-cadence.md`, `deploy-cadence.md`,
  `no-concurrent-next-builds.md`.

## 9. Cadence + version history

- One commit per discrete change; bump by extent (`pnpm version:bump patch|minor`). **Don't tag** until
  Jason says (tag = publish/deploy). Now on `main` — **push to `main` only when asked** (default branch).
- **Version history:** #1 → 0.65.0 · #2 → 0.65.1 · #3 → 0.66.0 · #4 → 0.66.1–.20 · #5 → .21 · #6 → .22 ·
  #7 → .23 · audit criticals → .24–.25 · raw-fetch → .26–.28 · apiEventStream → .29 · email #4 → .30 ·
  cleanups #5 → .31 · content-DTO #3a → .32 · signed assets #2 → .33 · **merged to main** (`f79ba436`) ·
  fonts → .34–.35 · assistant-400 → .36 · dev-tools → .37 · hydration → .38 · onboarding-zod → .39 ·
  UTC → .40 · CORS → **.41**.
