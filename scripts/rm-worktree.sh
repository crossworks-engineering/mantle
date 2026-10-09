#!/usr/bin/env bash
set -euo pipefail
#
# rm-worktree.sh: remove a worktree created by new-worktree.sh. Keeps the
# branch (delete that separately once it's merged). Refuses if the worktree has
# uncommitted changes unless you pass -f.
#
# Usage:
#   scripts/rm-worktree.sh <slug> [-f] [--drop-viewer-logins]
#
# --drop-viewer-logins: the worktree ran a throwaway brain on a shared Postgres
# (MANTLE_VIEWER_ROLES_PER_DATABASE=1) whose mantle_view_<level>_<database>
# logins are cluster objects: drop them too. Only ever on request, and never
# when the worktree's database is the integrator's: new-worktree.sh copies the
# integrator's .env.local, so by default a worktree points at the LIVE brain's
# database, and dropping its logins would break that brain's member pages.
#
slug="${1:-}"
if [ -z "$slug" ]; then
  echo "usage: scripts/rm-worktree.sh <slug> [-f] [--drop-viewer-logins]" >&2
  exit 1
fi
shift
force=0
drop_logins=0
for arg in "$@"; do
  case "$arg" in
    -f) force=1 ;;
    --drop-viewer-logins) drop_logins=1 ;;
    *)
      echo "unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

# Resolve the original clone (worktrees live under it), not the current worktree.
common="$(git rev-parse --git-common-dir)"
case "$common" in /*) ;; *) common="$(pwd)/$common" ;; esac
repo="$(cd "$(dirname "$common")" && pwd)"
cd "$repo"
dir=".claude/worktrees/$slug"

# The last KEY=value in an env file, quotes removed; empty when absent (no
# match must not end the script: set -e with pipefail).
env_value() {
  [ -f "$1" ] || return 0
  { grep -E "^[[:space:]]*$2=" "$1" || true; } | tail -1 |
    sed -E "s/^[[:space:]]*$2=//; s/^[\"']//; s/[\"'][[:space:]]*$//"
}
# The database name in a postgres URL: the path, without its query.
db_of() {
  local d="${1##*/}"
  printf '%s' "${d%%\?*}"
}

wt_env="$dir/server/web/.env.local"
per_db="$(env_value "$wt_env" MANTLE_VIEWER_ROLES_PER_DATABASE | tr 'A-Z' 'a-z')"
case "$per_db" in 1 | true | yes | on) per_db=1 ;; *) per_db=0 ;; esac

if [ "$per_db" = 1 ] && [ "$drop_logins" = 0 ]; then
  echo "  This worktree runs with MANTLE_VIEWER_ROLES_PER_DATABASE=1. If its database was a"
  echo "  throwaway brain, drop its logins: re-run with --drop-viewer-logins."
fi

if [ "$drop_logins" = 1 ]; then
  wt_db="$(db_of "$(env_value "$wt_env" DATABASE_URL)")"
  main_url="$(env_value server/web/.env.local DATABASE_URL)"
  main_db="$(db_of "$main_url")"
  if [ "$per_db" != 1 ]; then
    echo "✗ not dropping viewer logins: $wt_env does not set MANTLE_VIEWER_ROLES_PER_DATABASE=1" >&2
  elif [ -z "$wt_db" ]; then
    echo "✗ not dropping viewer logins: no DATABASE_URL in $wt_env" >&2
  elif [ -z "$main_url" ]; then
    echo "✗ not dropping viewer logins: cannot read the integrator's DATABASE_URL to rule out the live brain" >&2
  elif [ "$wt_db" = "$main_db" ]; then
    echo "✗ not dropping viewer logins: \"$wt_db\" is the integrator's own database (the live brain)" >&2
  elif [ "$force" = 0 ] && [ -n "$(git -C "$dir" status --porcelain)" ]; then
    : # git refuses the removal below; leave the logins until it goes
  else
    echo "→ dropping the per-database viewer logins of \"$wt_db\""
    if ! pnpm -C "$dir/packages/db" -s drop-viewer-logins "$wt_db"; then
      echo "⚠ could not drop them. Later: pnpm -C packages/db drop-viewer-logins $wt_db" >&2
      echo "  (or any migrate on that cluster drops them once the database is gone)" >&2
    fi
    echo "  The database \"$wt_db\" is still on the cluster: drop it when you are done with it."
  fi
fi

if [ "$force" = 1 ]; then
  git worktree remove --force "$dir"
else
  git worktree remove "$dir"
fi
echo "✓ removed $dir (branch kept: delete with git branch -d <branch> once merged)"
