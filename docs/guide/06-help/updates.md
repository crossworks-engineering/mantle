---
title: Updates
---

## Updates

Checks whether a newer Mantle release exists and, if you ask it to, installs it.

The screen itself doesn't do the installing. It **detects**: comparing
published releases against the build you're running, and it **requests**. A
separate updater component pulls the new images and restarts the stack, then
reports back. That separation is why the app can update itself without needing
the ability to restart itself from inside.

An update replaces application code. Your database, files and configuration are
untouched.

## Before you change anything

Take a backup first. Not because updates routinely break things, but because
the cost of the habit is thirty seconds and the cost of skipping it once is
whatever you'd lose.

Expect a short outage. The stack stops and starts, so anything mid-flight,
a long assistant turn, an in-progress ingest, is interrupted. Background work
resumes; a conversation in a browser tab needs a reload.

Read the release notes when a version jumps more than a patch. Migrations run
automatically on start, and the ones worth knowing about are called out there
rather than here.

## Technical

Version detection compares the running build against published releases, so it
reflects what actually started, not what a configuration file claims. A stack
that failed to come up on a new image and is still serving the old one will say
so.

The request is passed to the updater over a shared signal volume rather than by
giving the app permission to drive the container runtime. The app can ask for an
update; it cannot execute arbitrary container operations, which keeps that
capability outside the process most exposed to the outside world.

Migrations run at startup, each in its own transaction, replaying from the first
to the newest. A failed migration stops the sequence with the earlier ones
committed, so a failure leaves a diagnosable state rather than a half-applied
one.

If an update leaves something behaving oddly, the Config screen is the next
stop: it shows whether the release's new defaults actually reached your brain.
