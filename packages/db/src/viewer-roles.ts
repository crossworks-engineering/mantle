/**
 * Create the viewer LOGIN roles and (re)set their passwords (member logins
 * Phase 0b, plan section 2b). Idempotent: migrate runs it after every batch,
 * which also covers the cases where the roles would otherwise be missing or
 * stale:
 *  - a restore into a fresh cluster (roles are cluster objects and are not in
 *    a database dump),
 *  - a master-key change (the passwords are derived from it).
 *
 * The roles are shared by every database on the cluster. One brain per
 * cluster (every box) uses them as they are; a brain that shares its cluster
 * logs in as its own per-database roles instead (viewerRolePlan).
 *
 * The roles get no privileges here. Grants and row level policies live in the
 * migrations (the grant matrix), so a new table is invisible to a limited role
 * until the matrix names it: a missing grant fails loudly, never leaks.
 */
import type postgres from 'postgres';
import {
  viewerLoginRoleName,
  viewerRoleDatabase,
  viewerRoleName,
  viewerRolePassword,
  type LimitedLevel,
  type PoolRole,
} from './viewer';

export const LIMITED_LEVELS: readonly LimitedLevel[] = ['team', 'client', 'public'];

/** Every limited LOGIN role: the three levels plus the personal-space role
 *  (member logins Phase 2), which sees only the space its transaction names. */
export const POOL_ROLES: readonly PoolRole[] = [...LIMITED_LEVELS, 'space'];

/** Hard cap on connections per role, across every process of a box. */
const ROLE_CONNECTION_LIMIT = 30;

/** The attributes that make a viewer role a lock. */
const LOCK_ATTRS = `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`;

/** The statements that bring one LOGIN role to its wanted state. Pure, so a
 *  test can pin the attributes that make the lock a lock. With no master key
 *  the role still exists (so migrations can grant to it) but cannot log in: a
 *  limited pool then fails loudly instead of falling back to admin. `role` is
 *  the shared role by default, or a brain's per-database login role. */
export function viewerRoleStatements(
  level: PoolRole,
  masterKey: string | null,
  exists: boolean,
  role: string = viewerRoleName(level),
): string[] {
  let attrs: string;
  if (masterKey) {
    const password = viewerRolePassword(masterKey, level);
    if (!/^[A-Za-z0-9_-]+$/.test(password))
      throw new Error('viewer role password is not base64url');
    attrs = `LOGIN ${LOCK_ATTRS} CONNECTION LIMIT ${ROLE_CONNECTION_LIMIT} PASSWORD '${password}'`;
  } else {
    attrs = `NOLOGIN ${LOCK_ATTRS} PASSWORD NULL`;
  }
  return [exists ? `ALTER ROLE "${role}" WITH ${attrs}` : `CREATE ROLE "${role}" WITH ${attrs}`];
}

/**
 * Which brain owns the shared roles' passwords: a comment on each role names
 * its database. A role comment is a cluster object, like the role, so every
 * brain on the cluster sees it. A role with no note (every box before this
 * note existed, or a fresh restore) belongs to whoever migrates next.
 */
const OWNER_NOTE_PREFIX = 'mantle: password set for database ';

export function ownerNote(database: string): string {
  return `${OWNER_NOTE_PREFIX}${JSON.stringify(database)}`;
}

export function noteOwner(note: string | null | undefined): string | null {
  if (!note?.startsWith(OWNER_NOTE_PREFIX)) return null;
  try {
    const owner: unknown = JSON.parse(note.slice(OWNER_NOTE_PREFIX.length));
    return typeof owner === 'string' ? owner : null;
  } catch {
    return null;
  }
}

/** What `viewerRolePlan` needs to know about the cluster. */
export interface ClusterRoles {
  /** current_database(): the brain migrating. */
  database: string;
  /** Every `mantle_view_%` role on the cluster, with its comment. */
  roles: ReadonlyMap<string, string | null>;
  /** Every database on the cluster. */
  databases: ReadonlySet<string>;
}

