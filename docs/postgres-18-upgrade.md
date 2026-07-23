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

## The safety gate

The compose files pin the pgvector image behind `POSTGRES_IMAGE_TAG` (default
`pg17`) in both `docker-compose.yml` and `docker-compose.dev.yml`:

```yaml
image: pgvector/pgvector:${POSTGRES_IMAGE_TAG:-pg17}
```

The default stays on the **current** major on purpose: a plain `docker compose pull
&& up` can then never boot pg18 on a pg17 data dir and wedge a box. A box moves to
pg18 only by completing the migration below and **then** setting
`POSTGRES_IMAGE_TAG=pg18` in its environment. Flipping the committed *default* to
`pg18` is a separate, later step, taken only once every box has been migrated.

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

### 3. Bring up pg18 on the fresh dir and restore

```bash
export POSTGRES_IMAGE_TAG=pg18
docker compose up -d postgres --wait        # fresh initdb; init scripts create auth + extensions
scripts/db-restore.sh "$BK/postgres.dump"   # restores the main brain (see note below)

# Restore any OTHER databases into fresh copies:
for db in $(ls "$BK"/*.dump | xargs -n1 basename | sed 's/\.dump$//' | grep -vx postgres); do
  docker exec <pg> psql -U postgres -c "CREATE DATABASE \"$db\""
  docker exec -i <pg> pg_restore -U postgres -d "$db" --no-owner < "$BK/$db.dump"
done

docker compose up -d --wait                 # migrate is a no-op; app starts
```

> The init scripts pre-create `auth`, `auth.users`, and the extensions, so
> `pg_restore` prints a few harmless "already exists" notices for those objects —
> expected (they are identical to the dump). `pgcrypto` upgrades 1.3 → 1.4 on pg18;
> that is a normal bundled-extension bump, not an error.

### 4. Verify

```bash
docker exec <pg> psql -U postgres -d postgres -tAc "select version()"                       # → PostgreSQL 18.4
docker exec <pg> psql -U postgres -d postgres -tAc "select extversion from pg_extension where extname='vector'"  # → 0.8.5
docker exec <pg> psql -U postgres -d postgres -tAc "select count(*) from nodes"             # matches pre-upgrade
docker exec <pg> psql -U postgres -d postgres -tAc \
  "select count(*) from pg_index i join pg_class c on c.oid=i.indexrelid join pg_am am on am.oid=c.relam where am.amname='hnsw'"  # matches
docker exec <pg> psql -U postgres -tAc "select datname from pg_database where not datistemplate"  # all DBs present
```

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

The dump → pg18 → restore path was proven end-to-end against a real brain (throwaway
pg18 container, live stack untouched): PostgreSQL **18.4**, `pg_restore` exit 0 with
**zero errors/warnings**, node count preserved exactly, **all HNSW indexes rebuilt**,
pgvector **0.8.5**, and a live KNN vector query returned rows. Tika **3.3.1.0** and
browserless/chromium **v2.55.0** pull and start as drop-in replacements. Ollama
(**0.32.2**), Tailscale (**v1.98.9**), MinIO, Caddy, and MinIO `mc` are prod-compose
services validated on a full-compose box; MinIO/`mc`/Caddy were already current.
