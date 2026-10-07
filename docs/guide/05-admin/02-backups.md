# Back up and restore

Turn on scheduled backups in **Settings > Backups**, copy them off the box, and keep `.env` safe. This page also shows how to restore.

## What a full backup is

| Part | Where it lives |
|---|---|
| Database dumps | `data/backups/` (scheduled), `backups/` in the stack directory (manual) |
| Your files | `data/files/` |
| Attachments (the object store) | `data/rustfs/` |
| `.env` | the stack directory |

`data/` is `MANTLE_DATA_DIR`, next to `docker-compose.yml` unless you moved it. Each backup run also saves the app databases, the table workbooks and members' personal files beside the dump.

`.env` holds `MANTLE_MASTER_KEY`. Without it, the API keys, mail passwords and secrets in a backup cannot be read. Keep a copy of `.env` somewhere other than the backup folder.

## Turn on scheduled backups

1. Open **Settings > Backups**.
2. Switch on **Scheduled backups**.
3. Set **Frequency** (daily, or weekly on Sundays), **At hour** (in your profile's time zone) and **Keep** (how many dumps to keep, default 7).
4. Click **Save backup settings**.
5. Click **Run backup now** once to check it works. The dump appears under **On disk**.

Backups run only while the stack is up.

## Copy backups off the box

Mantle writes backups to the box only. Copy them somewhere else with the tool you trust. One `rsync` of `data/` without `data/postgres/` covers the scheduled dumps, your files and the attachments:

```bash
rsync -a --exclude postgres/ /opt/mantle/data/ backup-host.example.com:mantle-data/
```

Skip `data/postgres/`: live database files copied mid-write are not usable. The dumps are the database backup.

## Take a backup by hand

Run this in the stack directory before any risky change:

```bash
bash scripts/db-dump.sh
```

It writes `backups/mantle-<time>.dump` and the archives that go with it.

## Restore

Restore into a fresh database on a stopped stack. The script refuses a database that already holds data. On a new box, copy the old `.env` in first so `MANTLE_MASTER_KEY` matches.

1. Stop the stack: `docker compose down`.
2. Move `data/postgres/` aside (rename it).
3. Put the other parts back under `data/`:
   - Copy `files/` and `rustfs/` back. Restore `rustfs/` with the same object store version that wrote it.
   - From a manual backup, extract `mantle-app-dbs-<time>.tgz` into `data/app-dbs/` and `mantle-table-dbs-<time>.tgz` into `data/table-dbs/`.
4. Start only the database:

   ```bash
   docker compose up -d postgres --wait
   ```

5. Restore the dump. It also puts members' personal files back from the archive beside it:

   ```bash
   bash scripts/db-restore.sh backups/mantle-<time>.dump
   ```

6. When it exits 0, start everything: `docker compose up -d --wait`.

The script checks the restored logins and database rules before it exits:

- **0**: the restore is good.
- **2**: the restore is not usable. Do not start the app. Read the errors it printed, fix the cause and restore again into a fresh database.
- **3**: the checks passed but part of the dump did not restore. Find what is missing before you start the app.

## Check it worked

Sign in and open a few recent items and files.

## Next

- [Update Mantle](01-update.md)
- [Security](10-security.md)
