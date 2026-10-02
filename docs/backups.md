# Backups

The brain (Postgres) is the irreplaceable part of a Mantle install; everything
else is rebuildable from source. Mantle ships a built-in scheduled backup that
dumps the database to a **local folder you choose**; getting that folder
**offsite is deliberately your job**, because every operator has a different
story (rsync cron, rclone, restic, Syncthing, Time Machine) and all of them
work by pointing at a directory.

## The feature: /settings/backups

Configure at **Settings → Backups**:

| Setting   | Meaning                                  | Default                                                                              |
| --------- | ---------------------------------------- | ------------------------------------------------------------------------------------ |
| Enabled   | master switch                            | off                                                                                  |
| Frequency | daily, or weekly (Sundays)               | daily                                                                                |
| At hour   | hour of day **in your profile timezone** | 02:00                                                                                |
| Keep      | newest N dumps retained (rotation)       | 7                                                                                    |
| Folder    | destination directory                    | `MANTLE_BACKUP_DIR` → `/data/backups` in Docker (host: `${MANTLE_DATA_DIR}/backups`) |

The page also offers **Run backup now**, shows the last-run status (success or
the error), and lists the dumps currently on disk.

## How it works

Engine: [`packages/content/src/backup.ts`](../packages/content/src/backup.ts).

- `pg_dump -Fc --no-owner` against `DATABASE_URL`, streamed to
  `mantle-<ts>.dump` via a `.part` temp name (a partial dump can never be
  mistaken for a good one), then verified against the `PGDMP` magic bytes
  before being promoted.
- Beside each dump the same run snapshots the table workbooks
  (`mantle-table-dbs-<ts>/`), the app databases (`mantle-app-dbs-<ts>/`,
  with each app's own snapshots under `_snapshots/`) and
  members' personal-space file bytes (`mantle-spaces-<ts>.tgz`, the only copy
  of a member's upload). Each is loud but non-fatal: a failure there never
  spoils the Postgres dump.
- Rotation deletes beyond `keep`, and only files matching Mantle's own
  `mantle-*.dump` pattern (with their siblings), anything else in the folder
  is never touched.
- The scheduler is a cheap tick hosted by the **events worker**: when the
  wall-clock hour in your timezone matches the configured hour (and the last
  run is old enough to rule out a double-fire), it runs. Consequence: backups
  fire **while the stack is up**: if it was down during the window, the next
  window catches it.
- Config + status live on `profiles.preferences` (`backup` / `backupStatus`
  keys), so the UI and the worker share one source of truth.
- The Docker image ships `postgresql-client-18` (pgdg) so `pg_dump` matches the
  compose default `POSTGRES_IMAGE_TAG=pg18`. **The client must never be older
  than the server**, `pg_dump` aborts outright on a newer server, so a
  major-version bump in compose has to be matched here in the same change. The
  reverse is fine (an 18 client dumps a pinned-`pg17` box), so when in doubt
  ship the newer client. On a bare-metal/dev install, the engine looks for
  `pg_dump` on `PATH` and in the usual homebrew/pgdg locations (newest pgdg
  first); set `MANTLE_PG_DUMP` to point at a specific binary.

## What to copy offsite

Your offsite sync should include, from `${MANTLE_DATA_DIR}` (default
`./data` next to the compose file):

| Path             | What it is                                                                                                                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backups/`       | the rotated DB dumps (this feature's output)                                                                                                                                                                                                                     |
| `files/`         | your host-mirrored files (`/files` surface)                                                                                                                                                                                                                      |
| `rustfs/`        | attachment object bytes: the RustFS object store's data dir, not plain files (a restore needs the same RustFS version; see below)                                                                                                                                |
| `minio/`         | only on boxes that ran MinIO before 2026-09: the pre-switch copy kept for rollback, removable once `objectstore:verify` has been green for a couple of weeks ([deploy.md §5c](./deploy.md#5c-object-store-rustfs))                                               |
| `forum-uploads/` | only on boxes that ran the retired team forum: its old upload quarantine. Nothing reads it since the forum tables were dropped (migration 0177); the Forum archive export filed every upload whose bytes were there ([team-forum.md](./team-forum.md) section 8) |
| `spaces/`        | members' personal-space file bytes (also archived by every backup as `mantle-spaces-<ts>.tgz`)                                                                                                                                                                   |

One `rsync -a` of the `data/` directory (minus `postgres/`, the live cluster
files are useless mid-write; the dumps are the DB backup) covers everything.

**Master key caveat:** a restored database is unreadable in its encrypted
columns (`secrets`, account passwords, bot tokens) without the
`MANTLE_MASTER_KEY` from your `.env`. Keep a copy of that key somewhere safe
and separate. Losing the key loses the vault; nothing else.

## Restore drill

Onto a fresh stack:

```bash
docker compose down                      # keep volumes/binds for files/rustfs
# wipe ONLY the Postgres state (named volume or ${MANTLE_DATA_DIR}/postgres)
docker compose up -d postgres --wait
bash scripts/db-restore.sh <path-to>/mantle-<ts>.dump
docker compose up -d --wait
```

`db-restore.sh` drops the init-made `postgres` database and restores into a
pristine one, so the init scripts do not matter to a restore. It refuses a
target that already holds items or logins. After the restore it checks the
logins, the login role CHECK, the viewer row policies and every trigger the
dump lists. Exit code 2 means the restore is not usable: do not start the
app. Read the `pg_restore` errors it printed, fix the cause, drop the
database and run it again. Exit code 3 means the checks passed and every
step ran, but `pg_restore` reported an error the script cannot explain:
find what did not restore before you start the app. On exit 2 and 3 the
full `pg_restore` output is kept; the script prints where.

A dump taken before migration 0212 always gives one `pg_restore` error (the
folder share refresh trigger; docs/access-levels.md, section 6). The script
makes that trigger itself and does not count the error. A dump of a brain
that had already lost the trigger can carry stale folder share levels:
migration 0212 repairs them at the next migrate, and under a release before
0212 the nightly `share-drift` sweep does.

`db-restore.sh` also puts members' personal-space files back from the
`mantle-spaces-<ts>.tgz` beside the dump (into `${MANTLE_DATA_DIR}/spaces`,
only while that folder is empty).

Files and the object store restore by putting the
`files/` and `rustfs/` directories back under
`${MANTLE_DATA_DIR}` while the stack is stopped. `rustfs/` is RustFS's own
on-disk format, so restore it under the same RustFS version that wrote it
(`RUSTFS_IMAGE_TAG`, default in `docker-compose.yml`). Then prove the object
store is intact: every stored attachment's key is the sha256 of its bytes, so
this re-hashes each one and exits non-zero on any mismatch or unreadable object:

```bash
docker exec mantle_web pnpm -C packages/storage objectstore:verify
```

Worth doing once deliberately: a full end-to-end restore rehearsal onto a
scratch stack, so the first time isn't the bad day.

## Ad-hoc dumps

`scripts/db-dump.sh` remains the manual path (pre-deploy insurance, pre-
migration snapshots). It writes to `backups/` at the install root and is
independent of the scheduled feature, scheduled rotation never touches its
output.
