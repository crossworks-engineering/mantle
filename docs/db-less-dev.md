# Split frontend + brain — setup guide

Run the web frontend on your laptop against a **deployed** Mantle brain's HTTP
API — no local Docker, Postgres, MinIO, or workers. The browser fetches all
screen data straight from the remote box; the local Next server only serves the
UI. This is the "detached mode" delivered by the frontend/backend split
(`docs/frontend-backend-split.md`), **runtime-verified 2026-07-02** against
test.crossworks.network.

```
┌─────────────── laptop ───────────────┐      ┌────────── brain (box) ──────────┐
│  next dev (pnpm dev:fe)              │      │  full stack: web API, Postgres, │
│  · serves the UI bundle              │      │  MinIO, workers, Caddy/HTTPS    │
│  · auth gate reads the bearer token  │      │                                 │
│  · NO database, NO workers           │      │  MANTLE_API_CORS_ORIGINS        │
│                                      │      │  allowlists the laptop origin   │
│  browser ── apiFetch + bearer ──────────────▶  /api/** (bearer auth, CORS)    │
└──────────────────────────────────────┘      └─────────────────────────────────┘
```

## 1. Set up the brain (once per box)

Any deployed Mantle stack works — prod-style install or dev box. For a fresh
box, the public installer one-liner provisions everything (see
`scripts/install.sh`; the test box is the reference install).

The one addition a brain needs to serve a detached frontend:

