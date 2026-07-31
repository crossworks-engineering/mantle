# Mantle — repo guidance

## Worktrees are the default for parallel work

If more than one session touches this repo at once — a second Claude session, or
a session running alongside your editor — they must **not** share the original
checkout. Sharing one working directory has caused real failures here: a session
switched the branch out from under another, uncommitted edits intermingled, and a
shared `node_modules`/lockfile broke imports (a package showed up "not found"
after a revert that never re-installed). Give each parallel session its own git
worktree — separate working dir, branch, index, and `node_modules` — and none of
that class of bug can happen.

**Spin one up (one command):**

```sh
scripts/new-worktree.sh <name> [base]      # base defaults to main
cd .claude/worktrees/<name>
```

It forks a branch (`feat/<name>`), `pnpm install`s (hardlinked from the shared
store, so ~seconds), and copies `.env.local`. Tear down with
`scripts/rm-worktree.sh <name>`.

**Rules of the road**

- The **original clone is the integrator** — keep it on `main` and use it for
  merges/releases. Don't develop features directly in it while other sessions
  run; do feature work in a worktree.
- `main` (or any branch) can be checked out in **only one** worktree at a time.
  Merge a feature branch from the integrator. To merge from a worktree instead,
  `git checkout main` only where it's currently free, merge `--no-ff`, then
  switch back so `main` is free again.
- **Refs are shared** across worktrees — branches, tags, and the **stash stack**.
  Use unique branch names; don't run a bare `git stash` while others are active
  (scope it: `git stash push -- <paths>`).
- Each worktree has its own `.next`, so concurrent `next build`s are safe (the
  "one build at a time" hazard only applies inside a *shared* checkout).
- Run the dev server on a non-default port when another session holds `:3000`
  (`PORT=3100 pnpm -C server/web dev`).

## Commits: no agent co-authorship

This repo is **public**, and the commits are Jason's work. Never add a
`Co-Authored-By: Claude …` trailer or a `🤖 Generated with [Claude Code]` line
to a commit message — GitHub renders them as a real co-author on the commit and
in the contributors graph, which misrepresents authorship. This holds for every
session, every model, every worktree.

A `commit-msg` hook strips them mechanically, but only once the clone opts in:

```sh
git config core.hooksPath scripts/git-hooks   # once per clone/worktree
```

That same setting enables the `pre-push` gate, which runs `pnpm verify` before
a push (bypass with `--no-verify`). Write commit messages without the trailers
anyway — the hook is the backstop, not the rule.

History before 2026-07-25 still carries ~1695 of these. Left deliberately:
scrubbing them means rewriting every SHA and re-pointing 115 release tags,
which would re-fire the tag-triggered image builds.

## The `demo` branch merges ONE WAY

`demo` is main plus a `demo/` directory (generator, seed scripts, world
fixtures, the read-only edge). Take main into demo as often as you like:

```sh
git checkout demo && git merge --no-ff main
```

**Never the reverse.** Merging demo into main would drag the whole seeded-demo
apparatus into the product tree. That used to be a line in a handover; it is now
mechanical — `pre-push` refuses to push `main` if its tree contains `demo/`,
checked before `pnpm verify` so it fails in a second rather than after a full
test run. If you hit it, you almost certainly merged the wrong direction:
`git reset --hard origin/main` and merge main into demo instead.

## Other guidance

- **Frontend-only dev (no local Docker/DB): `pnpm dev:fe`** — runs the owner UI
  (`client/web`) detached against a deployed brain (the test box). Setup + troubleshooting:
  [docs/db-less-dev.md](docs/db-less-dev.md). Plain `pnpm dev` expects a full
  local stack and will 500 without one.
- UI conventions: [server/web/CLAUDE.md](server/web/CLAUDE.md).
- What a brain ships with (agents/skills/tool-groups/workers/persona): the system
  manifest is the single source of truth — see
  [server/web/lib/system-manifest/CLAUDE.md](server/web/lib/system-manifest/CLAUDE.md).
