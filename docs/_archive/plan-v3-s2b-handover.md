# Plan v3.2 S2b: the workspace row in SQL (handover)

The branch `feat/s2b` (one branch, one migration, one release, three parts
b1, b2, b3). The spec's rule is in [../actors.md](../actors.md), sections 9
and 15; this file holds the step's detail. Cut from main 101669eb3
(v0.300.99, S6 c1's 0308 merged), not 464c748df as the brief named: main had
moved, and 0308 on main keeps the journal's "no slot is skipped" cell green
without a rebase.

## Migration

`0309_ws_row_definers`, journal idx 309, `when` 1790197860000 (above S6
c1's 0308 at 1790197800000). Re-runnable (CREATE OR REPLACE only), `SET
LOCAL lock_timeout = '30s'` first. It only adds functions: no table, row,
trigger, grant or earlier function changes. The renumber proof is in
`packages/db/src/ws-row-definers.db.test.ts` (the `when` above every `when`
before it and above 0308's; a database just before 0309 applies 0309 and
only it; the revert's ledger line names 0309's own `when`).

Every definer: SECURITY DEFINER, search_path `public, pg_temp`, PUBLIC
revoked. The acting login is `mantle_scope_login_id()` through 0307's
`mantle_ws_acting_login` (an enabled login on its brain, never read-only);
with no acting login each is refused: `mantle_ws_system_work(fn)` names
none of them, so no allowlisted actor reaches them either (a cell runs both
listed actors and six refused ones through all four). The workspace row is
locked by 0307's `mantle_ws_user_seat`, which also answers `not_found` for a
workspace the acting login may not see. A refusal says `mantle_ws:<code>`
with its SQLSTATE; `wsRefusal` (server/web/lib/workspaces.ts) maps it to
the WsError the route answered before.

## Part b1: the name, the look, the contact

- `mantle_ws_update_about(owner, ws, patch jsonb)`: the name, description,
  colour and icon. `patch` carries a key per field to set (JSON null clears
  the colour or the icon). Archived refused, then a Moderator of it or an
  Admin user with the users area (`about_forbidden`), Admin keeps its name
  (`admin_keeps_name`), the name Admin reserved (`reserved_name`). One
  `workspace.update` event with the fields that changed, none when nothing
  did.
- `mantle_ws_set_contact(owner, ws, contact)`: an Admin user with the users
  area (`contact_admin_only`); a contact node of the brain or NULL
  (`no_contact`). Its own `workspace.update` event `{contactNodeId}`.
- The write role's (`WRITE_ROLE_FUNCTIONS`).

## Part b2: the assistant, the landing app

- PATCH `{assistantId}` calls 0307's `mantle_ws_set_assistant`; the
  TypeScript `setAssistant` and `agentHasHistory` are gone
  (`setAssistantCopies` 2 to 1). The byte-equal cell in
  `server/web/lib/workspaces.db.test.ts` ("setAssistantCopies is 1") still
  runs: PATCH and the definer called by hand leave the same rows and answers.
- `mantle_ws_app_held(owner, ws, app)` (private, no role): THE rule "the
  workspace holds the app by its own grant and the published build is
  green", `@mantle/content` `workspaceHeldApp`'s SQL moved (the TS function
  is deleted; it had no other caller).
- `mantle_ws_set_landing(owner, ws, app)`: a Moderator of the workspace
  (never an Admin area: `landing_forbidden`), the app held and green
  (`landing_app_not_held`, `landing_app_not_ready`), or NULL. A
  `workspace.landing` event `{appId}` when it changes. The write role's.

## Part b3: the archive, the readers, the exit gone

- `mantle_ws_archive(owner, ws)`: the heads of every item the workspace
  holds but is not the home of come first (`mantle_lock_heads`, by node id:
  withHeads' order), then the workspace row; a Moderator or an Admin user
  with the users area (`archive_forbidden`), never Admin (`archive_admin`),
  archived refused, refused while it is an item's home (`holds_items`, the
  count in its text); rows found after the first lock are locked NOWAIT
  (`mantle_lock_heads_more`), and a busy one fails the whole transaction,
  which `withDeadlockRetry` in TS runs again. Drops the shares and the
  "removed here" exclusions, stamps `archived_at`, writes `workspace.archive`
  and returns `{items, grants}`.
  - **Why the system pool:** it runs in a system-pool transaction in the
    request's write scope (`withSystemPoolInWriteScope`; its call site is
    pinned in `eslint-rules/scope-settings.mjs`, workspaces.ts 1 to 2 with
    the reason). On the write role `mantle_heads_scope_filter` leaves out the
    heads of items the scope does not read (an Admin user outside the
    workspace, or an item "removed here"), so their grants could not be
    dropped under their heads. The runtime role's
    (`RUNTIME_SYSTEM_FUNCTIONS`); the definer checks the acting login inside.
- `workspaceWriteSystem` and the reason `'workspace-write'` are deleted
  (viewer.ts, the as-system allowlist and routes, the `@ts-expect-error`
  cell in `ws-user-definers.db.test.ts` that it is no reason now).
- `seeWorkspace` takes no row lock any more (its `lock` option had no caller
  left): each definer locks the row.
- **The system-pool readers** of workspaces / workspace_users the plan names,
  surveyed site by site (one moves; the rest have no scope at hand or read in
  the scope already):
  - moved: `moderatorSeatsNow` (packages/db client.ts) reads in the turn's
    scope with `db` (was `getAdminDb`). Its one caller is the gate's pre-run
    check inside the turn scope, and the seats it asks (`modWs`) are inside
    the scope's `ws`, so the row rule shows every row it read before.
  - already scope reads: `link-serve.ts` `linkRights`, `list-workspaces.ts`
    (`mine` and its users), `grants.ts` `loadCtx` (an Admin user's write
    there runs on the system pool with the scope settings, by design).
  - no scope at hand, stay: `loginScopeColumns`, `appRunHolders` and
    `viewerScopeFor` (they build the scope `mantle_scope_ws()` returns);
    `createHomeFallback`'s reads (its session.ts and MCP callers run before
    any scope; inside a narrower turn scope the row rule would hide the Admin
    row and the private workspace, a wider answer of `ownWork`, so it may not
    move); `workspaces-check.ts` (a CLI, brain-wide counts);
    `packages/telegram` `chat-login.ts` (`systemWork('login-telegram')`,
    never in a scope); `workspace-ticks.ts` (the CLIs). `admin-user.ts`
    reads no table (it calls `mantle_area_rule`).

## Changed answers and rows

No answer is wider. Named:

- **Two events where there was one:** a PATCH that changes the name or
  look AND the contact writes two `workspace.update` rows (the about fields,
  then `{contactNodeId}`), was one with both. No reader merges them
  (`workspace-ticks.ts` reads only the 0286 row by `by`).
- **No event for a contact given in another case:** PATCH with
  `contactNodeId` equal to the current one in upper case wrote an update and
  an event (TS compared the strings); the definer compares uuids and writes
  nothing. The event's `contactNodeId` is the uuid in lower case (was the
  string as sent).
- **Under a race only:** PATCH and archive read the workspace without a lock
  first, then each definer locks it and checks again; a change that lands in
  between is refused by the definer with the same code the route gives (was:
  the TS read under the lock). The archive's answer carries the workspace as
  read before the change (was: as read inside it), so its counts can differ
  from a concurrent change only.
- `moderatorSeatsNow`: same answer (see above).

## Counts

- Raw writes to the four workspace tables in TS: 0 (`workspaceTableRawWrites`).
- The SQL allowlist (`mantle_ws_system_work`): unchanged, 2 pairs.
- Writer functions of the four tables (live catalog): 18 to 22, each with its
  rule in `WRITERS` (`ws-user-definers.db.test.ts`).

## Pins

On main 101669eb3 to this branch: `asSystemExits` and `asSystemFull` 57 to
55, `asSystemFiles` 16 to 15, `asSystemReasons` 15 to 14,
`asSystemFull_workspace-write` 2 to gone, `workspaceTableRawWrites` 6 to 0,
`workspaceTableWriterFns` 18 to 22 (raised: the four definers, each a rule
with its cell), `setAssistantCopies` 2 to 1, `rawWriteSqlScoped` 70 to 62,
`rawWriteSqlFiles` 60 to 59, `dbClientLines` 3211 to 3210,
`historyCodeComments` (S2b is a history code from this file's heading, so
the code comments that already named S2b count; the value and its reason in
the pin's note). `system-pool-scope-sites`: workspaces.ts 1 to 2.

## Tests

- `packages/db/src/ws-row-definers.db.test.ts`: per definer, warn and on
  (the actor and the edit check together): a Moderator and an Admin user yes
  as before (row and event); a plain user, another workspace's Moderator, an
  Admin user without the users area, no acting login and an archived
  workspace refused; each refusal code; no acting login for every actor;
  read-only and another brain; the catalog (definer, path, PUBLIC, which
  role runs which); the renumber proof; the revert.
- `server/web/server/s2b-ws-row-routes.db.test.ts`: PATCH and archive
  through `runRoute`, warn and on: the changes and their events, the
  refusals PATCH answered before (nothing changed, a refusal late in a body
  keeps none of it), member-negative (outside the workspace and a sibling's
  Moderator get a random id's answer, nothing changes; a plain user the 403
  it got), archive and its refusals.
- Updated: `ws-user-definers.db.test.ts` (`WRITERS`, the asSystem cell),
  `write-role.db.test.ts` (the reviewed list), `viewer.test.ts` (14 reasons),
  `workspaces.db.test.ts` (the setAssistantCopies cell's title).

## Rollback

**What breaks on the image one release back (N-1) with 0309 in place:**
nothing. 0309 only adds functions; N-1 writes the row, the landing app and
the archive in TS on the system pool (`workspace-write`), and the runtime
role keeps its write on the four tables until S2c. N-1's boot revokes the
write role's EXECUTE on the three new write-role definers (its matrix has
no line for them), which N-1 never calls.

**How to roll back:** pin the older tag. To leave the catalog exactly as
N-1 shipped it (optional), while the newer image is still up, as the
superuser, in one transaction:

```sh
docker exec mantle_web cat /app/packages/db/rollback/0309_ws_row_definers.revert.sql \
  | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
```

then pin the older tag straight away (or stop mantle_web first): until the
pin the newer image's rename, landing app and archive are refused, and a
mantle_web restart in between applies 0309 again. The revert drops the five
functions and deletes 0309's ledger row, so the next roll forward applies it
again. Proved in `ws-row-definers.db.test.ts` ("rollback: the revert drops
0309's functions ..."). docs/update-prod.md "Rollback" says the same.

## Open items

- **S2c:** `server/web/lib/workspace-ticks.ts` (`clearTicksTx`) takes
  `select ... from workspaces ... for update` on the system pool under
  `systemWork('ws-clear-ticks')`; FOR UPDATE needs UPDATE, so it fails once
  the runtime role is read-only on `workspaces`. The definer it calls
  (`mantle_ws_set_moderator`) locks the row itself, so S2c can drop that
  lock.
- The readers left on the system pool (above) keep working under S2c's
  `runtime: 'read'`.

## Gates

See "Gates (S2b)" below.
