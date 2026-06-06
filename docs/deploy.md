# Deploying Mantle to production (Docker Hub → VPS)

The production stack is `docker-compose.yml` — built images, a migrate gate,
healthchecks, restart policies, the bundled embedder (Ollama) + Tika, and an
optional Tailscale profile. This runbook covers the **build → push → deploy**
loop and the **one-time data migration** from your dev brain.

Companion: [`docker-compose.yml`](../docker-compose.yml) header comments,
[`.env.prod.example`](../.env.prod.example), and the scripts under
[`scripts/`](../scripts).

> **Golden rule.** Prod is your source-of-truth brain, not a test bench.
> Develop on the local dev stack (`pnpm start` + host hot-reload), validate, then
> promote a built image. The integrity **probe** belongs on dev; only the
> read-only **audit** is safe to run against prod. See the bottom of this file.

---

## 0. Topology

| | Where | How |
|---|---|---|
| **Dev** | your Mac | `docker-compose.dev.yml` (infra only) + `pnpm dev` (hot reload), separate dev DB |
| **Build** | your Mac | `scripts/docker-build-push.sh` → Docker Hub |
| **Prod** | Contabo VPS | `docker compose pull && up -d` (no build on the VPS) |

Persistent data is **bind-mounted** under `MANTLE_DATA_DIR` (default `./data`):
`postgres/`, `minio/`, `files/`. The Ollama model cache + Tailscale identity stay
as named volumes (re-pullable / re-auth on a new host).

---

## 1. One-time: secrets + env

On **both** the build machine and the VPS, create `.env` next to `docker-compose.yml`:

```bash
cp .env.prod.example .env
# then fill in:
#   SESSION_SECRET       openssl rand -base64 48
#   MANTLE_MASTER_KEY    openssl rand -base64 32   ← MUST be the SAME key you
#                        encrypted your dev vault with, or stored API keys /
#                        secrets won't decrypt after the data import.
#   ALLOWED_USER_ID      the uuid of your auth.users row (same as dev)
#   POSTGRES_PASSWORD, S3_SECRET_KEY, MANTLE_PUBLIC_URL
#   MANTLE_IMAGE_NAMESPACE=<your docker hub user>
#   MANTLE_DATA_DIR=/opt/mantle/data   (absolute path on the VPS)
#   MANTLE_SITE_ADDRESS=mantle.example.com   (Caddy serves this with auto-HTTPS)
```

### Front door / HTTPS (Caddy)

Caddy is the public entrypoint — it terminates TLS on 80/443 and reverse-proxies
to the app internally (`web:3000`, which is **not** publicly exposed). For
automatic HTTPS, before first boot:

1. Point a DNS **A record** (and AAAA if you have IPv6) for your domain at the VPS.
2. Open ports **80 and 443** on the VPS firewall (`ufw allow 80,443/tcp`; 443/udp
   too for HTTP/3).
3. Set `MANTLE_SITE_ADDRESS=your.domain` in `.env`. On `up`, Caddy fetches a
   Let's Encrypt cert automatically and renews it. (`:80` = plain HTTP for local
   testing without a domain.)

Certs persist in the `caddy_data` volume — don't wipe it, or you risk LE rate limits.

> `MANTLE_MASTER_KEY` and `ALLOWED_USER_ID` **must match dev** for the imported
> data to be usable — the master key decrypts the secrets/API-key vault, and the
> user id owns every row.

---

## 2. Build & push images (build machine)

> **⚠️ Architecture must match the VPS.** A Docker image is arch-specific. An
> Apple-Silicon Mac builds **arm64**; most VPSes (incl. Contabo) are **amd64**,
> and an arm64 image won't run there (`exec format error`). Three options:
> - **Build natively on the VPS** (simplest for a first deploy + frequent
>   updates — no emulation, no registry pull): `rsync` the source to the VPS and
>   run `docker compose build web` there. The image is local, so no `docker login`
>   / pull needed. This is how the Contabo deploy was done — see
>   [`handoff-deploy-contabo-2026-06-01.md`](./_archive/handoff-deploy-contabo-2026-06-01.md).
> - **Cross-build for amd64 on the Mac**: `docker buildx build --platform
>   linux/amd64 -t <ns>/mantle:<tag> --push .` (runs amd64 under QEMU — slow).
> - **Multi-arch**: `--platform linux/amd64,linux/arm64` (slowest; one tag runs
>   anywhere). Only worth it if you pull on both arches.
>
> The `docker compose build` / push flow below assumes the build machine and the
> VPS share an arch. If they don't, use one of the above.

```bash
docker login
MANTLE_IMAGE_NAMESPACE=youruser MANTLE_IMAGE_TAG=v1 scripts/docker-build-push.sh
```

