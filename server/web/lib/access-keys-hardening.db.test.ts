/**
 * Inbound API keys after the M2 audit, on a real migrated Postgres through
 * the real app (createApp):
 *
 *  - F4: an admin or member re-types their password to make a key (a client
 *    has none); a member's key lasts at most 90 days, a client's 30, and
 *    neither may be "never"; a password change and "sign out everywhere"
 *    revoke the login's keys, a client's plain sign-out does not;
 *  - F3: one address meets a cap of failed keys across every prefix, before
 *    the database is asked;
 *  - F7: the 50 live keys cap holds under concurrent creates, and one
 *    login's keys share one budget.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/access-keys-hardening.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;
type Json = Record<string, unknown>;

describe.skipIf(!URL)('inbound API keys: hardening', () => {
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let app: import('hono').Hono;
  let tokens: typeof import('./auth/tokens');
  const tag = `akhard-${randomUUID().slice(0, 8)}`;
  const PASSWORD = 'a long enough password';
  const admin = randomUUID();
  const member = randomUUID();
  const client = randomUUID();
  const capped = randomUUID();
  const busy = randomUUID();
  const all = [admin, member, client, capped, busy];
  const emailOf = (s: string) => `${tag}-${s}@example.com`;
  let ip = 0;

  const call = async (
    path: string,
    init: { method?: string; cookie?: string; bearer?: string; body?: unknown; ip?: string } = {},
  ) => {
    ip += 1;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-forwarded-for': init.ip ?? `198.51.100.${ip % 250}`,
    };
    if (init.cookie) headers.cookie = init.cookie;
    if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
    return app.request(path, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  };
  const json = async (res: Response) => (await res.json()) as Json;
  const epochOf = async (id: string) =>
    Number(
      (await sql<Row[]>`select session_epoch from auth.users where id = ${id}`)[0]!.session_epoch,
    );
  const cookieOf = async (id: string) =>
    `mantle_session=${
      tokens.buildSessionCookie(id, { epoch: await epochOf(id), ttlSeconds: 29 * 24 * 3600 }).value
    }`;
  const make = async (as: string, body: Json = {}) =>
    call('/api/access-keys', {
      method: 'POST',
      cookie: await cookieOf(as),
      body: { name: 'Hardening', access: 'read', areas: null, ...body },
    });
  const makeKey = async (as: string, body: Json = {}) => {
    const res = await make(as, as === client ? body : { password: PASSWORD, ...body });
    expect(res.status).toBe(201);
    return (await json(res)) as { id: string; prefix: string; secret: string; expiresAt: string };
  };
  const whoami = (bearer: string, at?: string) => call('/api/v1/whoami', { bearer, ip: at });
  const days = (iso: string) => (Date.parse(iso) - Date.now()) / 86_400_000;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'access-keys-hardening-db-test-secret-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    tokens = await import('./auth/tokens');
    await ensureTestAnchor(sql);
    const hash = bcrypt.hashSync(PASSWORD, 4);
    await sql`insert into auth.users (id, email, password_hash, role, display_name) values
      (${admin}, ${emailOf('admin')}, ${hash}, 'admin', 'Ada Admin'),
      (${member}, ${emailOf('member')}, ${hash}, 'member', 'Mia Member'),
      (${client}, ${emailOf('client')}, ${hash}, 'client', 'Cal Client'),
      (${capped}, ${emailOf('capped')}, ${hash}, 'member', 'Cap Member'),
      (${busy}, ${emailOf('busy')}, ${hash}, 'admin', 'Bea Busy')`;
    const { createApp } = await import('../server/app');
    app = await createApp();
  }, 120_000);

  afterAll(async () => {
    if (!sql) return;
    const keys = await sql<
      Row[]
    >`select id::text as id from access_keys where login_id in ${sql(all)}`;
    const ids = keys.map((k) => String(k.id));
    if (ids.length) await sql`delete from audit_log where detail->>'keyId' in ${sql(ids)}`;
    await sql`delete from access_keys where login_id in ${sql(all)}`;
    await sql`delete from mobile_tokens where user_id in ${sql(all)}`;
    await sql`delete from spaces where login_id in ${sql(all)}`;
    await sql`delete from auth.users where id in ${sql(all)}`;
  });

  // ── F4 ────────────────────────────────────────────────────────────────────

  it('an admin or member re-types the password; a client has none to type', async () => {
    for (const who of [admin, member]) {
      expect((await make(who)).status).toBe(403);
      expect((await make(who, { password: 'wrong password' })).status).toBe(403);
      expect((await make(who, { password: PASSWORD })).status).toBe(201);
    }
    expect((await make(client)).status).toBe(201);
  });

  it('caps a member key at 90 days and a client key at 30, never "never"', async () => {
    const list = (await json(
      await call('/api/access-keys', { cookie: await cookieOf(member) }),
    )) as Json;
    expect(list).toMatchObject({ maxExpiryDays: 90, needsPassword: true });
    expect(
      (await json(await call('/api/access-keys', { cookie: await cookieOf(client) }))) as Json,
    ).toMatchObject({ maxExpiryDays: 30, needsPassword: false, defaultExpiryDays: 30 });

    expect((await make(member, { password: PASSWORD, expiresInDays: null })).status).toBe(400);
    expect((await make(member, { password: PASSWORD, expiresInDays: 365 })).status).toBe(400);
    expect((await make(client, { expiresInDays: 90 })).status).toBe(400);
    expect((await make(client, { expiresInDays: null })).status).toBe(400);

    const clientKey = await makeKey(client);
    expect(days(clientKey.expiresAt)).toBeLessThanOrEqual(30);
    const adminKey = await makeKey(admin, { expiresInDays: null });
    expect(adminKey.expiresAt).toBeNull();
  });

  it('a password change and "sign out everywhere" revoke the keys', async () => {
    const before = await makeKey(member);
    expect((await whoami(before.secret)).status).toBe(200);
    const change = await call('/api/auth/change-password', {
      method: 'POST',
      cookie: await cookieOf(member),
      body: { oldPassword: PASSWORD, newPassword: 'another long enough password' },
    });
    expect([200, 204]).toContain(change.status);
    expect((await whoami(before.secret)).status).toBe(401);

    const again = await makeKey(admin);
    const out = await call('/api/auth/logout', {
      method: 'POST',
      cookie: await cookieOf(admin),
      body: { everywhere: true },
    });
    expect([200, 204]).toContain(out.status);
    expect((await whoami(again.secret)).status).toBe(401);
  });

  it("a client's plain sign-out leaves its keys alive", async () => {
    const key = await makeKey(client);
    const out = await call('/api/auth/logout', { method: 'POST', cookie: await cookieOf(client) });
    expect([200, 204]).toContain(out.status);
    expect((await whoami(key.secret)).status).toBe(200);
  });

  // ── F3 ────────────────────────────────────────────────────────────────────

  it('caps one address at 100 failed keys a minute, any prefix', async () => {
    const at = '192.0.2.200';
    const good = await makeKey(admin);
    for (let i = 0; i < 100; i += 1) {
      const prefix = randomUUID().replace(/-/g, '').slice(0, 8);
      expect((await whoami(`mtlk_${prefix}_${'D'.repeat(43)}`, at)).status).toBe(401);
    }
    // Past the cap the address is answered before the database is asked,
    // a valid key included; another address is untouched.
    expect((await whoami(good.secret, at)).status).toBe(429);
    expect((await whoami(good.secret, '192.0.2.201')).status).toBe(200);
  });

  // ── F7 ────────────────────────────────────────────────────────────────────

  it('holds the 50 live keys cap under concurrent creates', async () => {
    const rows = Array.from({ length: 49 }, (_, i) => ({
      name: `filler ${i}`,
      login_id: capped,
      login_role: 'member',
      key_prefix: randomUUID().replace(/-/g, '').slice(0, 8),
      key_hash: createHash('sha256').update(randomUUID()).digest('hex'),
      access: 'read',
    }));
    await sql`insert into access_keys ${sql(rows)}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => make(capped, { password: PASSWORD })),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409]);
  });

  it("shares one budget across a login's keys", async () => {
    const keys = await Promise.all(Array.from({ length: 6 }, () => makeKey(busy)));
    let refused = 0;
    for (const k of keys) {
      for (let i = 0; i < 101; i += 1) {
        if ((await whoami(k.secret)).status === 429) refused += 1;
      }
    }
    // 606 requests, each key under its own 120: the login's 600 refuses some.
    expect(refused).toBeGreaterThan(0);
  });
});
