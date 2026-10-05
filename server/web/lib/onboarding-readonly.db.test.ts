/**
 * isOnboarded on a database that refuses writes (a read-only replica, a role
 * with SELECT only such as the public demo's reader). A brain with an enabled
 * agent and no `onboardedAt` is set up: the answer is read, and the stamp
 * that saves the next call the lookup is best effort. GET /api/onboarding
 * answered 500 there, for a write the answer never needed.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run onboarding-readonly.db.test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('isOnboarded as a role with SELECT only', () => {
  type Db = typeof import('@mantle/db');
  type Admin = Parameters<Db['ensureViewerRoles']>[0];
  let m: Db;
  let onboarding: typeof import('./onboarding');
  let sqlTag: typeof import('drizzle-orm').sql;
  let reader: { name: string; url: string } | null = null;
  let anchor = '';
  const agent = randomUUID();
  const slug = `onb-ro-${agent.slice(0, 8)}`;

  const adminClient = () => (m.systemDb as unknown as { $client: Admin }).$client;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    onboarding = await import('./onboarding');
    sqlTag = (await import('drizzle-orm')).sql;
    const { createReadOnlyRole, ensureTestAnchor } = await import('@mantle/db/test-support');
    // The agent lookup is against the brain's anchor, whoever asks.
    anchor = await ensureTestAnchor(adminClient());
    await m.db.execute(sqlTag`
      insert into agents (id, owner_id, slug, name, model, system_prompt, enabled)
      values (${agent}, ${anchor}, ${slug}, ${slug}, 'test/model', 'You are a test agent.', true)`);
    reader = await createReadOnlyRole(adminClient(), URL!);
    await m.closeDb();
    process.env.DATABASE_URL = reader.url;
  }, 60_000);

  afterAll(async () => {
    if (!m) return;
    await m.closeDb();
    process.env.DATABASE_URL = URL;
    await m.db.execute(sqlTag`delete from agents where id = ${agent}`);
    if (reader) {
      const { dropReadOnlyRole } = await import('@mantle/db/test-support');
      await dropReadOnlyRole(adminClient(), reader.name);
    }
    await m.closeDb();
  });

  it('answers true from the enabled agent, though the stamp is refused', async () => {
    // Preferences as a brain from before onboarding has them: no stamp, no step.
    const prefs = {} as Parameters<typeof onboarding.isOnboarded>[1];
    expect(await onboarding.isOnboarded(anchor, prefs)).toBe(true);
    // The stamp itself is still a refused write for a caller that needs it.
    await expect(onboarding.markOnboarded(anchor)).rejects.toSatisfy(m.isWriteRefused);
  });
});
