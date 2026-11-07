---
title: Updates
---

## Updates

This screen checks for a newer MantleOS release and installs it.

1. Take a backup first: [Backups and restore](../05-admin/02-backups.md).
2. Press **Check now** under **Latest release**.
3. If a release is newer than **This install**, press **Update to** the new
   version and confirm with **Update now**.
4. Wait. The **Updater** section shows each phase, then the page reloads onto
   the new version.

Expect about a minute of downtime while the services restart. Work in progress,
such as a long reply or an ingest, is interrupted; background work resumes on
its own.

The web app (the **Interface**) has its own release line. A normal update
installs the brain and the interface that were tested together. **Update
interface to** moves the interface alone and takes a few seconds.

An update replaces the application. Your database, files and settings stay.
Read the **Release notes** when the version jumps by more than a patch.

Under **This install** a warning shows when the stack's compose file or the
updater script differs from the release. The warning says how to fix it.

## Assistant

The assistant cannot update the brain. Use this screen. You can ask about
updating:

- "How do I update MantleOS?"
- "What happens to my data during an update?"

## Technical

The screen does not install anything itself. It asks a separate updater
container, which pulls the new images and restarts the stack, then reports
back. The app never gets control of the container runtime. Database
migrations run automatically before the app starts. After a good update the
updater removes old images of this product, and keeps the ones needed to roll
back.

If the screen says the updater is not available, set `MANTLE_STACK_DIR` in
`.env`, or update from the stack directory with
`docker compose pull && docker compose up -d --wait --remove-orphans`.
After the update, **Last update log** shows what happened. More detail:
[Update MantleOS](../05-admin/01-update.md).
