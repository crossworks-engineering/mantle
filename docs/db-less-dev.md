# DB-less frontend dev

Run `apps/web` locally against a **deployed** Mantle's HTTP API — no local
Postgres, no Tailscale tunnel, no DB credentials. This is Phase 2 · Task 3 of the
frontend/backend split (`docs/frontend-backend-split.md`).

## How this works (post Phase 2 · Task 4)

Every dynamic `(app)` screen is now **client-fetched**: the server page is an auth
gate only (no DB reads during render), and the browser loads its data with
`apiFetch`/`apiSend`/`apiEventStream` (`apps/web/lib/api-fetch.ts`). Those helpers
already honor `NEXT_PUBLIC_MANTLE_API_BASE` + `NEXT_PUBLIC_MANTLE_API_TOKEN`, so
when they're set the **browser talks straight to the remote API** and the local
Next server never queries a database for screen data.

> This replaces the old server-side `lib/remote-data.ts` / `lib/data/*` seam,
> which was built for server-rendered pages reading the DB during render. After
> Task 4 nothing rendered server-side anymore, so that seam was removed.

Two things still touched Postgres on a data-free page, both handled in detached
mode and gated by `isDetachedDev()` (`apps/web/lib/auth-constants.ts`):

1. **The page auth gate** — `requireOwner()` → `getSessionUser()` → an `authUsers`
   lookup. In detached mode that's replaced by `detachedDevUser()`
   (`apps/web/lib/auth.ts`), which *decodes* (does not verify — the token is
   signed by the remote) the `NEXT_PUBLIC_MANTLE_API_TOKEN` bearer to learn which
   user the detached client is acting as, so the local page gate agrees with the
   remote data the client sees, with no DB.
2. **The Edge middleware** — it runs *before* the page render and would 307 every
   page navigation to `/login` (no local session cookie exists; a top-level nav
   can't carry a bearer header), so `detachedDevUser()` would never run — an
   infinite redirect loop. `middleware.ts` now lets page navs through when
   `isDetachedDev()`; the page gate resolves the identity. (API requests still
   401 — the client's data fetches target the *remote* API, not this server.)

**The master switch is `MANTLE_DETACHED_DEV` — a server-only flag** (never a
`NEXT_PUBLIC_` var, so it can't be flipped on from a shipped client bundle) and
`isDetachedDev()` is **hard-disabled in production** (`NODE_ENV === 'production'`
returns false). So the bypass can never activate in a prod build, no matter how
the public API vars are set.

## The one-command path: `pnpm dev:fe`

`scripts/dev-frontend.sh` automates all of the setup below. Create
`apps/web/.env.detached.local` (git-ignored) once:

```
MANTLE_REMOTE=https://test.crossworks.network
MANTLE_REMOTE_EMAIL=<login email on that box>
MANTLE_REMOTE_PASSWORD=<its password>
```

then `pnpm dev:fe` (extra args pass through to `next dev`, e.g.
`pnpm dev:fe --port 3001`). The script mints the 1-year bearer via
`/api/auth/mobile-login`, caches it back into the file, probes it against
`/api/shell` on every boot (re-mints if the box was reset), exports the
detached env, and runs `pnpm -C apps/web dev`.

**The remote must allowlist your origin for CORS** — in the box's `.env`:

```
MANTLE_API_CORS_ORIGINS=http://localhost:3000,http://localhost:3001
```

(passed through the compose `x-app-env` anchor; `docker compose up -d web` to
apply). Without it every cross-origin data fetch is blocked by the browser —
preflights 204 but responses carry no `Access-Control-Allow-Origin`.

## Manual setup (what the script does)

1. **Mint a bearer token against the remote** (no DB access needed — the remote
   mints it from your login):

   ```bash
   curl -s -X POST https://YOUR-REMOTE/api/auth/mobile-login \
     -H 'content-type: application/json' \
     -d '{"email":"you@example.com","password":"…"}' | jq -r .token
   ```

2. **Point local dev at the remote** — in `apps/web/.env.local`:

   ```
   MANTLE_DETACHED_DEV=1                       # master switch (server-only; off in prod)
   NEXT_PUBLIC_MANTLE_API_BASE=https://YOUR-REMOTE
   NEXT_PUBLIC_MANTLE_API_TOKEN=<token from step 1>
   # Optional — the placeholder shown on the few surfaces that display the email:
   MANTLE_DEV_EMAIL=you@example.com
   # DATABASE_URL can be omitted entirely.
   SESSION_SECRET=<any >=32 chars; required by lib/auth even in detached mode>
   ```

   `MANTLE_DETACHED_DEV` must be set or nothing below activates. No separate
   dev-uid var is needed — the identity is read from the token.

3. **Run the frontend only** (not the worker/agent fleet, which need a DB):

   ```bash
   pnpm -C apps/web dev
   ```

4. Open any `(app)` screen. You're already "logged in" as the token's user (no
   login step), the page renders with no local Postgres, and every data fetch
   goes browser → remote.

## Known limitations

- **Non-`apiFetch` transports stay same-origin** (Phase 2 · #5 follow-ups): raw
  asset `src`s (`/api/files/...?raw=1` in `<img>`/`<iframe>`/downloads, avatars)
  and the assistant turn/stream internals (`assistant-dock.tsx`) still use
  browser-native sources / raw same-origin `fetch`, which can't carry the bearer.
  Those surfaces won't load in a fully detached client until they move to a
  token-in-query / signed-URL or `apiFetch` transport.
- **Mutations hit the remote's data.** You're driving a real deployed brain —
  edits, deletes, and sends are live. Point at a throwaway/staging remote, not
  prod, unless you mean it.
- **No local login/signup.** `/api/auth/{login,signup,bootstrap-state}` still
  query the DB; in detached mode you never reach them (the token is your
  identity). Logging out clears the cookie but the token still authenticates —
  remove the env vars to "log out."
- **`MANTLE_DEV_EMAIL` is cosmetic.** The token payload carries only the user id,
  so the email shown in the shell/settings is the placeholder unless you set it.

## Runtime-verified 2026-07-02

Browser-smoked end-to-end against the test box (test.crossworks.network):
dashboard + tables render live remote data, activity/shell chrome works, no
local Postgres. Three latent breaks were found and fixed in that pass —
regressions that had accumulated while the path was dormant:

- **`(app)/layout.tsx` onboarding gate** (`isOnboarded` → profile-prefs DB
  read) postdated the split and 500'd every page — now skipped when
  `isDetachedDev()`.
- **`UsageCard`** reads the DB in-process (spend + agent context) — now dropped
  (null contextCard) in detached mode rather than 500ing the shell.
- **`withAuth` sent `credentials: 'include'` cross-origin** — the middleware's
  CORS deliberately omits `Allow-Credentials` (bearer-only design), so the
  browser refused every response. Detached mode now sends `credentials: 'omit'`.

> **History:** the first cut of this (the `detachedDevUser` page shim alone)
> looked done but was runtime-broken — a deep audit found the middleware would
> 307 every page nav to `/login` before the shim ran (infinite loop), and
> `/login` then hit `countUsers()`. Both are fixed above (middleware page-nav
> bypass + `isFirstRun` short-circuit), but the fix is itself only typecheck-
> verified. **Smoke it before relying on it.**

First smoke after a dev restart: set the env vars (incl. `MANTLE_DETACHED_DEV=1`),
open `/` then a list screen — confirm it does **not** redirect-loop or 500, data
loads from the remote, and the auth gate doesn't touch a local DB.
