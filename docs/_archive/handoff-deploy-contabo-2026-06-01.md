# Handover — Deploy Mantle to Contabo (jason.crossworks.network)

**Date:** 2026-06-01 · **Status:** ✅ **DEPLOYED & LIVE** at
https://jason.crossworks.network (valid Let's Encrypt cert). All 11 containers
healthy, brain restored (1948 nodes), connections stable. Three production-only
bugs surfaced and were fixed on the way up — see "Deploy completed" below.

---

## ✅ Deploy completed (2026-06-01, second session)

Resumed from the paused state below and finished the deploy. Build → restore →
up all succeeded; then three bugs that **only manifest in a real prod container**
(never in `next dev` on the Mac) had to be fixed, each requiring an image rebuild:

1. **Web crash-loop — `next start` read `-H` as a directory.** Image CMD was
   `pnpm -C apps/web start -- -H 0.0.0.0 -p 3000`; under pnpm 10/11 the `--` is
   forwarded literally to `next start`, which treats `-H` as the project-dir
   positional → `Invalid project directory: /app/apps/web/-H` → exit 1 → restart
   loop → Caddy 502. Fixed by switching to the worker `exec` form:
   `pnpm -C apps/web exec next start -H 0.0.0.0 -p 3000` (commit `e4ae962`).

2. **DB pool leak — the killer.** `packages/db/src/client.ts` exports `db` as a
   Proxy that calls `getDb()` on **every property access**, but cached the
   singleton on `globalThis` only when `NODE_ENV !== 'production'`. So in prod
   **every query minted a fresh `postgres()` pool (max 10)**; the long-lived
   agent + workers query on boot and on timers, so pools piled up at ~12
   conns/sec until Postgres hit `max_connections` and the whole stack cascaded
   (`FATAL 53300`, even `psql` locked out). Dev was immune precisely because the
   globalThis cache was active there. Fixed by caching unconditionally
   (commit `7910e2a`). **This is why "the identical dev stack runs fine" — it
   genuinely does; the bug is prod-only.** Diagnosis: isolate services one at a
   time and watch `select count(*) from pg_stat_activity` climb — the `agent`
   was the visible leaker (6→61→178 in 14s), but the root is shared by every
   prod service once it starts querying.

3. **Postgres `max_connections` 100 → 200** (commit `271367d`) — added as
   headroom while debugging #2. Now that #2 is fixed, steady state is ~20 and
   even 100 would be ample; 200 stays as cheap safety margin (11 GB box).

**Follow-up — DONE (2026-06-01).** `apps/web/workers/telegram-poll.ts` could
die on an unhandled promise rejection from a `PostgresError`
(`triggerUncaughtException`). The two unguarded DB paths were the 60s
`refreshAccounts` reconciler (fired by `setInterval`, whose returned promise is
never awaited) and the per-bot loop's account re-read (it sat outside the
`try/catch` that wraps `pollOnce`). Both now catch + back off, and a
`process.on('unhandledRejection')` backstop logs + keeps the process alive. The
same backstop was added to the other three web workers + the agent for
defense-in-depth (they were already structurally guarded — pg-boss handlers,
wrapped chokidar handlers, `runOnce` try/catch, `.catch` on every LISTEN handler
and interval). **Verified live:** `docker compose restart postgres` produced
`terminating connection due to administrator command` errors that were caught
gracefully (`[pg-boss] error`, `[extract-queue] pg-boss error`) — all five
services stayed `running` with `restarts=0` and connections held flat (~18, not
climbing). Commit `825b663`.

**Verify it's still healthy:**
```bash
ssh cwe@mcp.crossworks.network 'cd ~/mantle && docker compose ps'
ssh cwe@mcp.crossworks.network 'docker exec mantle_pg psql -U postgres -d postgres -tA -c "select count(*) from pg_stat_activity"'  # expect ~20, NOT climbing
curl -sI https://jason.crossworks.network   # 307 → /login, valid cert
```

---

