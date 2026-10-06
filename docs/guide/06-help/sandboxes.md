---
title: Sandboxes
toolGroups: [sandboxes]
---

## Sandboxes

Sandboxes are Linux containers where agents run commands, convert files, test
code and build apps, away from the brain's own host. A sandbox keeps its files
between commands, so a job can install something and then use it.

The left side lists your sandboxes. Select one to see its details and the
recent commands run in it, with their output.

- **Stop** stops a running sandbox.
- **Remove** deletes the container. Its `/files` work directory is kept unless
  you also tick the box to delete it, which cannot be undone.

If the screen says sandboxes are switched off, turn them on in
[Services](services.md).

## Assistant

- "Convert these files to CSV in a sandbox."
- "What did you run in the sandbox?"
- "Stop the sandboxes you are not using."

By default only the coder agent holds the Sandboxes group. Shell access widens
what a mistake can cost, so grant it to other agents with care.

## Technical

Each sandbox is a container with no route to your data, and it holds no
database password or master key. A brain allows three sandboxes by default
(`SANDBOX_MAX_COUNT`). A sandbox idle for an hour is stopped
(`SANDBOX_IDLE_STOP_MINUTES`); its files and installed packages survive, and
the next command starts it again. The command history comes from the traces of
`sandbox_exec` calls, so it outlives the container.

Agent tools include `sandbox_create`, `sandbox_exec`, `sandbox_list`,
`sandbox_stop`, `sandbox_rm`, `sandbox_export`, `sandbox_import` and
`sandbox_ls`. More detail: [Install options](../01-install/05-options.md).
