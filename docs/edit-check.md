# The edit check: the database checks writes

Workspaces arch plan v2, phase A3a (sections 5.1 to 5.3, 12, 19 and 20.3).
Migrations 0280 and 0281. The actors a write runs as are in
[actors.md](./actors.md); the model is [workspaces.md](./workspaces.md).

Every refusal A3a adds goes through one switch, `mantle.edit_check`, with
three steps: `off`, `warn`, `on`. Every box starts `off`, and `off` is the
behaviour before A3a exactly: the edit check's triggers are disabled, so a
write calls none of them.

## The switch

- `select mantle_set_edit_check('warn')` (or `off`, `on`; a second
  argument sets the tries, 50 by default) is the one way to change it, as
  the superuser that runs migrations (docs/update-prod.md). It sets the
  database setting and enables or disables every edit check trigger in one
  transaction. Both setters are `mantle_set_check(setting, mode, tries)`,
  through one trigger switch, `mantle_switch_triggers` (all locks first,
  `NOWAIT`, the tries 200 ms apart, then 55P03 with nothing changed).
- `mantle_edit_check_mode()` is the box setting, raised by a session's own
  value, never lowered (`mantle_check_mode`, the rule of
  `mantle.heads_check`). The mode is read only on a refusing path, so an
  allowed write pays nothing for it.
- `warn` runs the write and raises a NOTICE
  `mantle actor miss: edit: <what> (refused when the edit check is on)`. The
  app logs it as an actor miss: `actor_check_misses`, check name
  `edit: ...`. `on` refuses: SQLSTATE 42501 with a detail the mapper reads
  (plan 5.2): `no_read`, `no_edit`, `read_only` (an Informational app's
  data) or `ro_actor`. `editRefusalDetail` (`packages/std/src/access-error.ts`,
  re-exported by `@mantle/db`) reads it, the one mapper (`mapAccessError`,
  same file, arch A3c) turns it into each surface's answer, and the HTTP
  layer (`server/web/server/scope-refusal.ts`) puts it on the wire as
  `code`: `no_read` is a 404 (`not_found`);
  `read_only` and `ro_actor` a 403 with reason `read-only`; `no_edit` and
  the checks before A3a the 403 with reason `item-workspace`, as before.
- The edit check bites only where the actor check is `warn` or `on`: its
  per-table checks fire for the write role (`mantle_write_user`), which
  takes a write only then, and the read-only refusal reads
  `mantle.write_mode`, which the app sets only then. Turn the actor check
  on first.
- A pooled connection keeps the setting the database had when it opened:
  restart the app processes after a change.
- A bare `alter database ... set mantle.edit_check` (or a restore) leaves the
  triggers apart from the mode: the integrity row `edit_check_drift` and one
  warning at a pool's start (`EDIT_CHECK_DRIFT_SQL`) show it; the app never
  fixes it.

## The rule, written once

- `mantle_may_edit_in(ws, mod_ws, home, write_ws)` and
  `mantle_may_manage_in(mod_ws, home)` are the array forms, pure, for a
  preview that asks about any set of workspaces (plan 5.1).
  `mantle_may_edit` and `mantle_may_manage` call them with the scope.
- `mantle_check_row(home, write_ws, read_ws, need, kind, informational)` and
  `mantle_check_item(node, need)` answer for every table. The needs: `read`,
  `edit` (a Moderator of the home, or a grant with Write on), `manage` (a
  Moderator of the home; an Admin scope for an item with no home), `admin`
  (the scope holds the Admin workspace: an Admin user), `appdata` (edit, and
  while the app is Informational an Admin user too: D6), `link` (edit; an
  app: manage) and `link_close` (`link`, or an Admin user with the users
  area).
- The write check of the write role (0278, 0279) asks through
  `mantle_check_row` too. Same answers.

## The checks per table and operation (plan 5.2)

Declared once, on the table's row of `ACCESS_MATRIX`
(`packages/db/src/access-matrix.ts`, `editCheck`). Migrate makes the
triggers (`editCheckTriggers`, in `syncWriteRoleRules`): each named
`mantle_edit_check_<suffix>`, each calling the one function
`mantle_edit_check_trg(need, item, via, mode)`, each firing for the write
role only and only for the operations and columns that need more than the
write check already asks. A trigger's note (its hash) makes a migrate that
changes nothing change no trigger; a new one follows the box mode.

