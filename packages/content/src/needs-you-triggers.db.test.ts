/**
 * Cost-safety for the `needs_you_changed` event (migrations 0186, 0214,
 * 0230) on a real, migrated Postgres: the trigger functions that raise it
 * only notify (no write, no job, nothing an LLM could follow), and no other
 * function mentions the channel. The review queue and team requests the
 * event once counted for were removed in workspaces W5c; the triggers stay
 * (provider outages still raise it).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/needs-you-triggers.db.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const FNS = [
  'mantle_notify_needs_you',
  'mantle_notify_needs_you_request',
  'mantle_notify_provider_alert',
];

describe.skipIf(!URL)('needs_you_changed triggers', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let admin: Parameters<Db['ensureViewerRoles']>[0];

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
  }, 60_000);

  afterAll(async () => {
    if (m) await m.closeDb();
  });

  it('the trigger functions only notify: no write, no job, nothing an LLM could follow', async () => {
    const fns = await admin<{ proname: string; src: string }[]>`
      select proname, prosrc as src from pg_proc where proname in ${admin(FNS)}`;
    expect(fns.map((f) => f.proname).sort()).toEqual([...FNS].sort());
    for (const f of fns) {
      expect(f.src).toMatch(/pg_notify\('needs_you_changed'/);
      expect(f.src).not.toMatch(
        /insert\s+into|update\s+\S+\s+set|delete\s+from|pgboss|perform\s+(?!pg_notify)/i,
      );
    }
    const [other] = await admin<{ n: number }[]>`
      select count(*)::int as n from pg_proc
       where prosrc like '%needs_you_changed%' and proname not in ${admin(FNS)}`;
    expect(other!.n).toBe(0);
  });
});
