#!/usr/bin/env bash
#
# Behavioural tests for scripts/rm-worktree.sh's viewer-login cleanup, on a
# throwaway git repo with a stubbed pnpm (no database). Run by hand:
#
#   bash scripts/test-rm-worktree.sh
#
# The finding behind it (re-audit 2026-10-09): new-worktree.sh copies the
# integrator's .env.local, so a worktree points at the LIVE brain's database.
# Removing it must never drop that brain's per-database logins: the drop runs
# only on request (--drop-viewer-logins), and only for a database that is not
# the integrator's.
set -uo pipefail
SCRIPT="$(cd "$(dirname "$0")" && pwd)/rm-worktree.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fails=0

mkdir -p "$tmp/bin"
cat >"$tmp/bin/pnpm" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$PNPM_LOG"
STUB
chmod +x "$tmp/bin/pnpm"
export PATH="$tmp/bin:$PATH" PNPM_LOG="$tmp/pnpm.log"

git init -q "$tmp/repo"
cd "$tmp/repo" || exit 1
printf '.claude/\nserver/web/.env.local\n' >.gitignore
git add .gitignore
git -c user.email=t@example.invalid -c user.name=t commit -q -m init
mkdir -p server/web

# case <name> <integrator db|-> <worktree db> <per-db flag> <args...> -- <expect: drop db|none>
check() {
  local name=$1 main_db=$2 wt_db=$3 flag=$4
  shift 4
  local args=()
  while [ "$1" != "--" ]; do
    args+=("$1")
    shift
  done
  local expect=$2
  rm -f "$PNPM_LOG" server/web/.env.local
  [ "$main_db" = - ] ||
    printf 'DATABASE_URL=postgres://u:p@h:5432/%s\nMANTLE_VIEWER_ROLES_PER_DATABASE=1\n' "$main_db" >server/web/.env.local
  git worktree add -q --detach ".claude/worktrees/t" 2>/dev/null
  mkdir -p .claude/worktrees/t/server/web
  {
    printf 'DATABASE_URL="postgres://u:p@h:5432/%s?sslmode=disable"\n' "$wt_db"
    [ "$flag" = 1 ] && printf 'MANTLE_VIEWER_ROLES_PER_DATABASE=1\n'
  } >.claude/worktrees/t/server/web/.env.local
  local out
  out="$(bash "$SCRIPT" t "${args[@]}" 2>&1)"
  local got=none
  [ -f "$PNPM_LOG" ] && got="$(cat "$PNPM_LOG")"
  local want=none
  [ "$expect" = none ] || want="-C .claude/worktrees/t/packages/db -s drop-viewer-logins $expect"
  if [ "$got" = "$want" ] && [ ! -d .claude/worktrees/t ]; then
    echo "ok   $name"
  else
    echo "FAIL $name: pnpm=[$got] want=[$want]"
    echo "$out" | sed 's/^/     /'
    fails=$((fails + 1))
    git worktree remove --force .claude/worktrees/t 2>/dev/null
  fi
}

check "the live brain's database is never dropped" mantle mantle 1 -f --drop-viewer-logins -- none
check "no drop without --drop-viewer-logins" mantle tw_a 1 -f -- none
check "a throwaway database is dropped on request" mantle tw_a 1 -f --drop-viewer-logins -- tw_a
check "no drop when the integrator's env is unreadable" - tw_a 1 -f --drop-viewer-logins -- none
check "no drop when the worktree is not per-database" mantle tw_a 0 -f --drop-viewer-logins -- none
check "a plain worktree (no env flag) is removed as before" mantle mantle 0 -- none

[ "$fails" = 0 ] && echo "all passed" || {
  echo "$fails failed"
  exit 1
}
