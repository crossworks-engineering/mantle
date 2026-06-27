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

The one thing left that touched Postgres on a data-free page was the **auth
gate** — `requireOwner()` → `getSessionUser()` → an `authUsers` lookup. In
detached mode that's replaced by `detachedDevUser()` (`apps/web/lib/auth.ts`),
which *decodes* (does not verify — the token is signed by the remote) the
`NEXT_PUBLIC_MANTLE_API_TOKEN` bearer to learn which user the detached client is
acting as. So the local page gate agrees with the remote data the client sees,
with no DB. It is **triple-gated and impossible in production**: it returns null
unless `NODE_ENV !== 'production'` AND both `NEXT_PUBLIC_MANTLE_API_BASE` and
`NEXT_PUBLIC_MANTLE_API_TOKEN` are set.

## Setup

1. **Mint a bearer token against the remote** (no DB access needed — the remote
   mints it from your login):

   ```bash
   curl -s -X POST https://YOUR-REMOTE/api/auth/mobile-login \
     -H 'content-type: application/json' \
     -d '{"email":"you@example.com","password":"…"}' | jq -r .token
   ```

2. **Point local dev at the remote** — in `apps/web/.env.local`:

   ```
   NEXT_PUBLIC_MANTLE_API_BASE=https://YOUR-REMOTE
   NEXT_PUBLIC_MANTLE_API_TOKEN=<token from step 1>
   # Optional — the placeholder shown on the few surfaces that display the email:
   MANTLE_DEV_EMAIL=you@example.com
   # DATABASE_URL can be omitted entirely.
   SESSION_SECRET=<any >=32 chars; required by lib/auth even in detached mode>
   ```

   No separate dev-uid var is needed — the identity is read from the token.

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

## Not runtime-verified

This path is typecheck-verified only. A second `next dev` collides with a running
prod stack on `.next` (see project memory `no-concurrent-next-builds`), so it
hasn't been browser-smoked against a live remote + minted token. First smoke
after a dev restart: set the two env vars, open `/` and a list screen, confirm
data loads from the remote and the auth gate doesn't 500 on a missing DB.
