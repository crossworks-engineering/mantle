/**
 * The runtime role (workspaces arch A9, plan v2 section 4.2): the app's own
 * pools stop logging in as the superuser that runs the migrations.
 *
 *  - mantle_owner (NOLOGIN) owns the app's tables and sequences, and
 *    mantle_acl_internal() (the marker mantle_owner_role() asks about, 0241
 *    and 0290). Only the migrator acts for it: migrate runs as the superuser
 *    (DATABASE_URL) and hands every table and sequence in APP_SCHEMAS, and
 *    the marker, to it after the migrations (ownTables).
 *  - mantle_runtime is the system pool's login when MANTLE_DB_RUNTIME_ROLE
 *    is on (systemDatabaseUrl), and logs in only then (migrate sets LOGIN
 *    when it sees the switch, NOLOGIN when it does not): not a superuser,
 *    owns nothing, BYPASSRLS (the system pool reads and writes past the row
 *    rules, as it did as the superuser), and data rights only: SELECT,
 *    INSERT, UPDATE and DELETE on the tables but those the access matrix
 *    marks `runtime: 'none'`, the sequences, and EXECUTE on an allowlist
 *    (runtimeFunctionAllowlist: what PUBLIC or a viewer role may run, plus
 *    RUNTIME_SYSTEM_FUNCTIONS). A non-owner cannot ALTER a table or disable
 *    its triggers or row rules; a non-superuser cannot set
 *    session_replication_role, mark a function LEAKPROOF, or ALTER DATABASE
 *    (so not mantle.actor_check); and it cannot create anything in public
 *    (CREATE on the schema is taken from PUBLIC). Its password is derived
 *    from MANTLE_MASTER_KEY, as the viewer roles' are: nothing to store.
 *  - The runtime role is a member of mantle_owner WITHOUT INHERIT and
 *    WITHOUT SET: it holds none of the owner's rights and cannot become it,
 *    and mantle_owner_role() (0290: MEMBER, not USAGE) says yes to it, as
 *    to the superuser. So the marker that guard reads is out of its reach.
 *  - mantle_system (NOLOGIN) holds no right and owns nothing. The runtime
 *    role may SET ROLE to it (no INHERIT), and it may SET ROLE to the write
 *    role and the gap writer: the checked rerun's switches, which plan v3
 *    S3 deleted from client.ts (TODO(plan v3 S3 part 2, one release later):
 *    drop both SET memberships and the gap writer role). The
 *    write role's own membership tests (0277, 0278) count only a direct
 *    membership, so the system pool is still "not the write role's login"
 *    there, as it was as the superuser.
 *
 * Roles are cluster objects: a restore into a fresh cluster lacks them, so
 * migrate makes them on every run (ensureRuntimeRoles) and
 * scripts/db-restore.sh creates them (no login) before pg_restore, whose
 * grants name them. One brain per cluster: with
 * MANTLE_VIEWER_ROLES_PER_DATABASE the runtime role gets no login and the
 * app refuses the switch.
 */
import { hkdfSync } from 'node:crypto';
import type postgres from 'postgres';
import { env, feature } from '@mantle/config';
import { backoffMs, errorMessage, withRetry } from '@mantle/std';
import { ACCESS_MATRIX, GAP_WRITER_ROLE } from './access-matrix';
import { viewerRoleName } from './viewer';
import { LOCK_ATTRS, POOL_ROLES, runRoleStatement, withRoleRetry } from './viewer-roles';

type Sql = ReturnType<typeof postgres>;

export const OWNER_ROLE = 'mantle_owner';
export const RUNTIME_ROLE = 'mantle_runtime';
export const SYSTEM_ROLE = 'mantle_system';

/** The schemas the app's tables live in. pgboss (pg-boss's own, it makes
 *  partitions at run time) and drizzle (the ledger) stay the migrator's. */
export const APP_SCHEMAS = ['public', 'auth'] as const;

/** APP_SCHEMAS as a SQL list of literals, for the catalog reads below. */
export const APP_SCHEMAS_SQL = APP_SCHEMAS.map((s) => `'${s}'`).join(', ');

/** The roles scripts/db-restore.sh makes before pg_restore (a test checks
 *  the script names the same). */
export const RUNTIME_ROLES = [OWNER_ROLE, SYSTEM_ROLE, RUNTIME_ROLE] as const;

/** The function whose owner mantle_owner_role() asks about (0241, 0290). */
export const ACL_MARKER_FUNCTION = 'public.mantle_acl_internal()';

/** The derivation guards' owner test (0241). 0290 made it ask for MEMBER;
 *  before that it asked for USAGE, which the runtime role (a member without
 *  INHERIT) never passes: every write guard would refuse the system pool. */
export const OWNER_ROLE_FUNCTION = 'public.mantle_owner_role()';

/** The marker's body, as 0241 made it: migrate makes it again when it is
 *  missing or not this (ensureAclMarker). */
const ACL_MARKER_BODY = `
  SELECT coalesce(current_setting('mantle.acl_internal', true), '') = 'on'
`;

/**
 * Functions the runtime role may not EXECUTE, nor any viewer role (and
 * PUBLIC, again, though the migrations already took it): the switches of
 * the checks, the heads key's own primitives, the actor setters (packages/db
 * sets the actor with set_config), and the steps that change the schema.
 * Each is a migrator's or an operator's (docs/update-prod.md), never the
 * app's. A missing one (a database before its migration) is skipped.
 *
 * The runtime role's own rights are an allowlist (runtimeFunctionAllowlist),
 * so this list is not what keeps a function from it: it is what is taken
 * from PUBLIC and the viewer roles, and what the allowlist may never hold.
 */
