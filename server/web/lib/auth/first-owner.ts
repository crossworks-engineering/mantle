/**
 * Create the brain's first account, the owner. Shared by POST /api/auth/signup
 * and the terminal wizard (scripts/onboard.sh), so the two cannot disagree on
 * what a first owner is.
 *
 * The insert lands ONLY while auth.users is empty. The conditional
 * INSERT ... SELECT ... WHERE NOT EXISTS is atomic, which closes the window
 * between a caller's "no users yet" check and the insert: two concurrent
 * first-run signups with different emails cannot both land. The brain is
 * then put on workspaces (lib/workspaces-migrate.ts).
 *
 * Since arch A7 the code has no rule for a brain off workspaces, and the
 * boot refuses one (server/main.ts). A fresh install starts with no owner
 * (it may: it serves the signup), so its first owner's switch is the one
 * that counts: when it fails (a time budget, the switch guard, a database
 * error), the owner exists but the brain is not on workspaces. That is
 * answered `not-switched` with the reason, never `ok`: the signup route
 * stops the web process (refuseUnswitchedBrain, ./unswitched-brain.ts) so
 * its restart runs the
 * boot's switch again (and refuses to serve while that fails), and the
 * terminal wizard stops with the reason.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, isUniqueViolation } from '@mantle/db';
import { migrateWorkspacesQuietly, unmigratedBrainReason } from '../workspaces-migrate';
import { hashLoginPassword } from './session';

export type FirstOwnerResult =
  | { ok: true; id: string; email: string }
  | { ok: false; reason: 'exists' }
  /** The owner was made, but the brain is not on workspaces: `why` is
   *  mantle_ws_skip_reason's answer. Never served (see the top). */
  | { ok: false; reason: 'not-switched'; id: string; email: string; why: string };

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
  // A fresh install starts on workspaces (W5b1 audit M1): Admin and the
  // bridges, with the owner in Admin. Then asked: a brain the switch left
  // off workspaces is not served (see the top). A database that cannot be
  // read here throws (the route answers 500, and the boot asks again).
  // The assistant attach runs in the new owner's own scope (the assistants
  // area; 0307), never as system work inside a request.
  await migrateWorkspacesQuietly('first owner', id);
  const why = await unmigratedBrainReason();
  if (why !== null) return { ok: false, reason: 'not-switched', id, email, why };
  return { ok: true, id, email };
}
