/**
 * The extractor's queue counts (lib/extraction-queue.ts) and the backlog
 * count of the provider alerts (@mantle/db) on a real Postgres, with the three
 * queues that hold the work: `mantle.extract`, `mantle.extract.heavy` for
 * drawings and `mantle.extract.book` for books
 * (server/api/src/agent/extract-lanes.ts).
 *  - a job counts whichever queue holds it;
 *  - a drawing or a book is one "done", not two: the main queue completes its
 *    job when it sends the file on (output `{ lane: 'heavy' }` or
 *    `{ lane: 'book' }`), and that hop is not a finished extraction;
 *  - a job of another queue is not counted;
 *  - a dead-lettered run on demand is no backlog to recover;
 *  - the busy rule of a run on demand (extractQueueBusy, @mantle/db).
 * pg-boss makes its job table at its first start, after a scratch database's
 * migrate, so the table stands in here (as maintenance-box-status.db.test.ts
 * does), with pg-boss's own `output` column.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/lib/extraction-queue.db.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the extract queue counts, with the heavy and book lanes', () => {
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
      ('mantle.extract',       'completed', '{"lane":"heavy"}'::jsonb, now()),
      ('mantle.extract.heavy', 'completed', null, now()),
      -- a book: the hop, then done on the book lane; one more runs, one waits
      ('mantle.extract',       'completed', '{"lane":"book"}'::jsonb, now()),
      ('mantle.extract.book',  'completed', null, now()),
      ('mantle.extract.book',  'active',    null, null),
      ('mantle.extract.book',  'created',   null, null),
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

  it('counts the three queues, and a drawing or a book once', async () => {
    const { extractionQueueCounts } = await import('./extraction-queue');
    const counts = await m.runAsSystem('test:extraction-queue', () => extractionQueueCounts());
    expect(counts).toEqual({
      running: 3,
      waiting: 6,
      retrying: 2,
      doneLast10Min: 3,
      deadLettered: 1,
    });
  }, 60_000);

  it('the provider backlog holds the heavy and book lanes too', async () => {
    // 3 active + 6 created + 2 retry on the three queues, and 1 dead letter.
    expect(await m.runAsSystem('test:extraction-queue', () => m.countExtractBacklog())).toBe(12);
    expect(await m.runAsSystem('test:extraction-queue', () => m.countDeadLetteredExtracts())).toBe(
      1,
    );
  }, 60_000);

  it('a dead-lettered run on demand is no backlog to recover', async () => {
    await su`insert into pgboss.job (name, state, data) values
      ('mantle.extract.dead', 'created', '{"nodeId":"n","run":"sheet"}'::jsonb)`;
    expect(await m.runAsSystem('test:extraction-queue', () => m.countDeadLetteredExtracts())).toBe(
      1,
    );
    await su`delete from pgboss.job where data->>'run' = 'sheet'`;
  }, 60_000);

  it('the busy rule of a run on demand: more than EXTRACT_BUSY_JOBS waiting or retrying', async () => {
    const busy = () => m.runAsSystem('test:extraction-queue', () => m.extractQueueBusy());
    // 6 created and 2 retry above.
    expect(m.EXTRACT_BUSY_JOBS).toBe(50);
    expect(await busy()).toBe(false);
    await su`insert into pgboss.job (name, state)
      select 'mantle.extract.heavy', 'created' from generate_series(1, 42)`;
    expect(await busy()).toBe(false); // 50: not more than 50
    await su`insert into pgboss.job (name, state) values ('mantle.extract', 'retry')`;
    expect(await busy()).toBe(true);
  }, 60_000);
});
