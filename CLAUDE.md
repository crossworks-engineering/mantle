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
  (`PORT=3100 pnpm -C apps/web dev`).

## Other guidance

- UI conventions: [apps/web/CLAUDE.md](apps/web/CLAUDE.md).
- What a brain ships with (agents/skills/tool-groups/workers/persona): the system
  manifest is the single source of truth — see
  [apps/web/lib/system-manifest/CLAUDE.md](apps/web/lib/system-manifest/CLAUDE.md).
