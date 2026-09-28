/**
 * The "needs you" push goes to ACTIVE ADMIN devices only, on a real migrated
 * Postgres: a member's device, a deactivated admin's device and a device with
 * no login on record are never listed (fail closed), and another brain's
 * devices never are either.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/push/admin-subscriptions.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('listAdminSubscriptions', () => {
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  const tag = `nyou-push-${randomUUID().slice(0, 8)}`;
  const brain = randomUUID();
  const other = randomUUID();
  const admin = randomUUID();
  const gone = randomUUID();
  const member = randomUUID();
  const logins = [admin, gone, member];

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    for (const [id, role] of [
      [admin, 'admin'],
      [gone, 'admin'],
      [member, 'member'],
    ] as const) {
      await sql`insert into auth.users (id, email, password_hash, role)
                values (${id}, ${`${tag}-${id.slice(0, 8)}@example.invalid`}, 'x', ${role})`;
    }
    await sql`update auth.users set disabled_at = now() where id = ${gone}`;
    const device = (owner: string, login: string | null, label: string) => sql`
      insert into push_subscriptions (owner_id, login_id, routing_token, public_key, platform, label)
      values (${owner}, ${login}, ${`${tag}-${label}`}, 'pk', 'ios', ${label})`;
    await device(brain, admin, 'admin');
    await device(brain, gone, 'gone');
    await device(brain, member, 'member');
    await device(brain, null, 'unknown');
    await device(other, admin, 'other-brain');
  });

  afterAll(async () => {
    await sql`delete from push_subscriptions where routing_token like ${`${tag}-%`}`;
    for (const id of logins) await sql`delete from auth.users where id = ${id}`;
    await m.closeDb();
  });

  it('lists the active admin’s device and nothing else', async () => {
    const { listAdminSubscriptions } = await import('./store');
    const rows = await listAdminSubscriptions(brain);
    expect(rows.map((r) => r.label)).toEqual(['admin']);
  });
});
