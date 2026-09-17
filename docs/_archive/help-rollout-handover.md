# Handover: finish per-screen help

> Working doc for the help rollout, not user-facing guide content, which is why
> it lives here and not in `docs/guide/06-help/`. That directory is the topic
> corpus: `help.test.ts` asserts every file in it is a reachable topic with the
> three-section shape, so a stray doc there fails the build.

## The ask

Every screen in Mantle should have a help column. **10 of 50 nav routes have one.**
Work through the remaining **40**, in waves, until none are left.

## What already exists (don't rebuild it)

Shipped in **v0.216.1** on `main`. Read these first:

| Piece | Path |
|---|---|
| Route → topic map | `jackdaw/packages/web-ui/src/layout/help-topics.ts` |
| Content loader + frontmatter parser | `server/web/lib/help.ts` |
| API | `server/web/app/api/help/[topic]/route.ts` |
| Footer launcher | `jackdaw/components/help/help-launcher.tsx` |
| The rail | `jackdaw/components/help/help-rail.tsx` |
| Rail body (lazy) | `jackdaw/components/help/help-rail-body.tsx` |
| Open/close state | `jackdaw/components/help/help-rail-context.tsx` |
| Drift test | `server/web/lib/help.test.ts` |
| Content | `docs/guide/06-help/*.md` |
| Style rule | `docs/ui-style-guide.md` §6 |

**Adding a topic is two edits**: write `docs/guide/06-help/<topic>.md`, add a
`['/route', 'topic']` line to `help-topics.ts`. Nothing else. The launcher,
the rail, the API and the brain indexing all pick it up automatically.

## The content contract

Frontmatter, then exactly three `##` sections, in this order:

```markdown
---
title: Tables
toolGroups: [tables-read, tables-rows]
---

## Tables
What the screen is FOR, in the operator's terms.

## Assistant
How to ask for it in plain language. 3–4 real phrasings.

## Technical
How it works underneath, how the AI reads it, what's stored where.
```

- `toolGroups` must be real slugs from `MANIFEST_TOOL_GROUPS`
  (`server/web/lib/system-manifest/manifest.ts`). The test fails on invented ones.
  Names and counts are resolved at request time, so never write a group's name
  into the prose; it would drift.
- The **Assistant** section is dropped automatically when no agent holds any
  declared group; a one-line "grant this to enable it" hint shows instead.
- Screens the assistant genuinely cannot touch (most of Settings, all of
  System/debug) should declare **no** `toolGroups` and use section 2 for
  something honest, e.g. "## When to use this" or "## Before you change
  anything", rather than pretending there's an assistant angle.
- Third section's heading must be literally `Technical` (the test asserts it).

## House style for the copy

Set by the 11 existing topics, read `tables.md`, `contacts.md` and `secrets.md`
before writing.

- **Lead with what surprises people**, not with what the screen obviously is.
  Contacts' real story is that it's the email gate in both directions. Secrets'
  is that the assistant can find a secret but never read it.
- Say the effect, not the value. Never "Default 3".
- Two-to-four short paragraphs per section. This is a 22rem column.
- Ground every technical claim in the repo or `docs/`. **Do not guess** how a
  subsystem works, read it. Several existing topics cite exact storage
  mechanics; that trust is the point.
- No client names, hostnames or IPs; the repo is public.

## Suggested waves

| Wave | Routes | Notes |
|---|---|---|
| 1 | `/` `/formulas` `/apps` `/docs` | Finishes Workspace |
| 2 | `/models` `/settings/discover` `/team-admin` `/pending` | Review |
| 3 | Settings, the 9 the assistant depends on: `agents`, `ai-workers`, `tools`, `tool-groups`, `skills`, `keys`, `embedding`, `heartbeats`, `worker-groups` | Highest teaching value |
| 4 | Settings, the remaining 16 | `appearance`, `accounts`, `microsoft`, `calendar`, `profile`, `mcp`, `network`, `config`, `entities`, `peers`, `pdf-passwords`, `backups`, `updates`, `security`, `users`, `audit` |
| 5 | System, `/studio` `/dev-tools` `/runners` `/runs` `/sandboxes` `/traces` `/debug` | Technical-only; no Assistant section |

## Loop, and how to know you're done

```bash
# the authoritative gap list — nav routes with no topic
node -e '…' # or just re-run the inventory in help.test.ts
pnpm verify            # 3516 tests at handover; help.test.ts had 27
```

After each wave: `pnpm verify`, then commit. The drift test enforces that every
mapped topic has a file, every file is reachable from a route, every file has its
three sections, and every declared tool group is real. **Done = 0 nav routes
without a topic**, with `pnpm verify` green.

## Environment

Full stack runs locally on the Mac (Docker Desktop, M4, Node 26.5.0):

```bash
cd .claude/worktrees/<your-worktree>
pnpm infra:up && pnpm dev      # web :3000, client :3100
```

- Copy `server/web/.env.local` from an existing worktree, and **rewrite the
  absolute paths** in it (`MANTLE_FILES_ROOT`, `TABLE_DB_DIR`, `APP_DB_DIR`,
  `MANTLE_DOCS_ROOT`) to your worktree.
- **Copy `data/` across before starting**, or files-watch reconciles the brain
  against an empty tree. Tables are SQLite workbooks under `data/table-dbs`,
  missing them is a 500, not an empty list.
- The dev box's live stack is `~/stack-rehearsal`, **not** `~/mantle`. Copying
  from the wrong one gives you a stale unrelated file tree.
- `MANTLE_API_CORS_ORIGINS` must include `http://localhost:3100`.
- Restart with an explicit `cd`, the shell's cwd resets, and starting from the
  integrator silently runs the wrong checkout with no `.env.local`.
- **Never run `pnpm dev` in the integrator** (`~/Projects/mantle`); it's the
  merge/release checkout.

## Open, not blocking

- The rail's flare (gradient + grid) and its 22rem width are unreviewed in the
  running app; Jason may want them softened.
- Three-column layout (help + assistant + activity) on a 1440px screen is
  untested.
- `v0.215.0` and `v0.216.0` are committed on `main` but **never tagged**, so
  neither shipped. `main` is 12 commits unpushed. Leave alone unless asked.
