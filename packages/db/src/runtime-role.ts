/**
 * The runtime role (workspaces arch A9, plan v2 section 4.2): the app's own
 * pools stop logging in as the superuser that runs the migrations.
 *
 *  - mantle_owner (NOLOGIN) owns the app's tables and sequences. Only the
 *    migrator acts for it: migrate runs as the superuser (DATABASE_URL), and
 *    hands every table and sequence in public and auth to it after the
 *    migrations (ownTables).
 *  - mantle_runtime (LOGIN) is the system pool's login when
 *    MANTLE_DB_RUNTIME_ROLE is on (systemDatabaseUrl): not a superuser, not
 *    a table owner, BYPASSRLS (the system pool reads and writes past the row
 *    rules, as it did as the superuser), and data rights only: SELECT,
 *    INSERT, UPDATE and DELETE on the tables, the sequences, EXECUTE on the
 *    functions, less RUNTIME_DENIED_FUNCTIONS and the tables the access
 *    matrix marks `runtime: 'none'`. A non-owner cannot ALTER a table or
 *    disable its triggers or row rules; a non-superuser cannot set
 *    session_replication_role, mark a function LEAKPROOF, or ALTER DATABASE
 *    (so not mantle.actor_check); and it cannot create anything in public
 *    (CREATE on the schema is taken from PUBLIC). Its password is derived
 *    from MANTLE_MASTER_KEY, as the viewer roles' are: nothing to store.
 *  - mantle_system (NOLOGIN) holds no right. It is the system's identity
 *    for two things the superuser had by being one: it owns
 *    mantle_acl_internal(), so mantle_owner_role() (0241: the derivation's
 *    guards) says yes to its members; and it may SET ROLE to the write role
 *    and the gap writer, the checked rerun's switches (client.ts). The
 *    runtime role is its member (INHERIT for the first, SET for the
 *    second); the write role's own membership tests (0277, 0278) count only
 *    a direct membership, so the system pool is still "not the write role's
 *    login" there, as it was as the superuser.
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
import { ACCESS_MATRIX, GAP_WRITER_ROLE } from './access-matrix';
import { viewerRoleName } from './viewer';
import { LOCK_ATTRS, POOL_ROLES, withRoleRetry } from './viewer-roles';

type Sql = ReturnType<typeof postgres>;

export const OWNER_ROLE = 'mantle_owner';
export const RUNTIME_ROLE = 'mantle_runtime';
export const SYSTEM_ROLE = 'mantle_system';

/** The schemas the app's tables live in. pgboss (pg-boss's own, it makes
 *  partitions at run time) and drizzle (the ledger) stay the migrator's. */
export const APP_SCHEMAS = ['public', 'auth'] as const;

/** The function whose owner mantle_owner_role() asks about (0241). */
export const ACL_MARKER_FUNCTION = 'public.mantle_acl_internal()';

/**
 * Functions the runtime role may not EXECUTE, nor any viewer role (and
 * PUBLIC, again, though the migrations already took it): the switches of
 * the checks, the heads key's own primitives, the actor setters (packages/db
 * sets the actor with set_config), and the steps that change the schema.
 * Each is a migrator's or an operator's (docs/update-prod.md), never the
 * app's. A missing one (a database before its migration) is skipped.
 * runtime-role.db.test.ts also proves no SECURITY DEFINER function the
 * runtime role may run has DDL in its body.
 */
export const RUNTIME_DENIED_FUNCTIONS: Readonly<Record<string, string>> = {
  'public.mantle_set_check(text,text,integer)': 'sets a check mode (ALTER DATABASE)',
  'public.mantle_set_actor_check(text,integer)': 'sets mantle.actor_check',
  'public.mantle_set_edit_check(text,integer)': 'sets mantle.edit_check',
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
  'public.mantle_ws_migrate()': 'the workspaces switch, as its definer',
  'public.mantle_ws_migrate_locked()': 'the workspaces switch (executeAsMigrator)',
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
  /** Tables and sequences of the app's schemas the role owns. */
  owns: number;
};

