/**
 * Create the viewer LOGIN roles and (re)set their passwords (member logins
 * Phase 0b, plan section 2b). Idempotent: migrate runs it after every batch,
 * which also covers the cases where the roles would otherwise be missing or
 * stale:
 *  - a restore into a fresh cluster (roles are cluster objects and are not in
 *    a database dump),
 *  - a master-key change (the passwords are derived from it).
 *
 * The roles get no privileges here. Grants and row level policies live in the
 * migrations (the grant matrix), so a new table is invisible to a limited role
 * until the matrix names it: a missing grant fails loudly, never leaks.
 */
import type postgres from 'postgres';
import { viewerRoleName, viewerRolePassword, type LimitedLevel, type PoolRole } from './viewer';

export const LIMITED_LEVELS: readonly LimitedLevel[] = ['team', 'client', 'public'];

/** Every limited LOGIN role: the three levels plus the personal-space role
 *  (member logins Phase 2), which sees only the space its transaction names. */
export const POOL_ROLES: readonly PoolRole[] = [...LIMITED_LEVELS, 'space'];

/** Hard cap on connections per role, across every process of a box. */
const ROLE_CONNECTION_LIMIT = 30;

/** The statements that bring one role to its wanted state. Pure, so a test
 *  can pin the attributes that make the lock a lock. With no master key the
 *  role still exists (so migrations can grant to it) but cannot log in: a
 *  limited pool then fails loudly instead of falling back to admin. */
export function viewerRoleStatements(
  level: PoolRole,
  masterKey: string | null,
  exists: boolean,
): string[] {
  const role = viewerRoleName(level);
  const base = `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`;
  let attrs: string;
  if (masterKey) {
    const password = viewerRolePassword(masterKey, level);
    if (!/^[A-Za-z0-9_-]+$/.test(password))
      throw new Error('viewer role password is not base64url');
    attrs = `LOGIN ${base} CONNECTION LIMIT ${ROLE_CONNECTION_LIMIT} PASSWORD '${password}'`;
  } else {
    attrs = `NOLOGIN ${base} PASSWORD NULL`;
  }
  return [exists ? `ALTER ROLE "${role}" WITH ${attrs}` : `CREATE ROLE "${role}" WITH ${attrs}`];
}

/** Bring every viewer role to its wanted state. `sql` must be a superuser (or
 *  CREATEROLE) connection: migrate's own. */
export async function ensureViewerRoles(
  sql: ReturnType<typeof postgres>,
  masterKey: string | null,
): Promise<void> {
  const rows = await sql<{ rolname: string }[]>`
    select rolname from pg_roles where rolname like 'mantle_view_%'`;
  const existing = new Set(rows.map((r) => r.rolname));
  for (const level of POOL_ROLES) {
    for (const stmt of viewerRoleStatements(
      level,
      masterKey,
      existing.has(viewerRoleName(level)),
    )) {
      await withRoleRetry(() => sql.unsafe(stmt));
    }
  }
}

/** Two processes setting the same (cluster-wide) role at once make Postgres
 *  answer "tuple concurrently updated" (XX000) to one of them: parallel DB
 *  test files do exactly that. The statements are idempotent, so try again. */
async function withRoleRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= 5 || !/tuple concurrently updated/.test(msg)) throw err;
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
}
