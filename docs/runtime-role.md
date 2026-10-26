# The runtime role (arch A9)

The app's own database connections stop logging in as the superuser that runs
the migrations. Plan v2 (workspaces arch, phase A9, section 4.2): a role that
is not a superuser and not a table owner cannot disable a trigger, alter a
table, set `session_replication_role` or change `mantle.actor_check`, so the
actor check, the edit check and the row rules hold even against a bug or an
injected statement in the app.

Code: `packages/db/src/runtime-role.ts` (the roles, the rights, the URL),
`packages/db/src/migrator-steps.ts` (what migrate runs around the migrations),
`packages/db/src/runtime-role.db.test.ts` (the proof).

## The roles

| Role                                                         | Logs in                              | What it is                                                                                                                                           |
| ------------------------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres` (the compose superuser)                           | yes                                  | the migrator: `DATABASE_URL`. migrate, pg_dump backups, pg-boss, the DBOS runner database, the workspaces switch, hand psql                          |
| `mantle_owner`                                               | no                                   | owns every table and sequence of `public` and `auth`, and `mantle_acl_internal()`. migrate hands them over after the migrations. `BYPASSRLS` (below) |
| `mantle_runtime`                                             | yes, when `MANTLE_DB_RUNTIME_ROLE=1` | the app's system pool and its LISTEN connections. Not a superuser, owns nothing, `BYPASSRLS`, `NOINHERIT`, data rights only                          |
| `mantle_system`                                              | no                                   | holds no right and owns nothing. May `SET ROLE` to the write role and the gap writer: what the system pool had by being the superuser                |
| `mantle_system_narrow`                                       | no                                   | the narrow system role (below): `BYPASSRLS`, owns nothing, member of nothing, rights from the access matrix. Nothing runs on it yet                  |
| `mantle_view_user`, `mantle_write_user`, `mantle_gap_writer` | as before                            | the scoped pools, unchanged. They lose `EXECUTE` on the setter functions (below)                                                                     |

`mantle_runtime` holds:

- `SELECT, INSERT, UPDATE, DELETE` on every table of `public` and `auth`, but
  the tables the access matrix marks `runtime: 'none'` (`mantle_heads_key`,
  `mantle_moved_nodes`, `mantle_bridge_pending`: only definer functions touch
  them), and only `SELECT` on those it marks `runtime: 'read'` (`workspaces`,
  `workspace_users`, `workspace_events`, `workspace_resources`: every write
  is a definer call, so a system-pool write outside one is refused, 42501;
  `ws-runtime-read.db.test.ts`);
- `USAGE, SELECT, UPDATE` on every sequence there;
- `EXECUTE` on an allowlist, not on every function less a denylist
  (`runtimeFunctionAllowlist`): what `PUBLIC` or a viewer role may run, plus
  `RUNTIME_SYSTEM_FUNCTIONS`, the few functions taken from `PUBLIC` that the
  system pool calls itself, each listed with where it is called
  (`mantle_actor_miss_log`, `mantle_check_box_mode`,
  `mantle_embed_host`, `mantle_ws_attach_assistants`,
  `mantle_ws_private_workspace`, `mantle_ws_skip_reason`,
  `mantle_file_restamp_home`, `mantle_tg_login_moderates`). Everything else
  taken from `PUBLIC` is out of its reach: the workspaces switch and its steps
  (`mantle_ws_migrate`, `mantle_ws_migrate_bridged`, `mantle_ws_bridge_off`,
  `mantle_ws_spaces_fold`, `mantle_ws_review_off`, `mantle_ws_team_normal`;
  the app runs the switch as the migrator, `mantle_ws_migrate_locked` through
  `executeAsMigrator`), the trigger bodies (a trigger needs no `EXECUTE` to
  fire) and the derivation's internals. A function a new migration takes from
  `PUBLIC` is not the runtime role's until a line in that list says why;
  the test pins the list. Never on the list, and also taken from `PUBLIC`
  and from every viewer role (`RUNTIME_DENIED_FUNCTIONS`): the check switches
  (`mantle_set_actor_check`, `mantle_set_edit_check`, `mantle_set_check`, the
  trigger switches), the heads key's primitives (`mantle_heads_mac`,
  `mantle_heads_sig`, `mantle_heads_set` and the named heads-check bypass),
  the actor setters (`mantle_set_actor`, `mantle_operator_actor`:
  packages/db sets the actor with `set_config`, the
  `actor-setters-in-db-only` lint) and the schema-changing steps
  (`mantle_write_role_sync_table`, `mantle_ws_ddl_retry`,
  `mantle_ws_switch_off`, `mantle_ws_migrate_locked`);
- `USAGE` on schema `pgboss` and `SELECT` on its tables, read only: the
  extract backlog, the OCR rescan and the integrity page count its jobs.
  migrate makes the schema when it is missing (pg-boss installs into it), so
  the default privileges cover the tables pgboss:init makes right after.
  No pg-boss routine: pg-boss makes them with PUBLIC's default `EXECUTE`
  (`job_table_run` runs its text as SQL, as its caller), so every migrate
  and pgboss:init, right after pg-boss installs or upgrades, take it from
  PUBLIC (`revokePgBossRoutines`; a per-schema default privilege cannot take
  a global default away). pg-boss itself runs as the migrator, their owner.
  The `runtime_role_lock` integrity row names a routine the runtime or the
  narrow role may still run;
- membership in `mantle_owner` without `INHERIT` and without `SET` (a
  member that holds none of its rights and cannot become it), membership in
  `mantle_system` with `SET` only, and nothing else: a hand grant, or one of
  these with other options, is taken back at the next migrate. The role is
  `NOINHERIT`, so a hand `GRANT` without options gives it no rights even
  before that migrate.

No other role is a member of `mantle_owner`, `mantle_system` or
`mantle_runtime`: migrate takes back every membership held in the three but
the two above. A member of `mantle_runtime` is a member of `mantle_owner`
through it, whatever the options (`GRANT mantle_runtime TO mantle_view_user
WITH INHERIT FALSE, SET FALSE` was enough), and `mantle_owner_role()` says
yes to every member.

Each of those revokes names its grantor and cascades. An operator's `GRANT
mantle_system TO ops_a WITH ADMIN OPTION`, passed on by `ops_a` to `ops_b`,
leaves a membership that rests on the first, and a plain `REVOKE` is refused
(`2BP01`, dependent privileges exist): migrate would exit 1, and web and the
workers, which wait on it, would not start. So migrate takes the far end of
a chain first, and the dependents, memberships in the same role, go with
the one they rest on. Every membership taken back is one line in the
migrate log (`WARNING membership taken back: <role> from <member> (granted
by <grantor>)`). A revoke that fails for any other reason is a warning too,
never a failed migrate: the integrity row `runtime_role_lock` shows what is
left.

`CREATE` on schema `public` is taken from `PUBLIC`, so the runtime role makes
nothing there (it cannot replace a function it could otherwise shadow).

Two tests in SQL were written against a superuser system pool.

- `mantle_owner_role()` (0241, the derivation's guards) asks about the owner
  of `mantle_acl_internal()`. Since 0290 it asks for membership (`MEMBER`),
  not for that owner's rights (`USAGE`). The marker is `mantle_owner`'s, and
  the runtime role is its member without `INHERIT` and without `SET`, so the
  guard says yes to the runtime role as it did to the superuser, and no to
  the write role. The runtime role cannot drop or alter the marker, nor
  `DROP OWNED` or `REASSIGN OWNED` for its owner: before 0290 it had to
  inherit the owner to pass, and so could (audit M1). A marker dropped or
  changed anyway (by hand, as the superuser) is made again by the next
  migrate (`ensureAclMarker`), and until then the integrity row
  `runtime_role_lock` names it. A `mantle_owner_role()` that is not the
  `MEMBER` version (0290 skipped) refuses the runtime role at every write
  guard: the integrity row names that too, and migrate warns about it on
  every run until 0290 is in.
- The checked rerun (client.ts, gone since plan v3 S3) did `SET LOCAL ROLE`
  to the write role and the gap writer, which needs a membership with `SET`;
  both memberships stay one release (S3 part 2 drops them). It went through
  `mantle_system`, never directly: 0277 and 0278 count only a direct
  membership as "the write role's login", so the system pool is still not
  one, as it was not as the superuser. `mantle_system` owns nothing and holds
  no right, so the runtime role gains nothing by `SET ROLE` to it.

Why `mantle_owner` reaches more than its tables: Postgres runs a foreign key's
check and its cascade (and the triggers a cascade fires) as the owner of the
table queried. As the superuser's tables these ran as the superuser, so
`mantle_owner` gets `USAGE` on both schemas, every right on their tables and
`EXECUTE` on every function, and `BYPASSRLS`: a trigger a cascade fires
(`notify_runs_changed`, `notify_conversation_changed`) reads past the row
rules, as the superuser did, also on a table migrate left with its old owner
(a busy one, below), where the owner of the tables is not the table's owner.
As the marker's owner it passes `mantle_owner_role()` there too. Nobody logs
in as it, and nobody holds its rights: the runtime role is its member without
`INHERIT` and without `SET`, and `BYPASSRLS` is never inherited.
So `FORCE ROW LEVEL SECURITY` on a table would not bind a cascade either:
`BYPASSRLS` passes a forced row rule too, so a rule meant to hold a cascade
back needs another way (a trigger, or a check in the definer function).

The password of `mantle_runtime` is derived from `MANTLE_MASTER_KEY`
(HKDF, its own label), as the viewer roles' are. There is no secret to create
or store, and migrate sets it again on every run, after a restore and after a
master-key change. One brain per Postgres cluster: with
`MANTLE_VIEWER_ROLES_PER_DATABASE` the role gets no login and the app refuses
the switch.

`mantle_runtime` logs in only on a box that has switched: migrate gives it
`LOGIN` and its password when it sees `MANTLE_DB_RUNTIME_ROLE=1` (the compose
`migrate` service gets the variable through the `x-app-env` anchor, as every
app service does), and `NOLOGIN` with no password when it does not. So a box
that never switches has no login it does not use, and taking the switch out
again closes the login at the next migrate. Its log says which:
`runtime role mantle_runtime: LOGIN (MANTLE_DB_RUNTIME_ROLE is on)`, or
`NOLOGIN` with the cause that holds: the switch is off, per-database mode,
or the switch is on with no `MANTLE_MASTER_KEY` to derive the password from.
The narrow role's line reads the same with `MANTLE_NARROW_SYSTEM`.

A statement that sets a password (the runtime role's, the viewer roles')
runs in a transaction of its own that first sets, for that transaction only,
`log_statement = 'none'`, `log_min_duration_statement = -1` and
`log_min_error_statement = 'panic'`: no server log line prints its text, not
even when it fails (a "tuple concurrently updated" retried, say). What
remains: while it runs, `pg_stat_activity` shows the text to a superuser or a
member of `pg_read_all_stats`, and an extension that records statements
(`pg_stat_statements`, `pgaudit`; the compose Postgres loads none) would
see it.

## The narrow system role

`mantle_system_narrow` is the role narrow system work will run as: an exit
that needs past the row rules but writes no item (an Admin-area tool, an
area request, traces, spills, counters). It is `NOSUPERUSER`,
`BYPASSRLS`, `NOINHERIT`, `CONNECTION LIMIT 36`, owns nothing and is a member of nothing (the
text check below refuses the large-object functions, but it is not the
boundary: migrate takes `EXECUTE` on the server-side creators, `lo_create`,
`lo_creat`, `lo_from_bytea` and `lo_import`, from `PUBLIC` every run, in
each database it runs in (`revokeLargeObjectCreators`; no role the app runs
as makes a large object, measured), so the narrow login can make none and
own none). The runtime role is its member with `SET` only (`wantedMemberships`), so the
runtime role holds none of its rights and may take it; the superuser may take
it as any role. Migrate makes it and its membership on every run
(`ensureRuntimeRoles`), and a hand grant to it or from it is taken back like
the others'. It logs in only when migrate sees `MANTLE_NARROW_SYSTEM` on,
as the runtime role follows its own switch: `LOGIN` with a password derived
from `MANTLE_MASTER_KEY` (HKDF, the runtime role's scheme with its own
label, `runtime-role:mantle_system_narrow`), `NOLOGIN` with no password
otherwise, and always `NOLOGIN` in per-database mode (one cluster, several
brains: one password cannot be every brain's). Migrate logs which. When
the switch is on but migrate could not run the roles step (it does not
run as a superuser, or the server is older than Postgres 16), it warns
that the narrow role was not made or given its login, so unless an
earlier migrate did every narrow statement fails closed, and names the
fix: migrate as a superuser on Postgres 16 or later, or the per-box kill
switch `MANTLE_NARROW_SYSTEM=0` and a full `docker compose up -d`
(`narrowLoginWarning`, migrator-steps.ts). The
narrow route's own pool logs in as it (below), whatever the system pool
logs in as: with `MANTLE_DB_RUNTIME_ROLE` off (the system pool is the
superuser) the narrow pool still logs in as the narrow role, so a fresh
install with the runtime role off and the switch on works, and the narrow
work there can no more reach the superuser than on a box with the runtime
role on.

Its rights, made equal to the access matrix at every migrate inside
`applyRuntimeGrants` (`applyNarrowGrants`), from `narrow` in each row of
`packages/db/src/access-matrix.ts` (`narrowFor`):

- derived when a row sets none: the runtime role's `'none'` stays `'none'`
  and its `'read'` stays `'read'` (definers write those); a `content` table
  is `'read'`; a `system` or `admin` table is `'all'`. A row may set a
  narrower value than the derived one, never a wider one (it throws);
- on an `'all'` table, `SELECT`, and WRITES ONLY AS A MEASURED ALLOWLIST
  (`NARROW_WRITES`, access-matrix.ts; S7b part b2 round 8, the class fix of
  the full audits: the writes were derived by table name, so a rights table
  with a plain name was writable): `INSERT` where listed, `UPDATE` of only
  the listed columns (always column-level), `DELETE` where listed. A table
  or column not listed is read only, so a new one is closed by default.
  Measured with the switch on over the full DB suite, actor-off, actor-on,
  edit-on, runtime-role and the area-route sweep (a row trigger on every
  table and the statement log; an `INSERT ... ON CONFLICT DO UPDATE` needs
  `UPDATE` on every column its `SET` names even when no row conflicts, so
  the statement log's columns count, not only the rows a trigger saw).
  Never on it (`NARROW_NEVER_UPDATE`,
  `NARROW_NEVER_INSERT`): a maker, owner, login, workspace or agent column,
  a destination (base URLs, vault key ids, a handler, an integration, a
  redirect URI, a root path), what runs (a run's status, a run item's
  state, a pending call's tool, arguments and origin, a skill's
  instructions, a heartbeat's schedule, assistant and skill), and an
  insert into a table whose row is executed, decided or grants (runs, run
  items, pending calls, heartbeats, skills, tools, tool groups, agents,
  channels, AI workers, the embedding row and the rest of the list). Those
  writes run at a full-route spot, one per job (`run-control`: a run made,
  appended, answered, its budget decided or cancelled; `model-route`,
  `tool-config`, `heartbeat-maker`, `skill-text`, `pending-park`,
  `docs-root`, `agent-group-grant`, `push-device`: a phone subscribed and
  the push relay), where `systemDb`
  takes the system pool too. The screens and tools that edit such a table
  call `onNarrowSpots` (packages/db/src/narrow-spots.ts): one list,
  `NARROW_TABLE_SPOTS`, names per table the spots a write may need (an
  assistant's grant, its text, its vault key; a worker's prompt and its
  route; a group's tools and its integration), `narrowSpotFor` reads it
  with the allowlist (`narrowNeedsSpot`), and a write that needs two spots
  enters both. The lint reads the same list: a call names its spots by its
  table, each listed for the calling file. A run that names no login runs
  as the owner, so only an assistant assigned to no login may make one. A
  narrow session can
  therefore no longer forge a run the sweep executes, a heartbeat that
  fires as the anchor, a skill's text, a parked call, or point a vault key
  at another host (narrow-allowlist.db.test.ts). The runs worker checks a
  run's maker too: an item of a run that names neither its assistant nor
  its login, or a login that is gone, never runs. With the switch off,
  migration 0320 counts, report only, each write a narrow reason makes on
  the full route that the role would refuse (a table or column privilege,
  0319's one-way rules): `narrow-would-refuse` miss rows, read by
  scripts/arch-scoreboard-box.sh; its triggers are derived from the role's
  live grants on every migrate, so an allowed write fires none. A
  `systemDb` write inside a login's turn or request scope (which the narrow
  route takes with the switch on, whatever its actor) carries the login's
  actor, so the gateway marks its actor settings `mantle.route = 'narrow'`
  (gateway/pools.ts getScopeMarkedDb) and the counts take the mark
  (`mantle_narrow_counted`, round 10): the count has no blind spot there
  while the actor check is in warn or on (with it off no actor is sent, as
  before);
- the credential and rights tables within it: `auth.users`:
  `display_name`, `disabled_at`, `session_epoch` and `DELETE` (never `role`,
  `password_hash`, `email`, `is_owner` or `contact_id`, and no new login);
  `access_keys`: `revoked_at`, `revoked_by`; `oauth_access_tokens` and
  `mobile_tokens`: `revoked_at`; `pairing_codes` and `oauth_auth_codes`:
  `DELETE` only; `member_invites`, `peer_shares` and `peer_share_scopes`:
  `revoked_at`; `mantle_peers`: `last_contacted_at`, `updated_at`, and the
  unbind of a session end (`acts_as_login_id`, `ended_acts_as_login_id`);
  `telegram_chats`: no write; `agents`: every column but its grants
  (`tool_group_slugs`, `role`, `workspace_id`, `slug`, `owner_id`, `id`)
  and its routes' keys, base URLs and configuring login (`model-route`),
  `assigned_user_id` only released, `memory_config` but its `delegate_to`
  key (a delegate runs with its own tool groups for the caller, so naming
  one is a grant: round 7); `tool_groups`: `name`, `description`,
  `integration`, `enabled`, `configured_by`, `updated_at` (never
  `tool_slugs`, `slug`, `admin_only` or `owner_id`; since round 8 not
  `integration` or `configured_by` either: `tool-config`), and neither table's
  `DELETE`. Measured with the switch on (every statement
  the narrow login sent in the full DB suite, `log_statement = mod`; then a
  trigger logging each row the narrow login wrote on these tables with its
  actor, S7b part b2 round 5). A new login, a role change, an enable, a
  contact link and a password run at the full-route spot
  `login-credential`; a pairing code, an MCP authorization code, a member
  invite, a peer's way in, a peer share and a Telegram chat's pairing each
  at its own spot (`pair-code`, `oauth-code`, `member-invite`,
  `peer-access`, `peer-share`, `telegram-pair`); an assistant made, cloned,
  granted a tool group or a delegate, or assigned to a login at
  `assistant-grant`, a tool
  group made, removed or its tools changed at `tool-group-grant` (S7b part
  b2 round 6). The model routes, keys and a group's integration stay
  writable: outbound configuration, as `api_keys`;
- one way on the columns a right is taken back by (migration 0319,
  `mantle_narrow_one_way`, a BEFORE UPDATE trigger that holds only the
  narrow role): a revoke (`revoked_at` of access keys, OAuth tokens, device
  tokens, invites and peer shares) and a disable are never cleared, a
  session epoch is never lowered, a peer's `acts_as_login_id` and an
  assistant's `assigned_user_id` change only to NULL,
  `ended_acts_as_login_id` only to the old binding, and an assistant's
  `memory_config` `delegate_to` key never changes (`keep:`). A column
  right alone would let the narrow role bring a revoked credential back;
- `USAGE, SELECT` on the sequences its `'all'` tables draw from, never
  `UPDATE` (`setval`);
- `EXECUTE` on an allowlist, `NARROW_SYSTEM_FUNCTIONS`
  (`packages/db/src/runtime-role.ts`), measured with the switch on (the full
  DB suite; `MANTLE_NARROW_DUMP`'s `fn:<name>` uses, quoted names counted):
  what narrow statements call by name, ten today (the read definers
  of the login-self routes, the Admin area's approvals and the email
  discover; `mantle_brain_id`; 0321's message guard read). No writer on an
  area exit is left on it: the five that need the exit's login
  (`mantle_ws_set_moderator`, `mantle_tg_chat_set`, the structure and
  assistant delete definers, and `mantle_ws_attach_assistants`, the
  onboarding attach) run at the full-route spot `acting-login` through one
  helper, `atActingLogin` (gateway/acting-login.ts), each caller's own
  transaction inside it (0322: the identity readers answer no login on the
  narrow role). A secret's sealed row is written by the structure helper
  itself; its caller passes only the sealed value, no statement;
  `mantle_bridge_login` left it with the role change (and was dropped in
  0334), and the promotion
  definer `mantle_space_settle_promotion` in S7b part b2 round 5, all
  denied by name), and what the column defaults and checks of the
  tables it writes call (none today; runtime-role.db.test.ts reads them from
  the catalog and fails on one not listed). Each is also the runtime role's.
  `NARROW_DENIED_FUNCTIONS` may never be listed: the owner bodies with no
  Admin check (`mantle_contact_sharing_rows`,
  `mantle_contact_shares_revoke_rows`, `mantle_share_with_contacts_rows`,
  `mantle_entity_merge_rows`), the other content and workspace writers among
  the definers (the other `mantle_ws_*` writers, `mantle_workspace_event`,
  `mantle_lock_heads`, `mantle_share_close_admin`,
  `mantle_share_contact_write_set`, the grant, subtree, recall and app trash
  writers), `mantle_embed_host` (the refold step) and `mantle_role_drift`
  (the box count);
- `USAGE` on `public`, `auth` and `pgboss`, `SELECT` on pg-boss's tables;
- no default privileges: a table a migration makes is closed to it until the
  migrate's grants, and a table the matrix does not list never opens. A new
  `content` row is read only by the derivation.

It is not a member of `mantle_owner`, so `mantle_owner_role()` says no to it
and the derivation guards treat it as a limited role; it writes no content
table anyway. Postgres runs a foreign key's cascade as the table's owner, so
a narrow delete that cascades into a content table is not stopped by these
grants. `SET ROLE` asks the session's login: on the route's own pool the
login is the narrow role, a member of nothing, so a statement that resets
or changes the role lands on the narrow role again (it cannot `SET ROLE` to
any role, has no `SET SESSION AUTHORIZATION`, makes no temporary object;
`narrow-login.db.test.ts`). Only the per-database fallback, which takes the
role per transaction from the system pool's login, has a role to go back
to there; its hold check and text check stay. The actor stays
`system:<reason>` either way.

`runtime-role.db.test.ts` pins the attributes, the membership, the live
grants table by table against `narrowFor`, the function list against the
runtime role's, and the writes it is refused, taken from the runtime role and
from the superuser. `runtime-role.test.ts` pins the derivation and the counts
of `'all'`, `'read'` and `'none'` tables.

### The narrow route

`MANTLE_NARROW_SYSTEM` (feature `narrowSystem`): on by default everywhere
since S7b part b3 (production, development and tests); `0`, `off` or `false`
turns it off on a box (the kill switch, below). Read once per process when
the system pool opens, and a production process logs it with the pool's
login; migrate reads it too and gives the role its login only while it is
on. Off, every statement runs as before.

#### The kill switch

Per box, with no image change: set `MANTLE_NARROW_SYSTEM=0` in the box's
`.env` (`off` and `false` read the same), then a full `docker compose up
-d` (restarting the app containers alone runs no migrate, so the role
keeps its login).
Compose passes the switch to the migrate gate and to every app process
(x-app-env), so migrate runs first and makes `mantle_system_narrow`
`NOLOGIN` again, and each process starts on the full route (its boot line
says `narrow system route off`). Nothing in the database changes: the
column rights, the definers and the one-way rules stay, and hold only the
narrow role, which then runs nothing. To turn it back on, remove the line
(or set `1`) and `docker compose up -d` again. A process that reads the
switch on while migrate saw it off fails its narrow statements closed and
names the fix (`NARROW_LOGIN_FIX`); compose cannot produce that, since both
read the same `.env`.

What the default means for each shape:

- A fresh install: on. Compose's `MANTLE_NARROW_SYSTEM` is empty, so
  migrate gives the role its login (its password derived from
  `MANTLE_MASTER_KEY`, which compose requires) and the app opens the narrow
  pool on its first narrow statement. `MANTLE_DB_RUNTIME_ROLE` may be off:
  the narrow pool logs in as the narrow role either way.
- Per-database mode (`MANTLE_VIEWER_ROLES_PER_DATABASE`, several brains on
  one cluster): on, on the S7a route. The role has no login there (one
  password cannot be every brain's), so the system pool takes the role per
  transaction, with the hold check and the text check as the boundary.
- An existing box rolled to this release: on at that roll, with nothing set
  in its `.env`. Before the fleet flip the CEO reads the box counts
  (`scripts/arch-scoreboard-box.sh`) at 0 under the owner's rule (The
  narrow write count, below); the list is in
  docs/_archive/plan-v3-s7b-handover.md, part b3. The flip release also
  carries the b3 checklist (0328's wider grant hold, the text check
  counted, the box script's new lines): those ran on no box before it, and
  the switch is their fallback too.
- A box pinned back to an image before b3 (b2, v0.300.133 or .134): that
  image reads an unset switch as off in production, so the pin alone takes
  the box off the narrow route; a box that set `MANTLE_NARROW_SYSTEM=1`
  keeps it on (the one image back paragraph below says what that needs).

The kill switch's cells: `runtime-role.test.ts` (unset on in every
environment; `0`, `off`, `false` off in production too; read once per
process), `narrow-route.db.test.ts` ("off: every reason runs as the pool
login": an asSystem exit, its transaction and a request exit all on the
pool's own login), the full DB suite run with `MANTLE_NARROW_SYSTEM=0`, and
the drill's rows (migrate with the switch unset gives the role its login;
with `0` or `off` it takes it away).

On, a statement the system pool sends
for an exit routed `'narrow'` runs as `mantle_system_narrow`
(`packages/db/src/gateway/narrow-route.ts`):

- on the route's own pool (`gateway/pools.ts` `narrowPoolSql`, made by
  `newNarrowPool`): its connections log in as `mantle_system_narrow`
  (`narrowDatabaseUrl`), two per process at most (`NARROW_POOL_MAX`), opened
  on the first narrow statement (a process that runs no narrow work opens
  none) and closed after 30 idle seconds. The role's `CONNECTION LIMIT` of
  36 is sized to every pool a box may open at once: the 12 compose
  processes that take the app env at 2 each (24), up to 4 stdio MCP servers
  (8) and 2 operator runs, a maintain run and one more CLI (4)
  (`connection-ceiling.test.ts` reads the compose file and fails when that
  sum outgrows the limit, or the box's pools outgrow 90% of
  `max_connections`: the full shape 373 of 405, 393 of 450 with the stdio
  servers' and the operator runs' connections). The pool sends startup
  parameters (`narrowStartup`), which win over any setting stored on the
  role (`ALTER ROLE current_user SET ...`, for every database or `IN
