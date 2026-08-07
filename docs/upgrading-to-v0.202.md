# Upgrading to v0.202.0: the server/client split

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
| Server web tier | Next.js (`next start`) | **Hono + tsx**: Next.js fully removed from the server tier; the ~288 API routes are unchanged behind a compat seam |
| Runtime | Node 24 (Debian 12 bookworm) | **Node 26.5** (Debian 13 trixie, V8 14.6) |
| `pg_dump` in the image | PostgreSQL 17 client | **PostgreSQL 18 client** (see the backups note; this fixes a real bug) |
| Team surfaces | `/team`, `/hub` on the main origin | served by the client app at `app.<domain>/team` + `/hub` (old URLs redirect) |
| Appearance | localStorage-cached per browser | server-rendered from the brain's profile, theme + fonts follow the brain, not the browser |
| Boot | multi-minute `next build` baked into the image | no compile: `tsx` at boot (~3 s) |

**What does NOT change:** the HTTP contract (same routes, same port 3000, same
`/api/health`), the database schema pace (migrations run as always via the
one-shot migrate service), share links (`/s/<token>` URLs are untouched), and
member team tokens (still valid, but see the member note below).

## Who this guide is for

Registry-pull boxes: pinned `MANTLE_IMAGE_TAG` in `.env`, compose files from
the release deploy bundle, updater sidecar optional. A source-run dev box
follows the same order minus the pulls.

## Pick your shape first: same-origin or split

The two apps can be served two ways; decide before touching anything.

**Same-origin (one domain, path-routed)**: recommended for a single-box
install, and what the reference production box runs. Caddy routes the
server-owned paths (`/api/*`, `/s/*`, `/print/*`, the runtime bundles, the
OAuth discovery docs) to the server app and everything else to the client
app on ONE domain. No new DNS record, no CORS config, cookies are plainly
same-origin, and existing member team cookies keep working, since the
origin never changes. Use
[`infra/caddy/Caddyfile.same-origin`](../infra/caddy/Caddyfile.same-origin):

```sh
cp infra/caddy/Caddyfile.same-origin infra/caddy/Caddyfile
```

Env for this shape: `MANTLE_SERVER_ORIGIN=https://<domain>` (the client's
server-side appearance fetch needs an absolute origin; browsers treat it as
same-origin anyway). Skip `MANTLE_CLIENT_SITE_ADDRESS`,
`MANTLE_API_CORS_ORIGINS`, and the DNS prerequisite below entirely, steps
2's example simplifies accordingly, and the member re-token note does not
apply.

**Split (two origins: `<domain>` + `app.<domain>`)**: the generic default
the rest of this guide describes. Choose it when you want the owner UI on a
distinct origin (separate client box, CDN in front of the UI, stricter
origin isolation).

## Prerequisites

1. **On Postgres 18 already?** If the box is still on pg17, that major is a
   SEPARATE migration with its own runbook,
   [`docs/postgres-18-upgrade.md`](./postgres-18-upgrade.md), and it is not
   required for this upgrade (pin `POSTGRES_IMAGE_TAG=pg17` to stay put).
   Never batch the two: do the split, verify, then the database major on its
   own day.
2. **Backup.** Only some boxes have `scripts/db-dump.sh`; the portable form
   runs `pg_dump` INSIDE the container, where client and server versions
   always match:
   ```sh
   docker exec mantle_pg pg_dump -U postgres -Fc postgres > ~/pre-v0202-$(date -u +%Y%m%d-%H%M%S).dump
   ```
   Write it to `$HOME`, not `data/`; the data dir is often root-owned and
   the redirect fails with a bare "Permission denied". Snapshot the config
   too:
   ```sh
   cp .env .env.bak-pre-v0202
   cp docker-compose.yml docker-compose.yml.bak-pre-v0202
   cp infra/caddy/Caddyfile infra/caddy/Caddyfile.pre-v0202
   ```
3. **Get the deploy bundle** from the v0.202.1 GitHub release. You need two
   files out of it that are almost certainly NOT on the box already:
   `scripts/compose-adopt.sh` and the Caddyfile for your chosen shape. Copy
   them up before you start.
   ```sh
   scp scripts/compose-adopt.sh                <box>:<stack>/scripts/
   scp infra/caddy/Caddyfile.same-origin       <box>:/tmp/
   ```
   If `scripts/` or `infra/` is root-owned (it is on some boxes), stage in
   `/tmp` and `sudo cp` into place.
4. **Compose baseline**: if the box predates v0.142 (no
   `docker-compose.yml.release`), update once to any ≥ v0.142 tag first so
   `compose-adopt.sh` has an embedded canonical to extract.
5. **DNS** *(split shape only)*: create `app.<domain>` → the same IP as
   `<domain>`, and let it propagate before step 6; Caddy can't obtain the
   certificate until it resolves. Same-origin needs no DNS change at all.

## Steps

All commands run from the stack directory. This is the same-origin sequence
(the proven default); split-shape deltas are called out inline.

