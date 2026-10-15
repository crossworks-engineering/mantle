#!/usr/bin/env bash
# runs-on: mac. A dev or operator machine, the Mac included: keep it bash 3.2 and BSD-tool safe.
#
# Behavioural tests for scripts/tag-release.sh, on a throwaway clone whose
# origin is a local bare repo, with a stubbed pnpm (no verify run). Nothing
# here talks to GitHub. Run by hand:
#
#   bash scripts/test-tag-release.sh
#
# The finding behind it (2026-10-15): v0.300.50, .56 and .58 were tagged
# locally and never reached origin, and the script did not say so. It now
# verifies before tagging, pushes main + tag atomically without the pre-push
# hook, and asks origin (git ls-remote) whether both landed at HEAD.
set -uo pipefail
# Drop every GIT_* variable first. Run from a git hook (pre-push runs pnpm
# verify, which runs this), git exports GIT_DIR and friends for the REAL repo,
# and any git command in here would then write to it, not to a temp repo.
while IFS= read -r gv; do unset "$gv"; done < <(env | sed -n 's/^\(GIT_[A-Za-z0-9_]*\)=.*/\1/p')
if env | grep -q '^GIT_'; then
  echo "refusing to run: a GIT_* variable is still set, and git here would act on the real repo" >&2
  exit 1
fi
SCRIPT="$(cd "$(dirname "$0")" && pwd)/tag-release.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fails=0

# pnpm stub: logs its args; `pnpm verify` exits $PNPM_VERIFY_RC (default 0).
mkdir -p "$tmp/bin"
cat >"$tmp/bin/pnpm" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$PNPM_LOG"
[ "${1:-}" = verify ] && exit "${PNPM_VERIFY_RC:-0}"
exit 0
STUB
chmod +x "$tmp/bin/pnpm"
export PATH="$tmp/bin:$PATH" PNPM_LOG="$tmp/pnpm.log" TAG_RELEASE_RECHECK_SECONDS=0
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid
export GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid

# fresh <version>: a bare origin and a clone on main whose HEAD is the
# release commit for <version>, pushed except for that release commit.
fresh() {
  local v=$1
  rm -rf "$tmp/origin.git" "$tmp/repo" "$PNPM_LOG"
  git init -q --bare "$tmp/origin.git"
  git init -q -b main "$tmp/repo"
  cd "$tmp/repo" || exit 1
  mkdir -p server/web
  printf '{ "version": "0.0.1" }\n' >package.json
  printf '{ "version": "0.0.1" }\n' >server/web/package.json
  git add -A
  git commit -q -m init
  git remote add origin "$tmp/origin.git"
  git push -q -u origin main 2>/dev/null
  printf '{ "version": "%s" }\n' "$v" >package.json
  printf '{ "version": "%s" }\n' "$v" >server/web/package.json
  git commit -q -am "release: v$v"
}

remote_ref() { git --git-dir="$tmp/origin.git" rev-parse -q --verify "$1" 2>/dev/null || echo missing; }

# expect <name> <want rc: 0|nonzero> <want origin main: head|old> <want origin tag: head|missing>
#        <want local tag: head|missing> <output must match> -- <script args...>
expect() {
  local name=$1 want_rc=$2 want_main=$3 want_tag=$4 want_local=$5 want_out=$6
  shift 7
  local before head out rc
  before="$(git rev-parse HEAD~1)"
  head="$(git rev-parse HEAD)"
  out="$("$BASH" "$SCRIPT" ${@+"$@"} 2>&1)"
  rc=$?
  local got_main got_tag got_local why=""
  got_main="$(remote_ref refs/heads/main)"
  got_tag="$(remote_ref "refs/tags/$TAG")"
  got_local="$(git rev-parse -q --verify "refs/tags/$TAG" 2>/dev/null || echo missing)"
  case "$want_rc" in
    0) [ "$rc" = 0 ] || why="$why rc=$rc want 0;" ;;
    nonzero) [ "$rc" != 0 ] || why="$why rc=0 want non-zero;" ;;
  esac
  local m=$head
  [ "$want_main" = old ] && m=$before
  [ "$got_main" = "$m" ] || why="$why origin main=$got_main want $want_main;"
  local t=$head
  [ "$want_tag" = missing ] && t=missing
  [ "$got_tag" = "$t" ] || why="$why origin tag=$got_tag want $want_tag;"
  local l=$head
  [ "$want_local" = missing ] && l=missing
  [ "$got_local" = "$l" ] || why="$why local tag=$got_local want $want_local;"
  printf '%s\n' "$out" | grep -q -- "$want_out" || why="$why output lacks [$want_out];"
  if [ -z "$why" ]; then
    echo "ok   $name"
  else
    echo "FAIL $name:$why"
    printf '%s\n' "$out" | sed 's/^/     /'
    fails=$((fails + 1))
  fi
}