| Table                                          | INSERT                                             | UPDATE                                                                                                            | DELETE                                   |
| ---------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| nodes                                          | the create rules (0266, 0278), unchanged           | edit (0278); every column but the edit columns is the brain's; an embedding only cleared; a derived key only cleared | manage (0266), unchanged                 |
| pages, draws, tables                           | edit (0278)                                        | edit (0278)                                                                                                       | manage                                   |
| apps                                           | manage (D4); a switch above its safe value: admin   | the code: manage (D4); the switches and the author: admin (D5); the tool level lowered to team: nothing more        | manage                                   |
| app_databases                                  | appdata (D6)                                       | appdata (D6)                                                                                                      | manage                                   |
| recall_maps                                    | edit                                               | edit                                                                                                              | manage                                   |
| recall_nodes, recall_revisions                 | edit of the map                                    | edit of the map                                                                                                   | edit of the map                          |
| shares                                         | link; a contact share: admin                       | link; closing it (revoked_at): link_close; a contact share: admin                                                 | link_close; a contact share: admin       |
| node_snapshots                                 | edit of the item                                   | edit of the item                                                                                                  | edit of the item                         |
| content_chunks, content_chunk_windows, facts   | the write check (0278), unchanged                  |                                                                                                                   |                                          |
| item_grants                                    | the write check and the grant definers (0279)      |                                                                                                                   |                                          |
| node_embeds, peer_shares, contact_share_codes, node_comments | the write role holds no right on them: system work only, refused by construction | | |

- **nodes, what only the brain sets.** A new node (INSERT) that carries a
  derived key or an embedding: in `on` they are dropped
  (`mantle_edit_check_ins_keys`; the extractor writes them again from the
  item, so a member's copy keeps working), in `warn` reported; a forged
  summary or vector never reaches retrieval.
- **nodes, deny by default.** The edit columns (`NODE_EDIT_COLUMNS`) are
  the ones a login's edit changes; the derived ones among them (`home_ws`,
  `read_ws`, `write_ws`, `login_id`) keep their guards. Every other column
  (read from the catalog at migrate, so a column a later migration adds is
  in it) is the brain's: a change is refused. An embedding may be cleared
  (every content edit clears it), never set.
- **apps.** The code (`APP_CODE_COLUMNS`) needs a Moderator of the app's
  home (owner decision D4). The switches and the author
  (`APP_SWITCH_COLUMNS`: trust its tools, MCP access, data read only, who
  made it) need an Admin user (D5). Lowering the tool level to team, as the
  author ceiling does, is always allowed. A new app's row is code: manage.
- **App data** (D6): edit of the app; while Informational is on, an Admin
  user only. A member's and a contact's app-data writes run as named system
  work (`asSystem(..., 'app-data')`, the `/s` broker) after the app's own
  check. The app database's own broker (A3b) runs its checked statement
  before the file: [store-brokers.md](./store-brokers.md).
- **Links** follow the guide's table: open, change or close a link needs
  edit (an app: a Moderator of its home); an Admin user with the users area
  closes any; a contact share needs an Admin user, its home not checked.
- A row whose item is gone passes: its foreign key or its row rule decides.
  A cascade's inner rows are not checked (`pg_trigger_depth`; a foreign
  key's cascade runs as the table's owner): every cascade starts at a
  checked statement.
- **A deleted app's history rows** are the brain's: the trash flows run as
  `system(app-trash)` and the route asks manage of the stored home
  (`code.meta.homeWs`), or the owner for an app another login deleted
  (`server/web/lib/auth/session.ts`). On the write role their row rule
  follows the node, so a deleted item's rows match nothing there. A6 moves
  the trash reads into the scope.

## The read-only refusal

`mantle_edit_check_ro`, a statement trigger on every item table but
`node_acl_head` (a heads lock is not a change), `WHEN mantle.write_mode =
'ro'`, on every session: a read key, an assistant with no user, a public
link, a peer and a contact share without Can write write nothing (plan
4.1). It covers the system pool too: `systemUnder` keeps such a caller's
system work read only. A named read-path write (`READ_PATH_WRITES`,
`packages/db/src/actor.ts`) runs as `system(<name>)`, read-write, for any
caller. A3a named two more: a public link's view counter
(`backfill:link-views`) and the Recall prompt embeddings a reader's
`recall_match` heals (`backfill:recall-prompt-embeddings`).

## A contact share writes its app's data only