export const RUNTIME_DENIED_FUNCTIONS: Readonly<Record<string, string>> = {
  'public.mantle_set_check(text,text,integer,text)': 'sets a check mode (ALTER DATABASE)',
  'public.mantle_set_actor_check(text,integer,text)': 'sets mantle.actor_check',
  'public.mantle_set_edit_check(text,integer,text)': 'sets mantle.edit_check',
  'public.mantle_check_note(text,text)': 'writes the record of a lowered check (ALTER DATABASE)',
  'public.mantle_switch_triggers(text[],boolean,integer)': 'enables or disables triggers',
  'public.mantle_actor_check_triggers(boolean,integer)': 'the actor check triggers on or off',
  'public.mantle_edit_check_triggers(boolean,integer)': 'the edit check triggers on or off',
  'public.mantle_heads_mac(text)': 'a MAC with the heads key: a forged held list',
  'public.mantle_heads_sig(text,text)': 'a held list signature: a forged held list',
  'public.mantle_heads_set(uuid[],uuid[])': 'sets a signed held list without the locks',
  'public.mantle_heads_bypass(text)': 'turns the heads check off (migrations only)',
  'public.mantle_set_actor(text,text,text)': 'an actor setter (packages/db uses set_config)',
  'public.mantle_operator_actor(text)': "an operator's psql actor",
  'public.mantle_write_role_sync_table(text,boolean,text[])': 'row rules and triggers (DDL)',
  'public.mantle_ws_ddl_retry(text[],text)': 'runs DDL (the workspaces switch)',
  'public.mantle_ws_switch_off()': 'drops the bridge triggers (DDL)',
  'public.mantle_ws_migrate_locked()': 'the workspaces switch (executeAsMigrator)',
};

/**
 * The functions taken from PUBLIC (and from every viewer role) that the
 * system pool itself calls, each with where. With what PUBLIC or a viewer
 * role may run, this is all the runtime role may EXECUTE
 * (runtimeFunctionAllowlist); runtime-role.db.test.ts pins that the set of
 * such functions it may run is exactly this list, so a new one is a
 * reviewed line here. A trigger function needs no entry: Postgres checks
 * EXECUTE when the trigger is made, not when it fires. Everything a
 * SECURITY DEFINER function calls runs as its owner, so it needs no entry
 * either; an invoker function here calls none of the PUBLIC-revoked ones.
 * The workspaces switch (mantle_ws_migrate and its steps) is not here: the
 * app runs it as the migrator (mantle_ws_migrate_locked, executeAsMigrator).
 */
export const RUNTIME_SYSTEM_FUNCTIONS: Readonly<Record<string, string>> = {
  'public.mantle_actor_miss_log(text,text,text,text)':
    'client.ts logActorMiss: an actor check miss row, as system(actor-check)',
  'public.mantle_bridge_login(uuid)':
    'login-create.ts, login-update.ts, member-invites.ts: a login into its workspaces (0286)',
  'public.mantle_check_box_mode(text)':
    'client.ts EDIT_CHECK_DRIFT_SQL and CHECK_FLOOR_SQL: the boot warnings and the integrity rows',
  'public.mantle_check_lowered()':
    'client.ts CHECK_FLOOR_SQL: the record of a check lowered below on (0301), logged loudly',
  'public.mantle_contact_sharing_set(uuid,text,text)':
    "admin-acts.ts: an Admin user's switch of a contact's sharing (0308)",
  'public.mantle_contact_sharing_rows(uuid,uuid,text,text)':
    'contact-share-codes.ts: the same rows for an owner, system work (0308)',
  'public.mantle_contact_shares_revoke_all(uuid)':
    "admin-acts.ts: an Admin user's Revoke all of a contact's shares (0308)",
  'public.mantle_contact_shares_revoke_rows(uuid,uuid)':
    'contact-shares.ts: the same rows for an owner, system work (0308)',
  'public.mantle_embed_host(uuid,public.node_type)':
    'maintenance/refold-embeds.ts: the host text of an embedded item (0248)',
  'public.mantle_entity_merge(uuid,uuid)': "admin-acts.ts: an Admin user's entity merge (0308)",
  'public.mantle_entity_merge_rows(uuid,uuid,uuid)':
    'entity-dedup.ts mergeEntities: the entities-dedupe sweep and CLI, system work (0308)',
  'public.mantle_share_close_admin(uuid)':
    "admin-acts.ts: a share closed by an Admin user with the users area (0310)",
  'public.mantle_share_contact_write_set(uuid,boolean)':
    "admin-acts.ts: an Admin user's Can write on a contact share (0310)",
  'public.mantle_app_trash_act(uuid,text)':
    "admin-acts.ts: an Admin user's purge or restore check of a deleted app (0310)",
  'public.mantle_share_with_contacts(uuid,uuid[],text[],boolean,text[])':
    "admin-acts.ts: an Admin user's share of an item with contacts (0308)",
  'public.mantle_share_with_contacts_rows(uuid,uuid,uuid[],text[],boolean,text[])':
    'contact-shares.ts: the same rows for an owner, system work (0308)',
  'public.mantle_area_rule(uuid,text)':
    'client.ts loginHasArea: the area rule about another login (0304, S2a a0)',
  'public.mantle_login_areas(uuid)': 'the areas the area rule gives a login (0304, S2a a0)',
  'public.mantle_login_is_admin(uuid)':
    'client.ts loginHoldsAdmin: a login holds Admin now (0304, S2a a0)',
  'public.mantle_role_drift()':
    'the box count of role drift (scripts/arch-scoreboard-box.sh; 0304, S2a a0)',
  'public.mantle_ws_archive(uuid,uuid)':
    "workspaces.ts archiveWorkspace: a workspace archived by the acting login, on the system pool in its write scope so every held item's head is locked (0309, S2b)",
  'public.mantle_ws_attach_assistants()':
    'workspaces-migrate.ts attachDefaultAssistants: the default assistants (a definer since 0307: system work at boot, the assistants area at signup and onboarding)',
  'public.mantle_ws_private_workspace(uuid)':
    "client.ts: the creating login's private workspace (W6b create home)",
  'public.mantle_ws_skip_reason()':
    'snapshot-copies.ts and the integrity row workspaces_not_migrated',
};

