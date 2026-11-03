---
title: Sandboxes
toolGroups: [sandboxes]
---

## Sandboxes

Sandboxes are Linux containers where agents run commands, convert files, test
code and build apps, away from the brain's own host. A sandbox keeps its files
between commands, so a job can install something and then use it.

The left side lists your sandboxes. Select one to see its **Image**, its
**Network** (full egress, meaning it can reach the internet, or offline), when
it was **Created** and **Last used**, and the recent commands run in it, with
their output.

- **Stop** stops a running sandbox.
- **Remove** deletes the container. Its `/files` work directory is kept unless
  you also tick the box to delete it, which cannot be undone.

If the screen says sandboxes are switched off, turn them on in
[Services](services.md).

## Assistant

- "Convert these files to CSV in a sandbox."
- "What did you run in the sandbox?"
- "Stop the sandboxes you are not using."

By default only the coder agent holds the sandbox tools. Shell access widens
what a mistake can cost, so grant them to other agents with care.

## Technical

Each sandbox is a container with no route to your data, and it holds no
database password or master key. A brain allows three sandboxes by default
(`SANDBOX_MAX_COUNT`). A sandbox idle for an hour is stopped
(`SANDBOX_IDLE_STOP_MINUTES`); its files and installed packages survive, and
the next command starts it again.

The sandbox image (`24.04-v4`) carries every language, each with a short kit
of libraries and tools:

- Node 26 with npm and pnpm, and Bun.
- Python 3.12, with a shared virtual environment first on the path.
- Go, with gofmt, go vet and staticcheck.
- Rust, with rustfmt and clippy, and the tools to build WebAssembly.
- SQLite in every language, plus the `sqlite3` and `duckdb` command lines.
- git, ripgrep, jq, the Docker command line (no Docker engine) and Claude Code.

A first build needs no download. The full list, with versions, is in
`/etc/mantle/sandbox-kit.json` inside the sandbox. The image is several GB. The
box pulls it after an update or for the first sandbox, and only with 10 GB of
disk free. The
command history comes from the traces of `sandbox_exec` calls, so it outlives
the container.

Agent tools include `sandbox_create`, `sandbox_exec`, `sandbox_list`,
`sandbox_stop`, `sandbox_rm`, `sandbox_export`, `sandbox_import`,
`sandbox_ls`, `sandbox_autostart`, `sandbox_publish`, `sandbox_mcp_tools` and
`sandbox_mcp_call`. More detail: [Install options](../01-install/07-options.md).
