# Backups

The brain is irreplaceable personal memory; everything else in the stack is
rebuildable from source. This doc covers the automated two-leg backup
(installed 2026-06-10), what it protects, and the restore drill.

## What must survive

| Data | Where it lives on prod | Backup vehicle |
|---|---|---|
| Postgres (nodes, facts, entities, conversations, vault, …) | `mantle_pg` cluster | nightly `pg_dump -Fc` |
| Host-mirrored files | `~/mantle/data/files/` (bind mount) | rsync mirror |
| Object bytes (attachments) | `~/mantle/data/minio/` (bind mount, xl backend) | rsync mirror |
| `MANTLE_MASTER_KEY` + secrets | `~/mantle/.env` | **not** copied by the pull — the same master key already lives in the Mac's `apps/web/.env.local`. If you ever rotate it, update both by hand. |

Embeddings are derived data: they ride along inside the dump, and even a
total loss re-embeds locally for ~$0 (`pnpm re-embed`). The source text is
what matters.

## Leg 1 — VPS nightly dump (cron)

[`scripts/backup-prod.sh`](../scripts/backup-prod.sh), installed in the `cwe`
crontab at **02:30 server time**:

```
30 2 * * * cd $HOME/mantle && bash scripts/backup-prod.sh >> backups/nightly/backup.log 2>&1
```

- `pg_dump -Fc --no-owner` → `backups/nightly/mantle-<ts>.dump`, written via a
  `.part` temp name so a partial dump is never mistaken for a good one, then
  checked for the `PGDMP` magic bytes.
- Rotates `backups/nightly/` to the newest **7** dumps
  (`MANTLE_BACKUP_KEEP`). Manual dumps in `backups/` (from
  `scripts/db-dump.sh`, e.g. pre-deploy insurance) are never touched.
- `data/files` and `data/minio` need no VPS-side step — they're already plain
  files on disk; the offsite leg mirrors them directly.

## Leg 2 — Mac offsite pull (launchd)

[`scripts/pull-prod-backup.sh`](../scripts/pull-prod-backup.sh), installed as
`me.schoeman.mantle-backup-pull` (**daily 08:15**, missed runs fire on wake —
laptop-friendly). One-time install: `bash scripts/pull-prod-backup.sh
--install-launchd`.

Pulls over the existing `mantle-prod` SSH alias (read-only on prod) into
`~/Backups/mantle/prod/`:

- `db/` — dump archive. Mirrors the VPS's rotated window, then **accumulates**
  (`cp -n`) so local retention (30 days, `MANTLE_BACKUP_RETAIN_DAYS`) outlives
  the VPS's 7-dump window.
- `files/`, `minio/` — mirrored **without `--delete`**, deliberately: a
  deletion on prod (or a compromised prod) can never destroy the offsite copy.
- **Verification, not just transfer:** the newest dump must pass
  `pg_restore --list` or the run fails loudly. `last-success` carries the
  timestamp of the last good run; `pull.log` the history.

Checking health: `cat ~/Backups/mantle/prod/last-success` — if that date is
ever more than a couple of days old, read `pull.log`.

## Restore drill

**Postgres** (onto a fresh stack — same flow as dev replication, see
`prod-access-and-replication` memory / deploy.md §3):

```bash
docker compose down            # keep volumes for files/minio
docker volume rm <pg volume>   # nuke only the cluster
docker compose up -d postgres --wait      # init scripts recreate extensions + auth
bash scripts/db-restore.sh ~/Backups/mantle/prod/db/mantle-<ts>.dump
docker compose up -d --wait
```

**Files:** rsync `~/Backups/mantle/prod/files/` back to `data/files/`.

**MinIO:** the mirror is the raw xl backend — restoring onto the *same* MinIO
means putting the directory back at `data/minio/` while the container is
stopped. For a logical cross-server restore, stand up the backup dir under a
throwaway MinIO container and `mc mirror` out of it.

**Master key:** a restored DB is unreadable in its `_enc` columns without the
`MANTLE_MASTER_KEY` that sealed it. It lives in prod `.env` and the Mac's
`apps/web/.env.local` (kept equal). Losing both keys loses the vault +
secrets — nothing else.

Drill status: dump-level verification is automated (`pg_restore --list` every
pull). A full end-to-end restore rehearsal onto a scratch stack has **not**
been performed yet — worth one deliberate pass.

## Adding a third leg later

The natural hardening step is an independent cloud target (restic → B2/S3
with encryption), so a single house event can't take both copies. The pull
script's `DEST` layout is restic-friendly — point `restic backup
~/Backups/mantle/prod` at a bucket and it inherits the verified dumps.
