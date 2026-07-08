# Handover — content-surface renames: Todos→Tasks (deep) & Lifelogs→Memories (shallow)

Status as of this session. **Nothing is committed; nothing is deployed.** Everything
below is in the working tree on `main`, verified by typecheck + targeted tests.

## TL;DR

Two product surfaces were renamed for a more corporate register, at **two different
depths**:

| Surface | Old | New | Depth | Live-DB migration? |
|---|---|---|---|---|
| To-dos | `todos` | **Tasks** | **Deep** — labels, route, code symbols, file names, REST route, tool slugs, tool-group slug, ltree label | **Yes — `0108`** |
| Life Logs | `lifelog` | **Memories** | **Shallow** — labels + page route + docs only; *all* internals still `lifelog` | No |

The asymmetry is deliberate-so-far, not an oversight: Tasks was taken all the way to
"purity" by request; Memories was explicitly scoped to labels + URL. **The open
decision (the "look at lifelogs more" item) is whether to give Memories the same deep
treatment** — see the last section, which includes the one complication Tasks didn't
have (a Postgres enum value).

---

## What was done — Tasks (was To-dos)

The node **type was already `task`** in the DB — the single most load-bearing
identifier was correct from day one. The rename made the *periphery* agree with it.

Done in staged passes, each leaving the tree compiling:

1. **Labels** (user- + agent-visible wording): page title, sidebar nav, list/detail/
   form copy, toasts, empty states, the live status line (`stage-label.ts`), the in-app
   + MCP tool **names/descriptions**, the manifest tool-group display name, the dev-tools
   catalog label.
2. **Route**: `app/(app)/todos/` → `app/(app)/tasks/` (`git mv`), nav `href`, the
   `n/[id]` node-detail redirect, a `/todos → /tasks` redirect in `next.config.ts`.
3. **Code symbols** (tsc-protected): `createTodo`→`createTask`, `listTodos`→`listTasks`,
   `getTodo`/`updateTodo`/`deleteTodo`/`countTodos`, `todoConds`→`taskConds`, `TodoRow`→
   `TaskRow`, `TodoStatus`/`TodoPriority`, `Create/UpdateTodoInput`, `TODO_STATUSES`/
   `TODO_PRIORITIES`, `TodoForm`/`TodoDetail`/`TodoPayload`/`TodosClient`/`TodoPresenter`,
   `TODO_TOOLS`/`TODO_TOOL_SLUGS`.
4. **Files** (`git mv`, history preserved):
   - `packages/content/src/todos.ts` → `tasks.ts`
   - `packages/tools/src/builtins-todos.ts` → `builtins-tasks.ts`
   - `apps/web/lib/todos.ts` → `lib/tasks.ts`
   - `app/(app)/todos/{todos-client,todo-detail,todo-form}.tsx` → `tasks/{tasks-client,task-detail,task-form}.tsx`
   - `app/api/todos/` → `app/api/tasks/`
   - `components/share/todo-presenter.tsx` → `task-presenter.tsx`
   - `@mantle/content` export subpath `./todos` → `./tasks`
5. **REST**: `/api/todos` → `/api/tasks`; response fields `{ tasks }`/`{ task }`; the
   share-view discriminator `kind: 'task'`.
6. **Tool slugs** (the deliberate *last* code stage): `todo_*` → `task_*` everywhere —
   builtins, MCP server, manifest group membership, `stage-label` keys, agent-prompt
   mentions, the dev queue-approval default, and the assertions in
   `core-tools.test.ts` / `turn-stage.test.ts` / `stage-label.test.ts`.
7. **Storage identifiers** (migration `0108`, see below): the ltree root label
   `'todos'`→`'tasks'` (`TASKS_ROOT_LABEL`) and the **tool-group slug** `'todos'`→`'tasks'`
   (manifest group, persona grant, the `core-tools.ts` floor).

**Kept as-is:** the node type `task` (already correct). That's the only thing that stays
"unchanged" — because it never needed changing.

### Migration `0108_rename_todos_to_tasks.sql`

The only live-DB change in the whole effort. 5 reversible `UPDATE`s, idempotent,
nothing it touches is queried-by (all task queries filter `type='task'`):

