# Postgres major upgrade (pg17 → pg18)

Moving Postgres across a **major** version (17 → 18) is **not** a tag bump. A new
major refuses to start on the previous major's on-disk data directory:

```
FATAL:  database files are incompatible with server
DETAIL: The data directory was initialized by PostgreSQL version 17,
        which is not compatible with this version 18.x.
```

So the upgrade is a **dump → fresh data dir → restore**, done deliberately per box.
The stateless services in the stack (Tika, browserless/chromium, MinIO, Caddy,
Ollama, Tailscale) genuinely *are* pull-and-go; Postgres is the only one that is not.

## The default and the escape hatch

The compose files gate the pgvector image behind `POSTGRES_IMAGE_TAG` (default
`pg18`) in both `docker-compose.yml` and `docker-compose.dev.yml`:

```yaml
image: pgvector/pgvector:${POSTGRES_IMAGE_TAG:-pg18}
```

**Fresh installs come up on pg18 directly** — a new box has no data dir, so it just
initialises on 18. This is the shipping default going forward; new deployments need
no migration and no flags.

The gate exists for **existing pg17 boxes**. A new major will not start on an old
major's data dir, so a box already on pg17 must EITHER complete the migration below,
OR set `POSTGRES_IMAGE_TAG=pg17` in its env to hold on 17 until it does. **Deploy
ordering matters**: never let an un-migrated pg17 box pull this compose and `up`
without one of those — it will crash-loop pg18 on a pg17 dir. Practically, before
rolling this to the fleet, either migrate each existing box or pin it to `pg17`
first, then unpin as each is migrated.

### `PGDATA` must be pinned (pg18 image change)

The compose also sets `PGDATA=/var/lib/postgresql/data` on the postgres service.
This is **mandatory** for pg18+: the official images (which pgvector is built on)
moved the default `PGDATA` to a version-specific subdir and **refuse to initialize**
into a mount at the classic `/var/lib/postgresql/data`, failing with *"there appears
to be PostgreSQL data in /var/lib/postgresql/data (unused mount/volume)"* and
crash-looping. Pinning `PGDATA` back keeps the existing bind mount
(`${MANTLE_DATA_DIR}/postgres`) working; it is a no-op on pg17 (already its default).
Without it, `POSTGRES_IMAGE_TAG=pg18` will not boot — the tag change alone is not
enough.

> `pgvector/pgvector` bundles Postgres **and** the vector extension in one image, so
> "upgrade Postgres" and "upgrade pgvector" are the same image. `pg18` currently
> ships **PostgreSQL 18.4 + pgvector 0.8.5** (same pgvector as the `pg17` image, so
> the extension version does not change — only the Postgres major does).

## What the standard dump scripts do and don't cover

`scripts/db-dump.sh` / `scripts/db-restore.sh` operate on the **`postgres`
database only** (plus the app- and table-SQLite volumes, which are unaffected by a
Postgres upgrade). A major upgrade starts a **fresh cluster**, so **every**
non-template Postgres database must be captured — not just `postgres`. Depending on
what a box runs, that can also include:

- `mantle_dbos_sys` — the DBOS workflow/runs engine state (present when runs are enabled)
- any additional brain/demo databases

List them first: `docker exec <pg> psql -U postgres -c '\l'`. If `postgres` is the
only non-template database, `db-dump.sh` alone is enough; otherwise take a
`pg_dumpall` as well (below).

## Per-box procedure

`<pg>` = the Postgres container (`mantle_pg` on deployed boxes, `mantle_dev_pg` in
dev). Adjust the compose invocation to the box (`docker compose` /
`docker compose -f docker-compose.dev.yml`). **Schedule downtime** — the DB is
offline for the dump+restore.

### 1. Full backups (nothing is deleted until these exist)

```bash
BK=~/pg-preupgrade-$(date +%Y%m%d-%H%M%S); mkdir -p "$BK"
# Authoritative, whole-cluster (all databases + globals):
docker exec <pg> pg_dumpall -U postgres > "$BK/all-databases.sql"
# Plus per-database custom-format (smaller, indexable, matches db-restore.sh):
for db in $(docker exec <pg> psql -U postgres -tAc \
  "select datname from pg_database where not datistemplate and datname<>'postgres'"); do
  docker exec <pg> pg_dump -U postgres -d "$db" -Fc --no-owner > "$BK/$db.dump"
done
docker exec <pg> pg_dump -U postgres -d postgres -Fc --no-owner > "$BK/postgres.dump"
ls -lh "$BK"
```

Also run `scripts/db-dump.sh` to snapshot the app- and table-SQLite volumes (those
are separate from Postgres and must be preserved independently).

### 2. Stop the stack, move the old data dir aside (this is the rollback point)

```bash
docker compose down          # keeps host bind-mounts; only stops containers
# The data dir is owned by the container's postgres user; move it with a root
# helper container so no host sudo is needed. ${MANTLE_DATA_DIR:-./data}:
docker run --rm -v "$(pwd)/data:/d" alpine sh -c \
  'test ! -e /d/postgres.pg17.bak && mv /d/postgres /d/postgres.pg17.bak && mkdir /d/postgres'
```

Keeping `postgres.pg17.bak` is the instant rollback: if anything goes wrong, put it
back and unset `POSTGRES_IMAGE_TAG`.

### 3. Bring up pg18 on the fresh dir, then restore into PRISTINE databases

Set `POSTGRES_IMAGE_TAG=pg18` in the box env (with `PGDATA` already pinned in the
compose, per above), then bring Postgres up on the empty dir:

