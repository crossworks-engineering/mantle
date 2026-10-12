# Access levels (replaced by workspaces)

Levels are gone. Items, agents and tool groups no longer carry an admin,
team, client or public level that decides who reads them. Who reads and
changes an item is its grants to workspaces, set on the workspace screen
and in the item's Grant Access panel. Read
[workspaces.md](./workspaces.md).

- The item level columns (`nodes.audience`, `share_level`,
  `inherited_level`, `embedded_level`) were archived and frozen by the
  switch (migration 0261, workspaces W5b2). The agent and tool group
  levels were frozen by migration 0268 (W7b). Nothing reads them for
  access.
- `GET|PATCH /api/access/nodes/:id`, folder shares and `access_set` on an
  item are gone (410 `gone`, or refused). The shadow report and the
  nightly `share-drift` sweep are gone.
- A public link serves its item and its served list
  (`shares.settings.served`, migration 0262): [sharing.md](./sharing.md).
- The client logins and their level are gone too (W8a):
  [client-logins.md](./client-logins.md).
- What this page said about the level model (the four levels, the level
  roles, levels that drove links, client levels) is in the repository
  history before workspaces W8f.

## Operations

The database roles and the restore checks still matter to an operator.

- **Restore** (`scripts/db-restore.sh`) creates the five roles
  (`mantle_view_team`, `mantle_view_client`, `mantle_view_public`,
  `mantle_view_space` and `mantle_view_user`, the workspace role of
  workspaces W1) before `pg_restore` (a dump does not carry roles, but
  its policies and grants name them; migrate later gives them their login
  and password). It restores into a pristine database (it drops the empty
  `postgres` database the init scripts made and creates a new one, and
  refuses a target that holds any item or login), then exits 2, without
  "Restore complete", when the restored brain has no logins, no role CHECK
  (`users_role_ck`), or misses a viewer policy: `nodes_viewer_read`, and
  from migration 0187 on `agents_viewer_read`, `agents_client_read`,
  `tool_groups_viewer_read` and `tool_groups_client_read`. Each check applies
  once the dump's own migration ledger shows the migration that made it, so
  an older pre-roll dump is judged by what its release had. It also exits 2
  when a trigger the dump lists (`pg_restore --list`) is not in the restored
  database. When the checks pass but `pg_restore` reported an error the
  script cannot explain, it finishes its steps and exits 3, and never says
  "Restore complete": something in the dump did not restore.
- **Restores made from migration 0204 up to 0210 lost one trigger**
  (`nodes_share_refresh_after`: pg_dump cannot write its old form so that
  pg_restore can run it). Migration 0212 makes the trigger again in a form
  a dump can carry. To see whether a box has it: `select count(*) from
pg_trigger where tgname = 'nodes_share_refresh_after'` (1 is right). A
  dump from before 0212 still gives the one error; the script makes the
  trigger itself after such a restore and does not count that error. From
  0204 on it fails the restore (exit 2) when the trigger is not there.
  `packages/db/src/dump-restore.db.test.ts` dumps and restores a migrated
  brain and fails on any statement a restore cannot run;
  `db-restore-run.db.test.ts` runs the script itself.
- **Grant drift.** `pnpm -C server/web workspaces:check` compares the
  derived read columns with the grants and reports drift. It reads only.
- **Backups before a roll.** The updater takes a strict four-part backup
  (Postgres, app-dbs, table-dbs, spaces) into `backups/pre-roll/` before
  every server roll and refuses the roll when it fails (docs/update-prod.md).
  Restoring one of them is the only way back past a forward-only migration.
- **Every box connects as the Postgres superuser**, which bypasses row
  level security for system work. A user's reads run on the workspace role
  (`mantle_view_user`) with row security on. The `demo` branch's
  `demo_reader` role is NOT a superuser: it needs
  `ALTER ROLE demo_reader BYPASSRLS` (on the demo branch).