1. Tasks **branch** node — re-path + re-slug `todos`→`tasks`.
2. Branch **title** `Todos`→`Tasks` (only if the operator hadn't renamed it).
3. Every **task node** — re-path `todos`→`tasks`.
4. **tool_groups** row — `slug` `todos`→`tasks`.
5. **agents** — `array_replace(tool_group_slugs, 'todos', 'tasks')` (persona + operator
   agents).

Registered in `migrations/meta/_journal.json` (idx 108). Verified it parses via
drizzle's `readMigrationFiles` (5 statements split correctly).

---

## What was done — Memories (was Life Logs)

**Shallow by design.** Only the words a human or the agent *sees*, plus the page URL:

- **Labels**: page title + sidebar → "Memories"; editor/list copy, toasts, the live
  status line ("Saving to your memories…"), the in-app + MCP tool names/descriptions,
  the **identity-context block header** (`# About the user (Memories)` — this is what the
  agent reads every turn, so it makes the agent *speak* "memories"), the persona-bank
  reference, the manifest tool-group display name.
- **Route**: `app/(app)/lifelog/` → `app/(app)/memories/` (`git mv`), nav `href`, the
  `n/[id]` redirect, a `/lifelog → /memories` redirect.
- **Docs**: living docs swept (`docs/lifelog.md` retitled "Memories", etc.); historical
  changelogs/handovers left frozen.

**Everything internal stayed `lifelog`:** the node type `lifelog` (enum value), the tool
slugs `lifelog_*`, the tool-group slugs `lifelog` / `lifelog-admin`, `/api/lifelog`, the
ltree root `lifelog` (`LIFELOG_ROOT_LABEL`), all function names (`createLifelog`…), types
(`LifelogRow`), file names (`lifelog.ts`, `builtins-lifelog.ts`, and the
`memories/lifelog-client.tsx` / `lifelog-editor.tsx` components keep their names), and the
persona `memoryConfig.inject_lifelog` flag.

---

## Verification status

- **Typecheck clean**: `@mantle/content`, `@mantle/tools`, `@mantle/assistant-runtime`,
  `@mantle/mcp`, `@mantle/web`, `@mantle/api`.
- **Tests pass**: the slug/stage-label/manifest/floor-grant/turn-stage suites; the
  manifest **dangling-slug drift guard** passes (proves every grant resolves to a real
  group and every slug to a real builtin).
- **Migration `0108`** parses via drizzle (DB-free check).
- **NOT yet done**: full `pnpm exec vitest run`, a `next build` preflight (the deploy
  gate), a browser smoke of `/tasks` + `/memories`, and the docs sweep for **Tasks**
  (the Memories docs were swept; Tasks docs were not).

## Deploy checklist (when shipping)

Per the "always pg_dump before a live migration" rule, on **both prod boxes**:

1. `pg_dump` both boxes.
2. `db:migrate` (applies `0108`) — **must run before the app boots / reconciles.**
3. App boot **reconcile** (`seedToolCapabilities`, runs once per `APP_VERSION`)
   reaffirms the `tasks` group membership = `task_*`. Because `0108` already renamed the
   DB group + repointed agents, the reconcile updates that row *in place* — no duplicate,
   no orphaned `todos` group.
4. Eyeball `/settings/config` — it surfaces any grant drift loudly.

Reversible if needed (mirror `array_replace` / `UPDATE`s; no enum involved).

## Git state

All file/dir moves are tracked as renames (`R`). **Nothing committed.** Suggested
grouping when you're ready:

- `refactor(todos): rename to Tasks end-to-end — labels, route, symbols, tool slugs, group slug`
- `feat(db): migration 0108 — rename todos→tasks storage identifiers`
- `docs: Todos→Tasks across living docs` (after the Tasks docs sweep)
- (Memories label/route/docs commits, if not already split out)
- `pnpm version:bump` (minor)

---

## OPEN ITEM — "look at lifelogs more": should Memories get the deep rename too?

Right now Memories is "Tasks at stage 1–2 only": pretty on the outside, `lifelog`
everywhere inside. If the same future-grep / maintainability worry that drove the Tasks
deep-rename applies here, the playbook is identical **with one extra complication**.

A full `lifelog → memory` deep rename would touch the same shape as Tasks:

- **Symbols**: `createLifelog`→`createMemory`, `listLifelogs`, `LifelogRow`→`MemoryRow`,
  `LIFELOG_ROOT_LABEL`, `lifelogSortSql`, etc.
- **Files**: `lifelog.ts`→`memory.ts`, `lifelog-options.ts`, `builtins-lifelog.ts`,
  `lib/lifelog.ts`, the `memories/lifelog-{client,editor}.tsx`, `share/?`-presenter,
  `@mantle/content/lifelog` subpath.
- **REST**: `/api/lifelog` → `/api/memories`.
- **Tool slugs**: `lifelog_*` → `memory_*`; **tool-group slugs** `lifelog` /
  `lifelog-admin` → `memory` / `memory-admin` (manifest + persona grant + floor) — needs
  the same `agents.tool_group_slugs` migration as `0108`.
- **ltree root**: `lifelog` → `memory` (cosmetic, type-filtered — same as the tasks path).
- **Identity-context plumbing** Tasks did *not* have: the persona
  `memoryConfig.inject_lifelog` flag and `buildIdentityContext` / `identity-context.ts`,
  which inject Memories into every turn. Rename the flag + helpers too.

### The one thing Tasks didn't have: a Postgres **enum** value

Tasks' node type was already `task`. **Memories' node type is `lifelog` — a value in the
`node_type` Postgres enum.** So a *fully* pure rename needs an enum migration, which is
the one genuinely awkward bit:

- `ALTER TYPE node_type ADD VALUE 'memory'` is **irreversible** and **cannot run in the
  same transaction** that later uses it (this repo's custom migrate runner commits each
  migration separately, which handles that — see `migrate.ts`).
- Postgres **cannot drop** an enum value, so `lifelog` would linger in the enum forever.
- Then `UPDATE nodes SET type='memory' WHERE type='lifelog'` to move existing rows, and
  every `eq(nodes.type, 'lifelog')` / `type` filter / the `node_type` zod enums in the
  MCP server + search would need updating.

**Three options to decide between:**

1. **Leave Memories shallow** (current state) — internal name `lifelog`, zero further
   risk. The agent already says "memories"; only devs see `lifelog`.
2. **Deep rename but keep the node type `lifelog`** — do everything above *except* the
   enum. Mirrors Tasks closely (symbols/files/REST/slugs/ltree + a group-slug migration),
   no irreversible enum change. The node type stays an internal `lifelog` wart, exactly
   like Tasks would have if its type hadn't already been `task`.
3. **Full incl. the enum** — option 2 + the `ADD VALUE 'memory'` + data backfill. Cleanest
   end state, but the enum add is permanent and `lifelog` stays a dead enum member.

Recommendation if pursued: **option 2** is the sweet spot — it removes the `lifelog` name
from everything devs grep for day-to-day, with no irreversible step, and the same
migrate-before-reconcile deploy as `0108`. Option 3 only if a dead enum value genuinely
bothers you. Decide before starting, since it changes the migration's nature.