/**
 * The statements that bring this brain's viewer roles to their wanted state.
 * Pure, so a test can pin who may change what on a shared cluster.
 *
 * Shared names (the default, one brain per cluster): set the four roles and
 * note this database as their owner, as before the note existed. Refused,
 * before any change, when another database that still exists owns them:
 * resetting the passwords would lock that brain's member logins out.
 *
 * Per-database (`perDatabase`, MANTLE_VIEWER_ROLES_PER_DATABASE, see viewer.ts): the
 * shared roles are never altered (only created, without a login, when
 * missing, so the migrations can grant to them). The brain's own login role
 * gets the password, a membership that may only SET the shared role (INHERIT
 * FALSE: as itself it holds no privilege, so `SET ROLE NONE` escapes to
 * nothing), and `role` set at login in its own database.
 *
 * That membership is cluster-wide, and the `role` setting is only a default:
 * a login that could connect to another brain's database could SET ROLE there
 * and read that brain's rows. So the brain also closes its database: CONNECT
 * is taken from PUBLIC (every database grants it by default) and given only to
 * its own four logins and to the role migrating (the app's own role, the same
 * DATABASE_URL); the database owner and superusers keep it anyway. Every
 * per-database brain does this, so no brain's login reaches another
 * per-database brain. A brain in shared mode on the same cluster stays open
 * (boxes rely on that); ensureViewerRoles warns about every such database.
 *
 * Both modes drop the per-database logins of databases that are gone (a
 * throwaway brain dropped by hand): they would wait for a database of the
 * same name and get into it.
 */
export function viewerRolePlan(
  cluster: ClusterRoles,
  masterKey: string | null,
  perDatabase: boolean,
): string[] {
  const out: string[] = [];
  if (perDatabase) {
    const database = viewerRoleDatabase(cluster.database);
    for (const level of POOL_ROLES) {
      const shared = viewerRoleName(level);
      if (!cluster.roles.has(shared)) {
        out.push(`CREATE ROLE "${shared}" WITH NOLOGIN ${LOCK_ATTRS} PASSWORD NULL`);
      }
      const login = viewerLoginRoleName(level, database);
      out.push(...viewerRoleStatements(level, masterKey, cluster.roles.has(login), login));
      out.push(`GRANT "${shared}" TO "${login}" WITH INHERIT FALSE, SET TRUE, ADMIN FALSE`);
      out.push(`ALTER ROLE "${login}" IN DATABASE "${database}" SET role = '${shared}'`);
    }
    out.push(`REVOKE CONNECT ON DATABASE "${database}" FROM PUBLIC`);
    const logins = POOL_ROLES.map((level) => `"${viewerLoginRoleName(level, database)}"`);
    out.push(`GRANT CONNECT ON DATABASE "${database}" TO ${logins.join(', ')}, CURRENT_USER`);
    out.push(...orphanLoginDrops(cluster));
    return out;
  }

  const owners = new Set<string>();
  for (const level of POOL_ROLES) {
    const owner = noteOwner(cluster.roles.get(viewerRoleName(level)));
    if (owner !== null && owner !== cluster.database && cluster.databases.has(owner)) {
      owners.add(owner);
    }
  }
  if (owners.size > 0) {
    const names = [...owners].map((o) => `"${o}"`).join(', ');
    throw new Error(
      `The viewer roles (mantle_view_*) on this Postgres cluster belong to the brain in database ${names}. ` +
        `Migrating "${cluster.database}" would reset their passwords and lock that brain's member logins out ` +
        `("password authentication failed for user mantle_view_space"). For a second brain on this cluster, ` +
        `set MANTLE_VIEWER_ROLES_PER_DATABASE=1 for its migrate and its server, or give it its own Postgres. ` +
        `If ${names} is no brain any more, drop that database and migrate again.`,
    );
  }
  for (const level of POOL_ROLES) {
    const role = viewerRoleName(level);
    const note = cluster.roles.get(role);
    out.push(...viewerRoleStatements(level, masterKey, note !== undefined));
    if (noteOwner(note) !== cluster.database) {
      out.push(`COMMENT ON ROLE "${role}" IS '${ownerNote(cluster.database).replace(/'/g, "''")}'`);
    }
  }
  out.push(...orphanLoginDrops(cluster));
  return out;
}

/** A per-database login role's level and database, or null for any other
 *  role (the shared ones included). */
export function parseViewerLoginRole(role: string): { level: PoolRole; database: string } | null {
  for (const level of POOL_ROLES) {
    const prefix = `${viewerRoleName(level)}_`;
    if (role.startsWith(prefix) && role.length > prefix.length) {
      return { level, database: role.slice(prefix.length) };
    }
  }
  return null;
}

/** DROP the per-database logins whose database no longer exists. Their
 *  database is gone, so no grant or setting holds them. */
