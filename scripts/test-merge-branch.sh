#!/usr/bin/env bash
# runs-on: mac. A dev or operator machine, the Mac included: keep it bash 3.2 and BSD-tool safe.
#
# Behavioural tests for scripts/merge-branch.sh's migration check, on a
# throwaway integrator repo with a stub version bump. Nothing here talks to
# a remote. Run by hand:
#
#   bash scripts/test-merge-branch.sh
#
# Migration numbers are claimed at merge time: the script prints the next
# free number and refuses a branch whose new migration has a number or a
# journal `when` at or below main's last (the runner skips a `when` it has
# seen, in silence). A refusal merges nothing and frees the lock.
set -uo pipefail
# Drop every GIT_* variable first. Run from a git hook (pre-push runs pnpm
# verify, which runs this), git exports GIT_DIR and friends for the REAL repo,
# and any git command in here would then write to it, not to a temp repo.
while IFS= read -r gv; do unset "$gv"; done < <(env | sed -n 's/^\(GIT_[A-Za-z0-9_]*\)=.*/\1/p')
if env | grep -q '^GIT_'; then
  echo "refusing to run: a GIT_* variable is still set, and git here would act on the real repo" >&2
  exit 1
fi
SCRIPT="$(cd "$(dirname "$0")" && pwd)/merge-branch.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fails=0
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid
export GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid

# journal <entry>...: a journal whose entries are "tag:when".
journal() {
  local first=1 e
  printf '{\n  "entries": [\n'
  for e in "$@"; do
    [ $first = 1 ] || printf ',\n'
    first=0
    printf '    { "idx": 0, "tag": "%s", "when": %s }' "${e%%:*}" "${e##*:}"
  done
  printf '\n  ]\n}\n'
}

# fresh: an integrator repo on main with migrations 0000 and 0001 (when 100
# and 200), and the files the version bump writes.
fresh() {
  rm -rf "$tmp/repo"
  git init -q -b main "$tmp/repo"
  cd "$tmp/repo" || exit 1
  mkdir -p server/web scripts packages/db/migrations/meta
  printf '{ "version": "0.0.1" }\n' >package.json
  printf '{ "version": "0.0.1" }\n' >server/web/package.json
  printf 'readme\n' >README.md
  cat >scripts/bump-version.mjs <<'STUB'
import fs from 'node:fs';
for (const f of ['package.json', 'server/web/package.json']) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const [a, b, c] = j.version.split('.').map(Number);
  j.version = `${a}.${b}.${c + 1}`;
  fs.writeFileSync(f, JSON.stringify(j) + '\n');
}
STUB
  touch packages/db/migrations/0000_a.sql packages/db/migrations/0001_b.sql
  journal 0000_a:100 0001_b:200 >packages/db/migrations/meta/_journal.json
  git add -A
  git commit -q -m init
}

# branch <name> <file tag or -> <journal entries...>: a branch off main that
# adds the migration file (unless -) and writes the journal.
branch() {
  local name=$1 tag=$2
  shift 2
  git checkout -q -b "$name" main
  [ "$tag" = - ] || touch "packages/db/migrations/$tag.sql"
  journal "$@" >packages/db/migrations/meta/_journal.json
  printf '%s\n' "$name" >"work-$name"
  git add -A
  git commit -q -m "$name"
  git checkout -q main
}

# expect <name> <want: merged|refused> <output must match> -- <branch>
expect() {
  local name=$1 want=$2 want_out=$3 br=$5 before out rc why=""
  before="$(git rev-parse main)"
  out="$("$BASH" "$SCRIPT" "$br" 2>&1)"
  rc=$?
  case "$want" in
    merged)
      [ "$rc" = 0 ] || why="$why rc=$rc want 0;"
      git merge-base --is-ancestor "$br" main || why="$why $br not on main;"
      ;;
    refused)
      [ "$rc" != 0 ] || why="$why rc=0 want non-zero;"
      [ "$(git rev-parse main)" = "$before" ] || why="$why main moved;"
      ;;
  esac
  [ ! -d "$(git rev-parse --git-common-dir)/mantle-merge-branch.lock" ] || why="$why lock left;"
  printf '%s\n' "$out" | grep -q -- "$want_out" || why="$why output lacks [$want_out];"
  if [ -z "$why" ]; then
    echo "ok   $name"
  else
    echo "FAIL $name:$why"
    printf '%s\n' "$out" | sed 's/^/     /'
    fails=$((fails + 1))
  fi
}

fresh
branch no-mig - 0000_a:100 0001_b:200
expect "a branch with no migration merges, and the next free number is printed" merged \
  "next free migration number: 0002 (its journal when above 200)" -- no-mig

fresh
branch good 0002_c 0000_a:100 0001_b:200 0002_c:300
expect "a migration above main's last number and when merges" merged "next free migration number: 0002" -- good

fresh
branch same-num 0001_c 0000_a:100 0001_b:200 0001_c:300
expect "a number at main's last is refused" refused "0001_c: number at or below main's last (0001)" -- same-num

fresh
branch same-when 0002_c 0000_a:100 0001_b:200 0002_c:200
expect "a when at main's last is refused (the runner would skip it)" refused \
  "0002_c: when 200 at or below main's last (200)" -- same-when

fresh
branch low-when 0002_c 0000_a:100 0001_b:200 0002_c:150
expect "a when below main's last is refused" refused "0002_c: when 150" -- low-when

# Main moved on: another lane claimed 0002 first. The branch's 0002 is now
# at main's last, and the message names 0003 as free.
fresh
branch late 0002_late 0000_a:100 0001_b:200 0002_late:300
branch first 0002_first 0000_a:100 0001_b:200 0002_first:310
"$BASH" "$SCRIPT" first >/dev/null 2>&1 || {
  echo "FAIL setup: the first lane did not merge"
  fails=$((fails + 1))
}
expect "a lane that lost the race is refused and told the next free number" refused \
  "next free migration number: 0003 (its journal when above 310)" -- late

fresh
branch unjournaled 0001_x 0000_a:100 0001_b:200
expect "a new file at main's last number is refused even outside the journal" refused \
  "0001_x.sql: number at or below main's last" -- unjournaled

if [ "$fails" = 0 ]; then
  echo "all passed"
else
  echo "$fails failed"
  exit 1
fi
