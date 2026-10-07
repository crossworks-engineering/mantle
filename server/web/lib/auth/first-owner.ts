/**
 * Create the brain's first account, the owner. Shared by POST /api/auth/signup
 * and the terminal wizard (scripts/onboard.sh), so the two cannot disagree on
 * what a first owner is.
 *
 * The insert lands ONLY while auth.users is empty. The conditional
 * INSERT ... SELECT ... WHERE NOT EXISTS is atomic, which closes the window
 * between a caller's "no users yet" check and the insert: two concurrent
 * first-run signups with different emails cannot both land.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, isUniqueViolation } from '@mantle/db';
import { hashLoginPassword } from './session';

export type FirstOwnerResult =
  { ok: true; id: string; email: string } | { ok: false; reason: 'exists' };

export async function createFirstOwner(
  rawEmail: string,
  password: string,
): Promise<FirstOwnerResult> {
  // Stored lowercased so it matches the case-insensitive login lookup.
  const email = rawEmail.trim().toLowerCase();
  const passwordHash = await hashLoginPassword(password);
  const id = randomUUID();
  try {
    // is_owner: the first-run account is the ANCHOR, the identity all brain
    // content is keyed to. Later co-admin logins (Settings, Logins) are not.
    // The role is named: the column has no default (0190), and the anchor is
    // always an admin (CHECK).
    const inserted = await db.execute(sql`
      INSERT INTO auth.users (id, email, password_hash, is_owner, role)
      SELECT ${id}, ${email}, ${passwordHash}, true, 'admin'
      WHERE NOT EXISTS (SELECT 1 FROM auth.users)
      RETURNING id
    `);
    if (inserted.length === 0) return { ok: false, reason: 'exists' };
  } catch (err) {
    // Only a unique violation means "someone else got there first" (two
    // first-run signups with the same email). Anything else (the database is
    // down, a schema problem) is a real failure and must not read as "an
    // account already exists": it propagates, and the route answers 500.
    if (isUniqueViolation(err)) return { ok: false, reason: 'exists' };
    throw err;
  }
  return { ok: true, id, email };
}
