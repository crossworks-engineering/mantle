# DB-less (detached) frontend development

The owner UI lives in the jackdaw repo and runs **detached**: the browser app
on your machine, the brain (this repo: server/web + server/api + Postgres +
MinIO) on a box you can reach over HTTP. Nothing in jackdaw touches the
database; every screen fetches over `/api/**` with a bearer token.

## On the brain (this repo)

| Variable                  | Effect                                                                                                                                                                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MANTLE_API_CORS_ORIGINS` | Comma list of client origins (or `*`) allowed to call `/api/**` cross-origin. Bearer auth only, never cookies, so no `Allow-Credentials`. The `*` wildcard is refused on the credential-minting routes (`/api/auth*`, `/api/team/auth`, `/api/team/sso`).        |
| `MANTLE_DETACHED_DEV`     | Dev only (hard-off when `NODE_ENV=production`). Lets a page navigation render without a session cookie so the client shell can boot; `/api/**` still answers 401 without a credential. Identity for those page renders comes from `MANTLE_API_TOKEN` (below).    |
| `MANTLE_API_TOKEN`        | The bearer the detached client presents; `detachedDevUser()` in `server/web/lib/auth/session.ts` reads the owner id out of it for the page gate. (Was `NEXT_PUBLIC_MANTLE_API_TOKEN`; the old name is still honoured with a warning, see docs/configuration.md.) |
| `MANTLE_DEV_EMAIL`        | Optional display email for the placeholder identity.                                                                                                                                                                                                             |

Both `.env.example` (block "DB-less frontend dev") and `docker-compose.yml`
(`MANTLE_API_CORS_ORIGINS`) carry the same knobs.

## On the client

Point jackdaw's `MANTLE_SERVER_ORIGIN` at the brain and sign in; the client
stores the bearer and uses `apiFetch` / `apiSend` / `apiEventStream` for every
data call. The full runbook for the Mac-against-the-workstation setup lives in
the dev brain (Recall map `mantle-registry-start-here`, "Running it").

## What this is NOT

`server/web`'s own render surfaces (`/s/<token>` shares, `/print`) run on the
brain **with** the database. There is no DB-less mode for them; the old
"gate DB reads behind `isDetachedDev()`" rule from the monorepo days no longer
applies to this tier.