/** Tables the runtime role holds no right on (the access matrix's
 *  `runtime: 'none'`): what only definer functions touch. */
export function runtimeDeniedTables(): string[] {
  return ACCESS_MATRIX.filter((t) => t.runtime === 'none').map((t) => t.table);
}

/**
 * The runtime role's password: HKDF-SHA256 over the master key with its own
 * label (the viewer roles' scheme, another label). Deterministic, so every
 * process of a box derives it and migrate (re)sets it on every run, after a
 * restore and after a master-key change.
 */
export function runtimeRolePassword(masterKey: string): string {
  if (!masterKey)
    throw new Error('MANTLE_MASTER_KEY must be set to derive the runtime role password');
  const key = hkdfSync(
    'sha256',
    Buffer.from(masterKey, 'utf8'),
    Buffer.from('mantle-runtime-role', 'utf8'),
    Buffer.from('runtime-role:mantle_runtime', 'utf8'),
    32,
  );
  return Buffer.from(key).toString('base64url');
}

/** `adminUrl` with the runtime role's user and password. Host, port,
 *  database and options stay. */
export function runtimeDatabaseUrl(adminUrl: string, password: string): string {
  const u = new URL(adminUrl);
  u.username = RUNTIME_ROLE;
  u.password = password; // base64url: nothing to escape
  return u.toString();
}

/** Whether this process's pools log in as the runtime role. */
export function runtimeRoleOn(): boolean {
  return feature('dbRuntimeRole');
}

/**
 * The URL the app's own connections use (the system pool, the LISTEN
 * connections): DATABASE_URL, or with MANTLE_DB_RUNTIME_ROLE on the same
 * server and database as the runtime role. Fails loudly, never falls back
 * to DATABASE_URL, when the switch is on and the role cannot be named.
 */
export function systemDatabaseUrl(): string {
  const url = env('DATABASE_URL');
  if (!url) throw new Error('DATABASE_URL must be set');
  if (!runtimeRoleOn()) return url;
  if (feature('viewerRolesPerDatabase')) {
    throw new Error(
      'MANTLE_DB_RUNTIME_ROLE needs one brain per Postgres cluster: it cannot run with ' +
        'MANTLE_VIEWER_ROLES_PER_DATABASE (docs/runtime-role.md)',
    );
  }
  const key = env('MANTLE_MASTER_KEY');
  if (!key) throw new Error('MANTLE_DB_RUNTIME_ROLE needs MANTLE_MASTER_KEY (the role password)');
  return runtimeDatabaseUrl(url, runtimeRolePassword(key));
}

/** The mode a connection runs in, from DB_ROLE_SQL's row. */
export type DbRoleMode = 'runtime' | 'superuser' | 'other';

export type DbRoleRow = {
  user: string;
  superuser: boolean;
  bypassrls: boolean;
  /** Tables, sequences and functions of the app's schemas the role owns. */
  owns: number;
};

