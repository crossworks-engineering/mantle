/**
 * The one lock on an app's history (apps snapshots): a transaction-scoped
 * advisory lock keyed by the app id. Snapshots, restores, prunes and, since
 * the team apps follow-up, a member app's Accept (which moves the app and its
 * history to the brain) take it, so a restore never lands on an app that
 * moved under it. No node:fs here: the main content entry may import it.
 */
import { sql } from 'drizzle-orm';
import type { db } from '@mantle/db';

type Tx = Pick<typeof db, 'execute'>;

export async function lockAppHistory(tx: Tx, appId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`app-history:${appId}`}, 0))`,
  );
}
