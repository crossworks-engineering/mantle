import { sql } from 'drizzle-orm';
import type { db } from '@mantle/db';

/** A transaction handle (or db itself). */
export type OauthExec = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

/**
 * Serialize everything that mints or ends one login's OAuth grants (final
 * audit F3): the code exchange and the refresh (lib/mcp-oauth.ts), and
 * endLoginSessions (lib/auth/session.ts), which takes it before it revokes.
 * Whichever runs second sees what the first did: a refresh after a revoke
 * finds its row revoked, and a revoke after a refresh finds the new row.
 * Hold it inside a transaction (it ends with the transaction).
 */
export async function lockOauthActor(tx: OauthExec, actorId: string): Promise<void> {
  // Bounded waits (verification audit N1): a queue on one login's lock, or a
  // slow statement, fails this transaction in seconds and frees its pooled
  // connection, never holds it forever. Every query under the lock must run
  // on `tx` itself: a second connection taken while holding one is how a
  // full pool deadlocks.
  await tx.execute(sql`set local lock_timeout = '5s'`);
  await tx.execute(sql`set local statement_timeout = '15s'`);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`oauth-actor:${actorId}`}))`);
  // Back to the defaults once held (last check F3): the bound is on the
  // wait, and a caller's own transaction (an admin's End sessions, with its
  // row locks after this) must not inherit it.
  await tx.execute(sql`set local lock_timeout to default`);
  await tx.execute(sql`set local statement_timeout to default`);
}