/** Who the connection is: one row, readable by any role. */
export const DB_ROLE_SQL = `
  SELECT r.rolname AS "user", r.rolsuper AS superuser, r.rolbypassrls AS bypassrls,
         (SELECT count(*)::int FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relowner = r.oid AND n.nspname IN ('public', 'auth')
             AND c.relkind IN ('r', 'p', 'S')) AS owns
    FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;

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
  if (mode === 'superuser') {
    return (
      `[db] the system pool logs in as the superuser "${row.user}": it may alter tables, ` +
      `disable triggers and change the check modes. Set MANTLE_DB_RUNTIME_ROLE=1 to run as ` +
      `${RUNTIME_ROLE} (docs/runtime-role.md).`
    );
  }
  return (
    `[db] the system pool logs in as "${row.user}"${switchOn ? '' : ' (MANTLE_DB_RUNTIME_ROLE is off)'}` +
    `${row.owns > 0 ? `, which owns ${row.owns} table(s)` : ''}: not the runtime role A9 wants ` +
    `(docs/runtime-role.md).`
  );
}

/** The attributes of each role. Pure. */
function roleAttrs(role: string, password: string | null): string {
  if (role === RUNTIME_ROLE) {
    return password
      ? `LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION PASSWORD '${password}'`
      : `NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION PASSWORD NULL`;
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
  for (const role of [OWNER_ROLE, SYSTEM_ROLE, RUNTIME_ROLE]) {
    const verb = existing.has(role) ? 'ALTER' : 'CREATE';
    out.push(
      `${verb} ROLE "${role}" WITH ${roleAttrs(role, role === RUNTIME_ROLE ? password : null)}`,
    );
  }
  // The runtime role inherits mantle_system (mantle_owner_role says yes)
  // and may SET it, and through it the write role and the gap writer.
  out.push(`GRANT "${SYSTEM_ROLE}" TO "${RUNTIME_ROLE}" WITH INHERIT TRUE, SET TRUE, ADMIN FALSE`);
  // The owner too, without SET: a cascade (ON DELETE CASCADE, SET NULL)
  // runs as the owner of the table it changes, and so do the triggers it
  // fires; as the superuser's tables they passed the owner test.
  out.push(`GRANT "${SYSTEM_ROLE}" TO "${OWNER_ROLE}" WITH INHERIT TRUE, SET FALSE, ADMIN FALSE`);
  for (const target of [viewerRoleName('write'), GAP_WRITER_ROLE]) {
    out.push(`GRANT "${target}" TO "${SYSTEM_ROLE}" WITH INHERIT FALSE, SET TRUE, ADMIN FALSE`);
  }
  return out;
}

/** The memberships the runtime role and mantle_system may hold: any other
 *  (a hand grant of mantle_owner, say) is taken back on every run. */
const WANTED_MEMBERSHIPS: Readonly<Record<string, readonly string[]>> = {
  [RUNTIME_ROLE]: [SYSTEM_ROLE],
  [OWNER_ROLE]: [SYSTEM_ROLE],
  [SYSTEM_ROLE]: [viewerRoleName('write'), GAP_WRITER_ROLE],
};

export type RuntimeRolesOutcome = 'ok' | 'not-superuser' | 'old-server';

/**
 * Make the three roles and their memberships (runtimeRoleStatements), and
 * take back any other membership they hold. The runtime role logs in only
 * with a master key and outside per-database mode. Needs a superuser (a
 * BYPASSRLS role is a superuser's to make): any other caller changes
 * nothing and gets 'not-superuser'. Postgres 16 or later (membership
 * options). Before the migrations: they and the grants name the roles.
 */
export async function ensureRuntimeRoles(
  sql: Sql,
  masterKey: string | null,
  perDatabase = false,
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
    select rolname from pg_roles where rolname in (${OWNER_ROLE}, ${RUNTIME_ROLE}, ${SYSTEM_ROLE})`;
  const password = masterKey && !perDatabase ? runtimeRolePassword(masterKey) : null;
  for (const stmt of runtimeRoleStatements(new Set(rows.map((r) => r.rolname)), password)) {
    await withRoleRetry(() => sql.unsafe(stmt));
  }
  const held = await sql<{ member: string; role: string }[]>`
    select u.rolname as member, r.rolname as role
      from pg_auth_members m
      join pg_roles r on r.oid = m.roleid
      join pg_roles u on u.oid = m.member
     where u.rolname in (${RUNTIME_ROLE}, ${SYSTEM_ROLE}, ${OWNER_ROLE})`;
  for (const { member, role } of held) {
    if (WANTED_MEMBERSHIPS[member]?.includes(role)) continue;
    await withRoleRetry(() => sql.unsafe(`REVOKE "${role}" FROM "${member}"`));
  }
  return 'ok';
}