TAG=v1.2.3

fresh 1.2.3
expect "tags, pushes main + tag, and origin confirms both" 0 head head head \
  "origin confirms both" --
grep -qx verify "$PNPM_LOG" || {
  echo "FAIL the happy path did not run pnpm verify"
  fails=$((fails + 1))
}

fresh 1.2.3
export PNPM_VERIFY_RC=1
expect "a failed verify leaves no tag and pushes nothing" nonzero old missing missing \
  "NOT tagged, NOT pushed" --
unset PNPM_VERIFY_RC

fresh 1.2.3
export PNPM_VERIFY_RC=1
expect "--no-verify skips pnpm verify" 0 head head head "skipping pnpm verify" -- --no-verify
unset PNPM_VERIFY_RC

fresh 1.2.3
mkdir -p "$tmp/hooks"
printf '#!/bin/sh\necho "pre-push hook ran" >&2\nexit 1\n' >"$tmp/hooks/pre-push"
chmod +x "$tmp/hooks/pre-push"
git config core.hooksPath "$tmp/hooks"
expect "the push skips the pre-push hook (verify already ran)" 0 head head head \
  "origin confirms both" --
git config --unset core.hooksPath

# origin refuses the push: git push fails loudly, the script must too.
fresh 1.2.3
printf '#!/bin/sh\nexit 1\n' >"$tmp/origin.git/hooks/pre-receive"
chmod +x "$tmp/origin.git/hooks/pre-receive"
expect "a refused push exits non-zero and names the missing refs" nonzero old missing head \
  "NOT RELEASED" --

# origin accepts the push but the tag does not stay: git push exits 0. Only
# the ls-remote check can catch this one.
fresh 1.2.3
printf '#!/bin/sh\ngit update-ref -d refs/tags/%s\n' "$TAG" >"$tmp/origin.git/hooks/post-receive"
chmod +x "$tmp/origin.git/hooks/post-receive"
expect "a push that exits 0 without landing the tag is caught" nonzero head missing head \
  "origin $TAG: missing" --

# and a rerun resumes it: the tag exists at HEAD, it is pushed, no 2nd verify.
rm -f "$tmp/origin.git/hooks/post-receive" "$PNPM_LOG"
expect "a rerun resumes the push of a tag already at HEAD" 0 head head head "resuming" --
[ ! -f "$PNPM_LOG" ] || {
  echo "FAIL the resumed push ran pnpm verify again"
  fails=$((fails + 1))
}

# atomic: origin refuses main only, so the tag must not land on its own.
fresh 1.2.3
cat >"$tmp/origin.git/hooks/update" <<'HOOK'
#!/bin/sh
[ "$1" = refs/heads/main ] && exit 1
exit 0
HOOK
chmod +x "$tmp/origin.git/hooks/update"
expect "a refused main does not let the tag land alone" nonzero old missing head "NOT RELEASED" --

fresh 1.2.3
git tag "$TAG" HEAD~1
expect_mispointed() {
  local out rc
  out="$("$BASH" "$SCRIPT" 2>&1)"
  rc=$?
  if [ "$rc" != 0 ] && printf '%s\n' "$out" | grep -q "already exists" &&
    [ "$(remote_ref "refs/tags/$TAG")" = missing ]; then
    echo "ok   a tag on another commit is still refused"
  else
    echo "FAIL a tag on another commit is still refused: rc=$rc"
    printf '%s\n' "$out" | sed 's/^/     /'
    fails=$((fails + 1))
  fi
}
expect_mispointed

fresh 1.2.3
expect "--no-push tags and prints the push, origin untouched" 0 old missing head \
  "push withheld" -- --no-push

printf '(bash %s)\n' "$BASH_VERSION"
[ "$fails" = 0 ] && echo "all passed" || {
  echo "$fails failed"
  exit 1
}
