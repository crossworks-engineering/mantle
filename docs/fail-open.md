# Fail-closed branches (plan v3.2 S4b)

Six branches used to answer yes, or send a write to the system pool, for
code with no system actor bound. S4a counted them (a miss row each, the box
count `fail_open_misses`); after a fleet release with every count at 0,
S4b made each one refuse. Nothing counts them any more: the box script
prints `fail_open_branches gone`. The spec is [actors.md](./actors.md),
section 7.

| Branch                                                                                 | Where                                      | Now                                                                                  |
| -------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `scopeHoldsAdmin` outside every scope                                                  | `packages/db/src/gateway/scope-answers.ts` | yes for system work; no system actor bound: `SystemWorkRequiredError`                |
| `scopeHasArea` outside every workspace scope                                           | gateway/scope-answers.ts                   | the same                                                                             |
| a scoped typed write to a table the write role does not hold                           | `typedWrite` (gateway/write-route.ts)      | `SystemWorkRequiredError`, unless the table names `scopedSystemWrite` (a login only) |
| an unlisted `asSystem` exit from a turn scope                                          | `packages/db/src/viewer.ts`                | `TurnScopeExitError`, in production too                                              |
| `systemDb` in a turn scope from a file off `SYSTEM_DB_MODULES`                         | `assertSystemDbCaller` (viewer.ts)         | `TurnScopeExitError`, in production too                                              |
| `mantle_login_area` and `mantle_tg_moderated_chats` on a brain with no Admin workspace | migration 0340                             | no area, and no chats, for any login, as the strict rule answers                     |

A scoped raw write has no branch: it goes to the write role, which refuses a table it holds no right on (42501). System work (a
worker, an Admin area route, a named repair) binds a system actor, so it
is never refused here. A write is scoped as the login write gateway
decides it (`loginWriteRoute`): an actor the write role takes (a login, an
assistant, a link, a contact) and a write scope.

Tests: `packages/db/src/fail-closed.test.ts` (one cell per throw, the turn
fences with `NODE_ENV=production`), `fail-closed.db.test.ts` (on a
migrated database, with 0340's rollback), `viewer.test.ts`, and
`login-facts.db.test.ts` (`mantle_login_area` is the area rule).

## The scoped writes that stay on the system pool

A scoped typed write to a table the write role does not hold is refused,
unless the table's access matrix row names `scopedSystemWrite: '<reason>'`
(`packages/db/src/access-matrix.ts`, read as `SCOPED_SYSTEM_WRITE`); the
reason covers a login's write only. Keep the list small: the pin
`scopedSystemWriteTables` only goes down, or up with a reviewed note, and
`access-matrix.test.ts` holds each reason non-empty and never on a
write-role table.

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
- The approval queue (`pending_tool_calls`): every park (the turn's
  confirm gate, an agent's queued call, the toolsmith, the dev console) is
  one `parkPendingCall` at the full-route spot `pending-park`, and the
  claim, rejection, put-back, revert and settles of
  `packages/tools/src/pending.ts` are `decidePendingCall`,
  `unclaimPendingCall`, `revertPendingCall` and `settlePendingCall`
  (`packages/db/src/pending-calls.ts`): `systemDb`, the narrow route in a
  scope, with who may decide the call in each WHERE (`deciderFilter`), as
  `pending-elevated.ts` decides an elevated one. The narrow role already
  held every column written after a park.
- The conversation store (`assistant_messages`): `recordTurn`, a turn's
  outcome and the cancel route's supersede
  (`packages/db/src/conversation-writes.ts`): `systemDb`, as
  `team-messages.ts` writes a workspace thread. A row names its login
  whenever a login actor is bound (`threadLoginFor`): on the system pool
  the database's stamp reads no login, so an unset one would land a
  member's row in the anchor's thread; a row naming another login is
  refused. The supersede stamps a settled inbound row, which the narrow
  role never rewrites (0323), so it runs at the full-route spot
  `turn-supersede`, the system pool it ran on before.