`mantle_edit_check_contact` (migration 0294, A8 matrix F9), a statement
trigger on every item table but `app_databases` (its app's data) and
`node_acl_head`, `WHEN mantle.actor = 'contact:rw'`: a contact share with
Can write runs its write as named system work on the system pool, after
the `/s` broker's own check, and the database refuses any statement of it
on another item table (detail `ro_actor`). It is of the edit check's
family: `mantle_set_edit_check` switches it, warn reports, on refuses. The
export bookkeeping a contact's write starts (the dirty stamp and the
debounced sync of the app's exported Tables,
`packages/content/src/app-table-exports.ts`) runs as `system(app-export)`,
never the request's actor. Migrate's sync of the matrix-made triggers
leaves both migration-made triggers alone
(`EDIT_CHECK_MIGRATION_TRIGGERS`, `packages/db/src/access-matrix.ts`).
Both are installed by one loop, `mantle_edit_check_item_triggers()` (0294):
every item table gets the read-only refusal and, but `app_databases`, the
contact share's, by `CREATE OR REPLACE TRIGGER` (a SHARE ROW EXCLUSIVE lock,
so reads go on while it runs on a live box), then the box mode is applied.
A migration that adds an item table calls it.

## The heads locks filter by the scope

`mantle_lock_heads` and `mantle_lock_heads_more` (and so
`mantle_lock_heads_nested` and `mantle_lock_subtree_heads`, which call
them) drop, for a write-role caller (`mantle_caller_is_write_role`: the
session, or the `role` setting of the per-database login and the checked
rerun), the ids whose `read_ws && mantle_scope_ws()` is false. Through the
gate: `warn` reports and locks them all, `on` drops them.

## The derived keys and the presentation keys

- `mantle_node_derived_keys()` lists the keys of `nodes.data` only the brain
  sets: the extractor's, the refold's, and markers of system work. The same
  list, with each key's writers, is `DERIVED_KEY_WRITERS`
  (`packages/db/src/edit-check.ts`); `packages/db/src/edit-check.test.ts`
  holds each writer to its key and reads the extractor's writes against the
  list. A non-system write may clear a derived key (an edit invalidates
  what the brain derived from the old content), never set or change one; a
  new node's are dropped (above).
- `mantle_node_presentation_keys()` is `rank`: a change of it alone needs
  edit of the item or of its folder (the write check's exemption, plan
  20.3).
- `mantle_node_extractor_keys()` names the 13 keys the extractor writes
  about a file's bytes: the read-only snapshot copy trigger (0267) now reads
  it (the same 13, so the same answers), and the derived keys start with
  it.

## Folders

A folder's rename or move rewrites the path of everything below it. On the
write role a plain UPDATE reaches only the rows the scope reads and would
leave the rest orphaned under the old path (for a Files folder: a file's
row no longer where its bytes are). So every folder rename and move, node
folders (`packages/content/src/tree/node-ops.ts`) and Files folders
(`packages/files/src/ops/folders.ts`, `packages/files/src/move-copy.ts`),
goes through one definer, `mantle_subtree_rewrite(owner, old_path,
new_path)` (0282). For a write-role caller it asks manage of the folder's
home first (the move check asks the same in every mode), then:

- a RENAME (the same depth and the same path above it) moves every row
  below the folder, the ones the caller cannot read too, and takes their
  heads;