/** The outcome of one ownership change (ownTables). */
export type OwnOutcome = { owned: string[]; failed: { rel: string; error: string }[] };

/**
 * Hand every table and sequence of the app's schemas to mantle_owner, and
 * mantle_acl_internal() to mantle_system. Each change is its own statement
 * with a short lock_timeout (ALTER ... OWNER takes the table's strongest
 * lock): a busy table is tried again three times, then left with a warning
 * for the next run. Ownership is not the runtime role's lock (it never owns
 * anything, whoever does), so a table left behind is untidy, not a hole.
 * A sequence a column owns (serial, identity) moves with its table. Needs a
 * superuser.
 */
export async function ownTables(sql: Sql): Promise<OwnOutcome> {
  const out: OwnOutcome = { owned: [], failed: [] };
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
    for (let attempt = 1; ; attempt++) {
      try {
        await sql.begin(async (tx) => {
          await tx`set local lock_timeout = '3s'`;
          await tx.unsafe(stmt);
        });
        out.owned.push(rel);
        return;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (attempt < 3 && (code === '55P03' || code === 'XX000')) continue;
        out.failed.push({ rel, error: err instanceof Error ? err.message : String(err) });
        return;
      }
    }
  };
  const alter = ({ rel, kind }: { rel: string; kind: string }) =>
    `ALTER ${kind === 'S' ? 'SEQUENCE' : 'TABLE'} ${rel} OWNER TO "${OWNER_ROLE}"`;
  // All in one transaction first (a fresh database, a quiet box: one
  // commit); a busy table fails it, and then each goes on its own.
  let batched = false;
  if (rels.length > 1) {
    try {
      await sql.begin(async (tx) => {
        await tx`set local lock_timeout = '3s'`;
        for (const r of rels) await tx.unsafe(alter(r));
      });
      out.owned.push(...rels.map((r) => r.rel));
      batched = true;
    } catch {
      // One by one below.
    }
  }
  if (!batched) for (const r of rels) await change(alter(r), r.rel);
  const [marker] = await sql<{ fn: string | null; owner: string | null }[]>`
    select to_regprocedure(${ACL_MARKER_FUNCTION})::text as fn,
           (select pg_get_userbyid(p.proowner) from pg_proc p
             where p.oid = to_regprocedure(${ACL_MARKER_FUNCTION})) as owner`;
  if (marker?.fn && marker.owner !== SYSTEM_ROLE) {
    await change(
      `ALTER FUNCTION ${ACL_MARKER_FUNCTION} OWNER TO "${SYSTEM_ROLE}"`,
      ACL_MARKER_FUNCTION,
    );
  }
  return out;
}

/** The functions of RUNTIME_DENIED_FUNCTIONS that exist here. */
async function deniedFunctionsPresent(sql: Sql): Promise<string[]> {
  const rows = await sql<{ fn: string | null }[]>`
    select to_regprocedure(n)::text as fn from unnest(${Object.keys(RUNTIME_DENIED_FUNCTIONS)}::text[]) n`;
  return rows.map((r) => r.fn).filter((f): f is string => !!f);
}

/**
 * The runtime role's rights in this database, made equal to the wanted set
 * on every run (as applyViewerGrants does the viewer roles'): everything it
 * holds on the app's tables and sequences is revoked, then SELECT, INSERT,
 * UPDATE and DELETE on every table but runtimeDeniedTables, USAGE, SELECT
 * and UPDATE on every sequence, EXECUTE on every function but
 * RUNTIME_DENIED_FUNCTIONS (also taken from PUBLIC and every viewer role),
 * CONNECT on the database, and default privileges so a table a later
 * migration makes is the runtime role's at once. CREATE on public is taken
 * from PUBLIC: the runtime role may make nothing there.
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
  const viewers = [...POOL_ROLES.map((r) => viewerRoleName(r)), GAP_WRITER_ROLE]
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
      await tx.unsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schemas} TO ${rt}`);
      for (const fn of await deniedFunctionsPresent(tx as unknown as Sql)) {
        await tx.unsafe(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC, ${rt}, ${viewers}`);
      }
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