DATABASE`, which the narrow login may do and no grant can stop). A chosen
  list, not every setting a session can carry: the ones found to refuse
  narrow work, cut it short, end its session, make a commit return before
  it is durable, or change what a statement reads, writes or parses. Fixed
  at the value the app runs every pool with (compose sets none, so
  Postgres's defaults): `search_path`, `default_transaction_read_only` off,
  `default_transaction_isolation` read committed, `row_security` on,
  `statement_timeout`, `lock_timeout`,
  `idle_in_transaction_session_timeout`, `idle_session_timeout` and (on
  Postgres 17 and later) `transaction_timeout` 0, `exit_on_error` off,
  `synchronous_commit` on, `bytea_output` hex, `extra_float_digits` 1,
  `array_nulls` on, `transform_null_equals` off, `xmloption` content,
  `gin_fuzzy_search_limit` 0. And the system pool's own `TimeZone`,
  `DateStyle`, `IntervalStyle`, `timezone_abbreviations` and
  `standard_conforming_strings`: the values a session of the system pool
  starts with (`pg_settings.reset_val`, never one a session or transaction
  of it set since), read once per process before its first narrow statement
  (`systemStartup`, one statement on the system pool, then never again) and
  taken at each narrow connect, so the narrow route reads dates back in the
  text the system pool does. A read that fails fails the narrow statement
  (`NarrowStartupError`): no narrow connect without its settings.
  Any other stored setting holds until the next migrate, which takes every
  stored setting of the role back each run (`RESET ALL`, and the `IN