- a MOVE (a new parent) of a folder that holds rows the caller cannot read
  is refused (the owner's rule, 2026-10-13): 409, "This folder holds items
  you cannot move.", nothing moved. A Files folder is asked before its
  directory moves; a directory that cannot be moved back is logged.

Every folder delete (node folders, Files folders by the tree and by the
plain Files route and `folder_delete`) that would leave such rows behind is
refused the same way. The one rule is `mantle_subtree_refuse_hidden`
(42501, detail `hidden_rows`), always called inside a write transaction:
it follows the login write gateway, so it refuses only a caller on the
write role. Where it applies: a box whose actor check is `warn` or `on`,
for a login's (member, Admin turn) scoped write; never the system pool (an
Admin user's HTTP request until A4, workers, scripts), so a box whose
actor check is off answers exactly as before. It is not staged by
`mantle.edit_check`: it fixes orphans the write role made. A Files delete
names no file it refuses for (a count only).

The tools say the same words (`databaseErrorPublic`, the tool text of the
one mapper `mapAccessError` in `@mantle/std`, on every tool exit: a thrown
error and a tool's own error reply alike).

In `warn`, a rename over rows the caller cannot read logs one actor miss
whose check name starts `edit: heads lock:` (the heads `on` would drop at
the first lock; the rewrite then takes them itself). It is the rename's,
not drift: count it apart (`check_name like 'edit: heads lock:%'`).

A folder MOVE also holds every app inside it to the placement rule (a
workspace the destination adds needs a Moderator of it), as the move check
holds an app moved itself; a workspace the app, or a folder between it and
the moved folder, has "Removed here" is not added and does not count; a
rename asks nothing. That one is new and staged: `off` does not even
compute it, `warn` reports, `on` refuses.

## The write-role gaps

A3a moved `node_snapshots`, the Recall tables and `shares` to the write role
with the checks above. A secret's sealed value goes through
`mantle_secret_put(node, sealed, key_version)` and a renamed Recall map's
cross-map options through `mantle_recall_retarget(map, old_slug,
new_slug)`: definers that check only while a scope is set, through the edit
check's gate, so the role still holds no right on `secrets` and never
writes another map's cards itself. The two tables A3a left as gaps are
write-role tables since plan v3 S3 (docs/actors.md, "Plan v3 S3"):
`profiles` writes the login's own row, or the brain's with the Settings
area (owner decision 2026-10-17), and `app_table_exports` is read and
written by a manager of the app. The rerun mechanism is gone.

On a box whose actor check is `warn` or `on`, the moved tables' row rules
apply at once, with the roll, whatever the edit check: they ride the actor
check's switch. A write to a history row, a Recall map or a link that the
scope does not read matches no row. So the Admin MCP and the Admin
assistant (an Admin turn, on the write role) answer "not found" for a
Recall owner action (prompt confirm, map publish, revision restore, card
reorder) on a map not granted to Admin; an Admin user's own HTTP request
stays on the system pool until A4.

## The tests

- `packages/db/src/matrix/write-grid.db.test.ts`, the exit: every
  workspace kind, placement and write, as each login and each actor kind,
  at SQL level with both checks on, against the oracle
  (`packages/db/src/matrix/oracle.ts`, `expectedWrite`, written from the
  guide). It needs no switch in production code.
- `packages/db/src/edit-check.db.test.ts`: the switch, `off` / `warn` /
  `on`, the read-only refusal, the heads filter, the keys and columns, the
  app switches, contact shares, the definers, migrate's sync, coverage.
- `pnpm test:edit-on`: the write-path cells with both checks on
  (`MANTLE_TEST_EDIT_CHECK` switches each scratch database, as an operator
  switches a box).

## Cost

- `off`: every edit check trigger is disabled; no statement and no round
  trip is added (`server/web/server/a2a-round-trips.db.test.ts`, also with
  `MANTLE_RT_BASELINE=1`).
- `warn` and `on`: the checks run inside triggers, so no statement and no
  round trip is added either. A page, drawing or table save fires nothing
  new (only a delete has a check); a node update fires the derived keys'
  trigger only when `data` changes.
- p95 per write, the edit check off against on (2026-10-13, a restored
  Bible brain copy: 3,762 items, 122,277 chunks; the write role, a Write
  grant member, the actor check on; 400 transactions per path, in
  alternating blocks; a 62 KB page):

  | Write            | off p50 / p95 (ms) | on p50 / p95 (ms) | p95 on less off |
  | ---------------- | ------------------ | ----------------- | --------------- |
  | page save        | 8.99 / 10.29       | 9.09 / 10.65      | +0.36           |
  | draft save       | 5.78 / 6.82        | 6.02 / 6.64       | -0.18           |
  | title edit       | 1.89 / 2.23        | 1.85 / 2.04       | -0.19           |
  | rank drag        | 1.92 / 2.26        | 1.94 / 2.28       | +0.02           |
  | create in folder | 4.10 / 4.52        | 4.11 / 4.65       | +0.13           |

  Within the run's noise: no path pays a measurable cost.

## Known limits

- **The system pool is not checked by the per-table checks.** An Admin
  user's HTTP write (until A4), the workers and the scripts run there; the
  TypeScript checks stay for them (and everywhere: none is removed before
  its database check is on on every box, plan 7 step 4).
- **The tools** (MCP, the assistant's tool loop) answer `not found` for a
  `no_read` refusal (D2) and "This folder holds items you cannot move."
  for a folder's 409 (`databaseErrorPublic`, the tool text of
  `mapAccessError` in `packages/std/src/access-error.ts`, on every exit); every other database error stays the one public
  message.
- **The settings are not a credential.** Any role can set
  `mantle.write_mode`: on the write role a session that sets `rw` skips
  only the read-only refusal; the per-table checks and the row rules still
  hold. No caller-shaped SQL reaches Postgres today.
- **D4 changes what a Write grant may do** with an app's code once the edit
  check is on: the app's own gate still asks edit, so such a save is a 403
  from the database. Watch the `edit:` misses in `warn` before `on`.
