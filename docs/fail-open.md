# Fail-open counts (plan v3.2 S4a)

Six branches still answer yes, or send a write to the system pool, for code
that has no system actor bound. S4a only counts them: each hit writes one
miss row, and no answer changes. S4b (a later release, after one fleet
release with every count at 0) refuses them. The spec is
[actors.md](./actors.md), section 7.

## The six sites

| Site (`fail-open:<site>`) | Where                                           | A hit when                                                                               |
| ------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `scope-holds-admin`       | `scopeHoldsAdmin` (`packages/db/src/client.ts`) | code outside every scope gets yes (`isUnscoped()`) and no system actor is bound          |
| `scope-has-area`          | `scopeHasArea`, its system case (client.ts)     | the same: a yes outside every workspace scope with no system actor bound                 |
| `typed-write`             | `typedWrite` (client.ts)                        | a scoped write (`db.insert`, `update`, `delete`) to a table the write role does not hold |
| `raw-write`               | `loginWriteClient` (client.ts)                  | a scoped raw write (`executeWrite`, a write transaction) to such a table                 |
| `turn-exit`               | `asSystem` (`packages/db/src/viewer.ts`)        | production lets an unlisted `asSystem` reason leave a turn scope                         |
| `system-db`               | `assertSystemDbCaller` (viewer.ts)              | production lets a file outside `SYSTEM_DB_MODULES` use `systemDb` in a turn scope        |

System work takes the first two yes on purpose (a worker, an Admin area
route, a named repair: each binds a system actor), so it is never counted;
counting it would keep the number above 0 for ever. A write is scoped as the
login write gateway decides it (`loginWriteRoute`): an actor the write role
takes (a login, an assistant, a link, a contact) and a write scope.

The SQL one is not a row: `mantle_login_area` answers yes on a brain with no
Admin workspace (migration 0293), and so does the "migration skipped" path
of `areasOf` (`server/web/lib/workspaces.ts`). The box count
`brains_without_admin_workspace` covers both: a brain reaches either only
with no Admin workspace.

## The miss rows and the box counts

`packages/db/src/fail-open.ts` writes the row through actor.ts's miss writer
(`mantle_actor_miss_log`, on another connection, after the statement):
`check_name` is `fail-open:<site>`, `actor` the bound actor's kind (or the
scope's kind in viewer.ts), `detail` the calling file. A raw write runs when
its query is awaited, often with no app frame on the stack; its `detail`
names the table then (`unknown caller, table public.x`).

What it does, in order: a hit first asks a map keyed by site whether that
site took a stack in the last 60 seconds; if it did, nothing more happens
(no stack). Otherwise the site takes one stack, which names the calling
file, and a second map keyed by site and file says whether that pair's row
was written in the last hour; if not, the row is handed to the writer, and
the pair is marked only when the writer took it (a hit before the pool has
its writer is written by a later one). So a busy branch pays at most one
stack a minute, a second caller of the same site is found a minute later,
and every process that still hits writes its pair again each hour. The
database keeps at most 100 rows an hour per check.

`scripts/arch-scoreboard-box.sh <ssh-alias>` prints, numbers only:
`fail_open_misses:all` and one count per site (the distinct site and file
pairs in the last 24 hours, or since the last roll began, the updater's
`started_at`, when that is later; not since `mantle_web` started, which a
web-only restart would reset while the api, worker and MCP processes still
hit), a site's count is 0 only when no process hit it in that window;
`brains_without_admin_workspace`, and `env_has_runtime_role_line` (n/a with
no readable `.env`). The repo
count is the pin `failOpenSites` (`scripts/arch-scoreboard.pins.json`): the
six calls that note a hit. S4b takes it to 0.

## Measuring the system-pool tables

`MANTLE_FAIL_OPEN_DUMP=<file>` makes `vitest.setup.ts` write every hit of a
test run, one JSON line each (site, actor kind, table, test file). Under
vitest a hit is kept before the lookup and with no stack, and it never fails
a test. The list below was measured that way: the full vitest run on a
throwaway database with the actor check in warn (`vitest.config.ts`).

## The scoped writes that stay on the system pool

S4b refuses a scoped typed or raw write to a table the write role does not
hold, unless the table's access matrix row names
`scopedSystemWrite: '<reason>'` (`packages/db/src/access-matrix.ts`). These
are the tables the vitest measurement found; the box counts add what it
cannot see (below):

| Table                       | Site          | Who writes it                                                                                                                          | `scopedSystemWrite` reason (proposed) |
| --------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `public.item_marks`         | `raw-write`   | a login's own open counts and pins, keyed by its login (`packages/content/src/tree/marks.ts`, `packages/content/src/tree/apps-nav.ts`) | `'own-marks'`                         |
| `public.pending_tool_calls` | `typed-write` | an elevated tool call queued for approval, and its status (`packages/tools/src/pending-queue.ts`, `packages/tools/src/pending.ts`)     | `'approval-queue'`                    |
| `public.assistant_messages` | `typed-write` | the rows of a login's chat turn in the one conversation store (`packages/runtime/src/agent/conversation.ts`)                           | `'conversation-store'`                |

Measured 2026-10-18 at the S4a branch: 146 hits, all from a login actor, in
`precheck-removal-http`, `w6a-route-sweep`, `w6b-fix1` (`item_marks`),
`w7a-tool-sweep`, `a5-elevated-approval`, `a5-approval-recheck`
(`pending_tool_calls`), `w7c-chat` and `a5-mcp-writes-smoke`
(`assistant_messages`), all under `server/web/server/`. No other table.

So the list is vitest plus the box counts. The vitest run cannot see the
two production allows (tests and development throw there), the two
unscoped yes (every test binds `system(test)`), a scoped write on a path no
test reaches, or which table a box's raw writes name. The box counts see
every site on real traffic but give numbers only: a site with a count above
0 is read on that box (its `detail`, the calling file or the table) before
S4b names or refuses it. S4b flips after one fleet release with every count
at 0 or each row named here.
