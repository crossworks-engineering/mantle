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

# pnpm stub: logs its args; `pnpm verify` runs $PNPM_VERIFY_SIDE (a shell
# snippet, in the clone, standing in for another session) if set, then exits
# $PNPM_VERIFY_RC (default 0).
mkdir -p "$tmp/bin"
cat >"$tmp/bin/pnpm" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$PNPM_LOG"
if [ "${1:-}" = verify ]; then
  [ -n "${PNPM_VERIFY_SIDE:-}" ] && sh -c "$PNPM_VERIFY_SIDE"
  exit "${PNPM_VERIFY_RC:-0}"
fi
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

# expect <name> <want rc: 0|nonzero> <want origin main: head|old|other>
#        <want origin tag: head|missing|obj> <want local tag: head|missing|obj>
#        <output must match> -- <script args...>
# old is HEAD~1; other is neither HEAD nor HEAD~1 (origin moved on); obj is the
# local tag's own object id (an annotated tag's, not its commit's).
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
  case "$want_main" in
    other)
      { [ "$got_main" != "$head" ] && [ "$got_main" != "$before" ] && [ "$got_main" != missing ]; } ||
        why="$why origin main=$got_main want other;"
      ;;
    *)
      local m=$head
      [ "$want_main" = old ] && m=$before
      [ "$got_main" = "$m" ] || why="$why origin main=$got_main want $want_main;"
      ;;
  esac
  local obj
  obj="$(git rev-parse -q --verify "refs/tags/$TAG" 2>/dev/null || echo none)"
  local t=$head
  [ "$want_tag" = missing ] && t=missing
  [ "$want_tag" = obj ] && t=$obj
  [ "$got_tag" = "$t" ] || why="$why origin tag=$got_tag want $want_tag;"
  local l=$head
  [ "$want_local" = missing ] && l=missing
  [ "$want_local" = obj ] && l=$obj
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

# H1: the release push skips the pre-push hook, so the demo/ guard the hook
# runs must run here too, before the verify (scripts/lib/demo-guard.sh).
fresh 1.2.3
mkdir -p demo
echo seed >demo/seed.sh
git add demo
git commit -q --amend --no-edit
expect "a release commit carrying demo/ is refused before verify, nothing tagged or pushed" \
  nonzero old missing missing "contains demo/" --
[ ! -f "$PNPM_LOG" ] || {
  echo "FAIL the demo/ refusal ran pnpm verify first"
  fails=$((fails + 1))
}

# L1: an annotated tag made by hand at HEAD resumes, and origin's answer (the
# tag object's id, not the commit's) is judged as landed, not NOT RELEASED.
fresh 1.2.3
git tag -a -m "by hand" "$TAG"
expect "an annotated tag at HEAD resumes and is confirmed by its own object id" 0 head obj obj \
  "origin confirms both" --

# L2: origin cannot be asked. The push lands; ls-remote fails. That is not
# "missing": the state is unknown, and ls-remote's own stderr is shown.
fresh 1.2.3
mkdir -p "$tmp/lsfail"
real_git="$(command -v git)"
cat >"$tmp/lsfail/git" <<STUB
#!/bin/sh
if [ "\$1" = ls-remote ]; then
  echo "fatal: stub: origin unreachable for ls-remote" >&2
  exit 128
fi
exec "$real_git" "\$@"
STUB
chmod +x "$tmp/lsfail/git"
saved_path=$PATH
PATH="$tmp/lsfail:$PATH"
expect "a failed ls-remote says the state is unknown, with its stderr" nonzero head head head \
  "state unknown" --
PATH=$saved_path
out="$(PATH="$tmp/lsfail:$PATH" "$BASH" "$SCRIPT" 2>&1)"
if printf '%s\n' "$out" | grep -q "stub: origin unreachable for ls-remote" &&
  ! printf '%s\n' "$out" | grep -q "missing"; then
  echo "ok   the unknown state shows ls-remote's stderr and never says missing"
else
  echo "FAIL the unknown state shows ls-remote's stderr and never says missing"
  printf '%s\n' "$out" | sed 's/^/     /'
  fails=$((fails + 1))
fi

