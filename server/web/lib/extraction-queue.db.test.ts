/**
 * The extractor's queue counts (lib/extraction-queue.ts) and the backlog
 * count of the provider alerts (@mantle/db) on a real Postgres, with the two
 * queues that hold the work: `mantle.extract`, and `mantle.extract.heavy` for
 * drawings (server/api/src/agent/extract-lanes.ts).
 *  - a job counts whichever queue holds it;
 *  - a drawing is one "done", not two: the main queue completes its job when
 *    it sends the file on (output `{ lane: 'heavy' }`), and that hop is not a
 *    finished extraction;
 *  - a job of another queue is not counted.
 * pg-boss makes its job table at its first start, after a scratch database's
 * migrate, so the table stands in here (as maintenance-box-status.db.test.ts
 * does), with pg-boss's own `output` column.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/lib/extraction-queue.db.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the extract queue counts, with the heavy lane', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let su: ReturnType<Ts['superuserClient']>;
  let m: typeof import('@mantle/db');

  beforeAll(async () => {
    const ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    su = ts.superuserClient(scratch.url);
    await su`create table if not exists pgboss.job (
               id uuid primary key default gen_random_uuid(), name text not null,
               state text not null, data jsonb, output jsonb,
               created_on timestamptz not null default now(),
               completed_on timestamptz)`;
    await su`grant select on pgboss.job to mantle_runtime, mantle_system_narrow`;
    const hop = JSON.stringify({ lane: 'heavy' });
    await su`insert into pgboss.job (name, state, output, completed_on) values
      ('mantle.extract',       'active',    null, null),
      ('mantle.extract.heavy', 'active',    null, null),
      ('mantle.extract',       'created',   null, null),
      ('mantle.extract',       'created',   null, null),
      ('mantle.extract.heavy', 'created',   null, null),
      ('mantle.extract.heavy', 'created',   null, null),
      ('mantle.extract.heavy', 'created',   null, null),
      ('mantle.extract',       'retry',     null, null),
      ('mantle.extract.heavy', 'retry',     null, null),
      -- a document, done on the main queue
      ('mantle.extract',       'completed', null, now()),
      -- a drawing: the hop on the main queue, then done on the heavy lane
      ('mantle.extract',       'completed', ${hop}::jsonb, now()),
      ('mantle.extract.heavy', 'completed', null, now()),
      -- done long ago: not in the last ten minutes
      ('mantle.extract',       'completed', null, now() - interval '1 hour'),
      ('mantle.extract.dead',  'created',   null, null),
      -- not the extractor's
      ('mantle.email',         'active',    null, null),
      ('mantle.extract.heads', 'created',   null, null)`;
    m = await import('@mantle/db');
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await su?.end();
    await scratch?.drop();
  });

  it('counts both queues, and a drawing once', async () => {
    const { extractionQueueCounts } = await import('./extraction-queue');
    const counts = await m.runAsSystem('test:extraction-queue', () => extractionQueueCounts());
    expect(counts).toEqual({
      running: 2,
      waiting: 5,
      retrying: 2,
      doneLast10Min: 2,
      deadLettered: 1,
    });
  }, 60_000);

  it('the provider backlog holds the heavy lane too', async () => {
    // 2 active + 5 created + 2 retry on the two queues, and 1 dead letter.
    expect(await m.runAsSystem('test:extraction-queue', () => m.countExtractBacklog())).toBe(10);
    expect(await m.runAsSystem('test:extraction-queue', () => m.countDeadLetteredExtracts())).toBe(
      1,
    );
  }, 60_000);
});
