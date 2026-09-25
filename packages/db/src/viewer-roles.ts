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
import { viewerRoleName, viewerRolePassword, type LimitedLevel } from './viewer';

export const LIMITED_LEVELS: readonly LimitedLevel[] = ['team', 'client', 'public'];

/** Hard cap on connections per role, across every process of a box. */
const ROLE_CONNECTION_LIMIT = 30;

/** The statements that bring one role to its wanted state. Pure, so a test
 *  can pin the attributes that make the lock a lock. With no master key the
 *  role still exists (so migrations can grant to it) but cannot log in: a
 *  limited pool then fails loudly instead of falling back to admin. */
export function viewerRoleStatements(
  level: LimitedLevel,
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
  for (const level of LIMITED_LEVELS) {
    for (const stmt of viewerRoleStatements(
      level,
      masterKey,
      existing.has(viewerRoleName(level)),
    )) {
      await sql.unsafe(stmt);
    }
  }
}
