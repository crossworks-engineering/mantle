/**
 * Ping — the smallest possible real runner. It exists to prove the foundation
 * end-to-end: DBOS boot → system-DB journaling → queue dispatch → a real app-DB
 * read inside a durable step → a recorded run with timing. It also models the
 * conventions every runner follows: set the standard `mantle.*` span attributes
 * and log through DBOS.logger so traces are queryable by the same dimensions.
 */

import { DBOS } from '@dbos-inc/dbos-sdk';
import { db } from '@mantle/db';
import { sql } from 'drizzle-orm';

async function pingImpl(note: string): Promise<{ ok: true; note: string; dbNow: string }> {
  // Standard runner span tags — mirror these in every runner so execution
  // traces filter on the same dimensions (runner name, surface, owner, …).
  DBOS.span?.setAttribute('mantle.runner', 'ping');
  DBOS.logger.info(`[ping] runner started (note=${note})`);

  // A durable step: its result is checkpointed, so on a crash-resume the loop
  // skips it rather than re-running. Here it just proves app-DB connectivity.
  const dbNow = await DBOS.runStep(
    async () => {
      const rows = (await db.execute(sql`select now()::text as now`)) as unknown as Array<{
        now: string;
      }>;
      return rows[0]?.now ?? 'unknown';
    },
    { name: 'db_now' },
  );

  DBOS.logger.info(`[ping] runner done (dbNow=${dbNow})`);
  return { ok: true, note, dbNow };
}

export const pingWorkflow = DBOS.registerWorkflow(pingImpl, { name: 'pingWorkflow' });
