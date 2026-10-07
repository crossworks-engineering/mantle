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
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`oauth-actor:${actorId}`}))`);
}
