---
title: Backups
---

## Backups

Backups makes scheduled copies of the database to a folder on the server and keeps the newest few.

1. Turn on **Enable scheduled backups**.
2. Set the **Frequency** (Daily or Weekly on Sundays), the **At hour** and how many to **Keep**.
3. Set the **Folder**, or leave the default.
4. Click **Save backup settings**.

Click **Run backup now** before any risky upgrade. The **On disk** list shows each backup and the last result.

These copies stay on this server. Copy the folder somewhere else yourself, with a tool such as rsync, restic or rclone.

## Assistant

The assistant cannot run or change backups. Use this screen.

## Technical

- Each backup is a compressed `pg_dump` file, checked before it is kept. The oldest are deleted past the **Keep** count.
- Defaults: off, daily, 02:00, keep 7. The folder defaults to `MANTLE_BACKUP_DIR`, then `data/backups`.
- The dump holds the database only. Uploaded files and the object store need their own copy.
- Keep `MANTLE_MASTER_KEY` safe and apart from the backups. Without it, restored secrets, API keys and passwords cannot be read.
- Restore is done from the command line with `scripts/db-restore.sh`. See [Backups and restore](../05-admin/02-backups.md).
