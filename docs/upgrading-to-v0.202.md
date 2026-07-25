# Upgrading to v0.202.0 — the server/client split

This is the largest single upgrade a Mantle box has taken: one release moves
the fleet from the single-image era (≤ v0.160.x) onto the **split topology**
(v0.200 → v0.202 land together). Read the whole document before touching a
box. Every step is reversible until the DNS cutover, and the rollback recipe
at the bottom restores the previous release in minutes.

## What changes in one view

| Area | Before (≤ v0.160.x) | After (v0.202.0) |
| --- | --- | --- |
| Images | one `mantle` image | **two**: `mantle-server` (API, agent, workers, migrate, render surfaces) + `mantle-client` (zero-secret owner UI) |
| Owner UI | `https://<domain>` | `https://app.<domain>` (new vhost, same box) |
| Server web tier | Next.js (`next start`) | **Hono + tsx** — Next.js fully removed from the server tier; the ~288 API routes are unchanged behind a compat seam |
| Runtime | Node 24 (Debian 12 bookworm) | **Node 26.5** (Debian 13 trixie, V8 14.6) |
| `pg_dump` in the image | PostgreSQL 17 client | **PostgreSQL 18 client** (see the backups note — this fixes a real bug) |
| Team surfaces | `/team`, `/hub` on the main origin | served by the client app at `app.<domain>/team` + `/hub` (old URLs redirect) |
| Appearance | localStorage-cached per browser | server-rendered from the brain's profile — theme + fonts follow the brain, not the browser |
| Boot | multi-minute `next build` baked into the image | no compile: `tsx` at boot (~3 s) |

**What does NOT change:** the HTTP contract (same routes, same port 3000, same
`/api/health`), the database schema pace (migrations run as always via the
one-shot migrate service), share links (`/s/<token>` URLs are untouched), and
member team tokens (still valid — but see the member note below).

## Who this guide is for

Registry-pull boxes: pinned `MANTLE_IMAGE_TAG` in `.env`, compose files from
the release deploy bundle, updater sidecar optional. A source-run dev box
follows the same order minus the pulls.

## Prerequisites

1. **DNS**: create `app.<domain>` → the same IP as `<domain>`. Do this FIRST —
   Caddy needs it resolvable to obtain the certificate, and propagation is the
   one step you can't script. (`CNAME app <domain>.` works too.)
2. **Backup**: `scripts/db-dump.sh` from the stack dir — or directly:
   `docker exec mantle_pg pg_dump -U postgres -Fc postgres > pre-v0202.dump`.
   Also snapshot your env + compose: `cp .env .env.bak-pre-v0202 && cp docker-compose.yml docker-compose.yml.bak-pre-v0202`.
3. **Compose baseline**: the split ships a new compose contract
   (`docker-compose.yml` + `docker-compose.client.yml`, lockstep on ONE
   `MANTLE_IMAGE_TAG`). If the box predates v0.142 (no `.release` baseline),
   update once to any ≥ v0.142 single-image tag first so `compose-adopt.sh`
   has an embedded canonical to extract.
4. **Grab the deploy bundle** from the v0.202.1 GitHub release (it carries both
   compose files, `install.sh`, `infra/`, and `scripts/` including
   `compose-adopt.sh`).

## Steps

From the stack directory (all commands assume it):

