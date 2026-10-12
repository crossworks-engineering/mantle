/**
 * Every content table carries the actor check's write trigger (workspaces
 * arch A2a, migration 0275): each table ACCESS_MATRIX marks writer
 * 'content' that exists after migrate has the statement trigger
 * mantle_actor_check, so a write on it with no actor is a miss. A new
 * content table fails here until a migration gives it the trigger.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/actor-trigger-coverage.db.test.ts
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_MATRIX } from './access-matrix';
import { createMigratedScratchDatabase } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the actor check trigger covers every content table (arch A2a)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    sql = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('each content table that exists has mantle_actor_check', async () => {
    const content = ACCESS_MATRIX.filter((t) => t.writer === 'content').map((t) => t.table);
    expect(content.length).toBeGreaterThan(0);
    const rows = await sql<{ tbl: string; present: boolean; covered: boolean }[]>`
      select t.name as tbl,
             to_regclass(t.name) is not null as present,
             exists (select 1 from pg_trigger g
                      where g.tgrelid = to_regclass(t.name)
                        and g.tgname = 'mantle_actor_check'
                        and not g.tgisinternal) as covered
        from unnest(${content}::text[]) as t(name)`;
    const missing = rows.filter((r) => r.present && !r.covered).map((r) => r.tbl);
    expect(missing).toEqual([]);
    // The check reads real tables: most of the list exists.
    expect(rows.filter((r) => r.present).length).toBeGreaterThan(content.length / 2);
  });
});
