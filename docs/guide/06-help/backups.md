---
title: Backups
---

## Backups

Scheduled database dumps to a local directory, rotated so they don't fill the
disk.

Read the word **local** carefully, because it's the whole point of this screen.
Mantle's job ends at producing verified, rotated dumps on this machine. Getting
them somewhere else — another disk, another building, another country — is
deliberately yours, done with whatever you already trust: rsync, restic, rclone,
Syncthing, pointed at that directory.

That split is honest rather than lazy. A backup on the same disk as the database
protects you from a bad migration and from nothing else.

## Before you change anything

Two things make a backup restorable, and neither is on this screen.

**Carry the master key.** Secrets, API keys, mail credentials and PDF passwords
are all sealed with `MANTLE_MASTER_KEY`. Restore a dump onto a machine without
the same key and the data is intact and permanently unreadable. Store the key
somewhere other than the backup directory, or you have encrypted the backup with
a key that lives inside it.

**Files are not in the dump.** This backs up Postgres. Uploaded files, table
workbooks and app databases live on disk and need their own copy.

Run one manually before any upgrade you're unsure about. It's the cheapest
insurance in the system.

## Technical

Dumps are taken with `pg_dump` in its custom format, which is compressed and
restorable selectively — you can pull back one table rather than the whole
brain. The schedule is hosted by a background worker, so it runs whether or not
anyone has the app open.

Rotation keeps a fixed number of dumps and deletes the oldest. That means the
window you can recover to is your interval times your retention count, and it's
worth doing that arithmetic against how long a problem might plausibly go
unnoticed. Nightly with seven kept is a week; nightly with two kept is not much.

Restoring is a command-line operation against the dump, deliberately not a
button here. A one-click restore of a whole brain is a one-click way to lose
everything since the dump, and the moment you need it is the moment you should
be reading carefully rather than clicking.
