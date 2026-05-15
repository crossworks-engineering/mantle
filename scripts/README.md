# scripts

## At a glance

| Script | Where | What |
|---|---|---|
| `snapshot.sh` | laptop | Snapshot the local CLI's data (pg_dump + storage tar). |
| `restore.sh` | server-side | Apply a snapshot into a target compose. |
| `test-snapshot.sh` | laptop | Roundtrip-verify a snapshot is restorable. |
| `convert-to-bind-mounts.sh` | laptop, one-time | Move CLI's named volumes onto host bind-mounts for rsync-ability. |
| `deploy-supabase.sh` | laptop | rsync compose + Caddyfile + kong/ + volumes/ to the server. |
| `dev-tunnel.sh` | laptop | SSH port-forward (54322 → server's Postgres). |
| `gen-supabase-keys.mjs` | anywhere | Generate `ANON_KEY` + `SERVICE_ROLE_KEY` from `JWT_SECRET`. |
| `fix-supabase-roles.sh` | server | Reset reserved-role passwords to match `POSTGRES_PASSWORD` (needed after rsync of a data dir from a different env). |

## Backup & migration

Three scripts protect the data and let you move Mantle to a self-hosted
Supabase whenever you're ready. Run them from the repo root.

### `snapshot.sh` — capture everything

Captures a complete, restorable snapshot of Postgres + Storage into a
timestamped directory under `backups/`.

```bash
./scripts/snapshot.sh                 # → backups/20260515-093000/
./scripts/snapshot.sh ./pre-migration # custom path
./scripts/snapshot.sh --stop-storage  # pause storage container while taring
```

Produces:

```
backups/<timestamp>/
├── roles.sql       # pg_dumpall --roles-only
├── postgres.dump   # pg_dump -Fc (custom binary format)
├── storage.tar     # tar of /mnt inside the storage container
└── meta.txt        # image versions, row counts, timestamp
```

Postgres dump is taken transactionally — safe to run against a live
Mantle, no downtime. The storage tar can be slightly inconsistent if
uploads are in flight; pass `--stop-storage` for absolute consistency
(few seconds of downtime).

**What this does NOT back up:**

- `MANTLE_MASTER_KEY` (in `apps/web/.env.local`). **Critical** — losing
  this makes every encrypted column unrecoverable.
- Google OAuth credentials (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`),
  Supabase keys, `ALLOWED_USER_ID`. All env-only.
- `apps/web/.env.local` itself. Save this elsewhere (1Password, etc.).

### `restore.sh` — apply a snapshot to a target

Takes a snapshot directory and restores into the target Postgres + Storage
containers. Use this on a freshly-provisioned self-hosted Supabase to
seed it with your local data.

```bash
./scripts/restore.sh ./backups/20260515-093000 \
  prod_db prod_storage
```

Requires the target containers to be running and reachable from the
host running the script.

Sequence:
1. Applies `roles.sql` (tolerates "already exists" for Supabase's stock roles)
2. `pg_restore` with `--clean --if-exists --no-owner` — wipes existing
   schemas and recreates from the dump
3. Untars `storage.tar` into the target's `/mnt` (the storage-api
   container's data root)
4. Prints row counts for verification

### `test-snapshot.sh` — verify a snapshot is restorable

Roundtrip-tests a snapshot against a throwaway Postgres container and
compares row counts. Catches "I took a backup but it doesn't actually
restore" before you find out the hard way.

```bash
./scripts/test-snapshot.sh ./backups/20260515-093000
```

Run after every significant change (e.g. a new migration) to keep the
backup pipeline trustworthy.

## Suggested cadence

For a personal Mantle:

- `snapshot.sh` on demand before any destructive change (`supabase db reset`,
  large schema migration, "upgrading Supabase").
- A weekly or daily cron once you're past the "still actively building" phase.
- `test-snapshot.sh` against any snapshot you'd actually use to restore.

For production cutover (the eventual self-hosted move):

```bash
# on the laptop
./scripts/snapshot.sh ./pre-prod-cutover

# on the server (after rsync of pre-prod-cutover/)
./scripts/restore.sh ./pre-prod-cutover \
  mantle_prod_db mantle_prod_storage
```

## Server lifecycle

### `deploy-supabase.sh` — push compose + Caddyfile + volumes to the server

Stops the local Supabase CLI for a consistent rsync, then transfers
`infra/supabase/` (compose, Caddyfile, kong config) and `volumes/*`
(Postgres data, storage objects) to `cwe@mcp.crossworks.network`.

```bash
./scripts/deploy-supabase.sh
```

Refuses to run unless a `snapshot.sh` was taken in the last 24 hours
— rollback insurance.

### `dev-tunnel.sh` — SSH port-forward for the remote Postgres

```bash
./scripts/dev-tunnel.sh --background   # opens 127.0.0.1:54322 → server's 5432
./scripts/dev-tunnel.sh --stop         # closes it
./scripts/dev-tunnel.sh                # foreground (Ctrl-C to close)
```

Required for any local `pnpm dev` against the remote Supabase. If you
see `ECONNREFUSED 127.0.0.1:54322` in the worker logs, the tunnel
dropped.

### `gen-supabase-keys.mjs` — derive ANON_KEY and SERVICE_ROLE_KEY

Produces both JWTs from your `JWT_SECRET` using only Node's built-in
`crypto` (no third-party dependencies, no pasting secrets into web
pages).

```bash
JWT_SECRET="$(openssl rand -base64 48)" \
  node scripts/gen-supabase-keys.mjs
```

Or pick it up from the server's `.env`:

```bash
node --env-file=infra/supabase/.env scripts/gen-supabase-keys.mjs
```

Both keys default to a 10-year expiry. Rotate by changing `JWT_SECRET`
and re-running.

### `fix-supabase-roles.sh` — reset reserved-role passwords on the server

The Supabase Postgres image **does not re-sync reserved-role passwords
on container restart**. So after deploying a rsync'd data dir into a
fresh env, the old `POSTGRES_PASSWORD` is still baked in for
`supabase_auth_admin`, `supabase_storage_admin`, etc., and those
services crash-loop with `password authentication failed`.

This script temporarily edits the real `pg_hba.conf` (inside the
container, at `/etc/postgresql/pg_hba.conf` — *not* the data dir
version), adds a `local all all trust` rule, runs `ALTER ROLE` on every
reserved admin to use the current `POSTGRES_PASSWORD`, then restores
`pg_hba.conf` and reloads. ~3 seconds of trust-on-the-local-socket
inside the container; nothing public-facing.

Run on the server:

```bash
ssh cwe@mcp.crossworks.network
cd ~/mcp.cwe.cloud
scripts/fix-supabase-roles.sh    # or specify a different compose dir
docker compose -f infra/supabase/docker-compose.yml restart auth storage
```

Re-run any time you rotate `POSTGRES_PASSWORD`.

## One-time conversions

### `convert-to-bind-mounts.sh` — extract CLI named volumes onto host paths

Already run during initial setup. Documented in `infra/supabase/README.md`.
The compose now uses bind-mounted volumes under `infra/supabase/volumes/`
which means rsync, restic, and casual inspection all work on plain files.

## Other scripts

- `apps/web/scripts/sync-now.ts` — manually trigger an IMAP sync (used
  during dev when you don't want to wait for the 2-min cron).
- `apps/web/scripts/imap-folders.ts` — enumerate IMAP folders for an
  account (useful when debugging which folders are getting scanned).