DATABASE` form for each database), and the boot line names it; migrate
  sets the derived password again each run (the login may change its own).
  A production process reads the role
  with its boot line (`readNarrowLogin`)
  and, with the switch on, warns when it cannot log in, naming the fix (run
  migrate with the switch on, or set `MANTLE_NARROW_SYSTEM=0`); any stored
  setting it names whatever the switch. A role whose
  login migrate did not open fails the narrow statement, never the system
  pool instead (`NarrowLoginError`, its message the same fix);
- one statement outside a transaction: on one reserved connection, a
  session-level `SET` of the actor, its write mode, the box's check mode
  and the acting login (below), the statement, and a `RESET` of them, as
  the actor client sends a write outside a transaction, through the same
  pipeline (`gateway/actor-sql.ts` `settingsPipeline`): the `SET` goes in
  the statement's first send, the statement commits by itself, the caller
  has its answer before the `RESET` is answered, and a connection whose
  `SET` or `RESET` failed ends instead of going back (every reserve waits
  a bounded time, `reserved.ts` `reserveLease`: the narrow pool's 15 s,
  the system pool's, the user pool's and the index builds' 120 s, which
  only a reserve that never settles reaches, the write pool its own 15 s;
  then a busy error, 409 with a plain "The server is busy" text, never a
  hang; a reserve queued when a connection of a full pool closes is
  answered, and an ending pool reserves nothing, `patches/postgres@3.4.9.patch`). One failure answer on
  both pools: the statement's own result when it ran (a `SET` that failed
  beside it is no error of the caller's: the statement committed, with none
  of the settings, and met the database's checks as a statement with no
  actor), else the `SET`'s error when it failed too, else the statement's.
  No `BEGIN`, no role `SET`, no `COMMIT`. Measured with the check off (a2a-round-trips.db.test.ts,
  statements / round trips): a chat turn's start 104/144 with the switch
  off, 148/166 on the S7a route, 126/155 on the login pool with the `RESET`
  after the answer (the 11 more round trips are the `RESET`s, none on the
  caller's path); page save 15/20 off, 19/22 S7a, 17/21 now. Turn-stream and
  tracing writes stay narrow on these numbers;
- a transaction: the actor's `SET` with its first statement (none with no
  actor), the hold check before its `COMMIT`;
- per-database mode (the role has no login): the role is taken per
  transaction on the system pool, as S7a built it: `BEGIN`, one `SET`
  (`set_config('role', 'mantle_system_narrow', true)` with the actor's
  settings, never a session `SET`), the statement, the hold check,
  `COMMIT`, pipelined on one reserved connection;
- the hold check fails when the transaction is no longer the narrow role's:
  the transaction rolls back whole (`NarrowRoleLeftError`). On the login
  pool nothing can leave the role, so it never fires there; it stays as a
  second line. A statement Postgres refuses inside a
  transaction, and one that opens or ends a transaction, is refused
  (`NarrowRouteRefusedError`);
- the text check (`gateway/narrow-sendable.ts`): a narrow statement starts
  with a read or a row write (`select`, `insert`, `update`, `delete`,
  `merge`, `with`, `values`, `table`, `show`), or is `SET LOCAL` of an
  allowed setting (a `mantle.*` one, `NARROW_LOCAL_SETTINGS`) or `SET
