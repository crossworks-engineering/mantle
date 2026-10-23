/**
 * The "needs you" push goes to ACTIVE ADMIN devices only, on a real migrated
 * Postgres: a member's device, a deactivated admin's device and a device with
 * no login on record are never listed (fail closed), and another brain's
 * devices never are either. An admin is a user of the Admin workspace
 * (membership decides, S8b): a login whose role column says admin without
 * that seat is not listed (r6 app L2).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/push/admin-subscriptions.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSuperuser, ensureAdminUsers, superuserClient } from '@mantle/db/test-support';

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
  const unseated = randomUUID(); // role admin in the column, no Admin seat
  const logins = [admin, gone, member, unseated];

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    for (const [id, role] of [
      [admin, 'admin'],
      [gone, 'admin'],
      [member, 'member'],
      [unseated, 'admin'],
    ] as const) {
      await asSuperuser()`insert into auth.users (id, email, password_hash, role)
                values (${id}, ${`${tag}-${id.slice(0, 8)}@example.invalid`}, 'x', ${role})`;
    }
    // The two admins are users of Admin (on the superuser's own client: the
    // app pools only read the workspace tables under the runtime role).
    const su = superuserClient(URL!);
    try {
      await ensureAdminUsers(su, [admin, gone]);
    } finally {
      await su.end();
    }
    await sql`update auth.users set disabled_at = now() where id = ${gone}`;
    const device = (owner: string, login: string | null, label: string) => sql`
      insert into push_subscriptions (owner_id, login_id, routing_token, public_key, platform, label)
      values (${owner}, ${login}, ${`${tag}-${label}`}, 'pk', 'ios', ${label})`;
    await device(brain, admin, 'admin');
    await device(brain, gone, 'gone');
    await device(brain, member, 'member');
    await device(brain, null, 'unknown');
    // The unseated login's device carries a live token of its own (what a
    // member's login push asks for).
    const tok = randomUUID();
    await sql`insert into mobile_tokens (id, user_id, label, expires_at)
              values (${tok}, ${unseated}, ${tag}, now() + interval '30 days')`;
    await sql`insert into push_subscriptions
                (owner_id, login_id, token_id, routing_token, public_key, platform, label)
              values (${brain}, ${unseated}, ${tok}, ${`${tag}-unseated`}, 'pk', 'ios', 'unseated')`;
    await device(other, admin, 'other-brain');
  }, 60_000);

  afterAll(async () => {
    await sql`delete from push_subscriptions where routing_token like ${`${tag}-%`}`;
    await sql`delete from mobile_tokens where user_id = ${unseated}`;
    for (const id of logins) await sql`delete from auth.users where id = ${id}`;
    await m.closeDb();
  });

  it('lists the active admin’s device and nothing else', async () => {
    const { listAdminSubscriptions } = await import('./store');
    const rows = await listAdminSubscriptions(brain);
    expect(rows.map((r) => r.label)).toEqual(['admin']);
  });

  it('asks membership, not the role column: no Admin seat, no admin push; the device list and a login push say the same (r6 app L2)', async () => {
    const { listAdminSubscriptions, listAdminDeviceList, listLoginSubscriptions } =
      await import('./store');
    expect((await listAdminSubscriptions(brain, { loginId: unseated })).length).toBe(0);
    const list = (await listAdminDeviceList(brain)).map((r) => r.label).sort();
    // The display role: the disabled Admin user's device shows, the
    // unseated one does not; a device with no login shows as before.
    expect(list).toEqual(['admin', 'gone', 'unknown']);
    // A login push (one that concerns that login alone) is a member's: by
    // membership the unseated login is one, so its own live device is
    // listed for it; an Admin user's never is.
    expect((await listLoginSubscriptions(brain, unseated)).map((r) => r.label)).toEqual([
      'unseated',
    ]);
    expect((await listLoginSubscriptions(brain, admin)).length).toBe(0);
  });
});