```sh
# 1. Backup (see prerequisites) — do not skip.

# 2. Env additions — append to .env:
#    MANTLE_PUBLIC_URL          canonical public origin (share links, OAuth
#                               redirects) — set it explicitly now; several
#                               subsystems stop guessing from headers.
#    MANTLE_CLIENT_SITE_ADDRESS the new vhost Caddy should answer for.
#    MANTLE_SERVER_ORIGIN       what the client app calls (the server origin).
#    MANTLE_API_CORS_ORIGINS    += the client origin (the wildcard never
#                               covers credentialed paths — this must be
#                               explicit).
#    MANTLE_IMAGE_TAG=v0.202.1
#
# Example for mantle.example.com:
cat >> .env <<'ENV'
MANTLE_PUBLIC_URL=https://mantle.example.com
MANTLE_CLIENT_SITE_ADDRESS=https://app.mantle.example.com
MANTLE_SERVER_ORIGIN=https://mantle.example.com
MANTLE_API_CORS_ORIGINS=https://app.mantle.example.com
MANTLE_IMAGE_TAG=v0.202.1
ENV

# 3. Adopt the release compose contract (shows the diff first; --apply saves
#    the old file as docker-compose.yml.pre-adopt.<ts> and installs the
#    canonical + baseline). Move any box-local customization the diff reveals
#    into docker-compose.override.yml BEFORE --apply.
sh scripts/compose-adopt.sh          # review
sh scripts/compose-adopt.sh --apply

# 4. Roll the SERVER stack first: pull, migrate, up.
docker compose pull
docker compose run --rm migrate
docker compose up -d --wait --remove-orphans

# 5. Then the CLIENT stack (same tag — releases are lockstep, never roll one
#    without the other):
docker compose -f docker-compose.client.yml pull
docker compose -f docker-compose.client.yml up -d --wait
```

## Smoke checklist (per box, in order)

The hermetic test suites cover the API plane exhaustively; these are the paths
that only exist with a real brain — check them by hand:

1. Owner login at `https://app.<domain>` — and note the theme + fonts arrive
   on the FIRST paint of a fresh browser (this is the new server-rendered
   appearance; a default-themed flash here is a regression).
2. A **real streamed assistant turn** from the new origin (exercises
   cross-origin SSE through your proxy timeouts).
3. The designated **hub app** at `app.<domain>/hub` (cross-origin app broker).
4. A **forum attachment** upload + download round trip.
5. A share link, and a share link opened from the member workspace (SSO
   handoff).
6. A **real PDF export, eyeballed**. The export machinery produces a valid
   `%PDF` even when the print surface is broken (Chromium happily prints an
   error page), so only human eyes verify this one — check the page content
   AND that the brain's fonts/accent colours are present.
7. Team-admin tabs at `app.<domain>/team-admin`.
8. **Settings → Backups → “Run backup now”** — see the backups note below;
   confirm a fresh dump lands.

**Member note:** cookie sessions do not transfer origins. Each team member
re-enters their 8-character token ONCE at `app.<domain>/team`. Deliberate —
there is no credential-in-URL handoff.

**48-hour watch:** server logs for `?at=` 401s, CORS rejections, and
`/api/team` 401 spikes — the three signatures of a missed origin config.

## The backups fix (and the pg17-era history)

Two related facts for any box that came through the PostgreSQL 17 → 18 major
(the v0.160.x era):

- **Postgres 18 boxes keep their override.** The 17→18 upgrade was done via a
  `docker-compose.override.yml` pinning `pgvector/pgvector:pg18` plus the
  `PGDATA` env the 18-era images require (they moved the default data
  directory). The base compose still defaults to pg18 going forward, but keep
  the override through the adopt step and verify the EFFECTIVE config with
  `docker compose config --images` — never trust the base file alone.
- **Scheduled backups were silently broken on pg18 boxes** before this
  release: the image shipped the PostgreSQL **17** client, and `pg_dump`
  refuses to dump a server newer than itself, so every scheduled backup
  failed from the moment a box moved to pg18. v0.202.0 ships the **18**
  client (a newer `pg_dump` handles older servers fine, so pg17 boxes are
  unaffected). After the roll, run one manual backup (step 8 above) to
  confirm the pipeline is alive again — and treat the age of your newest
  pre-roll dump with suspicion.

The base image OS also moved (Debian 12 → 13, a side effect of `node:26`);
the PostgreSQL apt repository codename inside the image is now derived from
the OS at build time, so this class of breakage can't recur on the next base
bump.

## Rollback

Everything short of DNS is a file swap:

```sh
docker compose -f docker-compose.client.yml down
cp docker-compose.yml.pre-adopt.<ts> docker-compose.yml
cp .env.bak-pre-v0202 .env            # restores the old MANTLE_IMAGE_TAG
docker compose pull && docker compose up -d --wait
```

Canonical URLs never changed, so shares and member token links survive a
rollback untouched. The DB schema is forward-compatible from the previous
release for read paths, but if you migrated and must roll the schema back,
restore the step-1 dump. Leave the `app.<domain>` DNS record in place — it's
inert without the client stack.
