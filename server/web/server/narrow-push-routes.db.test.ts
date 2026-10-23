/**
 * The owner's push device routes on the narrow route (switch on), through
 * the real app (createApp): DELETE /api/push/subscriptions/:id (the
 * owner's phone, a device bearer) and POST /api/push/reset (the owner's
 * session), with the owner's and a member's device present. Each answers
 * 200 and the rows are gone; the owner's device (a held login, 0328) is
 * removed at the spot login-credential, the member's by the narrow login
 * itself; no statement is refused by the narrow role (vitest.setup.ts
 * fails a test on any denial). The relay is stubbed (no network).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/narrow-push-routes.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const RELAY = 'http://relay.push-routes';

// The reset seals the new instance token with the master key; the test key
// is no real one (as in the area sweep).
vi.mock('@mantle/crypto', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  seal: vi.fn(() => ({ ciphertext: Buffer.from('sealed'), keyVersion: 1 })),
  open: vi.fn(() => 'push-routes-instance-token'),
}));

describe.skipIf(!URL)('the push device routes on the narrow route', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let ts: Ts;
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let rr: typeof import('@mantle/db/runtime-role');
  let m: typeof import('@mantle/db');
  let tokens: typeof import('../lib/auth/tokens');
  let su: ReturnType<typeof postgres>;
  let app: { request: (path: string, init: RequestInit) => Response | Promise<Response> };
  const realFetch = globalThis.fetch;
  const owner = randomUUID();
  const member = randomUUID();
  const phone = randomUUID();

  beforeAll(async () => {
    ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    await su`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
             values (${owner}, ${`${owner}@example.test`}, 'x', true, 'admin', 'Push Owner')`;
    await su`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
             on conflict (id) do nothing`;
    await su`insert into auth.users (id, email, password_hash, role)
             values (${member}, ${`${member}@example.test`}, 'x', 'member')`;
    await su`insert into mobile_tokens (id, user_id, label, expires_at)
             values (${phone}, ${owner}, 'owner phone', now() + interval '30 days')`;
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'narrow-push-routes-secret-at-least-32-characters';
    process.env.MANTLE_PUSH_RELAY_URL = RELAY;
    await ts.runWorkspacesSwitch(scratch.url);
    await su`insert into profiles (user_id) values (${owner}) on conflict do nothing`;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : 'url' in input ? input.url : input.href;
      if (!url.startsWith(RELAY)) throw new Error('push routes: no network');
      // The relay registers the brain (its instance id) and takes the rest.
      const out = url.endsWith('/instances') ? { instanceId: 'push-routes-instance' } : {};
      return new Response(JSON.stringify(out), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    rr = await import('@mantle/db/runtime-role');
    // The narrow route whatever the run's switch: the cells are about it.
    rr.setNarrowSystemForTests(true);
    m = await import('@mantle/db');
    tokens = await import('../lib/auth/tokens');
    const { createApp } = await import('./app');
    app = await createApp();
  }, 120_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await m?.closeDb();
    rr?.setNarrowSystemForTests(null);
    await su?.end();
    await scratch?.drop();
  });

  /** A device of the brain enrolled by `login`; its id. */
  const device = async (login: string, label: string) => {
    const [row] = await su<{ id: string }[]>`
      insert into push_subscriptions (owner_id, login_id, routing_token, public_key, platform, label)
      values (${owner}, ${login}, ${`push-routes-${label}-${randomUUID()}`}, 'pk', 'ios', ${label})
      returning id::text as id`;
    return row!.id;
  };
  const left = async (ids: string[]) =>
    (
      await su<{ n: number }[]>`
        select count(*)::int as n from push_subscriptions where id = any(${ids}::uuid[])`
    )[0]!.n;

  it("DELETE /api/push/subscriptions/:id removes the owner's device (at login-credential) and a member's (narrow), 200 each", async () => {
    const mine = await device(owner, 'owner');
    const theirs = await device(member, 'member');
    const bearer = tokens.buildMobileToken(owner, phone).value;
    const del = (id: string) =>
      app.request(`/api/push/subscriptions/${id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${bearer}` },
      });
    ts.takeSpotUses();
    const a = await del(mine);
    expect(a.status, await a.clone().text()).toBe(200);
    expect(await a.json()).toEqual({ ok: true });
    expect(ts.takeSpotUses()).toContain('login-credential');
    ts.takeNarrowUses();
    const b = await del(theirs);
    expect(b.status, await b.clone().text()).toBe(200);
    expect(await b.json()).toEqual({ ok: true });
    // A member's device: the narrow login removes it, no spot.
    expect(ts.takeSpotUses()).not.toContain('login-credential');
    const uses = ts.takeNarrowUses();
    console.log('NARROW_USES', JSON.stringify(uses));
    expect(
      Object.entries(uses).filter(([actor, n]) => !actor.startsWith('fn:') && n > 0),
      'the member device delete ran on the narrow route',
    ).not.toEqual([]);
    expect(await left([mine, theirs])).toBe(0);
  });

  it("POST /api/push/reset with the owner's and a member's device: 200, every device gone", async () => {
    const ids = [await device(owner, 'owner-r'), await device(member, 'member-r')];
    const cookie = `mantle_session=${tokens.buildSessionCookie(owner).value}`;
    ts.takeSpotUses();
    const res = await app.request('/api/push/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ ok: true, invalidated: 2 });
    expect(ts.takeSpotUses()).toContain('login-credential');
    expect(await left(ids)).toBe(0);
    const [all] = await su<{ n: number }[]>`
      select count(*)::int as n from push_subscriptions where owner_id = ${owner}`;
    expect(all!.n).toBe(0);
  });
});
