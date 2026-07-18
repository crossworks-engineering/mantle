# Backups

The brain (Postgres) is the irreplaceable part of a Mantle install — everything
else is rebuildable from source. Mantle ships a built-in scheduled backup that
dumps the database to a **local folder you choose**; getting that folder
**offsite is deliberately your job**, because every operator has a different
story (rsync cron, rclone, restic, Syncthing, Time Machine) and all of them
work by pointing at a directory.

## The feature — /settings/backups

Configure at **Settings → Backups**:

| Setting | Meaning | Default |
|---|---|---|
| Enabled | master switch | off |
| Frequency | daily, or weekly (Sundays) | daily |
| At hour | hour of day **in your profile timezone** | 02:00 |
| Keep | newest N dumps retained (rotation) | 7 |
| Folder | destination directory | `MANTLE_BACKUP_DIR` → `/data/backups` in Docker (host: `${MANTLE_DATA_DIR}/backups`) |

The page also offers **Run backup now**, shows the last-run status (success or
the error), and lists the dumps currently on disk.

## How it works

Engine: [`packages/content/src/backup.ts`](../packages/content/src/backup.ts).

- `pg_dump -Fc --no-owner` against `DATABASE_URL`, streamed to
  `mantle-<ts>.dump` via a `.part` temp name (a partial dump can never be
  mistaken for a good one), then verified against the `PGDMP` magic bytes
  before being promoted.
- Rotation deletes beyond `keep`, and only files matching Mantle's own
  `mantle-*.dump` pattern — anything else in the folder is never touched.
- The scheduler is a cheap tick hosted by the **events worker**: when the
  wall-clock hour in your timezone matches the configured hour (and the last
  run is old enough to rule out a double-fire), it runs. Consequence: backups
  fire **while the stack is up** — if it was down during the window, the next
  window catches it.
- Config + status live on `profiles.preferences` (`backup` / `backupStatus`
  keys), so the UI and the worker share one source of truth.
- The Docker image ships `postgresql-client-17` (pgdg) so `pg_dump` matches
  the bundled Postgres 17. On a bare-metal/dev install, the engine looks for
  `pg_dump` on `PATH` and in the usual homebrew/pgdg locations; set
  `MANTLE_PG_DUMP` to point at a specific binary.

## What to copy offsite

Your offsite sync should include, from `${MANTLE_DATA_DIR}` (default
`./data` next to the compose file):

| Path | What it is |
|---|---|
| `backups/` | the rotated DB dumps (this feature's output) |
| `files/` | your host-mirrored files (`/files` surface) |
| `minio/` | attachment object bytes |
| `forum-uploads/` | quarantined member forum uploads awaiting review — the ONLY copy of a pending upload until you file it |

One `rsync -a` of the `data/` directory (minus `postgres/` — the live cluster
files are useless mid-write; the dumps are the DB backup) covers everything.

**Master key caveat:** a restored database is unreadable in its encrypted
columns (`secrets`, account passwords, bot tokens) without the
`MANTLE_MASTER_KEY` from your `.env`. Keep a copy of that key somewhere safe
and separate. Losing the key loses the vault — nothing else.

## Restore drill

Onto a fresh stack:

```bash
docker compose down                      # keep volumes/binds for files/minio
# wipe ONLY the Postgres state (named volume or ${MANTLE_DATA_DIR}/postgres)
docker compose up -d postgres --wait     # init scripts recreate extensions + auth
bash scripts/db-restore.sh <path-to>/mantle-<ts>.dump
docker compose up -d --wait
```

Files, MinIO, and pending forum uploads restore by putting the `files/`,
`minio/`, and `forum-uploads/` directories back under `${MANTLE_DATA_DIR}`
while the stack is stopped.

Worth doing once deliberately: a full end-to-end restore rehearsal onto a
scratch stack, so the first time isn't the bad day.

## Ad-hoc dumps

`scripts/db-dump.sh` remains the manual path (pre-deploy insurance, pre-
migration snapshots). It writes to `backups/` at the install root and is
independent of the scheduled feature — scheduled rotation never touches its
output.