function orphanLoginDrops(cluster: ClusterRoles): string[] {
  const out: string[] = [];
  for (const role of cluster.roles.keys()) {
    const parsed = parseViewerLoginRole(role);
    if (parsed && !cluster.databases.has(parsed.database)) {
      out.push(`DROP ROLE IF EXISTS "${role}"`);
    }
  }
  return out;
}

/**
 * The statements that remove one brain's per-database logins, for its
 * teardown (`pnpm -C packages/db drop-viewer-logins <database>`, run by
 * `scripts/rm-worktree.sh --drop-viewer-logins`). While the database exists
 * its CONNECT grant holds each role, so that goes first. Pure; `roles` = the
 * logins that exist.
 */
export function viewerLoginDropStatements(
  database: string,
  databaseExists: boolean,
  roles: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const level of POOL_ROLES) {
    const login = viewerLoginRoleName(level, viewerRoleDatabase(database));
    if (!roles.has(login)) continue;
    if (databaseExists) out.push(`REVOKE ALL ON DATABASE "${database}" FROM "${login}"`);
    out.push(`DROP ROLE IF EXISTS "${login}"`);
  }
  return out;
}

/** Remove one brain's per-database logins (viewerLoginDropStatements).
 *  Returns the roles dropped. `sql`: a CREATEROLE connection to any database
 *  on the cluster. */
export async function dropViewerLogins(
  sql: ReturnType<typeof postgres>,
  database: string,
): Promise<string[]> {
  const roles = await sql<{ rolname: string }[]>`
    select rolname from pg_roles where rolname like 'mantle_view_%'`;
  const [db] = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_database where datname = ${database}`;
  const plan = viewerLoginDropStatements(
    database,
    (db?.n ?? 0) > 0,
    new Set(roles.map((r) => r.rolname)),
  );
  for (const stmt of plan) await withRoleRetry(() => sql.unsafe(stmt));
  return plan.filter((s) => s.startsWith('DROP ROLE')).map((s) => s.split('"')[1]!);
}

/** Bring every viewer role to its wanted state. `sql` must be a superuser (or
 *  CREATEROLE) connection: migrate's own. `perDatabase`: see viewerRolePlan. */
export async function ensureViewerRoles(
  sql: ReturnType<typeof postgres>,
  masterKey: string | null,
  perDatabase = false,
): Promise<void> {
  const [current] = await sql<{ database: string }[]>`select current_database() as database`;
  const database = current!.database;
  const roles = await sql<{ rolname: string; note: string | null }[]>`
    select rolname, shobj_description(oid, 'pg_authid') as note
      from pg_roles where rolname like 'mantle_view_%'`;
  const databases = await sql<{ datname: string }[]>`select datname from pg_database`;
  const plan = viewerRolePlan(
    {
      database,
      roles: new Map(roles.map((r) => [r.rolname, r.note])),
      databases: new Set(databases.map((d) => d.datname)),
    },
    masterKey,
    perDatabase,
  );
  for (const stmt of plan) await withRoleRetry(() => sql.unsafe(stmt));

  if (perDatabase) {
    // The databases this brain's logins can still enter: every one that
    // grants CONNECT to PUBLIC. A brain in shared mode is one of them, and
    // its rows are readable there (SET ROLE works anywhere). `postgres` and
    // template1 hold no brain.
    const open = await sql<{ datname: string }[]>`
      select datname from pg_database
       where datallowconn and datname <> current_database()
         and datname not in ('postgres', 'template1')
         and has_database_privilege('public', datname, 'CONNECT')
       order by datname`;
    if (open.length > 0) {
      console.warn(
        `[viewer-roles] ${open.length} other database(s) on this cluster let every login connect: ` +
          `${open.map((d) => `"${d.datname}"`).join(', ')}. ` +
          `Any per-database brain's member login can enter them and SET ROLE to the shared viewer roles. ` +
          `Migrate each brain there with MANTLE_VIEWER_ROLES_PER_DATABASE=1 (it then closes its database), or drop it if it is a leftover.`,
      );
    }
  }
}

/** Two processes setting the same (cluster-wide) role at once make Postgres
 *  answer "tuple concurrently updated" (XX000) to one of them: parallel DB
 *  test files do exactly that. The statements are idempotent, so try again. */
export async function withRoleRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= 12 || !/tuple concurrently updated/.test(msg)) throw err;
      // Jittered: colliding callers retrying in step collide again (48
      // parallel test files hit five attempts of fixed backoff).
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 60 * attempt));
    }
  }
}