## Original handoff (paused state — kept for reference)

**Status when paused:** mid-deploy, PAUSED (Jason is reinstalling
Docker on the VPS; the build was interrupted by that). Everything up to the
build is staged on the VPS filesystem and survives a Docker reinstall.

**Goal:** Run the containerized Mantle stack on the Contabo VPS, migrate Jason's
dev brain (Postgres + files + MinIO) onto it, serve at `jason.crossworks.network`
with Caddy auto-HTTPS.

---

## Access + targets

| | |
|---|---|
| VPS SSH | `ssh cwe@mcp.crossworks.network` (key-based, non-interactive from Jason's Mac) |
| VPS | Ubuntu 24.04, **x86_64/amd64**, 6 CPU, 11 GB RAM, ~88 GB free |
| Install dir | `~/mantle` (= `/home/cwe/mantle`) |
| Domain | `jason.crossworks.network` → **185.207.250.252** = VPS IPv4 (CONFIRMED) |
| Image | `titanwest/mantle:latest` (Docker Hub, namespace `titanwest`, **private**) |

**Dev box = Jason's Mac** (`~/Projects/mantle`): dev stack runs from
`docker-compose.dev.yml` (infra) + host app; `mantle_pg` container holds the live
brain (1,945 nodes); secrets in `apps/web/.env.local`.

---

## ⚠️ Critical decisions (read before resuming)

1. **BUILD ON THE VPS — do NOT `docker compose pull`.** The Mac builds **arm64**;
   the VPS is **amd64**. The `titanwest/mantle:latest` already on Docker Hub is
   arm64 and will NOT run on the VPS (`exec format error`). Building natively on
   the VPS gives the right arch AND sidesteps the private-registry login. (For a
   future Mac→registry→VPS workflow you'd need `docker buildx --platform
   linux/amd64` — emulated/slow — or build on the VPS each update.)
2. **Single image:** every service (web/agent/4 workers/migrate) runs from
   `titanwest/mantle:latest` via a compose `command:` override; only `web` has
   `build:`. So `docker compose build web` builds the one image for all.
3. **Old stack cleared:** the VPS previously ran an old Supabase-based Mantle
   (project `mantle_supabase`, files at `/home/cwe/mcp.cwe.cloud/infra/supabase/`).
   Its containers (`mantle_kong/db/studio/caddy/storage/meta/auth`) were
   `docker stop`ped to free 80/443. Volumes were kept (a Docker reinstall may wipe
   them — Jason said the box can be empty, so fine).

---

## ✅ DONE (persists on `~/mantle`, survives Docker reinstall)

- **Source** rsynced → `~/mantle` (excludes node_modules/.next/.git/.claude/data/
  backups/.env). Has docker-compose.yml, Dockerfile, infra/{caddy,postgres},
  scripts/.
- **`~/mantle/.env`** written (verified):
  ```
  MANTLE_IMAGE_NAMESPACE=titanwest
  MANTLE_IMAGE_TAG=latest
  MANTLE_SITE_ADDRESS=jason.crossworks.network
  MANTLE_PUBLIC_URL=https://jason.crossworks.network
  MANTLE_DATA_DIR=/home/cwe/mantle/data
  POSTGRES_PASSWORD=*** (fresh, generated on VPS)
  S3_ACCESS_KEY=minio
  S3_SECRET_KEY=*** (fresh)
  SESSION_SECRET=*** (fresh)
  ALLOWED_USER_ID=61572800-924c-4597-b6f0-facde6640f6a   # MUST match dev
  MANTLE_MASTER_KEY=*** (carried over from dev — MUST match dev or vault won't decrypt)
  ```
- **Migration data on the VPS:**
  - `~/mantle/backups/mantle.dump` — 139 MB, `pg_dump -Fc` of the dev brain (1,945 nodes)
  - `~/mantle/minio.tgz` — 22 MB (untar into `data/minio`)
  - `~/mantle/data/files/` — 87 files / 25 MB (already in place)
- **DNS confirmed** (domain → VPS IPv4). 80/443 are free + inbound-open (old Caddy used them).

---

## ⏭️ PENDING — resume here

```bash
# 0. Confirm the daemon is back (Jason was reinstalling Docker)
ssh cwe@mcp.crossworks.network 'docker version && docker compose version'

# 1. Build the one image natively (amd64). ~5–10 min. (Was interrupted ~80%
#    through the deps install by the Docker reinstall — just re-run.)
ssh cwe@mcp.crossworks.network 'cd ~/mantle && docker compose build web'

# 2. Restore the brain BEFORE the app/migrate starts, then bring everything up.
#    ORDER MATTERS: restore into a fresh postgres so the public schema is empty
#    and the dump's drizzle bookkeeping makes the later migrate a no-op.
ssh cwe@mcp.crossworks.network 'cd ~/mantle &&
  docker compose up -d postgres --wait &&                 # init: extensions + auth schema
  bash scripts/db-restore.sh backups/mantle.dump &&        # benign "already exists" notices = OK
  tar xzf minio.tgz -C data/minio &&                       # restore object store
  docker compose up -d --wait'                             # migrate no-ops; web/agent/workers/caddy up

# 3. Verify
ssh cwe@mcp.crossworks.network 'cd ~/mantle && docker compose ps'
ssh cwe@mcp.crossworks.network 'docker exec mantle_pg psql -U postgres -d postgres -tA -c "select count(*) from nodes"'  # expect 1945
curl -sI https://jason.crossworks.network | head -5        # 200 + valid LE cert
# browser: https://jason.crossworks.network → /debug (traces) → /debug/integrity Corpus audit (clean)
```

Caddy issues the Let's Encrypt cert automatically on first `up` (DNS resolves +
80/443 open, both confirmed). Watch `docker compose logs caddy` if HTTPS lags.

Tailnet/remote-inference is **off** (no `TS_AUTHKEY`); skip unless wanted later
(`docker compose --profile tailnet up -d`).

---

## Watch points / gotchas

- **Restore before migrate/app** — `scripts/db-restore.sh` refuses to restore
  over a populated `nodes` table, so run it on the fresh DB before the app comes up.
- **"already exists" notices** for `auth`/`vector`/`ltree` during restore are
  expected (the init scripts pre-create them); the script ignores pg_restore's
  exit code and verifies by row count.
- **Don't `docker compose pull`** (registry image is arm64 — see decision #1).
- If the Docker reinstall changed group membership, re-add `cwe` to the `docker`
  group (`sudo usermod -aG docker cwe` + re-login) so non-sudo docker works.
- Master key / user id already in `.env`; to re-transfer the key without printing:
  `grep '^MANTLE_MASTER_KEY=' ~/Projects/mantle/apps/web/.env.local | ssh cwe@mcp.crossworks.network 'cat >> ~/mantle/.env'`
  (then dedupe the line).

## Re-dumping dev data (if needed again)

On the Mac (dev `mantle_pg` running):
```bash
docker exec mantle_pg pg_dump -U postgres -d postgres -Fc --no-owner > /tmp/mantle.dump
docker run --rm -v mantle_mantle_minio_data:/v:ro -v /tmp:/out alpine tar czf /out/minio.tgz -C /v .
# files live at the dev MANTLE_FILES_ROOT = ~/Projects/mantle/data/files
```

## Background — why the Dockerfile/next.config look the way they do

The production `next build` had never run before this session (only `next dev`).
Fixes committed to `main`: Node 24 (pnpm 11 needs >20), pnpm-via-npm (corepack
unbundled in Node 25+), `@napi-rs/canvas` webpack externals, `@mantle/voice/client`
browser-safe leaf (kept undici/node:crypto out of 4 settings pages),
`systeminformation` externalized. Image slimmed 3.4 GB → 1.6 GB (dropped
`.next/cache` + build toolchain). Canonical runbook: **docs/deploy.md**.
