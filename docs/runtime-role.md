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
  (`mantle_actor_miss_log`, `mantle_bridge_login`, `mantle_check_box_mode`,
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
brains: one password cannot be every brain's). Migrate logs which. The
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
  takes the system pool too; a caller asks `narrowNeedsSpot` (one helper
  reading the allowlist) whether its write needs one. A narrow session can
  therefore no longer forge a run the sweep executes, a heartbeat that
  fires as the anchor, a skill's text, a parked call, or point a vault key
  at another host (narrow-allowlist.db.test.ts). The runs worker checks a
  run's maker too: an item of a run that names neither its assistant nor
  its login, or a login that is gone, never runs. With the switch off,
  migration 0319 counts, report only, each write a narrow reason makes on
  the full route that the role would refuse (a table or column privilege,
  0318's one-way rules): `narrow-would-refuse` miss rows, read by
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
- one way on the columns a right is taken back by (migration 0318,
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
  what narrow statements call by name, fourteen today (the read definers
  of the login-self routes, the Admin area's approvals and the email
  discover; `mantle_brain_id`; the writers on an area exit, each its own
  rule: `mantle_ws_set_moderator`, `mantle_ws_attach_assistants`,
  `mantle_tg_chat_set`, the structure and assistant delete definers;
  `mantle_bridge_login` left it with the role change, and the promotion
  definer `mantle_space_settle_promotion` in S7b part b2 round 5, both
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

`MANTLE_NARROW_SYSTEM` (feature `narrowSystem`): on by default in tests and
development, off by default in production; read once per process when the
system pool opens, and a production process logs it with the pool's login.
Off, every statement runs as before. On, a statement the system pool sends
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
narrow login may not hold (S7b part b2, the interim audit of 0314 and
0315): `login-credential` (a new login, a role change, a contact link and a
password, with the Admin rows `mantle_bridge_login` keeps in step: the
whole transaction on the system pool's own login) and `structure-no-login`
(a structure item in a narrow exit that acts for no login, above). Outside
a narrow exit a spot changes nothing.

The structure items an Admin area's narrow exit makes, edits and removes
(the Secrets root, a secret, a peer, a sender's contact, a documentation
item and the folders above one, and the events a calendar synced, which
its unsubscribe removes) left the spots in S7b part b2: on the
narrow route each write is one call of `mantle_structure_item` (migration
0315, `gateway/structure-item.ts`). Its KIND is one of a fixed list that
fixes the item's type, the area its writer must hold (keys, connectors or
settings), the operations open to it and where a new one lands; the caller
must be a system session with no scope (0314's rule), name the acting
login, and that login must hold the kind's area (`mantle_area_rule`). The
narrow role runs it and holds no right on `nodes`. Anywhere else (a
login's scope, a full reason, the switch off) the app's own statements run
as before; the definer does what they did (the row, the heads, the index
reset), so placement and readers are the same.

Two more left the spots in part b2's third round, each for a definer of
its own with the same caller rule (migration 0316,
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
tests a failure (`vitest.setup.ts`). `MANTLE_NARROW_DUMP=<file>` lists the
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

The definers that act for a login with no scope take it (migration 0314):
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

The readers that take a login (`mantle_tg_my_chats`,
`mantle_tg_moderated_chats`, `mantle_read_cursors`,
`mantle_login_connector_rows`, `mantle_turn_heartbeats`, `mantle_ws_seen`,
`mantle_access_keys_seen`, `mantle_snapshot_bytes`) stay as they are: some
have a caller with no acting login (the heartbeat tick, a worker), and the
narrow role may run none of them; the login facts (`mantle_area_rule`,
`mantle_login_areas` and the rest) answer about a login another login may
ask about; `mantle_ws_private_workspace` and `mantle_ws_remove_user` take
the scope's login and refuse with none. A cell each: none writes for the
login it is given.

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
  role, the role it SET or else its login (migration 0317; 0312 asked
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
  definer (the same own-role test, 0317), once per
  statement (their foreign keys cascade or set null into content tables as
  the owner, past the role's own rights). A sign of content going away
  under narrow work, not a refusal to come: turning the role on does not
  stop it, since the cascade runs as the table's owner.
- Not counted: a write whose actor a narrow exit rebound (a login, an
  assistant, a full reason, system work), a definer's write, a cascade from
  any other table.

`scripts/arch-scoreboard-box.sh` prints `narrow_misses:content-write`,
`narrow_misses:cascade-delete` and `narrow_misses:denied` (distinct check,
actor and table rows in the fail-open rows' window; numbers only), and
`narrow_misses:would-refuse` and `narrow_misses:would-refuse-tables`
(migration 0319: the writes the role would refuse, made with the switch
off).

Every one of these counts needs the actor check in warn or on (the
process's `MANTLE_ACTOR_CHECK` or the box's mode, the higher). The counts
read the actor, and the route mark rides the actor's settings: with the
check off on both, no actor is sent on the full route and nothing is
counted, so a 0 then says nothing. The fleet boxes run the check on (the same
script's `actor_check=` line reads `on`), so their 0s are the evidence the
default flip waits for; read a box's `actor_check=` line before its 0s.
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