# L3: origin's main moved on between our fetch and our push (stood in for by
# no upstream, so the script's own fetch check is skipped, and a commit pushed
# to origin from another clone). The atomic push is refused non-fast-forward;
# the text must say to delete the local tag, by its exact command.
fresh 1.2.3
git branch -q --unset-upstream
git clone -q -b main "$tmp/origin.git" "$tmp/other" 2>/dev/null
(cd "$tmp/other" && echo x >other && git add other && git commit -q -m other && git push -q origin main 2>/dev/null)
rm -rf "$tmp/other"
expect "a non-fast-forward refusal says to delete the local tag" nonzero other missing head \
  "git tag -d $TAG" --

# H (re-audit 2): another session lands a commit on main WHILE verify runs,
# and that commit carries demo/. Tagging HEAD and pushing `main` by name would
# release it unverified and unguarded. The script must refuse: no local tag,
# and origin gets nothing (its main stays at the commit before the release).
fresh 1.2.3
export PNPM_VERIFY_SIDE='mkdir -p demo && echo seed >demo/seed.sh && git add demo && git commit -q -m "landed during verify"'
expect "a commit landed on main during verify (with demo/) is neither tagged nor pushed" \
  nonzero old missing missing "HEAD moved during the verify" --
unset PNPM_VERIFY_SIDE
if [ "$(git log -1 --pretty=%s)" = "landed during verify" ] &&
  [ "$(remote_ref refs/heads/main)" = "$(git rev-parse HEAD~2)" ] &&
  [ -z "$(git --git-dir="$tmp/origin.git" for-each-ref refs/tags)" ]; then
  echo "ok   origin holds neither the release commit, the landed commit, nor any tag"
else
  echo "FAIL origin holds neither the release commit, the landed commit, nor any tag"
  git --git-dir="$tmp/origin.git" for-each-ref | sed 's/^/     /'
  fails=$((fails + 1))
fi

# L2 (re-audit 2): the demo/ guard fails closed. A SHA git cannot read a tree
# for would give an empty ls-tree, which used to read as "no demo/".
fresh 1.2.3
# shellcheck source=lib/demo-guard.sh
. "$(dirname "$SCRIPT")/lib/demo-guard.sh"
bad_out="$(demo_guard 0123456789abcdef0123456789abcdef01234567 test 2>&1)"
bad_rc=$?
good_rc=0
demo_guard HEAD test 2>/dev/null || good_rc=$?
if [ "$bad_rc" != 0 ] && printf '%s\n' "$bad_out" | grep -q "cannot read a tree" && [ "$good_rc" = 0 ]; then
  echo "ok   the demo/ guard refuses a SHA it cannot read, and passes a clean one"
else
  echo "FAIL the demo/ guard refuses a SHA it cannot read, and passes a clean one: bad rc=$bad_rc good rc=$good_rc"
  printf '%s\n' "$bad_out" | sed 's/^/     /'
  fails=$((fails + 1))
fi

# L (scripts-lows): the tag is made by someone else WHILE verify runs. git
# tag would die with its bare "fatal: tag already exists"; the script must
# give its own refusal with a next step, tag nothing, and push nothing.
fresh 1.2.3
export PNPM_VERIFY_SIDE="git tag $TAG HEAD~1"
expect "a tag made on another commit during verify is refused with a next step" \
  nonzero old missing obj "It was made while the verify ran" --
unset PNPM_VERIFY_SIDE
fresh 1.2.3
out="$(PNPM_VERIFY_SIDE="git tag $TAG HEAD~1" "$BASH" "$SCRIPT" 2>&1)"
if printf '%s\n' "$out" | grep -q "already exists (at" && ! printf '%s\n' "$out" | grep -q "fatal:"; then
  echo "ok   the mid-verify tag gets the script's own message, not git's fatal"
else
  echo "FAIL the mid-verify tag gets the script's own message, not git's fatal"
  printf '%s\n' "$out" | sed 's/^/     /'
  fails=$((fails + 1))
fi

# ...and one made at HEAD by another run is refused too, then a rerun
# resumes its push with no second verify.
fresh 1.2.3
export PNPM_VERIFY_SIDE="git tag $TAG HEAD"
expect "a tag made at HEAD during verify is refused, nothing pushed" \
  nonzero old missing head "rerun this to" --
unset PNPM_VERIFY_SIDE
rm -f "$PNPM_LOG"
expect "a rerun then resumes the push of that tag" 0 head head head "resuming" --
[ ! -f "$PNPM_LOG" ] || {
  echo "FAIL the resume after a mid-verify tag ran pnpm verify again"
  fails=$((fails + 1))
}

printf '(bash %s)\n' "$BASH_VERSION"
[ "$fails" = 0 ] && echo "all passed" || {
  echo "$fails failed"
  exit 1
}
