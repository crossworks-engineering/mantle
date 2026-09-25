/**
 * The shadow report on a migrated copy of a provisioned brain (member logins
 * Phase 0b). Read-only. Not in CI (needs recorded team turns):
 *   MANTLE_TEST_BRAIN_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/access-shadow.db.test.ts
 */
import { afterAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_BRAIN_DATABASE_URL;

describe.skipIf(!URL)('access shadow report on a brain copy', () => {
  afterAll(async () => {
    const { closeDb } = await import('@mantle/db');
    await closeDb();
  });

  it('reads recorded team turns and lists what a team-level responder would lose', async () => {
    process.env.DATABASE_URL = URL;
    const { db } = await import('@mantle/db');
    const { sql } = await import('drizzle-orm');
    const { accessShadowReport } = await import('./access-shadow');
    const [o] = (await db.execute(sql`select id from auth.users where is_owner`)) as unknown as {
      id: string;
    }[];
    const report = await accessShadowReport(o!.id, { days: 3650 });
    console.log(
      '[shadow]',
      JSON.stringify({ ...report, usedAtAdmin: report.usedAtAdmin.slice(0, 5) }),
    );
    expect(report.turns).toBeGreaterThan(0);
    expect(report.agent?.slug).toBe('team-responder');
    for (const item of report.usedAtAdmin) expect(item.uses).toBeGreaterThan(0);
    expect(report.facts.withVisibleSource).toBeLessThanOrEqual(report.facts.current);
  });
});
