# Handover — Deploy Mantle to Contabo (jason.crossworks.network)

**Date:** 2026-06-01 · **Status:** mid-deploy, PAUSED (Jason is reinstalling
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
