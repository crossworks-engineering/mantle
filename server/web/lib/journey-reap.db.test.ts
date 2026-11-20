/**
 * The stale-trace reapers (journey.ts abandonedTraceSql) on a real, migrated
 * Postgres: a trace still `running` past the extract budget plus 15 minutes is
 * closed as abandoned, but a book read's trace (`data.lane` 'book', the
 * extract queue's book lane, and every trace opened inside it) has the book
 * lane's longest budget plus 15 (a saved base budget may be up to 12 hours, so
 * the longer cap): two hours in, and eleven, it stays running; thirteen hours
 * in, it is closed. The owner-scoped self-heal, the all-owner sweep and the
 * corpus audit's abandoned_traces check keep the one rule. A scratch
 * database (with a pg-boss schema: the audit's queue checks read it),
 * dropped after.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/lib/journey-reap.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the stale-trace reapers', () => {
  let m: typeof import('@mantle/db');
  let j: typeof import('./journey');
  let scratch: { url: string; drop: () => Promise<void> } | undefined;
  let anchor = '';
  const su = async (q: ReturnType<typeof sql>) =>
    (await import('@mantle/db/test-support')).superuserExec(scratch!.url, q);

  /** A running trace started `hours` ago, of a lane or none. */
  const trace = async (hours: number, lane?: string): Promise<string> => {
    const id = randomUUID();
    await su(sql`insert into traces (id, owner_id, kind, status, started_at, data)
      values (${id}, ${anchor}, 'pipeline_run', 'running',
              now() - make_interval(mins => ${Math.round(hours * 60)}),
              ${JSON.stringify(lane ? { source: 'book', lane } : { source: 'upload' })}::jsonb)`);
    return id;
  };
  const statusOf = async (id: string) =>
    (
      (await m.systemDb.execute(
        sql`select status::text as s, error from traces where id = ${id}::uuid`,
      )) as unknown as Array<{ s: string; error: string | null }>
    )[0]!;

  beforeAll(async () => {
    scratch = await (await import('@mantle/db/test-support')).createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key'; // as audit-read-only.db.test
    m = await import('@mantle/db');
    j = await import('./journey');
    const admin = (m.systemDb as unknown as { $client: Parameters<typeof ensureTestAnchor>[0] })
      .$client;
    anchor = await ensureTestAnchor(admin);
    const { PgBoss } = await import('pg-boss');
    const boss = new PgBoss({ connectionString: scratch.url, schema: 'pgboss' });
    await boss.start();
    await boss.stop({ graceful: false, timeout: 5_000 });
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it('a book read two hours in stays running; a plain trace two hours in is abandoned', async () => {
    const plain = await trace(2);
    const book = await trace(2, 'book');
    const fresh = await trace(0.1);
    expect((await j.listAbandonedTraces()).map((t) => t.id)).toEqual([plain]);
    expect(await m.runAsSystem('test:reap', () => j.reapAbandonedTraces(anchor))).toBe(1);
    expect(await statusOf(plain)).toMatchObject({ s: 'error' });
    expect((await statusOf(plain)).error).toMatch(/^abandoned/);
    expect(await statusOf(book)).toMatchObject({ s: 'running' });
    expect(await statusOf(fresh)).toMatchObject({ s: 'running' });
  });

  it('a book read past the book lane budget is abandoned, by the all-owner sweep too', async () => {
    const old = await trace(13, 'book');
    const live = await trace(11, 'book');
    expect(await j.reapAbandonedTracesAllOwners()).toBe(1);
    expect(await statusOf(old)).toMatchObject({ s: 'error' });
    expect(await statusOf(live)).toMatchObject({ s: 'running' });
  });

  it('the corpus audit reports what the reapers reap: a book read two hours in is live', async () => {
    const plain = await trace(2);
    const book = await trace(2, 'book');
    const { runCorpusAudit } = await import('./integrity/audit');
    const check = (await runCorpusAudit(anchor)).checks.find((c) => c.key === 'abandoned_traces');
    expect(check?.samples.map((r) => r.id)).toEqual([plain]);
    expect(await statusOf(book)).toMatchObject({ s: 'running' });
  });
});
