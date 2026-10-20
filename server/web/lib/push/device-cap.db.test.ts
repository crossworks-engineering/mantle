/**
 * The per-login device cap of a push enrol (insertSubscription) on a real
 * migrated Postgres: past MAX_DEVICES_PER_LOGIN devices the login's oldest
 * go (created_at, then id, newest kept), their routing tokens answered for
 * the relay; another login's devices never move. The rows dropped equal
 * the cap's raw text (the reference below), run first and rolled back.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/push/device-cap.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the device cap of a push enrol', () => {
  let m: typeof import('@mantle/db');
  let sql: import('postgres').Sql;
  const tag = `dcap-${randomUUID().slice(0, 8)}`;
  const login = randomUUID();
  const other = randomUUID();
  const token = randomUUID();
  /** Seeded devices: twelve for the login (two share a created_at), one
   *  for the other login. */
  const seeded: { token: string; id: string; at: string }[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: import('postgres').Sql }).$client;
    for (const id of [login, other]) {
      await sql`insert into auth.users (id, email, password_hash, role)
                values (${id}, ${`${tag}-${id.slice(0, 8)}@example.invalid`}, 'x', 'member')`;
    }
    await sql`insert into mobile_tokens (id, user_id, label, expires_at)
              values (${token}, ${login}, ${tag}, now() + interval '1 day')`;
    for (let i = 0; i < 12; i++) {
      // Minutes ago: 12 down to 1, but devices 2 and 3 share theirs (10), at
      // the cap's edge: the id decides which of them goes.
      const ago = i === 3 ? 10 : 12 - i;
      const id = randomUUID();
      const t = `${tag}-d${i}`;
      const [r] = await sql<{ at: string }[]>`
        insert into push_subscriptions (id, owner_id, login_id, routing_token, public_key, platform, created_at)
        values (${id}, ${login}, ${login}, ${t}, 'pk', 'ios',
                date_trunc('second', now()) - make_interval(mins => ${ago}))
        returning created_at::text as at`;
      seeded.push({ token: t, id, at: r!.at });
    }
    await sql`insert into push_subscriptions (owner_id, login_id, routing_token, public_key, platform, created_at)
              values (${other}, ${other}, ${`${tag}-other`}, 'pk', 'ios', now() - interval '1 day')`;
  }, 60_000);

  afterAll(async () => {
    if (sql) {
      await sql`delete from push_subscriptions where routing_token like ${`${tag}-%`}`;
      await sql`delete from mobile_tokens where id = ${token}`;
      for (const id of [login, other]) await sql`delete from auth.users where id = ${id}`;
    }
    await m?.closeDb();
  });

  it('drops the oldest past the cap, the rows the raw text drops', async () => {
    const store = await import('./store');
    expect(store.MAX_DEVICES_PER_LOGIN).toBe(10);
    // The reference: the cap's raw delete after the new device lands,
    // rolled back.
    const reference: string[] = [];
    await sql
      .begin(async (tx) => {
        await tx`insert into push_subscriptions (owner_id, login_id, token_id, routing_token, public_key, platform)
                 values (${login}, ${login}, ${token}, ${`${tag}-ref`}, 'pk', 'ios')`;
        const rows = await tx<{ routing_token: string }[]>`
          delete from push_subscriptions where id in (
            select id from push_subscriptions
             where login_id = ${login}
             order by created_at desc, id desc
             offset ${store.MAX_DEVICES_PER_LOGIN})
          returning routing_token`;
        reference.push(...rows.map((r) => r.routing_token));
        throw new Error('rollback');
      })
      .catch((err: unknown) => {
        if (String(err).includes('rollback')) return;
        throw err;
      });

    const res = await store.insertSubscription({
      ownerId: login,
      loginId: login,
      tokenId: token,
      routingToken: `${tag}-new`,
      publicKey: 'pk',
      platform: 'ios',
    });
    // The two oldest seeded devices, by created_at then id (newest kept).
    const order = [...seeded].sort((a, b) =>
      a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1,
    );
    const want = order.slice(9).map((d) => d.token);
    expect(want).toHaveLength(3);
    expect([...res.dropped].sort()).toEqual([...want].sort());
    expect([...reference].sort()).toEqual([...want].sort());

    const left = await sql<{ routing_token: string }[]>`
      select routing_token from push_subscriptions where login_id = ${login}`;
    expect(left).toHaveLength(10);
    expect(left.map((r) => r.routing_token)).toContain(`${tag}-new`);
    const [kept] = await sql<{ n: number }[]>`
      select count(*)::int as n from push_subscriptions where login_id = ${other}`;
    expect(kept!.n).toBe(1);
  });
});
