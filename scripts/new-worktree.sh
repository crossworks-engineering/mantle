#!/usr/bin/env bash
set -euo pipefail
#
# new-worktree.sh — spin up a fully set-up, ISOLATED git worktree for a parallel
# session (a second Claude session, or a session running alongside your editor).
#
# Why: two sessions sharing the original checkout step on each other — one
# switches the branch out from under the other, uncommitted edits intermingle,
# and a shared node_modules/lockfile breaks imports. A worktree gives each
# session its own working dir + branch + index + node_modules, so none of that
# can happen. See CLAUDE.md → "Worktrees".
#
# Usage:
#   scripts/new-worktree.sh <name> [base-branch]
#     name         short slug. "remote-mcp" → branch feat/remote-mcp,
#                  dir .claude/worktrees/remote-mcp. Pass a "kind/slug" (e.g.
#                  "fix/login") to set the branch prefix yourself.
#     base-branch  what to fork from (default: main).
#
# Then:  cd .claude/worktrees/<slug>  and work there.
#
name="${1:-}"
base="${2:-main}"
if [ -z "$name" ]; then
  echo "usage: scripts/new-worktree.sh <name> [base-branch]" >&2
  exit 1
fi

# The original clone (NOT the current worktree) — worktrees live under its
# .claude/worktrees/. Derive it from the shared git dir so this works whether run
# from the main checkout or from inside another worktree.
common="$(git rev-parse --git-common-dir)"
case "$common" in /*) ;; *) common="$(pwd)/$common" ;; esac
repo="$(cd "$(dirname "$common")" && pwd)"
cd "$repo"

# Branch: take a given "kind/slug" as-is, else default to feat/<name>.
case "$name" in
  */*) branch="$name" ;;
  *)   branch="feat/$name" ;;
esac
slug="${name##*/}"
dir=".claude/worktrees/$slug"

if [ -e "$dir" ]; then
  echo "✗ $dir already exists — pick another name or remove it first" >&2
  exit 1
fi
if git show-ref --verify --quiet "refs/heads/$branch"; then
  echo "✗ branch $branch already exists" >&2
  exit 1
fi

echo "→ git worktree add $dir -b $branch $base"
git worktree add "$dir" -b "$branch" "$base"

# Copy gitignored local env so the dev server + db tooling work in the worktree.
copied=0
for env in apps/web/.env.local .env.local; do
  [ -f "$env" ] || continue
  mkdir -p "$dir/$(dirname "$env")"
  cp "$env" "$dir/$env"
  echo "→ copied $env"
  copied=1
done
[ "$copied" = 1 ] || echo "  (no .env.local to copy — set one up in the worktree if you need the dev server)"

echo "→ pnpm install (hardlinks from the shared store — usually seconds)"
( cd "$dir" && pnpm install >/dev/null )

cat <<EOF

✓ worktree ready
    cd $dir            # branch $branch, forked from $base
    PORT=3100 pnpm -C apps/web dev   # use a non-default port if :3000 is taken
    scripts/rm-worktree.sh $slug     # tear it down when done
EOF
