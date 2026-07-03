# Developing against a remote (production) database

A workflow for running the **local codebase + dev server**, but pointed at a
**deployed Postgres + MinIO** instead of the local dev containers. Useful when you
want to build/iterate against real data without replicating it locally — and it's
the same thin-client shape a future Electron desktop build will use. For the
architecture behind it (and what else it unlocks), see
[Split UI / core](./split-ui-core.md).

> ⚠️ **This is live data.** Every dev write — an agent turn, a seed, a migration,
> a file upload — mutates the deployment. Read [Before you migrate](#before-you-migrate)
> before any schema change.

There are two ways to reach the remote data plane. **Tailscale (recommended)** is
a stable MagicDNS endpoint with nothing to babysit; the **SSH tunnel** is a
zero-standing-exposure fallback when you're not on the tailnet.

Both point **both** the DB and the object store at the deployment, on purpose:
without the S3 side, an upload would write its row to the remote DB but its bytes
to local MinIO, leaving a dangling file node in production (and remote file reads
would 404 locally).

---

## Option A — Tailscale (recommended)

The remote node publishes Postgres + MinIO on the tailnet with `tailscale serve
--tcp`; any device signed into the same tailnet reaches them by MagicDNS:

```
local dev server ──▶ mantle.taildc9091.ts.net:5432   (Postgres, over the tailnet)
                 └──▶ mantle.taildc9091.ts.net:9000   (MinIO/S3, over the tailnet)
```

**One-time, on the prod node** — publish the data plane (see also
`scripts/prod-tailscale-serve.sh`):

```sh
pnpm tailscale:serve          # ssh in, resolve container IPs, run `tailscale serve --tcp`
pnpm tailscale:serve:status   # verify
```

`tailscale serve` targets must be IPs and docker IPs change on container recreate,
so the script re-resolves them each run — **re-run `pnpm tailscale:serve` after a
prod redeploy** if the tailnet endpoints stop responding. Remove the exposure with
`scripts/prod-tailscale-serve.sh reset`.

**On each dev machine:**

1. Install Tailscale (macOS: `brew install --cask tailscale && open -a Tailscale`,
   then sign in with the **same account** as the deployment) and confirm
   `tailscale status` lists the prod node.
2. Point `apps/web/.env.local` at the MagicDNS name, using the *remote* creds
   (from the server's `.env`: `POSTGRES_PASSWORD`, `S3_SECRET_KEY`):
   ```sh
   DATABASE_URL=postgres://postgres:<REMOTE_POSTGRES_PASSWORD>@mantle.taildc9091.ts.net:5432/postgres
   S3_ENDPOINT=http://mantle.taildc9091.ts.net:9000
   S3_REGION=us-east-1
   S3_ACCESS_KEY=minio
   S3_SECRET_KEY=<REMOTE_S3_SECRET_KEY>
   S3_BUCKET=mantle
   ```
3. Run the dev server (see [Running the dev server](#running-the-dev-server)).

> **Security:** `serve` is a *standing* exposure — the DB + object store are
> reachable by every device on your tailnet (scope with tailnet ACLs). On a
> single-user tailnet the blast radius is small, but it's a real posture change.
> The status shows "TLS over TCP" — that's Tailscale's label; a plain Postgres/S3
> client connects normally, and the tailnet itself is WireGuard-encrypted.
>
> **No inbound ports** are opened on the host: `5432`/`9000` live on the tailnet
> only (never the public interface); Tailscale needs just *outbound* (UDP 41641,
> or DERP over 443). See [Split UI / core → Ports & firewall](./split-ui-core.md#ports--firewall-nothing-to-open).

---

## Option B — SSH tunnel (fallback, no standing exposure)

When you're not on the tailnet. Opens local ports forwarded over SSH to the
remote containers (IPs re-resolved each run):

```
local dev server ──▶ 127.0.0.1:55432 ──ssh──▶ <pg container IP>:5432     (Postgres)
                 └──▶ 127.0.0.1:9100  ──ssh──▶ <minio container IP>:9000  (MinIO/S3)
```

```sh
pnpm db:tunnel            # open both forwards (idempotent; re-resolves the IPs)
pnpm db:tunnel:down       # close when done    ·  status: scripts/prod-db-tunnel.sh status
```

Then set `.env.local` to the local ports instead of the MagicDNS name:
`DATABASE_URL=…@127.0.0.1:55432/postgres`, `S3_ENDPOINT=http://127.0.0.1:9100`.
The tunnel is key-gated and on-demand — nothing is reachable unless it's open. It
dies on reboot / network drop; re-run `pnpm db:tunnel`.

Config knobs (env overrides; defaults match the reference deployment):
`PROD_SSH_HOST=mantle-prod`, `MANTLE_PG_CONTAINER=mantle_pg`,
`MANTLE_MINIO_CONTAINER=mantle_minio`, `PROD_DB_LOCAL_PORT=55432`,
`PROD_S3_LOCAL_PORT=9100`.

---

## Running the dev server

```sh
pnpm -C apps/web dev      # web (next dev) against the remote DB
# … other services as needed, each run directly:
#   pnpm -C apps/web worker:dev   pnpm -C apps/agent dev   pnpm -C apps/mcp dev
```

**Don't use root `pnpm dev` / `pnpm start` in this mode.** Their `predev` hook
(`scripts/preflight-dev.sh`) hard-requires a healthy *local* `mantle_dev_pg` container
and will refuse to start. The per-service `dev` scripts above skip the preflight.

The encryption master key (`MANTLE_MASTER_KEY`) must match the server's so
encrypted vault rows decrypt — for the reference deployment it already does.

## Before you migrate

A `pnpm db:migrate` in this mode runs **against the remote DB**, and some
migrations (e.g. `ALTER TYPE … ADD VALUE`) are **not cleanly reversible**. Always
take a backup first:

```sh
ssh mantle-prod 'docker exec mantle_pg pg_dump -U postgres -d postgres -Fc --no-owner' \
  > backups/mantle-prod-$(date +%Y%m%d-%H%M%S).dump   # confirm non-empty
pnpm db:migrate                                        # then migrate
```

Restore path + full replication steps: [`backups.md`](backups.md).

## Revert to a fully local stack

Swap `DATABASE_URL` back to `…@127.0.0.1:54323/postgres` and `S3_ENDPOINT` to
`http://127.0.0.1:9000` (key `minio12345`), then `pnpm start`.
