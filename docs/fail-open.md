# Fail-open counts (plan v3.2 S4a)

Six branches still answer yes, or send a write to the system pool, for code
that has no system actor bound. S4a only counts them: each hit writes one
miss row, and no answer changes. S4b (a later release, after one fleet
release with every count at 0) refuses them. The spec is
[actors.md](./actors.md), section 7.

## The six sites

| Site (`fail-open:<site>`) | Where                                                    | A hit when                                                                                             |
| ------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `scope-holds-admin`       | `scopeHoldsAdmin` (`packages/db/src/client.ts`)          | code outside every scope gets yes (`isUnscoped()`) and no system actor is bound                        |
| `scope-has-area`          | `scopeHasArea`, its system case (client.ts)              | the same: a yes outside every workspace scope with no system actor bound                               |
| `typed-write`             | `typedWrite` (client.ts)                                 | a scoped write (`db.insert`, `update`, `delete`) to a table the write role does not hold               |
| `raw-write`               | `loginWriteClient` (client.ts)                           | a scoped raw write (`executeWrite`, a write transaction) to such a table                               |
| `turn-exit`               | `asSystem` (`packages/db/src/viewer.ts`)                 | production lets an unlisted `asSystem` reason leave a turn scope                                       |
| `system-db`               | `assertSystemDbCaller` (viewer.ts)                       | production lets a file outside `SYSTEM_DB_MODULES` use `systemDb` in a turn scope                      |

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

Cost: a hit asks one map, by site, before any stack is taken. A site takes
at most one stack a minute, so a busy branch never pays a stack per call,
and a second caller of the same site is still found a minute later. One row
per site and calling file in a process; the database keeps at most 100 rows
an hour per check.

`scripts/arch-scoreboard-box.sh <ssh-alias>` prints, numbers only:
`fail_open_misses:all` and one count per site (the distinct site and file
pairs since `mantle_web` started, all of them when it is not there),
`brains_without_admin_workspace`, and `env_has_runtime_role_line`. The repo
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
are the tables the measurement found:

MEASUREMENT PENDING