```sh
# 1. Backup + snapshots — see prerequisites. Do not skip.

# 2. Env. Same-origin needs exactly two changes:
sed -i 's/^MANTLE_IMAGE_TAG=.*/MANTLE_IMAGE_TAG=v0.202.1/' .env
cat >> .env <<'ENV'

# v0.202 split — same-origin shape
MANTLE_SERVER_ORIGIN=https://mantle.example.com
ENV
#    MANTLE_PUBLIC_URL should already be set; if not, set it now — several
#    subsystems stop guessing the public origin from headers.
#    MANTLE_SITE_ADDRESS is unchanged, and may carry a COMMA-SEPARATED list
#    of hostnames; every one of them keeps working under the new Caddyfile.
#
#    SPLIT SHAPE instead adds:
#      MANTLE_CLIENT_SITE_ADDRESS=https://app.mantle.example.com
#      MANTLE_API_CORS_ORIGINS=https://app.mantle.example.com

# 3. Adopt the release compose contract. Dry run FIRST and read the diff:
#    left-only ('-') lines are things your box adds. Anything box-specific
#    must move to docker-compose.override.yml BEFORE --apply, or it is lost.
#    (Common local pins that DO survive, because the override wins: the pg18
#    image + PGDATA, a held-back browser sidecar version.)
sh scripts/compose-adopt.sh            # review
sh scripts/compose-adopt.sh --apply    # installs canonical + .release baseline
                                       # and the new docker-compose.client.yml

# 4. Server stack: pull, migrate, up.
docker compose pull
docker compose run --rm migrate
docker compose up -d --wait --remove-orphans

# 5. Client stack — SAME tag, releases are lockstep. Note --project-directory:
#    without it compose resolves .env relative to the compose file and the
#    client comes up unconfigured.
docker compose -f docker-compose.client.yml --project-directory . pull
docker compose -f docker-compose.client.yml --project-directory . up -d --wait

# 6. Caddy LAST — compose-adopt handles COMPOSE FILES ONLY, so the box's
#    Caddyfile is still the pre-split one and knows nothing about the client
#    app. Install the shape you chose, then recreate:
cp infra/caddy/Caddyfile.same-origin infra/caddy/Caddyfile   # or your split vhost
docker compose up -d --force-recreate caddy
```

Recreating Caddy is a ~2 second blip on the public origin; everything else
above is rolling. Confirm Caddy picked up every hostname you expect:

```sh
docker logs mantle_caddy 2>&1 | grep "automatic TLS"
# → "domains":["mantle.example.com", ...]   ← all of them, or stop and fix
```

### What the routing now looks like (same-origin)

One domain, split by path, no CORS, no second certificate, and existing
member cookies keep working because the origin never changes:

| Path | Served by |
| --- | --- |
| `/api/*` | server app (Hono) |
| `/s/*`, `/print/*` | server app, the server-rendered share + print surfaces |
| `/share-runtime/*`, `/app-runtime/*` | server app, bundles those surfaces load |
| `/.well-known/oauth-*` | server app, MCP connector discovery |
| **everything else** | client app, owner UI, `/login`, `/team`, `/hub`, `/env.js`, `/_next/*` |

**Split shape on v0.202.1 needs one extra thing:** the canonical compose
does not forward the vhost variable to the Caddy container, so
`app.<domain>` silently falls back to `:8080`. Until the next tag, add to
`docker-compose.override.yml`:

```yaml
services:
  caddy:
    environment:
      MANTLE_CLIENT_SITE_ADDRESS: ${MANTLE_CLIENT_SITE_ADDRESS:-:8080}
```

Same-origin is unaffected.

## Smoke checklist (per box, in order)

The hermetic test suites cover the API plane exhaustively; these are the paths
that only exist with a real brain, check them by hand:

1. Owner login at `https://app.<domain>`, and note the theme + fonts arrive
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
   error page), so only human eyes verify this one, check the page content
   AND that the brain's fonts/accent colours are present.
7. Team-admin tabs at `app.<domain>/team-admin`.
8. **Settings → Backups → “Run backup now”**: see the backups note below;
   confirm a fresh dump lands.

**Member note:** cookie sessions do not transfer origins. Each team member
re-enters their 8-character token ONCE at `app.<domain>/team`. Deliberate,
there is no credential-in-URL handoff.

**48-hour watch:** server logs for `?at=` 401s, CORS rejections, and
`/api/team` 401 spikes, the three signatures of a missed origin config.

## The backups fix (and the pg17-era history)

Two related facts for any box that came through the PostgreSQL 17 → 18 major
(the v0.160.x era):

- **Postgres 18 boxes keep their override.** The 17→18 upgrade was done via a
  `docker-compose.override.yml` pinning `pgvector/pgvector:pg18` plus the
  `PGDATA` env the 18-era images require (they moved the default data
  directory). The base compose still defaults to pg18 going forward, but keep
  the override through the adopt step and verify the EFFECTIVE config with
  `docker compose config --images`, never trust the base file alone.
- **Scheduled backups were silently broken on pg18 boxes** before this
  release: the image shipped the PostgreSQL **17** client, and `pg_dump`
  refuses to dump a server newer than itself, so every scheduled backup
  failed from the moment a box moved to pg18. v0.202.0 ships the **18**
  client (a newer `pg_dump` handles older servers fine, so pg17 boxes are
  unaffected). After the roll, run one manual backup (step 8 above) to
  confirm the pipeline is alive again, and treat the age of your newest
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
restore the step-1 dump. Leave the `app.<domain>` DNS record in place; it's
inert without the client stack.
