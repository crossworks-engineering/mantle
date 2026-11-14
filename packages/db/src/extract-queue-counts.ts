/**
 * The extractor's queue as counts, and the one busy rule of a start on
 * demand. One read of pg-boss's job table, shared by
 * server/web/lib/extraction-queue.ts (GET /api/embedding/extraction and
 * box_status) and by `pipeline_run` (packages/tools/src/pipeline-run.ts).
 * Numbers only.
 *
 * Two queues hold the work: `mantle.extract`, and `mantle.extract.heavy` for
 * drawings (server/api/src/agent/extract-lanes.ts). A drawing's job is
 * completed on the first when it is sent on to the second, with the output
 * `{ lane: 'heavy' }`: that hop is not a finished extraction, so "done"
 * leaves it out and counts the file once, when the heavy lane finishes it.
 *
 * The busy rule is the one of scripts/box-maintain.sh ("Not into a busy
 * box"): more than EXTRACT_BUSY_JOBS extract jobs waiting (created or
 * retry). Change the two together.
 *
 * On systemDb, as countExtractBacklog: the job table is pg-boss's, read on
 * the system pool (the narrow role inside a scope, which may select it).
 */
import { sql } from 'drizzle-orm';
import { systemDb } from './gateway/handles';

/** More extract jobs waiting than this, and the box is busy: a start on
 *  demand sends nothing. The same number as scripts/box-maintain.sh. */
export const EXTRACT_BUSY_JOBS = 50;

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

/** The counts of the two queues and the dead letters. */
export async function extractionQueueCounts(): Promise<ExtractionQueueCounts> {
  const rows = (await systemDb.execute(sql`
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
      WHERE name IN ('mantle.extract', 'mantle.extract.heavy', 'mantle.extract.dead')`)) as unknown as QueueRow[];
  const q = rows[0];
  return {
    running: q?.running ?? 0,
    waiting: q?.waiting ?? 0,
    retrying: q?.retrying ?? 0,
    doneLast10Min: q?.done_10m ?? 0,
    deadLettered: q?.dead ?? 0,
  };
}

/** Whether the extract queue is busy: more than EXTRACT_BUSY_JOBS jobs
 *  waiting or retrying (scripts/box-maintain.sh holds the same rule). A
 *  count that cannot be read (no pg-boss schema yet on a fresh brain)
 *  decides nothing, as in the shell. */
export async function extractQueueBusy(): Promise<boolean> {
  try {
    const c = await extractionQueueCounts();
    return c.waiting + c.retrying > EXTRACT_BUSY_JOBS;
  } catch {
    return false;
  }
}