1. **Allowlist the frontend's origin for CORS** — in the stack's `.env`:

   ```
   MANTLE_API_CORS_ORIGINS=http://localhost:3000,http://localhost:3001
   ```

   then `docker compose up -d web` to recreate the web service. The variable is
   passed through the compose `x-app-env` anchor (compose ≥ v0.111.0; on an
   older deployed bundle, add `MANTLE_API_CORS_ORIGINS: ${MANTLE_API_CORS_ORIGINS:-}`
   to the `x-app-env` block in its `docker-compose.yml` first).

   CORS is **off by default** (same-origin clients don't need it). `'*'` is
   accepted for the data API but never applies to `/api/auth/**` — auth routes
   require an explicit origin entry.

2. **Have a login on that brain** (the normal signup/onboarding). The detached
   frontend acts as that user via a bearer token; there is no separate
   "dev user" concept.

## 2. Set up the frontend (once per machine)

Create `server/web/.env.detached.local` (git-ignored):

```
MANTLE_REMOTE=https://test.crossworks.network
MANTLE_REMOTE_EMAIL=<login email on that box>
MANTLE_REMOTE_PASSWORD=<its password>
```

That's it. Your regular `server/web/.env.local` needs nothing detached-specific
(only `SESSION_SECRET`, which every install has; `DATABASE_URL` is ignored in
this mode).

## 3. Run it

```bash
pnpm dev:fe                 # default port 3000
pnpm dev:fe --port 3001     # extra args pass through to `next dev`
```

`scripts/dev-frontend.sh` does the rest on every boot:

- mints a **1-year bearer** from the remote's `/api/auth/mobile-login` using the
  stored credentials, and caches it back into `.env.detached.local`
- probes the cached token against `/api/shell` first — if the box was reset or
  re-onboarded since the last mint, it re-mints automatically
- exports the detached env (`MANTLE_DETACHED_DEV=1`,
  `NEXT_PUBLIC_MANTLE_API_BASE`, `NEXT_PUBLIC_MANTLE_API_TOKEN`,
  `MANTLE_DEV_EMAIL`) and execs `pnpm -C server/web dev`

Open any `(app)` screen: you're already "logged in" as the token's user (no
login step), and every data fetch goes browser → remote. There's also a
`web-fe` entry in `.claude/launch.json` running the same script on :3001 for
Claude preview sessions.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Every page 500s, server log shows `ECONNREFUSED` on a Postgres port | Detached mode isn't active — the app is trying its normal DB path | Run via `pnpm dev:fe`, not plain `pnpm dev`; check the boot line "Frontend-only dev against …" printed |
| Shell renders but every data fetch fails `net::ERR_FAILED`; preflight `OPTIONS` returns 204 but the `GET` dies | The brain isn't emitting `Access-Control-Allow-Origin` — `MANTLE_API_CORS_ORIGINS` unset on the box, or set but not passed through compose | Step 1 above (env + anchor passthrough + recreate `web`) |
| Data fetches 401 / bounce to `/login` | Stale or foreign token (box reset since mint) | Delete the `NEXT_PUBLIC_MANTLE_API_TOKEN` line from `.env.detached.local` and rerun — it re-mints; or just rerun (the boot probe usually catches this) |
| Token mint fails at boot | Wrong `MANTLE_REMOTE` / credentials, or the box is down | `curl -sf $MANTLE_REMOTE/api/health`; check creds against the box's login screen |
| Redirect-loops to `/login` on page nav | `MANTLE_DETACHED_DEV` didn't reach the server process | Don't set the detached vars by hand in `.env.local` halves — use the script, which exports all of them together |

## Known limitations

- **Every transport is detached-aware, but the asset path is lightly verified.**
  Data fetches (`apiFetch`/`apiSend`), SSE (`apiEventStream` — realtime + turn
  streams), and the assistant dock's raw turn POST (`apiUrl`+`withAuth`) all
  carry the base + bearer. Browser-native asset `src`s (`<img>`/`<iframe>`/
  downloads) can't carry a header, so `assetUrl()` appends the short-lived
  `?at=` token the shell mints (`lib/asset-url.ts`); its cross-origin *success*
  path has had less smoke than the data path — if an image 401s detached,
  start there.
- **No usage card.** `UsageCard` (spend + agent context in the sidebar rail)
  reads the DB in-process, so detached mode drops it instead of 500ing.
- **Mutations hit the remote's data.** You're driving a real deployed brain —
  edits, deletes, and sends are live. Point at a throwaway/staging box (the
  test box), not prod, unless you mean it.
- **No local login/signup.** The token is your identity; logging out clears the
  cookie but the token still authenticates. Remove the env vars to "log out."
- **`MANTLE_DEV_EMAIL` is cosmetic.** The token payload carries only the user
  id; the script sets it to `MANTLE_REMOTE_EMAIL` so the shell shows the right
  address.

## How it works (internals)

Every dynamic `(app)` screen is **client-fetched**: the server page is an auth
gate only (no DB reads during render), and the browser loads its data with
`apiFetch`/`apiSend`/`apiEventStream` (`server/web/lib/api-fetch.ts`). Those
helpers honor `NEXT_PUBLIC_MANTLE_API_BASE` + `NEXT_PUBLIC_MANTLE_API_TOKEN`,
so when they're set the browser talks straight to the remote API and the local
Next server never queries a database for screen data.

Four things would otherwise still touch Postgres (or break) on a data-free
page; all are gated by `isDetachedDev()` (`server/web/lib/auth-constants.ts`):

1. **The page auth gate** — `requireOwner()` → `getSessionUser()` → an
   `authUsers` lookup. Detached, that's replaced by `detachedDevUser()`
   (`server/web/lib/auth.ts`), which *decodes* (does not verify — the token is
   signed by the remote) the bearer to learn which user the client acts as, so
   the local page gate agrees with the remote data, with no DB.
2. **The Edge middleware** — it runs before the page render and would 307 every
   page nav to `/login` (no local session cookie; a top-level nav can't carry a
   bearer header) — an infinite redirect loop. `middleware.ts` lets page navs
   through when detached; the page gate resolves the identity. API requests
   still 401 — the client's data fetches target the *remote* API.
3. **The `(app)` layout's onboarding gate** — `isOnboarded()` reads profile
   prefs from the DB. Skipped when detached (the remote brain is already
   onboarded).
4. **Fetch credentials** — the middleware's CORS reflects the origin **without**
   `Access-Control-Allow-Credentials` (bearer-only by design: no cookie ever
   travels cross-origin, so no CSRF surface). `withAuth` therefore sends
   `credentials: 'omit'` when detached — a credentialed cross-origin response
   lacking `Allow-Credentials` is refused by the browser.

**The master switch is `MANTLE_DETACHED_DEV` — a server-only flag** (never a
`NEXT_PUBLIC_` var, so it can't be flipped on from a shipped client bundle),
and `isDetachedDev()` is **hard-disabled in production**
(`NODE_ENV === 'production'` returns false). The bypass can never activate in a
prod build, no matter how the public API vars are set.

> **History:** the first cut (the `detachedDevUser` shim alone) looked done but
> was runtime-broken: the middleware redirect loop and a `countUsers()` call on
> `/login` (both fixed pre-verification), then the 2026-07-02 smoke found three
> more latent breaks — the layout onboarding gate, `UsageCard`'s in-process DB
> read, and `credentials: 'include'` cross-origin (fixed as listed above).
> Moral: this path regresses silently when server-side code gains DB reads —
> anything added to the `(app)` layout/pages that touches `@mantle/db` during
> render must be `isDetachedDev()`-gated. Smoke with `pnpm dev:fe` after
> touching the shell/layout/auth path.
