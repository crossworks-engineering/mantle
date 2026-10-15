/**
 * A scratch database's drop() lets work still running on it finish before the
 * forced drop (test-support settleDatabase), and gives up after its wait.
 *
 * The flake behind it (CI on v0.300.48, w7e-member-scope.db.test.ts): every
 * test passed, then a request's leftover query opened a new pool after
 * closeDb(), and the forced drop killed that connection during postgres.js's
 * array-type lookup: an unhandled CONNECTION_CLOSED that failed the run. A
 * query in flight must now finish first; an idle connection the drop ends
 * rejects nothing.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/scratch-drop.db.test.ts
 */
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createEmptyScratchDatabase, pollUntil, settleDatabase } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('scratch drop waits for work in flight', () => {
  const active = async (admin: postgres.Sql, name: string) => {
    const [row] = await admin<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity
       where datname = ${name} and state = 'active' and query like '%pg_sleep%'`;
    return (row?.n ?? 0) > 0;
  };

  it('a query running when drop() starts finishes; the idle connection goes quietly', async () => {
    const scratch = await createEmptyScratchDatabase(URL!);
    const admin = postgres(URL!, { max: 1, onnotice: () => {} });
    const sql = postgres(scratch.url, { max: 2, onnotice: () => {} });
    try {
      // One connection that has run a query and sits idle, one mid query.
      await Promise.all([sql`select 1`.execute(), sql`select 2`.execute()]);
      const running = sql<{ n: number }[]>`select pg_sleep(0.4), 7 as n`.execute();
      await pollUntil(() => active(admin, scratch.name), { what: 'the sleep to start' });
      const t0 = Date.now();
      await scratch.drop();
      const [row] = await running;
      expect(row?.n).toBe(7);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
      const [gone] = await admin<{ n: number }[]>`
        select count(*)::int as n from pg_database where datname = ${scratch.name}`;
      expect(gone?.n).toBe(0);
    } finally {
      await sql.end({ timeout: 0 });
      await admin.end();
    }
  });

  it('stops waiting after its limit, so a stuck query cannot hold the teardown', async () => {
    const scratch = await createEmptyScratchDatabase(URL!);
    const admin = postgres(URL!, { max: 1, onnotice: () => {} });
    const sql = postgres(scratch.url, { max: 1, onnotice: () => {} });
    try {
      const stuck = sql`select pg_sleep(30)`.execute().catch((e: unknown) => e);
      await pollUntil(() => active(admin, scratch.name), { what: 'the sleep to start' });
      const t0 = Date.now();
      await settleDatabase(admin, scratch.name, 200);
      expect(Date.now() - t0).toBeLessThan(5_000);
      await scratch.drop();
      // The forced drop ended it: rejected, and caught above.
      expect(await stuck).toBeInstanceOf(Error);
    } finally {
      await sql.end({ timeout: 0 });
      await admin.end();
    }
  }, 30_000);
});
