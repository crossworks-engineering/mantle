#!/usr/bin/env bash
# runs-on: mac. A dev or operator machine, the Mac included: keep it bash 3.2 and BSD-tool safe.
#
# demo/ must NEVER reach main. Sourced, not run: one check shared by the
# pre-push hook (scripts/git-hooks/pre-push, against each SHA pushed to main)
# and scripts/tag-release.sh (against the release SHA, before its verify). The release
# push skips the hook (--no-verify, see tag-release.sh), so without this
# shared copy the release path would carry no demo guard at all.
#
# The `demo` branch is main plus a demo/ directory, and the merge is ONE-WAY:
# main into demo, never the reverse. A demo-into-main merge would drag the
# whole seeded-demo apparatus into the product tree, and the tell is simple:
# main must not contain a demo/ directory at all.
#
#   demo_guard <sha> <who>
#     Returns 0 when <sha>'s tree has no demo/. Otherwise prints why to
#     stderr, prefixed with <who> (the caller's name), and returns 1.
#     Fails closed: a <sha> git cannot resolve to a tree is refused too,
#     since an empty ls-tree from a bad SHA would otherwise read as "no demo/".

demo_guard() {
  local sha=$1 who=$2
  if ! git cat-file -e "$sha^{tree}" 2>/dev/null; then
    echo "✘ $who: REFUSING: cannot read a tree for $sha, so cannot prove it has no demo/" >&2
    return 1
  fi
  if [ -z "$(git ls-tree -r --name-only "$sha" -- demo 2>/dev/null | head -1)" ]; then
    return 0
  fi
  {
    echo
    echo "✘ $who: REFUSING: $(git rev-parse --short "$sha") is bound for main and contains demo/"
    echo
    echo "  The demo branch merges ONE WAY: main into demo, never demo into main."
    echo "  This would put the demo's seed scripts, generator and world fixtures"
    echo "  into the product tree."
    echo
    echo "  Most likely you merged demo into main by mistake. Undo it:"
    echo "      git reset --hard origin/main"
    echo "  and take main into demo instead, from the demo branch:"
    echo "      git merge --no-ff main"
    echo
  } >&2
  return 1
}