```bash
docker compose up -d postgres --wait        # fresh initdb; init scripts run
```

> ⚠️ **Do NOT restore straight over the freshly-initialized `postgres` database.**
> The init scripts (`infra/postgres/init/*.sql`) pre-create `auth`, `auth.users`,
> and the extensions. If a box's on-disk init script is **older than the dumped
> schema** (e.g. it predates a column added by a later migration), `pg_restore`
> silently skips `CREATE TABLE auth.users` ("already exists") and then its data
> `COPY` fails on the column mismatch — leaving `auth.users` **empty and
> wrong-shaped**, which breaks auth. This actually happened on a live box. The fix
> is to restore into a **pristine** database with no init objects:

```bash
# Replace the init-populated postgres DB with an empty one, then restore clean:
docker exec <pg> psql -U postgres -d template1 -c "DROP DATABASE postgres WITH (FORCE);"
docker exec <pg> psql -U postgres -d template1 -c "CREATE DATABASE postgres;"
docker exec -i <pg> pg_restore -U postgres -d postgres --no-owner < "$BK/postgres.dump"

# Every OTHER database is created fresh (init never touched them) and restored:
for db in $(ls "$BK"/*.dump | xargs -n1 basename | sed 's/\.dump$//' | grep -vx postgres); do
  docker exec <pg> psql -U postgres -c "CREATE DATABASE \"$db\""
  docker exec -i <pg> pg_restore -U postgres -d "$db" --no-owner < "$BK/$db.dump"
done

docker compose up -d --wait                 # migrate is a no-op; app starts
```

A pristine restore should report **0 errors**. `pgcrypto` upgrades 1.3 → 1.4 on
pg18 — a normal bundled-extension bump, not an error. (`scripts/db-restore.sh`
restores *over* the init objects instead, which is fine only when the box's init
script exactly matches the dumped schema — the drop/recreate above is unconditional
and safe, so prefer it for major upgrades.)

### 4. Verify

```bash
docker exec <pg> psql -U postgres -d postgres -tAc "select version()"                       # → PostgreSQL 18.4
docker exec <pg> psql -U postgres -d postgres -tAc "select extversion from pg_extension where extname='vector'"  # → 0.8.5
docker exec <pg> psql -U postgres -d postgres -tAc "select count(*) from nodes"             # matches pre-upgrade
docker exec <pg> psql -U postgres -d postgres -tAc \
  "select count(*) from pg_index i join pg_class c on c.oid=i.indexrelid join pg_am am on am.oid=c.relam where am.amname='hnsw'"  # matches
# Identity intact — MUST be non-zero with the owner present (this is the check that
# catches the auth.users init-collision from step 3):
docker exec <pg> psql -U postgres -d postgres -tAc "select count(*) filter (where is_owner) from auth.users"  # → ≥1
docker exec <pg> psql -U postgres -tAc "select datname from pg_database where not datistemplate"  # all DBs present
```

Start the app **only after** these pass. Gate the app behind DB verification — if
`auth.users` is empty/short, roll back (step 5) rather than starting the app.

Then persist the flag so it survives a reboot/redeploy — add `POSTGRES_IMAGE_TAG=pg18`
to the box's env file (the same place `MANTLE_IMAGE_TAG` etc. live).

### 5. Rollback (if verification fails)

```bash
docker compose down
unset POSTGRES_IMAGE_TAG        # and remove it from the env file
docker run --rm -v "$(pwd)/data:/d" alpine sh -c 'rm -rf /d/postgres && mv /d/postgres.pg17.bak /d/postgres'
docker compose up -d --wait     # back on pg17, original cluster intact
```

Once pg18 is confirmed healthy and you no longer need the rollback, delete
`data/postgres.pg17.bak` and the `$BK` backups.

## Fleet ordering & cautions

- **One box at a time**, lowest-stakes first; verify before moving on.
- **HNSW/ivfflat indexes rebuild from `CREATE INDEX` on restore** (they are not
  copied binary), so vector search returns immediately after restore — no reindex
  step, but the restore does the index-build work up front.
- **In-flight runs / DBOS**: a box mid-workflow will lose queue state unless
  `mantle_dbos_sys` is captured and restored (step 1/3 above). Prefer a quiet
  window.
- **A client/production brain mid-acceptance is upgraded last**, with its own
  scheduled window and a tested rollback — never batched with the rest.
- **No concurrent writers**: make sure no dev server or other session is writing to
  the brain during the dump/restore, or their writes between the dump and the
  restore are lost.

## Validation status

Proven end-to-end on a **live full-stack production box** (12-container stack, real
brain): migrated 17.10 → **18.4** in place with ~4 min downtime, then verified —
node count preserved exactly (936), 2228 chunks, all **4 HNSW indexes rebuilt**,
pgvector 0.8.2 → **0.8.5**, owner identity intact, and the full stack (web + api +
10 workers + tika **3.3.1.0** + chromium **v2.55.0**) came back healthy and served
live traffic. Both failure modes in this doc were **hit and fixed on that box**: the
`PGDATA` crash-loop (§ safety gate) and the `auth.users` init-collision (§ step 3) —
the drop/recreate restore then reported 0 errors. A prior dry run (throwaway pg18
container, live stack untouched) had also validated the dump/restore.

Ollama (**0.32.2**) and Tailscale (**v1.98.9**) defaults are bumped in compose but
were **not** exercised on the production run (Tailscale left pinned there because it
was live; Ollama not running on that box). Validate those two on a box where they
run before relying on them. MinIO, Caddy and MinIO `mc` were already current.