Builds + pushes **one image** — `<youruser>/mantle:v1`. Every service (web,
agent, the four workers, migrate) runs from that same image, differing only in
the compose `command:`. Use a real tag (`v1`, a date, or a git sha) — `latest`
is fine but harder to roll back from.

---

## 3. First deploy + data migration (VPS)

The migration moves three things: **the database**, the **file bytes** (`files/`),
and the **object store** (`minio/`).

```bash
# 3a. Pull images and prepare the data dir
docker compose pull
mkdir -p "$MANTLE_DATA_DIR"/{postgres,minio,files}

# 3b. Bring up ONLY postgres — its init creates the extensions + auth schema
docker compose up -d postgres --wait

# 3c. Restore the DB dump you took on dev (see §4) BEFORE the app starts.
#     A few "already exists" notices for auth/vector/ltree are expected + benign.
scripts/db-restore.sh backups/mantle-<ts>.dump

# 3d. Copy the file bytes + object store from dev (bind-mount dirs → just rsync)
rsync -a  dev-host:/path/to/dev/data/files/  "$MANTLE_DATA_DIR"/files/
rsync -a  dev-host:/path/to/dev/data/minio/  "$MANTLE_DATA_DIR"/minio/
#   (On dev these live wherever MANTLE_DATA_DIR pointed; for the dev compose,
#    export the named volumes instead — see §4.)

# 3e. Bring up the rest — migrate sees the restored bookkeeping and no-ops
docker compose up -d --wait

# 3f. (optional) join the tailnet for remote inference
TS_AUTHKEY=tskey-... docker compose --profile tailnet up -d --wait
```

Verify: `https://<MANTLE_PUBLIC_URL>` loads, `/debug` shows your traces, and the
**Corpus audit** (`/debug/integrity` → Corpus audit) comes back clean.

---

## 4. Taking the dev dump + files

On the **dev** machine:

```bash
# DB → custom-format archive under ./backups
scripts/db-dump.sh          # writes backups/mantle-<ts>.dump

# File bytes + object store. With the dev compose these are NAMED volumes
# (mantle_pg_data / mantle_minio_data / mantle_files_data), so export them:
docker run --rm -v mantle_files_data:/v -v "$PWD/backups":/out alpine \
  tar czf /out/files.tgz -C /v .
docker run --rm -v mantle_minio_data:/v -v "$PWD/backups":/out alpine \
  tar czf /out/minio.tgz -C /v .
```

Copy `backups/mantle-<ts>.dump`, `files.tgz`, `minio.tgz` to the VPS; untar the
two archives into `$MANTLE_DATA_DIR/files` and `/minio` (step 3d alternative).

> The DB is moved by **dump/restore**, never by copying `postgres/` raw — that
> only works same-PG-major + clean shutdown and is fragile. `pg_dump` is portable.

---

## 5. Promoting a change (after first deploy)

```bash
# build machine
MANTLE_IMAGE_NAMESPACE=youruser MANTLE_IMAGE_TAG=v2 scripts/docker-build-push.sh

# VPS
#   bump MANTLE_IMAGE_TAG=v2 in .env, then:
docker compose pull
docker compose up -d --wait        # migrate runs first (gated); then app rolls
```

**Always `scripts/db-dump.sh` before a deploy that includes a migration** — a
backup is cheap insurance for a brain. Migrations are the one thing you never
test in prod first; run them against dev (or a throwaway staging project) first.

### Rollback

```bash
# VPS — set MANTLE_IMAGE_TAG back to the previous tag in .env
docker compose pull && docker compose up -d --wait
```

Code rolls back instantly. **Schema does not** — a migration is forward-only, so
if a deploy migrated the DB, rolling back the image may leave the schema ahead.
This is why the pre-deploy dump matters: to truly roll back a bad migration,
restore the dump into a fresh DB (§3b–c).

---

## 6. Staging on the VPS (for tailnet / remote-inference testing)

To test the real VPS→tailnet→model path without touching prod data, run a second
isolated project:

```bash
MANTLE_DATA_DIR=/opt/mantle/staging-data TS_HOSTNAME=mantle-staging \
  docker compose -p mantle-staging --profile tailnet up -d --wait
# ...test..., then:
docker compose -p mantle-staging down
```

The `-p` prefix namespaces containers + volumes; the separate `MANTLE_DATA_DIR`
gives it its own DB/files. (Override the published port or stop prod first to
avoid a `:3000` clash.)

---

## 7. Integrity tooling in prod

- **Corpus audit** (`/debug/integrity` → Corpus audit) — read-only, safe, run it
  anytime / on a schedule as your standing health check.
- **Active probe** — writes synthetic fixtures; **keep it off prod.** Run it on
  dev (or against a dedicated test owner / the staging project). See
  [data-flow-tracing.md](./data-flow-tracing.md).