/** Who the connection is: one row, readable by any role. */
export const DB_ROLE_SQL = `
  SELECT r.rolname AS "user", r.rolsuper AS superuser, r.rolbypassrls AS bypassrls,
         ((SELECT count(*)::int FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relowner = r.oid AND n.nspname IN (${APP_SCHEMAS_SQL})
              AND c.relkind IN ('r', 'p', 'S'))
          + (SELECT count(*)::int FROM pg_catalog.pg_proc p
               JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
              WHERE p.proowner = r.oid AND n.nspname IN (${APP_SCHEMAS_SQL}))) AS owns
    FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;

/**
 * The integrity row runtime_role_lock (server/web/lib/integrity/audit.ts):
 * one row (id, kind, detail) when mantle_runtime is no longer the lock it
 * was made as, none when it is (or does not exist: a box before A9). Here,
 * beside the roles it names. Also what the lock leans on: the marker present
 * and mantle_owner's, mantle_owner_role() the MEMBER version of 0290 (a
 * skipped 0290 shows here), and no role but mantle_runtime (and a
 * superuser, a member of every role) a member of mantle_owner, directly or
 * through another role: mantle_owner_role() says yes to every such member.
 * afterMigrations logs every row as a warning.
 */
export const RUNTIME_LOCK_SQL = `
  SELECT '${RUNTIME_ROLE}' AS id, 'lock broken' AS kind, x.detail AS detail
  FROM (
    SELECT concat_ws('; ',
      CASE WHEN r.rolsuper THEN 'a superuser' END,
      CASE WHEN r.rolcreaterole THEN 'may create roles' END,
      CASE WHEN r.rolcreatedb THEN 'may create databases' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                         WHERE c.relowner = r.oid AND n.nspname IN (${APP_SCHEMAS_SQL}))
           THEN 'owns tables' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                         WHERE p.proowner = r.oid AND n.nspname IN (${APP_SCHEMAS_SQL}))
           THEN 'owns functions' END,
      CASE WHEN has_schema_privilege(r.oid, 'public', 'CREATE') THEN 'may create in public' END,
      CASE WHEN EXISTS (SELECT 1 FROM unnest(ARRAY['${OWNER_ROLE}', '${SYSTEM_ROLE}']) o(name)
                         WHERE to_regrole(o.name) IS NOT NULL
                           AND pg_has_role(r.oid, to_regrole(o.name), 'USAGE'))
           THEN 'holds the rights of ${OWNER_ROLE} or ${SYSTEM_ROLE}' END,
      CASE WHEN to_regrole('${OWNER_ROLE}') IS NOT NULL
            AND pg_has_role(r.oid, to_regrole('${OWNER_ROLE}'), 'SET')
           THEN 'may become ${OWNER_ROLE}' END,
      CASE WHEN to_regrole('${OWNER_ROLE}') IS NOT NULL
            AND coalesce((SELECT pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p
                           WHERE p.oid = to_regprocedure('${ACL_MARKER_FUNCTION}')), '')
                <> '${OWNER_ROLE}'
           THEN '${ACL_MARKER_FUNCTION} missing or not ${OWNER_ROLE}''s' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                         WHERE p.oid = to_regprocedure('${OWNER_ROLE_FUNCTION}')
                           AND position('''MEMBER''' IN upper(p.prosrc)) = 0)
           THEN '${OWNER_ROLE_FUNCTION} is not the MEMBER version (migration 0290 not applied): ' ||
                'every write guard refuses ${RUNTIME_ROLE}' END,
      (SELECT 'other members of ${OWNER_ROLE}: ' || string_agg(o.rolname, ', ' ORDER BY o.rolname)
         FROM pg_catalog.pg_roles o
        WHERE to_regrole('${OWNER_ROLE}') IS NOT NULL AND NOT o.rolsuper
          AND o.rolname NOT IN ('${OWNER_ROLE}', '${RUNTIME_ROLE}')
          AND pg_has_role(o.oid, to_regrole('${OWNER_ROLE}'), 'MEMBER'))) AS detail
    FROM pg_catalog.pg_roles r WHERE r.rolname = '${RUNTIME_ROLE}') x
  WHERE x.detail <> ''`;

/** What the integrity row runtime_role_lock says now: its details, none
 *  when the lock is whole (afterMigrations logs each). */
export async function runtimeLockDetails(sql: Sql): Promise<string[]> {
  const rows = (await sql.unsafe(RUNTIME_LOCK_SQL)) as unknown as { detail: string }[];
  return rows.map((r) => r.detail);
}

/** runtime: the runtime role, not a superuser and owning nothing (what A9
 *  wants); superuser: the box before its roll; other: anything else. */
export function dbRoleMode(row: DbRoleRow): DbRoleMode {
  if (row.superuser) return 'superuser';
  if (row.user === RUNTIME_ROLE && row.owns === 0) return 'runtime';
  return 'other';
}

/** A line for the log about the mode, or null when there is nothing to say
 *  (the runtime role, as wanted). */
export function dbRoleNote(row: DbRoleRow, switchOn: boolean): string | null {
  const mode = dbRoleMode(row);
  if (mode === 'runtime') return null;
  // Plan v3.2 S4a: off (unset or 0) is said loudly at every start; the
  // default stays off so no existing box flips (new installs write 1).
  const loud = switchOn ? '' : '[db] SECURITY: MANTLE_DB_RUNTIME_ROLE is unset or 0. ';
  if (mode === 'superuser') {
    return (
      `${loud}[db] the system pool logs in as the superuser "${row.user}": it may alter tables, ` +
      `disable triggers and change the check modes. Set MANTLE_DB_RUNTIME_ROLE=1 to run as ` +
      `${RUNTIME_ROLE} (docs/runtime-role.md).`
    );
  }
  return (
    `${loud}[db] the system pool logs in as "${row.user}"${switchOn ? '' : ' (MANTLE_DB_RUNTIME_ROLE is off)'}` +
    `${row.owns > 0 ? `, which owns ${row.owns} table(s) or function(s)` : ''}: not the runtime role A9 wants ` +
    `(docs/runtime-role.md).`
  );
}

/** One membership: `role` granted to `member` with these options. */
export type Membership = {
  member: string;
  role: string;
  inherit: boolean;
  set: boolean;
};

/**
 * Every membership the three roles may hold, and every one held in them,
 * with its options: any other (a hand grant of mantle_owner with INHERIT,
 * say, or of mantle_runtime to another role), or one of these with other
 * options, is taken back on every run. A member of mantle_runtime is a
 * member of mantle_owner through it, whatever the options, and
 * mantle_owner_role() (0290, MEMBER) says yes to it.
 *
 *  - runtime in mantle_owner: neither INHERIT nor SET. Membership only,
 *    which mantle_owner_role() asks (0290), and none of the owner's rights:
 *    it cannot drop or alter the marker, nor DROP OWNED or REASSIGN OWNED.
 *  - runtime in mantle_system: SET only, and mantle_system in the write
 *    role and the gap writer: SET only. The checked rerun's SET ROLE goes
 *    through it (Postgres 16: a chain of SET options), never directly, so
 *    0277 and 0278 do not count the system pool as the write role's login.
 *    mantle_system owns nothing and holds no right, so SET ROLE to it gains
 *    nothing.
 */
export function wantedMemberships(): readonly Membership[] {
  return [
    { member: RUNTIME_ROLE, role: OWNER_ROLE, inherit: false, set: false },
    { member: RUNTIME_ROLE, role: SYSTEM_ROLE, inherit: false, set: true },
    { member: SYSTEM_ROLE, role: viewerRoleName('write'), inherit: false, set: true },
    // TODO(plan v3 S3 part 2, one release later): nothing SETs these two
    // since S3 (the checked rerun is gone); kept one release so a rollback
    // to the image before S3 still finds them (rule 2).
    { member: SYSTEM_ROLE, role: GAP_WRITER_ROLE, inherit: false, set: true },
  ];
}

/** The attributes of each role. Pure. */
function roleAttrs(role: string, password: string | null): string {
  // NOINHERIT: a membership granted without options (a hand GRANT) then
  // defaults to INHERIT FALSE; migrate takes it back all the same.
  if (role === RUNTIME_ROLE) {
    return password
      ? `LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD '${password}'`
      : `NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD NULL`;
  }
  // The owner runs a foreign key's check and cascade, and the triggers a
  // cascade fires, as the superuser did: past the row rules, on its own
  // tables and on one migrate left with its old owner (ownTables, busy).
  // Nobody logs in as it, and nobody holds its rights: the runtime role is
  // its member without INHERIT and without SET, and BYPASSRLS is never
  // inherited anyway.
  if (role === OWNER_ROLE) {
    return `NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD NULL`;
  }
  return `NOLOGIN ${LOCK_ATTRS} PASSWORD NULL`;
}

/**
 * The statements that bring the three roles and their memberships to their
 * wanted state. Pure, so a test can pin the attributes. `existing`: the
 * roles that exist; `password`: the runtime role's (null = no login).
 */
export function runtimeRoleStatements(
  existing: ReadonlySet<string>,
  password: string | null,
): string[] {
  if (password !== null && !/^[A-Za-z0-9_-]+$/.test(password)) {
    throw new Error('runtime role password is not base64url');
  }
  const out: string[] = [];
  for (const role of RUNTIME_ROLES) {
    const verb = existing.has(role) ? 'ALTER' : 'CREATE';
    out.push(
      `${verb} ROLE "${role}" WITH ${roleAttrs(role, role === RUNTIME_ROLE ? password : null)}`,
    );
  }
  for (const m of wantedMemberships()) {
    out.push(
      `GRANT "${m.role}" TO "${m.member}" WITH INHERIT ${m.inherit ? 'TRUE' : 'FALSE'}, ` +
        `SET ${m.set ? 'TRUE' : 'FALSE'}, ADMIN FALSE`,
    );
  }
  return out;
}

export type RuntimeRolesOutcome = 'ok' | 'not-superuser' | 'old-server';

/** One row of pg_auth_members, by name. */
export type HeldMembership = {
  member: string;
  role: string;
  grantor: string;
  inherit: boolean;
  set: boolean;
  admin: boolean;
};

/** Anything that runs a query string: a pool, or a transaction (a test
 *  takes its own grants back in the transaction that made them). */
type Runner = Pick<postgres.TransactionSql, 'unsafe'>;

/**
 * The order to take memberships back in, from every membership `held` in
 * the same roles: a grant made on the strength of another's ADMIN option
 * (an operator's `GRANT mantle_system TO ops_a WITH ADMIN OPTION`, then
 * ops_a's own grant on to ops_b) before the one it rests on, the far end of
 * a grant chain first. So the CASCADE each revoke carries rarely has
 * anything left to take. Pure; stable for rows of equal depth.
 */
export function revokeOrder<T extends HeldMembership>(
  revoke: readonly T[],
  held: readonly HeldMembership[],
): T[] {
  const depth = (m: HeldMembership, seen: Set<string>): number => {
    const key = `${m.role}\u0000${m.member}\u0000${m.grantor}`;
    if (seen.has(key)) return 0; // a cycle: Postgres refuses one, but never loop
    seen.add(key);
    const parents = held.filter((x) => x.role === m.role && x.member === m.grantor && x.admin);
    return parents.length === 0 ? 0 : 1 + Math.max(...parents.map((p) => depth(p, seen)));
  };
  return revoke
    .map((m, i) => ({ m, i, d: depth(m, new Set()) }))
    .sort((a, b) => b.d - a.d || a.i - b.i)
    .map((x) => x.m);
}

/** pg_auth_members by name: the three roles' memberships both ways, or
 *  (`role`) every membership in one role. */
async function readMemberships(sql: Runner, role?: string): Promise<HeldMembership[]> {
  const where = role
    ? 'r.rolname = $1'
    : `u.rolname IN (${RUNTIME_ROLES.map((r) => `'${r}'`).join(', ')})
        OR r.rolname IN (${RUNTIME_ROLES.map((r) => `'${r}'`).join(', ')})`;
  return (await sql.unsafe(
    `select u.rolname as member, r.rolname as role, g.rolname as grantor,
            m.inherit_option as inherit, m.set_option as set, m.admin_option as admin
       from pg_auth_members m
       join pg_roles r on r.oid = m.roleid
       join pg_roles u on u.oid = m.member
       join pg_roles g on g.oid = m.grantor
      where ${where}`,
    role ? [role] : [],
  )) as unknown as HeldMembership[];
}

const membershipKey = (m: { role: string; member: string; grantor: string }) =>
  `${m.role}\u0000${m.member}\u0000${m.grantor}`;

/**
 * Take back every membership the three roles hold, and every one held in
 * them, that wantedMemberships does not name with these options (part of
 * ensureRuntimeRoles). Each revoke names its grantor and CASCADEs: an
 * operator's grant WITH ADMIN OPTION that its holder passed on leaves a
 * dependent membership, and without CASCADE Postgres refuses the revoke
 * (2BP01) and migrate, and so the app, would not start. The dependents are
 * memberships in the same role, made on the strength of the one taken back,
 * and go with it; revokeOrder takes them first anyway. Every membership
 * that goes, a dependent too, is one warning (role, member, grantor). A
 * revoke that fails for any other reason is a warning as well, never a
 * failed migrate: the integrity row runtime_role_lock shows what is left.
 * Needs a superuser.
 */
export async function takeBackMemberships(
  sql: Runner,
  warn: (line: string) => void,
): Promise<void> {
  const held = await readMemberships(sql);
  const wanted = wantedMemberships();
  const revoke = held.filter((h) => {
    const w = wanted.find((x) => x.member === h.member && x.role === h.role);
    return !(w && w.inherit === h.inherit && w.set === h.set && !h.admin);
  });
  const gone = new Set<string>();
  for (const h of revokeOrder(revoke, held)) {
    if (gone.has(membershipKey(h))) continue; // went with an earlier CASCADE
    try {
      const before = await readMemberships(sql, h.role);
      if (!before.some((b) => membershipKey(b) === membershipKey(h))) continue;
      await withRoleRetry(() =>
        sql.unsafe(
          `REVOKE "${h.role.replace(/"/g, '""')}" FROM "${h.member.replace(/"/g, '""')}" ` +
            `GRANTED BY "${h.grantor.replace(/"/g, '""')}" CASCADE`,
        ),
      );
      const after = new Set((await readMemberships(sql, h.role)).map(membershipKey));
      for (const b of before) {
        if (after.has(membershipKey(b))) continue;
        gone.add(membershipKey(b));
        warn(
          `  WARNING membership taken back: ${b.role} from ${b.member} (granted by ${b.grantor})` +
            (membershipKey(b) === membershipKey(h) ? '' : ', with the grant it rested on'),
        );
      }
    } catch (err) {
      warn(
        `  WARNING could not take back ${h.role} from ${h.member} (granted by ${h.grantor}): ` +
          `${errorMessage(err)}; ` +
          'the integrity row runtime_role_lock shows what is left',
      );
    }
  }
}

