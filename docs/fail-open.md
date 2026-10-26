# Fail-open counts (plan v3.2 S4a)

Five branches still answer yes, or send a write to the system pool, for code
that has no system actor bound. S4a only counts them: each hit writes one
miss row, and no answer changes. S4b (a later release, after one fleet
release with every count at 0) refuses them. The spec is
[actors.md](./actors.md), section 7.

## The sites

| Site (`fail-open:<site>`) | Where                                                             | A hit when                                                                               |
| ------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `scope-holds-admin`       | `scopeHoldsAdmin` (`packages/db/src/gateway/scope-answers.ts`)    | code outside every scope gets yes (`isUnscoped()`) and no system actor is bound          |
| `scope-has-area`          | `scopeHasArea`, its system case (gateway/scope-answers.ts)        | the same: a yes outside every workspace scope with no system actor bound                 |
| `typed-write`             | `typedWrite` (gateway/write-route.ts)                             | a scoped write (`db.insert`, `update`, `delete`) to a table the write role does not hold |
| `raw-write`               | none since S10 round 3 (the name stays for an older image's rows) | never: a scoped raw write goes to the write role, which refuses such a table             |
| `turn-exit`               | `asSystem` (`packages/db/src/viewer.ts`)                          | production lets an unlisted `asSystem` reason leave a turn scope                         |
| `system-db`               | `assertSystemDbCaller` (viewer.ts)                                | production lets a file outside `SYSTEM_DB_MODULES` use `systemDb` in a turn scope        |

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
scope's kind in viewer.ts), `detail` the calling file. A write runs when
its query is awaited, often with no app frame on the stack; its `detail`
names the table then (`unknown caller, table public.x`).

What it does, in order: a hit first asks a map keyed by site whether that
site took a stack in the last 60 seconds; if it did, nothing more happens
(no stack). Otherwise the site takes one stack, which names the calling
file, and a second map keyed by site and file says whether that pair's row
was written in the last hour; if not, the row is handed to the writer, and
the pair is marked only when the writer took it (a hit before the pool has
its writer is written by a later one). So a busy branch pays at most one
stack a minute, a second caller of the same site is found when it is the
first hit after the site's minute gate, and every process that still hits writes its pair again each hour. The
database keeps at most 100 rows an hour per check.

`scripts/arch-scoreboard-box.sh <ssh-alias>` prints, numbers only:
`fail_open_misses:all` and one count per site (the distinct site and file
pairs in the last 24 hours, or since the last roll began, the updater's
`started_at`, when that is later, but never from later than an hour ago:
any write of the updater's status moves `started_at`, a client-only or
refused roll too, and none restarts a server, so an error reads as a false
non-zero, never a false 0; not since `mantle_web` started, which a web-only
restart would reset while the api, worker and MCP processes still hit), a
site's count is 0 only when no process hit it in that window;
`brains_without_admin_workspace`, and `env_has_runtime_role_line` (n/a with
no readable `.env`). The repo
count is the pin `failOpenSites` (`scripts/arch-scoreboard.pins.json`): the
five calls that note a hit. S4b takes it to 0.

## Measuring the system-pool tables

`MANTLE_FAIL_OPEN_DUMP=<file>` makes `vitest.setup.ts` write every hit of a
test run, one JSON line each (site, actor kind, table, test file). Under
vitest a hit is kept before the lookup and with no stack. The lists below
were measured that way: the full DB vitest run (two shards) on a throwaway
database with the actor check in warn (`vitest.config.ts`).

`vitest.setup.ts` also rehearses S4b: a `typed-write` hit fails its test
unless its table is on the list still left to decide
(`SCOPED_SYSTEM_WRITES_LEFT`, `packages/db/src/fail-open.ts`). A table that
names a reason is no hit at all. So a new scoped typed write to a table
the write role does not hold fails the suite before it can reach S4b. A
cell that causes one on purpose takes it (`takeFailOpenHits`).

## The scoped writes that stay on the system pool

S4b refuses a scoped typed write to a table the write role does not hold,
unless the table's access matrix row names `scopedSystemWrite: '<reason>'`
(`packages/db/src/access-matrix.ts`, read as `SCOPED_SYSTEM_WRITE`). The
named tables are not counted (`noteScopedSystemWrite` skips them). Keep the
list small: the pin `scopedSystemWriteTables` only goes down, or up with a
reviewed note, and `access-matrix.test.ts` holds each reason non-empty and
never on a write-role table.

| Table               | `scopedSystemWrite` reason                                                 | Writers                                                                                           |
| ------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `public.item_marks` | own marks: actor_id is the caller's login; the node is read in scope first | `packages/content/src/tree/marks.ts`, `tree/apps-nav.ts`, `app-nav.ts` (the owner's and members') |

Moved off the caller's scoped write instead of named (a reason on these
tables would let every scoped configuration write through):

- The use counters of an assistant and an AI worker
  (`bumpAgentUsage`, `bumpWorkerUsage`): `systemDb`, the narrow route in a
  scope; `ai_workers` holds `last_used_at` and `usage_count` in
  `NARROW_WRITES`, as `agents` did.
- `api_tool_update`'s tool row, group and External access (tools,
  tool_groups, audit_log): `areaSystem('connectors', …)`, the area asked
  again, as `api_tool_create` runs whole.

Left to decide (`SCOPED_SYSTEM_WRITES_LEFT`; each is moved or named before
S4b, else S4b refuses it):

| Table                       | Measured in                                                                       | Writers                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `public.pending_tool_calls` | `a5-approval-recheck`, `a5-elevated-approval`, `w7a-tool-sweep` (79 hits, logins) | the approval queue: `packages/tools/src/pending-queue.ts`, `pending.ts`, `toolsmith/groups.ts` |
| `public.assistant_messages` | `a5-mcp-writes-smoke`, `w7c-chat` (4 hits, logins)                                | a login's turn rows over MCP: `packages/runtime/src/agent/conversation.ts`                     |

Measured 2026-10-26 on feat/s4a-list (both shards of the full DB run): no
other table. The integrity screen's delete of a node's trace rows
(`server/web/lib/integrity/landed.ts`) has no vitest hit.

So the list is vitest plus the box counts. The vitest run cannot see the
two production allows (tests and development throw there), the two
unscoped yes (every test binds `system(test)`), a scoped write on a path no
test reaches, or which table a box's writes name. The box counts see every
site on real traffic but give numbers only (`fail_open_misses:typed-write`
is this site): a site with a count above 0 is read on that box (its
`detail`, the calling file or the table) before S4b names or refuses it.
S4b flips after one fleet release with every count at 0 or each table
named here.