TRANSACTION`; no role change in any spelling, no DO block, no `U&` name,
  no tagged-template placeholder where a function or a setting is named,
  no call of a function that runs its text as SQL (`SQL_TEXT_RUNNERS`,
  shared with readSql: `query_to_xml`, `ts_stat`, pg-boss's
  `job_table_run`, `dblink` and the rest), no call of a function whose
  effect outlives the transaction (`SESSION_LASTING_FUNCTIONS`, shared with
  readSql: `set_limit`, `setseed`, a session advisory lock or unlock, any
  large-object function; the transaction's own `pg_advisory_xact_lock` and
  its kin stay allowed: share-lock.ts and advisory-lock.ts take them), so
  narrow work leaves nothing on the pooled session and makes no large
  object; no text that never closes or that
  Postgres may read otherwise. The text is read by the repo's one SQL text
  reader (`packages/db/src/sql-text.ts`, as Postgres's lexer: nested block
  comments, a `--` comment a `\r` ends, dollar-quote tags and names with
  characters that are not ASCII). The gateway's own settings (the actor, its
  write mode, the check mode, the route, the scope, where a create lands)
  are set only by the gateway's SET. It guards against mistakes, not
  deliberate code: a statement written to leave the role can get past any
  text check, and a fragment a tagged template takes from another
  postgres.js client (another pool's `sql`) is text this client never sees
  at all. The fix for that is a narrow pool that logs in as the narrow role
  itself (S7b), so the session holds no other role to go back to;
- a narrow transaction's statements go out in the order they are awaited
  (as postgres.js sends its own; every route's transaction client does the
  same), so a `SET TRANSACTION` awaited first is the transaction's first
  statement;
- no role the app runs as may make a temporary object: `TEMPORARY` on the
  database is taken from PUBLIC and the narrow role at every migrate
  (`applyRuntimeGrants`) and granted to none (a function made in `pg_temp`
  is code the text check never reads); a migrate after which the narrow
  role still holds it (a migrator that neither owns the database nor is a
  superuser, whose REVOKE only warns) fails.

Who picks it (`packages/db/src/viewer.ts`): `AS_SYSTEM_ROUTE`, a
`Record<AsSystemReason, 'narrow' | 'full'>`, so a new reason must pick, and
`REQUEST_SYSTEM_ROUTE` for the request exits (the guard's `area` and
`login-self`, narrow; the first owner's `first-owner`, full: the signup's
switch onto workspaces, as the boot's). The nearest `asSystem` decides; `systemWork` always runs
full (workers, boot steps; `WorkspaceSystemReason` too). The pick holds only
while the actor the exit bound is still bound: code inside it that binds
another actor (a named repair, the miss log) runs full, as itself.
`systemDb` inside a turn or request scope runs narrow (its traces, spills,
counters and logs); outside every scope it is system work and runs full.

Narrow: `admin-area` (the `systemWhole` tools and `areaSystem`),
`agent-workspace`, `connector-binding`, `connector-call`,
`heartbeat-own-row`, `login-telegram`, `audit-log`, `pending-approval`, and
the request exits `area` and `login-self`. Full, each with its why in
`AS_SYSTEM_ROUTE`'s comment: `app-data`, `rule-in-query`,
`keyword-candidates`, `app-trash`, `page-refold`, `brain-bookkeeping`, and
the system-work and test reasons.

Where a narrow exit's own work writes a content table (measured), that
work runs on the full route, keeping its actor, at a spot named in
`FULL_ROUTE_SPOTS` (`viewer.ts`, `onFullSystemRoute`), each with its why;
the rest of the exit stays narrow: `profile-row` (the login-self routes and
the settings area write `profiles`, the write role's own-login table, with
no scope to carry), `integrity-delete` (the landed delete), and the
others the list names. S7b moves each to the write role in the caller's
scope or to a definer. Two spots are not content writes but rights the
narrow login may not hold (S7b part b2, the interim audit of 0315 and
0316): `login-credential` (a new login, a role change, a contact link and a
password; a role change is the Admin membership definer's add or removal,
which writes the role with the Admin row since 0330: the whole transaction
on the system pool's own login) and `structure-no-login`
(a structure item in a narrow exit that acts for no login, above). Outside
a narrow exit a spot changes nothing.

The structure items an Admin area's narrow exit makes, edits and removes
(the Secrets root, a secret, a peer, a sender's contact, a documentation
item and the folders above one, and the events a calendar synced, which
its unsubscribe removes) left the spots in S7b part b2: on the
narrow route each write is one call of `mantle_structure_item` (migration
0316, `gateway/structure-item.ts`). Its KIND is one of a fixed list that
fixes the item's type, the area its writer must hold (keys, connectors or
settings), the operations open to it and where a new one lands; the caller
must be a system session with no scope (0315's rule), name the acting
login, and that login must hold the kind's area (`mantle_area_rule`). The
narrow role runs it and holds no right on `nodes`. Anywhere else (a
login's scope, a full reason, the switch off) the app's own statements run
as before; the definer does what they did (the row, the heads, the index
reset), so placement and readers are the same.

Two more left the spots in part b2's third round, each for a definer of
its own with the same caller rule (migration 0317,
`gateway/spot-definers.ts`): a login made admin on the users area's exit
gets its personal space's shared and submitted items back as private
drafts (`mantle_space_settle_promotion`, the users area; it refuses a
target that is no admin), and an assistant deleted on the assistants
area's exit, with its conversation or not
(`mantle_agent_delete`, the assistants area: the digests' heads, the agent
row, its messages and digests, a pinned Telegram chat denied). Without
its conversation the delete took the heads too (`mantle_lock_heads`, which
the narrow role may not run), so it was refused on the narrow exit before.

A system transaction (`withSystemTx`, and the heads helpers and the
hidden-rows check built on it) opened in a request's own narrow exit
keeps that exit for the work inside (`runInSystemTx` carries it on the
transaction's scope): the transaction's statements took the narrow route
already (it is chosen when the transaction begins), and since part b2's
third round so does any statement inside it on the system pool itself or
on `systemDb` (each a connection of its own), with the acting login. They
had run as the system pool's own login with no actor (measured:
`narrow-system-tx.db.test.ts`). An `asSystem` exit's route was never
hidden there.

The route's own statements carry `/* mantle:narrow */` (never the actor's
tag): the round-trip test counts them as the path's in every mode. Its
statements in flight are waited for by `closeDb`, as the actor client's
pipelines are (a connection handed back after the pool's end began would
keep it from ending). Each file's `systemDb` uses are marked `narrow`
(reached in a scope) or `full` (only outside one) in
`eslint-rules/system-db-allowlist.mjs` (`SYSTEM_DB_ROUTE`; pins
`systemDbUses_narrow`, `systemDbUses_full`). The marks are declarations
only: the scope decides the route at run time, and the switch-on suite, not
the mark, proves a file holds on it.

Inside a narrow transaction each statement is checked before it is sent
(a role change, the name bare or quoted; a session-level SET or RESET,
or a call whose effect outlives the transaction; transaction control; a DO block; any statement naming `pg_settings`; and
any `set_config` but one whose first argument is a plain literal naming a
`mantle.*` setting, or `lock_timeout` or `enable_sort`, and whose third is
the literal `true`, so a name built by concatenation or sent as a bound
parameter is refused; literals and comments are not read as statements):
refused with `NarrowRouteRefusedError`. On the login pool the text check is
a guard against mistakes (a session setting, a gateway setting, a call whose
effect outlives the transaction), not the boundary: the boundary is the
login. A function that changes the role inside cannot be seen by text: on
the login pool it lands on the narrow role again; on the per-database
fallback the hold check before the COMMIT rolls such
a transaction back (`NarrowRoleLeftError`), and the role may run no
function it was not granted and create none. The narrow role runs no
content-writing definer (`NARROW_SYSTEM_FUNCTIONS` is its whole list).

A right the narrow role does not hold, met on the route, is noted every
time, a caught one too: a miss row (check `narrow-denied`) on a box, and in
tests a failure (`vitest.setup.ts`). So is a statement the text check
refused before it was sent (detail `text:<what>`, e.g. `text:a-do-block`):
one helper (`sendOrNote`, gateway/narrow-denial.ts) runs the text check
and notes its refusal in both switch states, a denial on the route and a
`narrow-would-refuse` count off it. `MANTLE_NARROW_DUMP=<file>` lists the
route's uses by actor and its denials per test file: how each reason was
measured. A denial is a measurement result: the reason routes full with its
why, or the table is granted narrowly with a reason, never widened for a
member, client, key, peer or public link.

`narrow-route.db.test.ts` pins the route: each reason's role, a statement
and a transaction; the request exits; the actor carried; a content write
refused and noted; the hold check's rollback; the refused statements; off
changes nothing; the system-pool write scope carries the actor's write mode
(a definer's read-only refusal, `mantle_ws_archive`, reads it).
`narrow-login.db.test.ts` pins the login: every escape form the S7a audits
found, sent unguarded on a narrow session, leaves it the narrow role and a
content write after it refused, the row absent; no `SET ROLE`, no
`SET SESSION AUTHORIZATION`, no `TEMP`, no pg-boss routine, no definer off
the two lists; the route on the login pool, opened lazily; each gateway
setting refused by name.

### The acting login

Each system exit records the login it acts for beside its route
(`viewer.ts` `actingLoginNow`: the request's login on an Admin area or
login-self exit, the outer login's on an `asSystem` exit inside a login's
scope or exit), held only while the exit's actor is the one bound; the actor
itself is unchanged (`system:<reason>`). The gateway sends it as
`mantle.acting_login` with the actor's settings: on the narrow route always,
on the full route whenever the actor's settings go, and for the request's
own exit in every check mode (`requestExitActingLogin`: with the check off
too, so its writes and transactions carry it). It is a gateway setting: no
narrow statement may name it (`GATEWAY_SETTING`).

On the narrow login the acting login is a mistake guard, not a boundary:
a raw narrow session may name any acting login (only the gateway's text
check refuses a narrow statement that names it). The database boundaries
there are each definer's own kind, op, place, type and owner checks and
the narrow role's column rights (above): no credential or rights column of
`auth.users`, no new login, no minted key or token. A definer the narrow
role may run must give nothing whichever login it is told it acts for
(`narrow-containment.db.test.ts`: on a switched brain, the raise, bridge
and structure item chain refused at each step, rows unchanged; every
definer that takes a login with no scope, called as the narrow role with
another acting login, writes nothing).

An `asSystem` exit inside a turn whose actor is no login (a Telegram turn
with the actor check off, the system actor `workflow:telegram-turn`) acts
for the login of the turn scope it leaves; with no login there either (a
heartbeat's turn that answers none) it acts for none, and the structure
items then run the app's own statements at the full-route spot
`structure-no-login`, as before their definer.

The definers that act for a login with no scope take it (migration 0315):
`mantle_tg_chat_set` (the assistants area's Telegram block and unpair) and
`mantle_access_key_revoke`. In a scope the scope's own login rules, as
before. With no scope the call must come from a system session, and the
login passed must be the acting login (42501 otherwise, nothing changes). A
system session is one whose `session_user` (the login, never `current_user`,
which a definer or `SET ROLE` changes) is the runtime role (the system pool
with `MANTLE_DB_RUNTIME_ROLE` on), the narrow role (the narrow route's own
login), a superuser (the system pool with the runtime role off; in
per-database mode the narrow route takes the role on that pool) or the
definers' owner (a brain whose DATABASE_URL logs in as a non-superuser
owner): `mantle_system_session()`, one check for every such definer. The acting
login alone would not do: the write role can clear its own scope and set
`mantle.acting_login` in its transaction, and the session check refuses it
(acting-login-definers.db.test.ts). The image one release back already sends
the acting login, so rolling back one image needs no revert.

The Admin membership definers (`mantle_ws_add_user`, `mantle_ws_remove_user`)
take the exit's acting login with no scope too since 0330 (S8b), only on the
Admin workspace and only from a system session that is not the narrow login
(`mantle_ws_exit_login`): the Users screen's role change and its admin login
create run them at the full-route spot `login-credential`, on the system pool,
where the gateway sends the acting login in every check mode. The definer then
asks the area rule of that login for the users area (an Admin user with the
area), as a scope asks its own; the write role, which can set the acting login
itself, is no system session, and the narrow role may run neither definer
(role-guard.db.test.ts).

The readers that take a login (`mantle_tg_my_chats`,
`mantle_tg_moderated_chats`, `mantle_read_cursors`,
`mantle_login_connector_rows`, `mantle_turn_heartbeats`, `mantle_ws_seen`,
`mantle_access_keys_seen`, `mantle_snapshot_bytes`) stay as they are: some
have a caller with no acting login (the heartbeat tick, a worker), and the
narrow role may run none of them; the login facts (`mantle_area_rule`,
`mantle_login_areas` and the rest) answer about a login another login may
ask about; `mantle_ws_private_workspace` takes the scope's login and
refuses with none (so does `mantle_ws_remove_user` on any workspace but
Admin, above). A cell each: none writes for the login it is given.

### The identity gateway

A session sets the `mantle.*` identity settings itself with `set_config`:
the login (`mantle.login_id`, `mantle.scope_login`), the workspaces
(`mantle.ws`, `mantle.mod_ws`), the create-stamp workspaces
(`mantle.create_ws`, `mantle.private_ws`), the acting login
(`mantle.acting_login`) and the actor (`mantle.actor`). A function that read
one of them directly trusted whatever the session said: the re-audits made a
member Moderator through a self-set login and workspace, and deleted an
assistant through a self-set acting login, both as the narrow login. The
rule (migration 0322) closes the class in the database, not one function at
a time:

- One gateway. Only the readers read an identity setting:
  `mantle_login_id()`, `mantle_scope_login_id()`, `mantle_scope_ws()`,
  `mantle_scope_mod_ws()`, `mantle_scope_active()`, `mantle_setting_uuid()`,
  `mantle_identity_acting_login()` (and `_required()`, which refuses with
  42501 when there is none) and `mantle_identity_actor()`. The eleven
  functions that read the acting login or the actor directly were rewritten
  through them (the bodies otherwise unchanged; the revert puts the reads
  back the same way).
- Fail closed on the narrow role. When the session's own role (the role it
  SET, else its login: a definer changes `current_user`, never this) is
  `mantle_system_narrow`, the readers answer no login, no scope, no
  workspaces, no acting login and no create-stamp workspace, and the actor
  `system:narrow` (the role's own name, never a reason the session set: the
  actor check still sees system work). Every definer that needs a login
  refuses the narrow role by construction. The five that a narrow exit
  called with an acting login (`mantle_ws_set_moderator`,
  `mantle_tg_chat_set`, `mantle_structure_item`, `mantle_agent_delete`,
  `mantle_ws_attach_assistants`) left
  its EXECUTE list and run at the full-route spot `acting-login`, where the
  gateway's own SET carries the acting login (a spot keeps the exit's acting
  login; the gateway sends it there in every check mode, since a turn's
  exit is no request exit and with the check off nothing else would). A
  signed acting login, which the narrow role cannot forge, later lets the
  readers trust a signed value and removes the spot.
- Why the actor reads `system:narrow` on the narrow role, not NULL (a
  decision the CEO accepted, round 13b): the actor check refuses a write
  with no actor on an actor-checked table when it is on, so NULL would
  refuse every narrow write of those tables; `system:narrow` is the role's
  own name, which no list trusts (`mantle_ws_system_work`'s three reasons,
  the counts' narrow reasons), so the session's own actor is never
  trusted and the check still sees system work.
- The catalog check. `mantle_identity_leaks()` lists every function body
  (a SQL-standard body's text too), policy, trigger condition, column
  default, check constraint, domain check and view of the app's schemas
  that reads a `mantle.*` setting outside the readers, by
  `current_setting` (quoted or qualified too), `pg_settings`,
  `pg_show_all_settings` or `SHOW`. A reader is matched by its exact
  signature in `public`, never by its name alone.
  Keys that name no identity are on its list, each with why (the route,
  `write_mode`, `acl_internal`, the heads keys, `keep_updated_at`, the
  workspace switch's keys, the notify toggles, `role`); an unknown key
  counts as an identity key; a body that builds a key at run time must be
  named with why (the check modes, the once-per-transaction markers).
  What a function sets is read too: `set_config` and `SET` or `RESET` of
  an identity key (the name quoted or spaced in any part), a function's
  own `SET` clause, a `SET` whose name is built at run time (`EXECUTE