/**
 * Make the three roles and their memberships (runtimeRoleStatements), and
 * take back any other membership they hold or another role holds in them,
 * or one with other options. The
 * runtime role logs in only when `login` (migrate: MANTLE_DB_RUNTIME_ROLE
 * on), with a master key and outside per-database mode; otherwise it is
 * NOLOGIN with no password, so switching the switch off closes the login at
 * the next migrate. Needs a superuser (a BYPASSRLS role is a superuser's to
 * make): any other caller changes nothing and gets 'not-superuser'.
 * Postgres 16 or later (membership options). Before the migrations: they
 * and the grants name the roles. `warn`: each membership taken back
 * (takeBackMemberships); console.warn when not given.
 */
export async function ensureRuntimeRoles(
  sql: Sql,
  masterKey: string | null,
  opts: { login: boolean; perDatabase?: boolean; warn?: (line: string) => void },
): Promise<RuntimeRolesOutcome> {
  const [me] = await sql<{ su: boolean; v: number }[]>`
    select r.rolsuper as su, current_setting('server_version_num')::int as v
      from pg_roles r where r.rolname = current_user`;
  if (!me?.su) return 'not-superuser';
  if (me.v < 160000) return 'old-server';
  // The roles these memberships name: the write role and the gap writer
  // are made by ensureViewerRoles and syncGapWriterRights; a fresh cluster
  // may not have the gap writer yet.
  const gap = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_roles where rolname = ${GAP_WRITER_ROLE}`;
  if ((gap[0]?.n ?? 0) === 0) {
    await withRoleRetry(() =>
      sql
        .unsafe(`CREATE ROLE "${GAP_WRITER_ROLE}" WITH NOLOGIN ${LOCK_ATTRS} PASSWORD NULL`)
        .catch((err: Error) => {
          if (!/already exists/.test(err.message)) throw err;
        }),
    );
  }
  const rows = await sql<{ rolname: string }[]>`
    select rolname from pg_roles where rolname = any(${[...RUNTIME_ROLES]}::text[])`;
  const password =
    opts.login && masterKey && !opts.perDatabase ? runtimeRolePassword(masterKey) : null;
  // Wrong memberships first, so the GRANTs below land on a clean slate (a
  // membership is one row per grantor: a GRANT does not change another
  // grantor's row).
  await takeBackMemberships(sql, opts.warn ?? ((line) => console.warn(line)));
  for (const stmt of runtimeRoleStatements(new Set(rows.map((r) => r.rolname)), password)) {
    await runRoleStatement(sql, stmt, true);
  }
  return 'ok';
}

/** The outcome of one ownership change (ownTables). `busy`: left for the
 *  next run because a lock was not to be had in time. */
export type OwnOutcome = {
  owned: string[];
  failed: { rel: string; error: string; busy: boolean }[];
};

/** How long ownTables waits for one table's lock: the old app still serves
 *  while compose's migrate runs, and every statement queued behind an
 *  ALTER ... OWNER waits with it. */
export const OWN_LOCK_TIMEOUT = '200ms';

/** The batch's whole budget: past it, the batch gives up (rolling back,
 *  so every lock it took is let go) and each table goes on its own. */
const OWN_BATCH_BUDGET_MS = 1_000;

/** A lock not to be had within lock_timeout. */
function isBusy(err: unknown): boolean {
  return (err as { code?: string })?.code === '55P03';
}

/** "tuple concurrently updated": two sessions changing the same catalog
 *  row (a GRANT on the table in another migrate or test). Idempotent, so
 *  tried again; any other internal error is not. */
function isConcurrentUpdate(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === 'XX000' && /tuple concurrently updated/.test(e.message ?? '');
}

/**
 * Hand every table and sequence of the app's schemas, and the marker
 * mantle_acl_internal() (made again first when missing or changed,
 * ensureAclMarker), to mantle_owner. Never fails the run.
 *
 * ALTER ... OWNER takes the table's strongest lock, and on a box this runs
 * while the old app still serves (compose's migrate). So: all in one
 * transaction first (a fresh database or a quiet box: one commit), each lock
 * waited for at most OWN_LOCK_TIMEOUT and the whole batch at most
 * OWN_BATCH_BUDGET_MS; past either it rolls back, letting every lock go,
 * and each change goes on its own with the same short wait, tried three
 * times. A table still busy then is left for the next migrate (`busy`).
 * Ownership is not the runtime role's lock (it never owns anything, whoever
 * does), and mantle_owner, which runs a foreign key's cascade and the
 * triggers it fires, holds every right on such a table (applyRuntimeGrants)
 * and BYPASSRLS, so it reads there what it reads on its own: a table left
 * behind is untidy, not a hole. A sequence a column owns (serial, identity)
 * moves with its table. Needs a superuser.
 */
export async function ownTables(sql: Sql): Promise<OwnOutcome> {
  const out: OwnOutcome = { owned: [], failed: [] };
  await ensureAclMarker(sql);
  const rels = await sql<{ rel: string; kind: string }[]>`
    select c.oid::regclass::text as rel, c.relkind::text as kind
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = any(${[...APP_SCHEMAS]}::text[])
       and c.relkind in ('r', 'p', 'S')
       and c.relowner <> (select oid from pg_roles where rolname = ${OWNER_ROLE})
       and not exists (select 1 from pg_depend d
                        where d.classid = 'pg_class'::regclass and d.objid = c.oid
                          and d.deptype = 'e')
       and not (c.relkind = 'S' and exists (
             select 1 from pg_depend d
              where d.classid = 'pg_class'::regclass and d.objid = c.oid
                and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i')))
     order by 1`;
  const change = async (stmt: string, rel: string) => {
    try {
      // Three tries, 50 then 100 ms apart (plus jitter), on a busy lock or
      // a concurrent catalog update only.
      await withRetry(
        () =>
          sql.begin(async (tx) => {
            await tx.unsafe(`set local lock_timeout = '${OWN_LOCK_TIMEOUT}'`);
            await tx.unsafe(stmt);
          }),
        {
          retries: 2,
          retryOn: ({ error }) => isBusy(error) || isConcurrentUpdate(error),
          delayMs: (retry) => backoffMs(retry - 1, { baseMs: 50, jitter: 'quarter' }),
        },
      );
      out.owned.push(rel);
    } catch (err) {
      out.failed.push({
        rel,
        error: errorMessage(err),
        busy: isBusy(err),
      });
    }
  };
  const alter = ({ rel, kind }: { rel: string; kind: string }) =>
    `ALTER ${kind === 'S' ? 'SEQUENCE' : 'TABLE'} ${rel} OWNER TO "${OWNER_ROLE}"`;
  const items = rels.map((r) => ({ rel: r.rel, stmt: alter(r) }));
  const [marker] = await sql<{ owner: string | null }[]>`
    select (select pg_get_userbyid(p.proowner) from pg_proc p
             where p.oid = to_regprocedure(${ACL_MARKER_FUNCTION})) as owner`;
  if (marker?.owner && marker.owner !== OWNER_ROLE) {
    items.push({
      rel: ACL_MARKER_FUNCTION,
      stmt: `ALTER FUNCTION ${ACL_MARKER_FUNCTION} OWNER TO "${OWNER_ROLE}"`,
    });
  }
  let batched = false;
  if (items.length > 1) {
    const started = Date.now();
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(`set local lock_timeout = '${OWN_LOCK_TIMEOUT}'`);
        for (const it of items) {
          if (Date.now() - started > OWN_BATCH_BUDGET_MS) throw new Error('batch budget');
          await tx.unsafe(it.stmt);
        }
      });
      out.owned.push(...items.map((it) => it.rel));
      batched = true;
    } catch {
      // Rolled back, every lock let go: one by one below.
    }
  }
  if (!batched) for (const it of items) await change(it.stmt, it.rel);
  return out;
}

/**
 * Make mantle_acl_internal() again, as 0241 made it, when it is missing or
 * changed (another body, volatility, a definer, a setting): every write
 * guard asks mantle_owner_role(), which errors without it. The superuser
 * replaces it; ownTables then hands it to mantle_owner. A database before
 * 0241 (no mantle_owner_role) is left alone. Returns whether it was made.
 */
export async function ensureAclMarker(sql: Sql): Promise<boolean> {
  const [m] = await sql<{ ok: boolean }[]>`
    select to_regprocedure('public.mantle_owner_role()') is null or coalesce((
      select btrim(p.prosrc, E' \n\t\r') = btrim(${ACL_MARKER_BODY}, E' \n\t\r')
             and p.provolatile = 's' and p.proparallel = 's' and not p.prosecdef
             and p.proconfig is null and p.prorettype = 'boolean'::regtype
             and l.lanname = 'sql'
        from pg_proc p join pg_language l on l.oid = p.prolang
       where p.oid = to_regprocedure(${ACL_MARKER_FUNCTION})), false) as ok`;
  if (m?.ok) return false;
  await sql.unsafe(
    `CREATE OR REPLACE FUNCTION ${ACL_MARKER_FUNCTION}\n` +
      `  RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE SECURITY INVOKER AS $$${ACL_MARKER_BODY}$$`,
  );
  // CREATE OR REPLACE keeps what ALTER FUNCTION ... SET added: reset it.
  await sql.unsafe(`ALTER FUNCTION ${ACL_MARKER_FUNCTION} RESET ALL`);
  return true;
}

/** The functions of RUNTIME_DENIED_FUNCTIONS that exist here. */
async function deniedFunctionsPresent(sql: Sql): Promise<string[]> {
  const rows = await sql<{ fn: string | null }[]>`
    select to_regprocedure(n)::text as fn from unnest(${Object.keys(RUNTIME_DENIED_FUNCTIONS)}::text[]) n`;
  return rows.map((r) => r.fn).filter((f): f is string => !!f);
}

/** The viewer roles (the scoped pools and the gap writer): what any of
 *  them may run, the runtime role may run. */
function viewerRoles(): string[] {
  return [...POOL_ROLES.map((r) => viewerRoleName(r)), GAP_WRITER_ROLE];
}

/**
 * The functions of APP_SCHEMAS the runtime role is granted EXECUTE on
 * (it runs what PUBLIC may run anyway, as every role): every one a viewer
 * role may run that PUBLIC may not, and RUNTIME_SYSTEM_FUNCTIONS, never one
 * of RUNTIME_DENIED_FUNCTIONS. An allowlist: a function a migration takes
 * from PUBLIC and gives to no viewer role is not the runtime role's until a
 * line in RUNTIME_SYSTEM_FUNCTIONS says why. Read after the denials are
 * taken from PUBLIC and the viewer roles.
 */
export async function runtimeFunctionAllowlist(sql: Sql): Promise<string[]> {
  const rows = await sql<{ fn: string }[]>`
    select p.oid::regprocedure::text as fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = any(${[...APP_SCHEMAS]}::text[])
       and not has_function_privilege('public', p.oid, 'EXECUTE')
       and (exists (select 1 from unnest(${viewerRoles()}::text[]) v
                     where to_regrole(v) is not null
                       and has_function_privilege(to_regrole(v), p.oid, 'EXECUTE'))
            or p.oid in (select to_regprocedure(x)
                           from unnest(${Object.keys(RUNTIME_SYSTEM_FUNCTIONS)}::text[]) x))
       and p.oid not in (select to_regprocedure(x)
                           from unnest(${Object.keys(RUNTIME_DENIED_FUNCTIONS)}::text[]) x
                          where to_regprocedure(x) is not null)
     order by 1`;
  return rows.map((r) => r.fn);
}

/**
 * The runtime role's rights in this database, made equal to the wanted set
 * on every run (as applyViewerGrants does the viewer roles'): everything it
 * holds on the app's tables, sequences and functions is revoked, then
 * SELECT, INSERT, UPDATE and DELETE on every table but runtimeDeniedTables,
 * USAGE, SELECT and UPDATE on every sequence, EXECUTE on the allowlist
 * (runtimeFunctionAllowlist; RUNTIME_DENIED_FUNCTIONS are also taken from
 * PUBLIC and every viewer role), CONNECT on the database, and default
 * privileges so a table a later migration makes is the runtime role's at
 * once. CREATE on public is taken from PUBLIC: the runtime role may make
 * nothing there.
 *
 * And mantle_owner's: USAGE on the schemas, every right on the tables and
 * EXECUTE on every function. Nobody logs in as it, but Postgres runs a
 * foreign key's check and its cascade as the owner of the table queried,
 * and the triggers a cascade fires as that owner too: as the superuser's
 * tables these ran as the superuser, so the owner must reach what they
 * reach (auth's tables, the functions taken from PUBLIC). One transaction.
 */
export async function applyRuntimeGrants(sql: Sql): Promise<void> {
  const rt = `"${RUNTIME_ROLE}"`;
  const schemas = APP_SCHEMAS.join(', ');
  const viewers = viewerRoles()
    .map((r) => `"${r}"`)
    .join(', ');
  await withRoleRetry(() =>
    sql.begin(async (tx) => {
      const [db] = await tx<{ name: string; me: string }[]>`
        select current_database() as name, current_user as me`;
      await tx.unsafe(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
      await tx.unsafe(`GRANT CONNECT ON DATABASE "${db!.name}" TO ${rt}`);
      const ow = `"${OWNER_ROLE}"`;
      await tx.unsafe(`GRANT USAGE ON SCHEMA ${schemas} TO ${ow}`);
      await tx.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA ${schemas} TO ${ow}`);
      await tx.unsafe(`GRANT ALL ON ALL SEQUENCES IN SCHEMA ${schemas} TO ${ow}`);
      await tx.unsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schemas} TO ${ow}`);
      await tx.unsafe(`GRANT USAGE ON SCHEMA ${schemas} TO ${rt}`);
      await tx.unsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schemas} FROM ${rt}`);
      await tx.unsafe(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schemas} FROM ${rt}`);
      await tx.unsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schemas} TO ${rt}`,
      );
      await tx.unsafe(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schemas} TO ${rt}`);
      const denied = await tx<{ t: string }[]>`
        select c.oid::regclass::text as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname || '.' || c.relname = any(${runtimeDeniedTables()}::text[])`;
      for (const { t } of denied) await tx.unsafe(`REVOKE ALL ON ${t} FROM ${rt}`);
      for (const fn of await deniedFunctionsPresent(tx as unknown as Sql)) {
        await tx.unsafe(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC, ${rt}, ${viewers}`);
      }
      // Functions: an allowlist, not every function less a denylist.
      await tx.unsafe(`REVOKE ALL ON ALL ROUTINES IN SCHEMA ${schemas} FROM ${rt}`);
      const allowed = await runtimeFunctionAllowlist(tx as unknown as Sql);
      if (allowed.length > 0) {
        await tx.unsafe(`GRANT EXECUTE ON ROUTINE ${allowed.join(', ')} TO ${rt}`);
      }
      // pg-boss's own schema (it stays the migrator's: pg-boss makes
      // partitions at run time): read only, for the queue counts the app
      // shows (provider-alerts.ts, ocr-rescan.ts, the integrity page). Made
      // here when missing (pg-boss installs into it: CREATE SCHEMA IF NOT
      // EXISTS, then its version table), so the default privileges cover the
      // tables pgboss:init makes after this migrate on a fresh box.
      await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS pgboss`);
      await tx.unsafe(`GRANT USAGE ON SCHEMA pgboss TO ${rt}`);
      await tx.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA pgboss TO ${rt}`);
      await tx.unsafe(
        `ALTER DEFAULT PRIVILEGES FOR ROLE "${db!.me}" IN SCHEMA pgboss GRANT SELECT ON TABLES TO ${rt}`,
      );
      // Objects a later migration makes (as this role, or as mantle_owner)
      // are the runtime role's at once; the next run applies the denials.
      await tx.unsafe(
        `ALTER DEFAULT PRIVILEGES FOR ROLE "${db!.me}" IN SCHEMA ${schemas} ` +
          `GRANT EXECUTE ON FUNCTIONS TO ${ow}`,
      );
      for (const owner of [db!.me, OWNER_ROLE]) {
        await tx.unsafe(
          `ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA ${schemas} ` +
            `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${rt}`,
        );
        await tx.unsafe(
          `ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA ${schemas} ` +
            `GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${rt}`,
        );
      }
    }),
  );
}
