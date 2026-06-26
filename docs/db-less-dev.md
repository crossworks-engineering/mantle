# DB-less frontend dev

Run `apps/web` locally against a **deployed** Mantle's HTTP API — no local
Postgres, no Tailscale tunnel, no DB credentials. This is Phase 2 · Task 3 of the
frontend/backend split (`docs/frontend-backend-split.md`).

## Why this works

`@mantle/db`'s client is a **lazy singleton** — it only connects on the first
query. So `next dev` boots fine with no `DATABASE_URL`; the only thing that needs
Postgres is server-side code that *queries during render* (RSC pages + route
handlers). DB-less dev routes those server-side reads to a remote API over HTTP
instead, via the **remote-data seam** (`apps/web/lib/remote-data.ts`):

- `MANTLE_REMOTE_API` unset → `isRemoteData()` is false → every path is exactly
  as before (in-process `@mantle/*` package calls). Zero risk to normal dev.
- `MANTLE_REMOTE_API` set → adopted screens fetch the deployed API with a bearer
  token. No local DB touched.

A screen is "adopted" when its data load goes through a `lib/data/*` module that
branches on `isRemoteData()` (package fn vs `remoteGet()`). The page stays dumb.

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
   MANTLE_REMOTE_API=https://YOUR-REMOTE
   MANTLE_API_TOKEN=<token from step 1>
   # DATABASE_URL can be omitted entirely.
   SESSION_SECRET=<any >=32 chars, for your own local login cookie>
   ```

3. **Run the frontend only** (not the worker/agent fleet, which need a DB):

   ```bash
   pnpm -C apps/web dev
   ```

4. Open an **adopted** screen — e.g. `/settings/accounts`. The account list is
   served from the remote; your local process never connects to Postgres.

## What's adopted so far

| Screen | Data module | Status |
|---|---|---|
| `/settings/accounts` (list + detail) | `lib/data/email-accounts.ts` | ✅ reference adopter |

Everything else still does in-process DB access, so in remote mode those screens
will error (they try to query a DB you don't have). Adopting the rest is
incremental and shares the work with Task 4 (client-fetch conversion) — each
screen gets a `lib/data/*` module on the same pattern.

### Known limitations (reference adopter)
- The **folders** sub-view (`?mode=folders`) does a live IMAP probe server-side
  (needs the sealed account password), so it isn't reachable in remote mode — the
  account list, detail, add/edit forms are.
- Run-timestamps arrive as ISO strings over HTTP; the screen only renders
  non-date run fields and `formatDateTime` accepts strings, so it's identical.

## Adopting a new screen

1. Add `apps/web/lib/data/<screen>.ts` exporting a `load…View(userId)` that
   branches: `if (isRemoteData()) return remoteGet('/api/…'); else <package fn>`.
2. Point the page at it; drop the direct `@mantle/*` data calls.
3. Type the view on the **redacted** shape the endpoint returns (e.g.
   `PublicEmailAccount`), so local and remote agree.