'SET ' || ...`, `format('SET %I ...')`), and the session's role (`SET
ROLE`, `SET SESSION AUTHORIZATION`, `set_config('role', ...)`, a `role`
  clause); and a role's or this database's default
  (`ALTER ROLE ... SET`, `ALTER DATABASE ... SET`, read from
  `pg_db_role_setting`) of an identity key or the role (the role only as a per-database viewer login takes its pool role). The narrow role's
  own defaults are not read: its login may store one on itself (`ALTER
ROLE current_user SET role ...`), which would otherwise fail every
  migrate; the readers answer it no identity whatever it sets, and migrate
  takes every one back each run (`resetNarrowRoleSettings`, the boot line
  names any). A statement built
  whole at run time is not read: the readers answer the narrow role no
  identity whatever it sets.
  migrate fails on any leak, inside each migration's own transaction
  before its commit (so a migration that leaves one leaves nothing) and
  again after the grants (`afterMigrations`), so a new function is covered
  with no list to keep.
- The derivation's flag (`mantle.acl_internal`, 0327 part 4). Not an
  identity, but a session setting a check trusted: the item_grants
  triggers skipped the heads check and the folder propagation while it
  was on, so a write role session (or the runtime role) that set it
  itself could unshare a folder and leave its items readable in that
  workspace (a pg18 cell proved it). The nine functions that set it now
  sign it (`mantle_acl_on()`: the flag and `mantle.acl_sig`, a mark keyed
  by the heads key and the transaction; `mantle_acl_saved()` and
  `mantle_acl_restore()` keep and put back both, so the mark is valid
  only inside one of them), and the two triggers ask
  `mantle_acl_signed()`. A session's own flag, or a mark from another
  transaction, is the flag off. The bare flag still reads `on` for the
  derived-column guards, which pair it with `mantle_owner_role()` (the
  write role is no member; the runtime role is, by design, and may write
  derived columns anyway). `mantle_acl_flag_leaks()` runs with the
  identity check: a body that sets the flag or its mark itself, reads
  them outside the three readers, or decides from `mantle_acl_internal()`
  outside `mantle_acl_writer()`, and any policy, trigger condition,
  default, check or view that reads them, fails migrate. Cells:
  `packages/db/src/acl-flag.db.test.ts` and the forge proof's flag forms.
- The live cell (`packages/db/src/identity-gateway.db.test.ts`, and the
  workstation's forge proof): as the real narrow login, every identity
  setting forged to the owner and the Admin workspace (scoped, and with no
  scope), every function the narrow role may EXECUTE, generated from the
  catalog, is called with owner-shaped arguments; each refuses or changes
  no row (a transaction that changed a row has a transaction id). A write
  the narrow login may make shows as one (the control).

### The member turn ledger

A login that is not an Admin user takes a slot of its daily turn cap and
token budget for each chat turn, summary and transcription
(`member_turn_ledger`). Since 0326 the ledger is written only by two
definers: `mantle_member_turn_claim` (the whole claim: the per-login lock,
a retried turn id admitted and not counted again, the day's turns against
the cap, the login's member chat tokens against the budget, the row) and
`mantle_member_turn_release` (a slot given back when its turn's enqueue
failed: the scope login's own row, made in the last five minutes, only).
Neither takes a login: each reads the scope's own login through the
identity gateway, which the app sets on the system pool for that login
only (`loginDefinerCall`, packages/db `login-definer.ts`: the request's own
login, or a Telegram chat's paired login). The runtime role runs them and
only reads the table; the narrow role, the write role and the workspace
role may run neither and write nothing there, so a forged narrow session
can clear no login's slot (its own or another's) and make none. Before
0326 the app's own statements wrote the table on the system pool, which
inside a member's chat request is the narrow route: refused with the
switch on.

The token budget reads the ledger's own tokens since 0327, never the
traces: the narrow role inserts and updates traces (a turn's record), so a
forged narrow session could zero its own member chat traces or raise
another login's to lock it out. A team turn's model tokens (in + out, what
its trace's close writes) are stamped on its slot at that close by
`mantle_member_turn_settle(turn, tokens)`: the scope login's own row only,
only up (a retried close writes the same count or more). The runtime role
runs it (`loginDefinerCall`), the narrow role may not, and no role but the
definers' owner writes the column. A slot claimed before 0327 carries 0
tokens, so on the day 0327 lands the budget counts from then. Late usage
added to a trace after its close is not on the slot: the budget is a brake
on a runaway, not an invoice. The narrow role holds no DELETE of traces
either (the integrity screen's delete of a node's traces runs at its spot
`integrity-delete`).

Rolling the release that adds 0326: between the migrate and the restart of
each app process, an older process still writes the ledger itself, which
the runtime role may no longer do (0326's image takes those writes away in
its migrate): its member claims are refused (42501, a 500 on that member's
chat send) until it restarts. `docker compose up -d` right after the
migrate (the roll script does both) keeps the window to the restart; no
member slot is lost, only that send.

### The login hold

The narrow role may update `auth.users.disabled_at` and `session_epoch`
(the users area disables a login and ends its sessions). Migration 0327's
hold (`mantle_narrow_login_hold`, BEFORE UPDATE OF those two columns)
refuses it either column on the brain owner's row, an admin by role, or a
user of the Admin workspace, disabled or not (`mantle_narrow_login_held`, a
read definer on the narrow allowlist): a forged narrow session cannot lock
the owner and every Admin user out, nor sign them out again and again. The
users area's disable and session end of such a login runs at the spot
`login-credential` (`onLoginHoldSpot`, packages/db `login-hold.ts`, which
asks the same definer; endLoginSessions and applyLoginChange go through
it). Off the narrow route the same change by a narrow reason is counted
(0320's notice), at the spot it is not. When the S8b rebase lands, Admin
here keeps meaning the Admin workspace's users; the role column test is
the older name of the same thing.

The same hold covers their grants (`mantle_narrow_token_hold`): a revoke
of their access key, OAuth token or device token, a delete of their open
OAuth code and of an MCP client a live grant of theirs rides on (0327),
and since 0328 a delete of their unclaimed pairing code or of a push
device of theirs (a device row with no login is the owner's), and a peer
taken off acting as them (`mantle_peers.acts_as_login_id` to NULL). The
product sites go through `onLoginHoldSpot` too: the lockout and session
end (login-update.ts, endLoginSessions), and every device delete outside
a caller's transaction (`devicesDelete` in server/web `lib/push/store.ts`
reads the rows' logins first, on the narrow route only). The decision is
`onFullSystemRoute`'s own third argument (`when`, asked only on the
narrow route): one rule for every hold.

### The narrow role's message rows

The turn writes its message rows (`assistant_messages`) on the narrow
route, so the narrow role keeps INSERT and an UPDATE of `text`, `model`,
`status` and `data`. Migration 0323's guard (a BEFORE INSERT OR UPDATE row
trigger, so ON CONFLICT, MERGE and COPY meet it too) holds the shape: a row
names this brain, an assistant of this brain (never none), that
assistant's workspace (NULL only for an Admin workspace assistant) and a
login that may talk there (a user of the workspace, the owner or an Admin
user; for the Admin workspace the owner or an Admin user only). A row
whose status is not `pending` is never rewritten (a finished turn's text is
what later turns read as history), but for the follow-up suggestion in its
data; a settled row never goes back to pending. Off the narrow route the
same break by a narrow reason is counted (0320's notice) and runs.

### The narrow write count

Report only (migration 0312): what the role would refuse once it is on by
default is counted one release before, on every box, whatever the switch.
Nothing is refused and no model work starts; the triggers raise a notice
and the pool writes a miss row on another connection, as the actor check's
misses (at most one per check, actor and table an hour).

- `narrow-content-write`: the actor check trigger on a content table counts
  a write whose actor is a narrow reason's (`mantle_narrow_actor`: the
  `AS_SYSTEM_ROUTE` and `REQUEST_SYSTEM_ROUTE` reasons routed narrow, pinned
  equal by `narrow-observe.test.ts`) AND `current_user` is the session's own
  role, the role it SET or else its login (migration 0318; 0312 asked
  `current_user = session_user`, which a superuser-owned definer met on the
  per-database fallback: the full route, where the narrow role was refused
  before any trigger, a definer runs as its owner, a cascade as the table's
  owner) AND `mantle.route` is not
  `full` (not a declared spot). Counted where the actor check runs (warn or
  on); with it off the trigger is disabled and no actor is sent on the full
  route. Exact with the runtime role on: as the superuser, a definer a
  migration made runs as that superuser, and its writes count too.
- `narrow-cascade-delete`: a delete from `auth.users`, `spaces` or `agents`
  by a narrow reason's actor, not at a spot, on either route, not inside a
  definer (the same own-role test, 0318), once per
  statement (their foreign keys cascade or set null into content tables as
  the owner, past the role's own rights). A sign of content going away
  under narrow work, not a refusal to come: turning the role on does not
  stop it, since the cascade runs as the table's owner.
- Not counted: a write whose actor a narrow exit rebound (a login, an
  assistant, a full reason, system work), a definer's write, a cascade from
  any other table.

`scripts/arch-scoreboard-box.sh` prints `narrow_misses:content-write`,
`narrow_misses:cascade-delete` and `narrow_misses:denied` (distinct check,
actor and table rows since the release's epoch, below; numbers only), and
`narrow_misses:would-refuse` and `narrow_misses:would-refuse-tables`
(migration 0320: the writes the
role would refuse, made with the switch off; like 0318's counts it asks
for the session's own role, so a definer's own writes are left out on the
narrow route and with the runtime role on, and counted on a system pool
logged in as the superuser that owns the definers, where the two are one
role (the "Exact with the runtime role on" note above: read those boxes'
counts with that in mind), and 0321's row rules (a heartbeat's books, an enable,
the owner's and an Admin user's row) count through 0320's report branch).

The counts are read since the release's epoch, so a release that fixed a
cause starts again from 0. The epoch is a row of `actor_check_misses`
itself, check `narrow-epoch`, its detail the release's version (no
migration and no new table): migrate writes one after the runtime role's
grants (`ensureNarrowEpoch` in `packages/db/src/migrator-steps.ts`), the
version read from the root `package.json` as the server reads it, once per
version. A second migrate of the same version writes none, and neither
does a roll back to a version an epoch row already names (the newer epoch
holds). No version read: no row, and a warning. The box counts every
narrow row whose `at` is at or after the latest epoch row's; a box with
none reads all time, as before. The script prints the epoch it counts
from as `narrow_misses_since_epoch` (the version and its time in UTC;
`none` when there is none). The maintenance reaper keeps the epoch rows,
as it keeps every `narrow-` row. Migrate runs before the new release's
processes start, so a row the old processes write in that minute counts
in the new epoch: one more reason a nonzero count is read on the box
before it is acted on.

The reset, by hand: write an epoch row with the reason in its detail, as
the superuser that runs migrations (the counts start again from that
moment; the script prints such an epoch's version as `reset`, since its
detail is free text and only numbers leave a client box):

```sql
insert into public.actor_check_misses (source, check_name, actor, detail)
values ('operator', 'narrow-epoch', '', 'reset: <why, no names>');
```

The next release's migrate writes its own epoch row after it, as usual.
To go back to the release's epoch, delete the hand row
(`delete from public.actor_check_misses where check_name = 'narrow-epoch'
and source = 'operator'`).

What the counts do not see, and which the switch-on suites measure
instead (the DB vitest shards, actor-off, actor-on, edit-on, runtime-role
and the area-route sweep, each with `MANTLE_NARROW_SYSTEM=1`; a refusal
there fails the run; the sweep sends every writing area row, every
writing `self` row and every GET of an area or `self` row, from the route
table, so a read on an area's narrow exit is measured too): a function the narrow role may not EXECUTE (outside
`NARROW_SYSTEM_FUNCTIONS`), a read of a table or column it may not SELECT,
and a TRUNCATE (no role the app runs as holds it). The static narrow
write scan (`packages/db/src/narrow-write-scan.test.ts`) reads the source
for every drizzle write of a table that is not a content table and holds
it against the allowlist: at a spot, in a system-only file, or pinned open
(a list that only shrinks). The same scan reads every `mantle_<name>(` call
in the SQL text the source sends and holds it against what the narrow role
may run (its EXECUTE allowlist and PUBLIC definers, or a function that runs
as its caller and stays PUBLIC's, read from the migrations): any other call
sits at a spot, in a system file, or is pinned per file with its count and
its function's decision (`NARROW_SCAN_FN_OPEN`, `NARROW_SCAN_FN_DECIDED`),
so a new call of a definer the narrow role may not run fails the unit suite.
`runtime-role.db.test.ts` checks that reading against the catalog.

The counter sees refused calls too (no blind spot, the round 10 class
rule): with the switch off, a statement the narrow route would take (an
exit routed narrow, or systemDb inside a turn or request scope, the
scope-marked handle) is read for its `mantle_<name>(` calls, and each
function the narrow role may not EXECUTE (its grants and PUBLIC's, read
from the catalog once every ten minutes, `has_function_privilege`) is
noted as `narrow-would-refuse <actor> fn:<name> EXECUTE`, beside the
database's own count of refused writes. Only `public.mantle_*` calls are
read, bare or schema-qualified as `public` (quoted or not); a name after
any other schema's dot is not (one pattern, `CALLED_FN` in
`gateway/narrow-would-refuse.ts`, which the static scan reads too). The
text check the narrow route runs before it sends a statement
(`narrowSendable`) runs here as well, and a statement it would refuse is
noted as `narrow-would-refuse <actor> text:<what> TEXT` (`<what>` the
refusal as one word, e.g. `text:a-do-block`): the switch-off count has
no blind spot for the text check either. Inside a transaction of such an
exit its statements (tagged templates included) and savepoints are read
too. Not read: a call made
inside a function (a definer's calls run as its owner, so the role needs
no EXECUTE there) and a name built at run time (dynamic SQL); the
switch-on suites cover those. A trigger function that is not a definer is
the exception: it runs as the role that wrote the row, so every
`mantle_<name>` it reaches (through other plain functions, never past a
definer) needs the narrow role's EXECUTE when the table is one the role
may write. No statement shows that call, so neither reading sees it; a
catalog cell holds it instead (`runtime-role.db.test.ts`, "every function
a plain trigger reaches on a narrow-writable table is narrow-executable"),
read from `pg_trigger` and the function bodies, so a new trigger is
covered without a list.

Its cost is the reading alone: a statement with no `mantle_` in it is not
lexed. Measured on the workstation (`a2a-round-trips.db.test.ts`, the scan
cost cell, every statement of a path read, an upper bound): a chat turn's
start sends 125 statements, 8 of them lexed, 87 microseconds a turn; no
other path above 0.2 ms. No cache per statement text: it would cost more
to keep than it saves.

With the switch on, every 42501 a narrow statement meets is noted as
`narrow-denied`: a privilege gap, and a refusal a row rule, a guard or a
definer raises with that code; and every text check refusal, as
`text:<what>` (it carries no SQLSTATE: nothing was sent). Such an error is marked where it is met, so
a caller that skips a write a read-only database refuses
(`isWriteRefused`, `bestEffortWrite`) never skips the narrow role's
refusal, systemDb inside a scope included.

What the counts can still lose: a miss row is written after the statement
from the pool's NOTICE (`onnotice`), on another connection; a process that
dies between the two, or a notice the driver drops, loses that row (the
statement itself is unchanged). NOTIFY and advisory locks are no writes:
the narrow role may send a NOTIFY or take an advisory lock, and listeners
read the database again before they act (a NOTIFY is a hint, never a
grant). An encrypted value (a sealed key or token) is bound to its row id
and, for vault keys, its service, not to its table: a narrow session that
may update both columns could move a sealed value between two rows it may
write; the next re-encrypt binds the table name too (named for that
work).

The narrow switch going off (`MANTLE_NARROW_SYSTEM=0` and a migrate) makes
the role NOLOGIN; Postgres does not end a session already logged in. The
app's narrow pool closes when the process restarts with the switch off
(`docker compose up -d` recreates the container), so a box flipped off has
no narrow session left once its app is up again; a hand session as the
role ends when its client disconnects, or by
`select pg_terminate_backend(pid) from pg_stat_activity where usename = 'mantle_system_narrow'`
as the superuser.

The derived triggers hold columns. An `AFTER UPDATE OF <columns>`
trigger records each column as a dependency, so a migration that drops a
column or changes its type would fail on every migrated box (and not in
CI, whose fresh database has no trigger yet). So migrate drops the
derived UPDATE OF triggers before its first pending migration
(`dropNarrowWouldRefuse`, from `applyJournal`) and makes them again from
the grants after the last (`applyNarrowWouldRefuse`, in
`afterMigrations`); a migration that fails puts them back on its way out.
Only the UPDATE OF triggers are dropped (an INSERT or DELETE trigger
holds no column), so a migrate with a migration pending takes a short lock
twice on each table that has one, and none on the rest; a migrate with
nothing pending touches none of them. The drop runs inside the same guard
as the migrations: one that stops part way makes them again too. Each
table's triggers change in a transaction of their own, `lock_timeout` 3 s,
retried on a lock wait or a deadlock (the old app is still serving during
a roll). A trigger present by its name that counts nothing (disabled,
replica only, or calling another function) is dropped and made again by
the same step, so the next migrate puts back what a hand change took
out of the count. The
rule for migration authors: nothing to do; a hand-run revert that drops or
retypes a column on a table outside the actor check runs
`select tgname, tgrelid::regclass from pg_trigger where tgname like 'mantle\_narrow\_would\_refuse\_%'`
first and drops those on its table (the next migrate makes them again).

One image back needs no revert with the narrow switch off
(`MANTLE_NARROW_SYSTEM=0`; or unset on an image before b3, whose default
is off in production): every report branch asks one predicate,
`mantle_narrow_report(who, held, id)`, which answers false when the role
may not run a reader it asks (the older image's migrate grants the runtime
role its own list, without this release's held readers), so the sign-in
and sign-out writes (a device token's rotation, a phone's sign-out, a key
or token revoke, a disable, an End sessions, an MCP client's removal, an
OAuth code's burn) write, uncounted; the drill's N-1 rows run each as the
runtime role with the actor check on. With the switch on, the older
image's grants also leave the narrow role without those readers, so its
holds refuse (42501, fail closed) every write they guard, a member's too.
The b2 image (one back) is the exception: its own migrations (0315 to
0327) grant the held readers, and with the switch on only 0328's wider
hold stands in its way (it refuses the push device deletes b2 sends
outside the spot). So with the switch on, pinning b2 takes one of
two forms: set `MANTLE_NARROW_SYSTEM=0` in the same `.env` edit as
`MANTLE_IMAGE_TAG` and one `docker compose up -d` for both (no container
of the older image ever runs with the switch on), or revert 0329 and
then 0328 first (below; 0329 only changes the counter's function, which
no image calls, but its ledger row must go before 0328's), then pin; an
image older than b2 takes the same switch edit, or the reverts of 0329
down to 0315. The switch alone, with
no pin, is the fallback for a narrow refusal on this release
(update-prod.md's rollback floors say the same).

Reverting the narrow migrations by hand (before pinning an image older
than one back, or to keep the switch on one back): newest first, each file in its own
transaction, `0329_narrow_counter_enabled` (0328's counter function
back: a trigger counts when not disabled), `0328_narrow_hold_wider` (the grant hold's three new
triggers and the counter's missing-triggers function; 0327's hold body
back), `0327_narrow_lockout_and_ledger_tokens`,
`0326_member_turn_ledger_definers`,
`0325_narrow_off_on_insert`, `0324_narrow_enable_off`,
`0323_narrow_message_rules`, `0322_identity_gateway`,
`0321_narrow_row_rules`, then
`0320_narrow_would_refuse`, `0319`, `0318`, `0317`, `0316`, `0315` (each in
`packages/db/rollback/`): 0327's revert drops the settle definer, the
login and grant holds and the miss guard, puts 0320's report predicate
back (no hold named), puts 0326's claim back (the budget from the
traces) and drops the ledger's tokens column; 0326's revert drops the two ledger definers (an
older image writes the ledger itself, its own migrate grants the runtime
role the writes again), 0325's revert takes INSERT out of the one-way
triggers and its two replaces out of `mantle_narrow_one_way` (0324's then
takes the switch rules out), 0323's revert puts 0321's message guard back
(which 0321's revert then drops), 0322's revert puts the direct reads back into the
bodies 0321 and 0320 wrote, and 0320's revert puts 0319's
`mantle_narrow_one_way` back, so each must run before the next.

Every one of these counts needs the actor check in warn or on (the
process's `MANTLE_ACTOR_CHECK` or the box's mode, the higher). The counts
read the actor, and the route mark rides the actor's settings: with the
check off on both, no actor is sent on the full route and nothing is
counted, so a 0 then says nothing. The fleet boxes run the check on (the same
script's `actor_check=` line reads `on`), so their 0s are the evidence the
default flip waits for; read a box's `actor_check=` line before its 0s. The
default flip (S7b part b3) waits for 0 since the epoch of the release
that will flip: every box rolled to that release (its
`narrow_misses_since_epoch` names that version) and each count 0 since
its epoch, not since some older one. A 0 counts only where the counter
exists: `narrow_counter_triggers` above 0 (the derived triggers migrate
makes; 0 on a box before 0320 or after a failed migrate) and
`narrow_counter_actor_check` warn or on, and
`narrow_counter_missing_triggers` 0 (the triggers the narrow role's grants
call for, less the ones there, enabled (origin or always: 0329; one set
to fire in replica mode only never fires on a box) and calling the count's function:
a migrate stopped part way can leave the total above 0 with one table
blind; from 0328 the database's own `mantle_narrow_counter_missing()`
answers, over `mantle_narrow_would_refuse_expected()`, the one derivation
migrate makes the triggers from and the script and the cell in
`narrow-lockout.db.test.ts` read), and `narrow_counter_held_readers` yes
(the runtime role may run the two held readers the login and grant holds
ask; without them those writes run uncounted). b3 needs all four on every
box, and `narrow_hold_triggers` 8 (the grant hold's triggers: five from
0327, three from 0328). The epoch must also have seen real work: the rule (the owner's,
2026-10-23) is one working day of real use since the epoch on the box with
the most daily member traffic (member and Admin turns, the users, keys and
settings areas, workers), each count 0 at its end, and each count 0 on
every other box; a release rolled to that box in between starts its own
epoch and the day again. A fresh epoch on a quiet box reads 0 and proves
nothing, so the day is of that busy box: the script prints that use as
counts (`narrow_traffic_since_epoch:member-turns`, `:audited-actions`
(every `audit_log` row since the epoch),
`:active-logins`) and the switch as the app container has it
(`narrow_switch`: on, off, unset or `?`). The script also prints the epoch
before (`narrow_prev_epoch:*`, from the second latest epoch row to the
latest), so a reset shows what the one before it saw. The release shape
(which release carries the default to a box, and after which day's counts)
is decided by the CEO per box, recorded in
[update-prod.md](update-prod.md) before that box rolls. A path
too rare to run in a day (a yearly job, a recovery tool) is not proven by
it; it rests on the switch-on suites above. The fallback after the flip is
per box and is the switch itself, not a code roll: `MANTLE_NARROW_SYSTEM=0`
in the stack's `.env` and a full `docker compose up -d` (migrate first,
which takes the role's login, then the app), the full route again for
every system write. Only migrate or an operator writes an epoch row: 0327's
guard refuses the narrow role a `narrow-epoch` row or a miss row dated
ahead (directly or through `mantle_actor_miss_log`).
`narrow-observe.db.test.ts` holds the cells (as the runtime role, so
`current_user = session_user` is the pool login's), the box query and the
revert (`packages/db/rollback/0312_narrow_write_observe.revert.sql`);
`w7a-area-system-sweep.db.test.ts` runs every `systemWhole` tool with the
switch on (narrow, no denial) and off (no content write counted).

## What runs as what

| Connection                                                                                                         | Role                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| migrate (`pnpm -C packages/db migrate`, the compose `migrate` service)                                             | `DATABASE_URL`                                                                                                                  |
| the system pool (`db`, `systemDb`), the LISTEN connections (realtime, push-notify, turn-cancel, the agent runtime) | `mantle_runtime` with the switch on, `DATABASE_URL` without                                                                     |
| the scoped pools (`mantle_view_user`, `mantle_write_user`)                                                         | unchanged                                                                                                                       |
| the workspaces switch (`mantle_ws_migrate_locked`, at the first owner and at boot)                                 | `DATABASE_URL`, through `executeAsMigrator`: it runs DDL                                                                        |
| pg-boss                                                                                                            | `DATABASE_URL`: its maintenance makes and drops partitions of `pgboss.queue_stats`                                              |
| the DBOS runner database (`mantle_dbos_sys`)                                                                       | `DATABASE_URL`: DBOS makes its own schema                                                                                       |
| the scheduled backup (`packages/content/src/backup.ts`, pg_dump)                                                   | `DATABASE_URL`: the runtime role cannot read `mantle_heads_key`, and a dump without it restores a brain whose heads checks fail |
| one-shot maintenance scripts that open `postgres(DATABASE_URL)` themselves                                         | `DATABASE_URL`                                                                                                                  |

## The switch and the mode report

`MANTLE_DB_RUNTIME_ROLE` (feature `dbRuntimeRole`, off by default; the compose
`x-app-env` anchor passes it to every app service). Off, the app runs as
`DATABASE_URL`'s role, exactly as before.

New installs and the `.env` line (plan v3.2 S4a). The code default and the
compose default stay off, so no box changes by a default. Instead:

- `scripts/install.sh` writes `MANTLE_DB_RUNTIME_ROLE=1` on a fresh box (no
  Postgres data yet) whose `.env` has no line; `.env.example` shows it set.
- Every roll first writes the line a `.env` lacks, holding the value the app
  runs with now (`ensure_runtime_role_line` in `infra/updater/updater.sh`,
  through `persist_env`, which keeps the file's owner and mode): the running
  `mantle_web`'s environment (`docker exec mantle_web printenv`; unset there
  is 0), else 0 when no `mantle_web` runs. A line already there is kept. The
  roll log (`update.log`) says what was written and from where. A failed
  read of the running container writes nothing. `scripts/roll.sh` sends the
  same functions from its checkout before it requests the roll, so a box
  whose updater is older gets the line too.
- `scripts/arch-scoreboard-box.sh` counts it: `env_has_runtime_role_line`
  (the line is there) next to `env_names_runtime_role` (it is on).

So a later release can turn the default on without flipping any box: every
box that rolled once names its own value.

Which mode a box runs in shows in three places:

- the log of every app process at its start (production): `[db] the system
pool logs in as mantle_runtime (arch A9 runtime role)`, or a warning that it
  logs in as the superuser and how to change that, which starts with
  `[db] SECURITY: MANTLE_DB_RUNTIME_ROLE is unset or 0.` when the switch is
  off (S4a);
- `/api/health`: `postgres.role` is `{ mode, user }`, `mode` one of `runtime`,
  `superuser`, `other`;
- `/debug/integrity`, the row `runtime_role_lock` (`RUNTIME_LOCK_SQL` in
  runtime-role.ts): a row when `mantle_runtime` is no longer the lock it was
  made as (a superuser, a CREATEROLE or CREATEDB, owning a table or a
  function, CREATE on public, holding the rights of `mantle_owner` or
  `mantle_system`, able to become `mantle_owner`), when
  `mantle_acl_internal()` is missing or not `mantle_owner`'s, when
  `mantle_owner_role()` is not the `MEMBER` version of 0290, or when a role
  other than `mantle_runtime` (and a superuser) is a member of
  `mantle_owner`, directly or through another role. migrate puts it back on
  its next run, and logs what it could not put back
  (`WARNING the runtime role lock is not whole`).

## Rolling a box (W9)

This rolls with W9, one box at a time, each with the owner's go. Nothing here
runs on any box before that.

The release that carries A9 is safe on a box that has not switched: its
migrate makes the three roles, hands the tables to `mantle_owner` and grants
the runtime role its rights on every run, and with the switch off the app
logs in as before (with the warning). A box switches by setting one line in
its `.env`, and switches back by taking it out.

0. **Before anything: a backup.** `scripts/db-dump.sh` with
   `MANTLE_DUMP_STRICT=1`, its own exit status checked (never piped), four
   files with one timestamp (docs/update-prod.md, step 1). Where a box has its
   own backup rule (a verified backup, copied off the box, before any roll),
   that rule comes first. Then the owner's go for this box.
1. **The release.** The box runs a release with A9 (rolled the standard way,
   `scripts/roll.sh`). Check that migrate made the roles, as the superuser:

   ```sh
   docker exec mantle_pg psql -U postgres -d postgres -Atc \
     "select rolname, rolcanlogin, rolsuper, rolbypassrls from pg_roles
       where rolname in ('mantle_owner', 'mantle_runtime', 'mantle_system') order by 1"
   # mantle_owner|f|f|t    mantle_runtime|f|f|t    mantle_system|f|f|f
   # (mantle_runtime has no login until the box switches, step 2)
   docker exec mantle_pg psql -U postgres -d postgres -Atc \
     "select pg_get_userbyid(c.relowner), count(*) from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname in ('public', 'auth') and c.relkind in ('r', 'p') group by 1"
   # mantle_owner|<every table>
   ```

   migrate hands the tables over while the old app may still serve, so it
   never waits long for a lock: all in one transaction first, each lock
   waited for at most 200 ms and the whole batch at most a second; past that
   it lets every lock go and takes each table on its own (200 ms, three
   tries). A table still busy then keeps its old owner and migrate goes on:
   its log names it (`WARNING n table(s) busy`), and the next migrate tries
   again. It is untidy, not a hole: the runtime role owns nothing either way,
   and `mantle_owner`, which runs the cascades and the triggers they fire,
   holds every right on that table and `BYPASSRLS`, so it reads there what it
   reads on its own tables.

2. **The compose change.** In the box `.env`: `MANTLE_DB_RUNTIME_ROLE=1`.
   There is no secret to create (the password is derived from
   `MANTLE_MASTER_KEY`, which the box already has). Then recreate the stack:
   `docker compose up -d --wait`. migrate runs first, sees the switch and
   gives the role its login (`runtime role mantle_runtime: LOGIN` in
   `docker logs mantle_migrate`) and its rights; the app containers start
   with the switch on.
3. **Verify.**

   ```sh
   docker logs mantle_web 2>&1 | grep '\[db\]' | tail -3
   # [db] the system pool logs in as mantle_runtime (arch A9 runtime role)
   curl -s -H "Authorization: Bearer $TOKEN" https://<box>/api/health | jq .postgres.role
   # { "mode": "runtime", "user": "mantle_runtime" }
   docker exec mantle_pg psql -U postgres -d postgres -Atc \
     "select usename, count(*) from pg_stat_activity where datname = 'postgres' group by 1 order by 1"
   # mantle_runtime and the viewer roles carry the app; postgres only pg-boss and psql
   ```

   The exit, on the box itself, as the superuser in a transaction rolled
   back:

   ```sql
   BEGIN;
   SET LOCAL ROLE mantle_runtime;
   ALTER TABLE public.nodes DISABLE TRIGGER mantle_actor_check;  -- ERROR: must be owner
   ROLLBACK;
   BEGIN;
   SET LOCAL ROLE mantle_runtime;
   SELECT mantle_set_actor_check('off');  -- ERROR: permission denied for function
   ROLLBACK;
   BEGIN;
   SET LOCAL ROLE mantle_runtime;
   DROP FUNCTION mantle_acl_internal();  -- ERROR: must be owner of function
   ROLLBACK;
   ```

   (`SET ROLE` from there to another role proves nothing in this session:
   Postgres checks it against the session's login, the superuser.
   `runtime-role.db.test.ts` logs in as `mantle_runtime` for that.)

   Then the app's paths: sign in, a chat turn, a note edit, a file upload, a
   page share. /debug/integrity shows no `runtime_role_lock` row.

4. **Rollback.** Take the line out of `.env` (or set it to `0`) and
   `docker compose up -d --wait`: migrate sets `mantle_runtime` to `NOLOGIN`
   again and the app logs in as `DATABASE_URL`. No data changed, so there is
   nothing to undo. The roles, the ownership and the grants stay; the
   superuser ignores them. To take the ownership back as
   well (never needed for the app to run):

   ```sql
   -- as the superuser, connected to the brain's database
   REASSIGN OWNED BY mantle_owner TO postgres;
   ```

   (migrate hands the tables over again on its next run while the release
   carries A9.)

### After a restore

`scripts/db-restore.sh` makes the three roles (no login) before pg_restore,
whose grants and default privileges name them, and marks `ts_match_vq`
LEAKPROOF again. The tables come back owned by the restoring superuser
(`--no-owner`) and the runtime role has no password yet: the migrate of the
next `docker compose up -d --wait` hands the tables to `mantle_owner`, gives
the runtime role its login and rights, and marks the function again
(`afterMigrations`). Start the stack through compose, never one app service on
its own: with the switch on, the app cannot log in before that migrate has
run. `packages/db/src/dump-restore.db.test.ts` proves a restored brain is
whole after it. A backup from before the brain's workspaces switch, with
clients present, needs the manual switch ([workspaces.md](./workspaces.md),
"Operator notes") after the restore and before boot: since A7 the web boot
refuses a brain not on workspaces.

### Operator notes

- Hand psql stays the superuser (`docker exec mantle_pg psql -U postgres`):
  the check switches (`mantle_set_actor_check`, `mantle_set_edit_check`) and a
  manual workspaces switch are run there, as before.
- A maintenance task that needs DDL, run inside `mantle_web` on a switched
  box: `docker exec -e MANTLE_DB_RUNTIME_ROLE=0 mantle_web ...` runs that one
  process as `DATABASE_URL`.
- A box on Postgres before 16 gets no runtime role (migrate warns): the
  memberships need 16. Every box runs 17 or 18.

## Left for later

- The superuser's password is still in every app container's environment
  (`DATABASE_URL`): pg-boss, the DBOS database, the scheduled backup and the
  workspaces switch use it. Taking it out means a pg-boss role that owns the
  `pgboss` schema, a backup role (the owner, or the superuser in the backup
  sidecar), and the switch moved into the migrate service.
- The migrator itself could log in as `mantle_owner` instead of the
  superuser, except for the steps that need one (making roles, `BYPASSRLS`,
  `LEAKPROOF`, `ALTER DATABASE SET` of a check mode).
- For S7c (the signed acting login, then the content read revoke): the
  narrow role's inserts whose text reaches a later prompt
  (`tool_result_chunks`, `tool_results.chunked`, `trace_steps.output`) stay
  on its allowlist (the turn's hot path) and move to the turn's own write
  role or a signed check there; the ingest scope columns the narrow role
  may update (`email_accounts.imap_included_folders`, `ms_drive_scopes`,
  `ms_drives.delta_link`) choose what a feed brings in, never a right or
  a destination, and stay until then with that reason.
- Migrations from 0315 on are never edited in place: the planner refuses
  a journal entry whose `when` the ledger holds under another hash
  (`HASH_REFUSED_FROM`, migrate-plan.ts), so a stamp two branches shared,
  or an edit after a box ran it, stops the migrate with its name instead of
  being skipped for ever. A database that ran a branch's build of a renumbered
  migration (a drill or test cluster) reverts that build's migrations by
  their revert files (each deletes only its own stamp), then migrates.

## Tests

- `packages/db/src/runtime-role.db.test.ts`: the exit (no trigger disabled,
  no table altered, no `session_replication_role`, no `mantle.actor_check`
  change), the marker (no `DROP`, `ALTER` or `DROP OWNED`, also after `SET
ROLE mantle_system`), the workspaces switch denied, the allowlist pinned
  (the functions taken from `PUBLIC` it may run are exactly
  `RUNTIME_SYSTEM_FUNCTIONS`), no definer function it may run reaching DDL
  through any call its body names, the heads key, the viewer roles and the
  setters, the ownership, a broken marker made again, the integrity row,
  idempotence, every membership held in the runtime roles taken back, a
  `mantle_owner_role()` from before 0290 named, and a table left with its
  old owner still read past the row rules as `mantle_owner`. The narrow
  system role's attributes, membership and grants (above).
- `pnpm test:runtime-role`: the database suites with the app's pools on the
  runtime role (`vitest.runtime-role.config.ts`).
