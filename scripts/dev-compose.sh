#!/usr/bin/env bash
# Run docker compose for the DEV stack, always from the original clone.
#
# Why this exists: the dev stack's data lives in bind mounts resolved relative
# to compose's working directory — `${MANTLE_DATA_DIR:-./data}/postgres`. The
# compose project name is pinned (`name: mantle-dev`), so running from a git
# worktree does NOT get you a separate stack: you get THE SAME containers,
# pointed at a DIFFERENT data directory. Bring the stack up from a worktree and
# the database lives inside that worktree.
#
# On 2026-08-01 that cost a database. The stack had been started inside a
# worktree; `rm-worktree.sh` later deleted it, pulling the data directory out
# from under a running Postgres, which PANICked on a missing pg_control and
# could not restart (`error while creating mount source path … no such file or
# directory`). Nothing warned, because from compose's point of view every run
# was correct — it faithfully mounted `./data` of wherever it was invoked.
#
# So: resolve the ORIGINAL clone from the shared git dir (the same trick
# new-worktree.sh uses) and operate there. Worktrees are disposable; the clone
# is not, and the data belongs to the clone. An explicitly-set MANTLE_DATA_DIR
# still wins — this only fixes what the RELATIVE default resolves against.
#
# Usage: scripts/dev-compose.sh <compose args…>
#   scripts/dev-compose.sh up -d --wait
#   scripts/dev-compose.sh down
#
# Scope is deliberately dev-only. The prod compose reads MANTLE_DATA_DIR from a
# real .env on a real host with no worktrees, and rerouting a deploy's working
# directory is a bigger change than the problem warrants.

set -euo pipefail

common="$(git rev-parse --git-common-dir 2>/dev/null || true)"
if [ -z "$common" ]; then
  echo "dev-compose: not inside a git repository — run this from the Mantle tree." >&2
  exit 1
fi
case "$common" in /*) ;; *) common="$(pwd)/$common" ;; esac
repo="$(cd "$(dirname "$common")" && pwd)"

# Say so when the caller is somewhere else, so "my data isn't here" is never a
# mystery again.
if [ "$repo" != "$(pwd)" ]; then
  echo "→ dev stack operates from the original clone: $repo" >&2
fi

cd "$repo"
exec docker compose -f docker-compose.dev.yml "$@"
