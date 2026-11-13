/**
 * The extractor's queue at a glance, as counts: what runs, waits and
 * retries now, what finished in the last ten minutes, and what is
 * dead-lettered (the integrity audit's `extract_dead_letter` rows: a node
 * whose extraction used up its retries). One read of pg-boss's job table,
 * shared by GET /api/embedding/extraction and box_status (box-status.ts).
 * Numbers only.
 *
 * Two queues hold the work: `mantle.extract`, and `mantle.extract.heavy` for
 * drawings (server/api/src/agent/extract-lanes.ts). A drawing's job is
 * completed on the first when it is sent on to the second, with the output
 * `{ lane: 'heavy' }`: that hop is not a finished extraction, so "done"
 * leaves it out and counts the file once, when the heavy lane finishes it.
 */
import { sql } from 'drizzle-orm';
import { db } from '@mantle/db';
import { rowsOf } from './integrity/sql-util';

export type ExtractionQueueCounts = {
  running: number;
  waiting: number;
  retrying: number;
  doneLast10Min: number;
  deadLettered: number;
};

type QueueRow = {
  running: number;
  waiting: number;
  retrying: number;
  done_10m: number;
  dead: number;
};

export async function extractionQueueCounts(): Promise<ExtractionQueueCounts> {
  const q = rowsOf<QueueRow>(
    await db.execute<QueueRow>(sql`
      SELECT
        count(*) FILTER (WHERE name IN ('mantle.extract', 'mantle.extract.heavy')
                           AND state = 'active')::int AS running,
        count(*) FILTER (WHERE name IN ('mantle.extract', 'mantle.extract.heavy')
                           AND state = 'created')::int AS waiting,
        count(*) FILTER (WHERE name IN ('mantle.extract', 'mantle.extract.heavy')
                           AND state = 'retry')::int AS retrying,
        count(*) FILTER (WHERE name IN ('mantle.extract', 'mantle.extract.heavy')
                           AND state = 'completed'
                           AND completed_on > now() - interval '10 minutes'
                           AND (output->>'lane') IS DISTINCT FROM 'heavy')::int AS done_10m,
        count(*) FILTER (WHERE name = 'mantle.extract.dead' AND state = 'created')::int AS dead
      FROM pgboss.job
      WHERE name IN ('mantle.extract', 'mantle.extract.heavy', 'mantle.extract.dead')`),
  )[0];
  return {
    running: q?.running ?? 0,
    waiting: q?.waiting ?? 0,
    retrying: q?.retrying ?? 0,
    doneLast10Min: q?.done_10m ?? 0,
    deadLettered: q?.dead ?? 0,
  };
}
