# Update Mantle

Update from **Settings > Updates** in Jackdaw with one click, or from the stack directory with two commands.

## Before you start

- You need an admin login.
- Read the release notes when the version jumps more than a patch.
- Expect about a minute of downtime. A reply in progress stops and needs a reload.

## Update from Jackdaw

1. Open **Settings > Updates**.
2. Click **Check now**.
3. Click **Update to** followed by the version, then **Update now**.
4. Wait. The page shows the log and reloads onto the new version.

The updater takes a full backup into `backups/pre-roll/` in the stack directory before it changes anything. If the backup fails, or the disk is too full for it, the update is refused and nothing changes. It keeps the newest 3 of these backups.

An update moves the server and the Jackdaw interface together, to a pair tested as one. The **Interface** section can move the interface alone with **Update interface to**.

## Update from the command line

Use this when the box has no updater. Run it in the stack directory (the folder with `docker-compose.yml` and `.env`).

1. Take a backup:

   ```bash
   bash scripts/db-dump.sh
   ```

2. Update the server:

   ```bash
   docker compose pull && docker compose up -d --wait
   ```

3. Update the interface. It is a second stack, and step 2 does not touch it:

   ```bash
   docker compose -f docker-compose.client.yml --project-directory . pull
   docker compose -f docker-compose.client.yml --project-directory . up -d --wait
   ```

Database migrations run by themselves before the app starts.

To stay on a fixed version, set `MANTLE_IMAGE_TAG` in `.env` to a release tag (for example `v1.2.3`) instead of `latest`.

## Check it worked

**Settings > Updates** shows the new version under **This install**. On the box, run:

```bash
bash scripts/install.sh --check
```

## Roll back

1. Set `MANTLE_IMAGE_TAG` in `.env` back to the previous version.
2. Run `docker compose pull && docker compose up -d --wait`.

Migrations only go forward. If the update ran a migration, restore the backup taken before it as well. See [Back up and restore](02-backups.md).

## If it fails

- **"The updater is not configured on this host"**: add `MANTLE_STACK_DIR=` with the full path of the stack directory to `.env` (`pwd -P` prints it), then run `docker compose up -d updater`.
- **"Stack compose has drifted"**: `docker-compose.yml` has local edits, so updates no longer refresh it. Move your changes into `.env` or `docker-compose.override.yml`. Run `sh scripts/compose-adopt.sh` to see what differs, then `sh scripts/compose-adopt.sh --apply`.
- **The interface stays old after a command-line update**: you skipped step 3.

## Next

- [Back up and restore](02-backups.md)
- [Troubleshooting](11-troubleshooting.md)
