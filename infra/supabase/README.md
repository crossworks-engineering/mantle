# Mantle production Supabase

Self-hosted Supabase + Caddy stack split across three subdomains that
all resolve to the same VPS. Designed to run while you continue to
develop locally — the laptop's Next.js / worker / MCP server talk to
this remote backend.

## The three subdomains

| Subdomain                    | What it serves                          | Status    |
|------------------------------|-----------------------------------------|-----------|
| `db.crossworks.network`      | Supabase API: `/auth/v1/*` and `/storage/v1/*` only | **Live** |
| `mantle.crossworks.network`  | Mantle Next.js app                      | Reserved  |
| `mcp.crossworks.network`     | MCP server over HTTP/SSE                | Reserved  |

**Studio is not publicly exposed.** Caddy only proxies the two routes
the browser-side Mantle code actually calls (`/auth/v1/*` for sign-in
and `/storage/v1/*` for attachment downloads). Everything else under
`db.crossworks.network` returns a friendly 404. Server admin happens
via the SSH-tunnelled Postgres (see "Switching local dev to the remote
backend" below) and `pnpm db:studio` from the laptop.

All three are declared in [Caddyfile](Caddyfile) and acquire Let's
Encrypt certificates on first start. The reserved ones currently
return `503 — not yet deployed` until you swap in the relevant
`reverse_proxy` directive (one-line change). The certs are still
acquired so the deploy step doesn't have to wait on ACME.

## Layout

```
infra/supabase/
├── docker-compose.yml      caddy + db + kong + auth + storage + meta + studio
├── Caddyfile               TLS + reverse proxy for the three subdomains
├── kong/kong.yml           API gateway routing (auth, storage, meta, studio)
├── .env.example            secrets template — copy to .env on the server
└── volumes/                bind-mounted data (rsync target, gitignored)
    ├── db/                 Postgres data dir
    └── storage/            attachment objects, content-addressed
```

## Topology

```
   Laptop                                           Server
   ──────                                           ──────

   browser  ──── HTTPS ──► db.crossworks.network ──► Caddy ──► Kong ──► auth
                                                        ▲              storage
                                                        │              meta
                                                        │              studio
                                                        │
   pnpm dev (3000) ─── reads/writes via @supabase/ssr ──┘
   pg-boss worker  ─┐
   MCP server      ─┼── SSH tunnel ────► 127.0.0.1:5432 (Postgres, loopback)
   Drizzle queries ─┘   127.0.0.1:54322
```

Browser code in the Mantle app calls `db.crossworks.network/auth/v1/*`
and `/storage/v1/*` directly. Server-side code on the laptop (Drizzle,
pg-boss, MCP) hits Postgres at `127.0.0.1:54322` — forwarded by SSH to
the server's loopback-bound Postgres on `127.0.0.1:5432`.

### Why two channels (HTTPS + SSH tunnel)?

The asymmetry is deliberate. The two paths carry different protocols
to different services:

| Caller | Hits | Why |
|---|---|---|
| Browser-side (Supabase JS SDK) | `https://db.crossworks.network/auth/v1/*` and `/storage/v1/*` | Public HTTPS via Caddy → Kong → GoTrue / Storage. The only thing the browser ever needs. |
| Server-side (Drizzle, pg-boss, MCP, `@mantle/email`) | `postgres://…@127.0.0.1:54322/postgres` | Native Postgres wire protocol via the SSH tunnel. Caddy doesn't proxy TCP/5432 — it does HTTPS only. |

`db.crossworks.network` is **"the Supabase API"** (HTTPS). The **SSH
tunnel is "direct Postgres"** (TCP). They're served by different
processes on the server (Caddy/Kong on 80/443; Postgres bound to
`127.0.0.1:5432`).

**Why not just expose Postgres publicly too?** You could — bind it to
`0.0.0.0:5432`, open the firewall, point `DATABASE_URL` at
`db.crossworks.network:5432`. Three reasons we deliberately don't:

1. **Plaintext on the wire by default.** Postgres needs `sslmode=require`
   plus TLS certs configured in `postgresql.conf` to encrypt. The SSH
   tunnel gives you encryption for free.
2. **Port 5432 is one of the most-scanned ports on the internet.**
   Public Postgres = bots probing within minutes with default
   credentials. SSH-only access means port 5432 isn't even *visible*
   to the internet.
3. **One auth surface instead of two.** The SSH key is already gating
   server access. Adding a separate Postgres auth surface buys very
   little for a single-user app.

**Required laptop env (`apps/web/.env.local`)**:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://db.crossworks.network        # browser
NEXT_PUBLIC_SUPABASE_ANON_KEY=<from server .env>              # browser
SUPABASE_SERVICE_ROLE_KEY=<from server .env>                  # server-side
DATABASE_URL=postgres://postgres:<POSTGRES_PASSWORD>@127.0.0.1:54322/postgres
NEXT_PUBLIC_APP_URL=http://localhost:3000                     # dev
MANTLE_MASTER_KEY=<unchanged from before — keep!>
ALLOWED_USER_ID=<unchanged from before — keep!>
```

`NEXT_PUBLIC_*` vars are baked into the browser bundle. `DATABASE_URL`
is *deliberately not* `NEXT_PUBLIC_*` — connection strings should never
reach the client.

**Required startup sequence**:

```bash
./scripts/dev-tunnel.sh --background    # 127.0.0.1:54322 → server's Postgres
pnpm dev                                # Next.js + worker + MCP server
```

If the tunnel drops, the worker logs `ECONNREFUSED 127.0.0.1:54322` —
that's a dead tunnel, not a dead server. Re-run
`./scripts/dev-tunnel.sh --background` to reopen.

## What's deployed (and what isn't)

The official Supabase self-hosting compose has 13 services. We ship 7:

| Service | Status | Reason |
|---|---|---|
| caddy | ✓ | TLS termination, public 80/443 |
| db | ✓ | Postgres 17.6.1.106 — matches local CLI exactly |
| kong | ✓ | Internal API gateway |
| auth | ✓ | `/auth/v1/*` — login flow |
| storage | ✓ | `/storage/v1/*` — attachment uploads/downloads |
| meta | ✓ | Powers Studio |
| studio | ✓ | `/` (basic-auth gated) — admin UI |
| rest | ✗ | Mantle uses Drizzle direct |
| realtime | ✗ | No websocket subscriptions |
| functions | ✗ | No Edge Functions |
| imgproxy | ✗ | No image transforms |
| analytics, vector, supavisor | ✗ | Not needed for single-user load |

## First-time setup

### On the server (`cwe@mcp.crossworks.network`)

Prerequisites:
- Docker + Docker Compose installed.
- DNS A record `mcp.crossworks.network` → server's public IP (already done — `185.207.250.252`).
- Ports 80 and 443 open to the internet (for Caddy's ACME challenge and HTTPS).
- Port 22 open from your laptop (for SSH tunnel + deploys).

Nothing to do on the server before the first deploy — the deploy script
creates the directory structure and rsyncs everything into place.

### From the laptop (one-time)

```bash
# Take a fresh snapshot — rollback insurance.
./scripts/snapshot.sh

# Push compose + Caddyfile + kong config + volumes to the server.
./scripts/deploy-supabase.sh
```

The deploy stops your local Supabase CLI so the bind-mounted data is
consistent, then rsyncs everything to `/home/cwe/mcp.cwe.cloud/infra/supabase/`.

### On the server (one-time)

```bash
ssh cwe@mcp.crossworks.network
cd /home/cwe/mcp.cwe.cloud/infra/supabase

cp .env.example .env
$EDITOR .env
#   ↑ POSTGRES_PASSWORD:    openssl rand -base64 24
#   ↑ JWT_SECRET:           openssl rand -base64 48
#   ↑ ANON_KEY:             https://supabase.com/docs/guides/self-hosting#api-keys
#   ↑ SERVICE_ROLE_KEY:     same generator, role=service_role
#   ↑ DASHBOARD_PASSWORD:   strong, random — basic-auth for Studio
#   ↑ PUBLIC_HOSTNAME:      mcp.crossworks.network (already in .env.example)

docker compose up -d
docker compose logs -f caddy   # wait for "certificate obtained successfully"
```

The first Caddy boot takes ~30 seconds to acquire the Let's Encrypt
cert. After that, `https://mcp.crossworks.network/` answers with the
Studio basic-auth prompt.

## Switching local dev to the remote backend

Once the server's up, point your laptop's `apps/web/.env.local` at it:

```bash
# Required edits (everything else stays as-is):
NEXT_PUBLIC_SUPABASE_URL=https://db.crossworks.network
NEXT_PUBLIC_SUPABASE_ANON_KEY=<ANON_KEY from server's .env>
SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY from server's .env>
DATABASE_URL=postgres://postgres:<POSTGRES_PASSWORD>@127.0.0.1:54322/postgres
# MANTLE_MASTER_KEY stays — must match what encrypted the existing rows
# ALLOWED_USER_ID  stays — auth.users.id moved across with the rsync
```

Open the SSH tunnel and start dev:

```bash
./scripts/dev-tunnel.sh --background    # 127.0.0.1:54322 → server's PG
pnpm dev
```

Stop with `./scripts/dev-tunnel.sh --stop` when done.

**Add localhost to Google OAuth's redirect URI list** if it isn't
already: Google Cloud Console → your OAuth client → Authorized redirect
URIs → add `http://localhost:3000/api/oauth/google/callback`. When you
later deploy Mantle to `mantle.crossworks.network`, add
`https://mantle.crossworks.network/api/oauth/google/callback` alongside
(both can coexist).

## Updating

To push code/config/volume changes after the first deploy:

```bash
./scripts/deploy-supabase.sh
ssh cwe@mcp.crossworks.network 'cd /home/cwe/mcp.cwe.cloud/infra/supabase && docker compose up -d'
```

The deploy is incremental rsync — only changed files transfer.

## Snapshots, backups, restores

Same workflow as local — the scripts work against any container set:

```bash
# Snapshot the SERVER's data (run on the server, or via ssh)
ssh cwe@mcp.crossworks.network \
  'cd /home/cwe/mcp.cwe.cloud && MANTLE_DB_CONTAINER=mantle_db MANTLE_STORAGE_CONTAINER=mantle_storage ./scripts/snapshot.sh'

# Or copy server's volumes back to laptop (reverse of deploy)
rsync -avz \
  cwe@mcp.crossworks.network:/home/cwe/mcp.cwe.cloud/infra/supabase/volumes/ \
  ./infra/supabase/volumes/
```

For automated backups, set up a cron on the server that runs
`scripts/snapshot.sh` to a backups directory, then `restic` / `borg` /
`rclone` that off-box.

## Operational notes

- **Cert renewal**: Caddy handles this automatically. Storage in the
  `caddy_data` Docker volume; survives container restarts. Renewals
  log to `docker compose logs caddy`.
- **Postgres exposure**: bound to `127.0.0.1:5432` on the server only —
  no public port. The only way in is the SSH tunnel.
- **Studio**: runs internally but is *not* publicly routed by Caddy.
  Admin via the SSH tunnel + `pnpm db:studio` from the laptop. If you
  ever want the actual Supabase Studio UI, see "Re-exposing Studio for
  admin via SSH tunnel" in the troubleshooting section below.
- **No `DISABLE_SIGNUP=false` blooper**: Mantle is single-user.
  `DISABLE_SIGNUP=true` is the default — flip only if you intentionally
  want to onboard another user.
- **JWT rotation**: change `JWT_SECRET` → re-issue `ANON_KEY` and
  `SERVICE_ROLE_KEY` → restart compose → update `apps/web/.env.local`
  on the laptop. All existing sessions are invalidated (you'll log in
  again) but encrypted columns stay intact (those use `MANTLE_MASTER_KEY`,
  unrelated).

## Why this layout

- **One compose, one box** for now. Add a sibling compose for the
  Mantle Next.js app later if you want to colocate it; or deploy app
  separately to Vercel/Fly while keeping data here.
- **Caddy + Kong** rather than nginx + Kong because Caddy auto-handles
  TLS without a separate certbot dance, and the Caddyfile is two
  meaningful lines.
- **Bind-mounted volumes** rather than named volumes because rsync,
  restic, and casual inspection all work on plain files.

## Troubleshooting

Issues hit during the first deploy. Documenting them so future-Jason
isn't rediscovering anything.

### Auth + Storage crash-loop with `password authentication failed for user supabase_auth_admin`

**Symptom**: `mantle_auth` and `mantle_storage` containers restart every
~10 seconds with logs like:

```
fatal running db migrations: ...
  failed SASL auth (FATAL: password authentication failed for user
  "supabase_auth_admin" (SQLSTATE 28P01))
```

**Cause**: the rsync'd Postgres data dir came with the OLD environment's
role passwords baked in. The Supabase Postgres image does *not*
re-sync the reserved-role passwords on every container start — once a
data dir is initialised, those passwords are sticky. Your fresh server
`.env` has a new `POSTGRES_PASSWORD`, but `supabase_auth_admin`,
`supabase_storage_admin`, etc. inside the database still hold the old
hash.

**Fix**: run [`scripts/fix-supabase-roles.sh`](../../scripts/fix-supabase-roles.sh)
on the server. It temporarily adds a `local all all trust` line to
the real `pg_hba.conf`, connects as `supabase_admin` (the actual
superuser), runs `ALTER ROLE` on every reserved role to match the
current `POSTGRES_PASSWORD`, then restores `pg_hba.conf`. Reload is via
SIGHUP — no full restart. Followed by:

```bash
docker compose restart auth storage
```

Then `docker compose ps` should show both healthy.

Same script applies if you ever rotate `POSTGRES_PASSWORD` in `.env`.

### Editing pg_hba.conf doesn't take effect (you edited the wrong file)

**Symptom**: you add a line to `volumes/db/pg_hba.conf`, reload Postgres,
and the change is silently ignored.

**Cause**: the Supabase image overrides `hba_file` in `postgresql.conf`
to point at `/etc/postgresql/pg_hba.conf` — *not* the file in the data
dir. The data-dir copy is a leftover stub.

**Fix**: edit the real one inside the container:

```bash
docker exec -u postgres mantle_db sh -c '
  cat >> /etc/postgresql/pg_hba.conf <<EOF
host all all 10.0.0.0/8 scram-sha-256
EOF
  pg_ctl reload -D /var/lib/postgresql/data
'
```

Verify by inspecting what Postgres actually loaded:

```bash
docker exec -u postgres mantle_db \
  psql -d postgres -c "select name, sourcefile from pg_settings where name='hba_file';"
```

### Kong crash-loops with `error parsing declarative config file /home/kong/kong.yml`

**Symptom**: Kong won't start, logs reference `basicauth_credentials` or
`@entity` or `missing primary key`.

**Cause**: `kong.yml` references a consumer that doesn't exist (e.g.
basic-auth credentials pointing at a `DASHBOARD` consumer that was
never declared). Common after editing kong.yml to remove a route.

**Fix**: either remove the orphan reference entirely (cleanest) or add
back the matching `consumers:` entry. After fixing, `scp` the file to
the server and `docker compose up -d kong` to retry.

### Caddyfile syntax errors

**Symptom**: Caddy container fails to start with `Unexpected next token
after '{' on same line`.

**Cause**: Caddy 2 doesn't accept all directives in single-line block
form (e.g. `request_body { max_size 60MB }`). Multi-line is reliable.

**Fix**: validate locally before deploying:

```bash
docker run --rm \
  -v "$(pwd)/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile
```

Then rsync to the server and reload Caddy.

### Re-exposing Studio for admin via SSH tunnel

If you ever want the Supabase Studio UI without putting it back on the
public Caddy:

1. Add `127.0.0.1:8000:8000` to `kong.ports` in `docker-compose.yml`
   (loopback-only host port).
2. `docker compose up -d kong` on the server.
3. From the laptop: `ssh -L 3001:127.0.0.1:8000 cwe@mcp.crossworks.network`
4. Open `http://localhost:3001/` — but you'll also need to re-add a
   `dashboard` service block to `kong.yml` (the one we removed) so
   Kong actually routes `/` to Studio.

For day-to-day admin, **`pnpm db:studio` from the laptop while the
Postgres tunnel is up is usually enough** — it's a table editor against
the live DB without any Studio infrastructure.

### Connection refused on port 80 / 443 from outside, server is up

**Symptom**: `curl https://db.crossworks.network` returns
`Connection refused` (code `000`) but SSH works.

**Cause**: Caddy isn't listening. Usually because of a config error
that crashed it, or compose wasn't brought up yet.

**Fix**: check the logs:

```bash
ssh cwe@mcp.crossworks.network 'cd ~/mcp.cwe.cloud/infra/supabase && docker compose logs caddy --tail 20'
```

The error is usually in the last 5 lines. Common causes: bad Caddyfile
syntax (validate locally first), the `kong` upstream not reachable
because Kong itself crashed (check its logs too), or missing DNS for
one of the declared site blocks (Caddy retries ACME but keeps trying
to start).
