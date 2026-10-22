/**
 * The `actor-misses-reap` sweep on a real, migrated Postgres
 * (actor-misses-reap.ts): a row past the retention goes, a recent one
 * stays, and the narrow rows stay at any age: the counts and the epoch row
 * migrate writes once per release (narrow-epoch, packages/db/src/
 * migrator-steps.ts ensureNarrowEpoch), which the box script counts from.
 * A scratch database, so no other test's rows are reaped.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/maintenance/actor-misses-reap.db.test.ts
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('actor-misses-reap keeps the narrow rows and their epoch', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let reap: typeof import('./actor-misses-reap');
  let su: ReturnType<typeof postgres>;

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    m = await import('@mantle/db');
    reap = await import('./actor-misses-reap');
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await su?.end();
    await scratch?.drop();
  }, 60_000);

  it('reaps an old miss row, keeps a recent one, and keeps every narrow row at any age', async () => {
    await su`delete from public.actor_check_misses`;
    const row = (source: string, check: string, detail: string, ago: string) =>
      su`insert into public.actor_check_misses (at, source, check_name, actor, detail)
         values (now() - ${ago}::interval, ${source}, ${check}, '', ${detail})`;
    await row('ts', 'db.insert', 'old caller', '30 days');
    await row('ts', 'fail-open:raw-write', 'old file', '30 days');
    await row('ts', 'db.insert', 'recent caller', '1 day');
    await row('migrate', 'narrow-epoch', '9.8.7', '400 days');
    await row('operator', 'narrow-epoch', 'reset: by hand', '30 days');
    await row('sql', 'narrow-would-refuse', 'public.agents UPDATE', '400 days');

    expect(await reap.reapActorMisses({ dryRun: true })).toEqual({ deleted: 2 });
    expect(await reap.reapActorMisses()).toEqual({ deleted: 2 });
    const left = await su<{ check_name: string; detail: string }[]>`
      select check_name, detail from public.actor_check_misses order by check_name, detail`;
    expect(left.map((r) => `${r.check_name} ${r.detail}`)).toEqual([
      'db.insert recent caller',
      'narrow-epoch 9.8.7',
      'narrow-epoch reset: by hand',
      'narrow-would-refuse public.agents UPDATE',
    ]);
    // Idempotent: nothing more to reap.
    expect(await reap.reapActorMisses()).toEqual({ deleted: 0 });
  });
});
