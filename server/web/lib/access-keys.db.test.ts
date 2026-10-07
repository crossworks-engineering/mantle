/**
 * Inbound API keys end to end on a real migrated Postgres, through the real
 * app (createApp): make, list, use, refuse, revoke.
 *
 *  - an admin makes a key for itself or for a member or client login, never
 *    for another admin; a member cannot reach the key routes at all;
 *  - the secret is answered once; the row keeps only its SHA-256 and the
 *    list never shows either;
 *  - a key works on /api/v1/* and nowhere else under /api, even with a
 *    cookie riding along, and not on the public /api/auth prefix;
 *  - a wrong secret, a revoked key, an expired key, and a key whose login
 *    was signed out everywhere, disabled or changed role are all a 401;
 *  - the key's rate budget (120 a minute) and the failed-try budget per
 *    address (20 a minute) answer 429;
 *  - key.created, key.revoked and key.refused land in the audit log.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/access-keys.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;
type Json = Record<string, unknown>;

describe.skipIf(!URL)('inbound API keys', () => {
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let app: import('hono').Hono;
  let tokens: typeof import('./auth/tokens');
  const tag = `akey-${randomUUID().slice(0, 8)}`;
  const admin = randomUUID();
  const admin2 = randomUUID();
  const member = randomUUID();
  const client = randomUUID();
  const member2 = randomUUID();
  const all = [admin, admin2, member, client, member2];
  const emailOf = (s: string) => `${tag}-${s}@example.com`;
  let ip = 0;

  const call = async (
    path: string,
    init: {
      method?: string;
      cookie?: string;
      bearer?: string;
      body?: unknown;
      ip?: string;
    } = {},
  ) => {
    ip += 1;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // A fresh address per call keeps the per-IP limits out of the way.
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
  const cookieOf = (id: string, epoch = 0) =>
    `mantle_session=${tokens.buildSessionCookie(id, { epoch }).value}`;
  const epochOf = async (id: string) =>
    Number(
      (await sql<Row[]>`select session_epoch from auth.users where id = ${id}`)[0]!.session_epoch,
    );

  const make = async (body: Json, as = admin) =>
    call('/api/access-keys', { method: 'POST', cookie: cookieOf(as, await epochOf(as)), body });
  const makeKey = async (body: Partial<Json> = {}) => {
    const res = await make({
      name: 'Script',
      loginId: admin,
      access: 'read',
      areas: null,
      ...body,
    });
    expect(res.status).toBe(201);
    return (await json(res)) as { id: string; prefix: string; secret: string };
  };
  const whoami = (bearer: string, extra: { cookie?: string; ip?: string } = {}) =>
    call('/api/v1/whoami', { bearer, ...extra });
  const audited = async (action: string, keyId: string) => {
    for (let i = 0; i < 100; i += 1) {
      const rows = await sql<Row[]>`
        select actor_id, detail from audit_log
        where action = ${action} and detail->>'keyId' = ${keyId}`;
      if (rows.length) return rows;
      await new Promise((r) => setTimeout(r, 20));
    }
    return [];
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'access-keys-db-test-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    tokens = await import('./auth/tokens');
    await ensureTestAnchor(sql);
    await sql`insert into auth.users (id, email, password_hash, role, display_name) values
      (${admin}, ${emailOf('admin')}, 'x', 'admin', 'Ada Admin'),
      (${admin2}, ${emailOf('admin2')}, 'x', 'admin', 'Abe Admin'),
      (${member}, ${emailOf('member')}, 'x', 'member', 'Mia Member'),
      (${client}, ${emailOf('client')}, 'x', 'client', 'Cal Client'),
      (${member2}, ${emailOf('member2')}, 'x', 'member', 'Max Member')`;
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
    await sql`delete from spaces where login_id in ${sql(all)}`;
    await sql`delete from auth.users where id in ${sql(all)}`;
  });

  // ── Make and list ─────────────────────────────────────────────────────────

  it('answers the secret once and keeps only its hash', async () => {
    const res = await make({
      name: 'Backup script',
      loginId: admin,
      access: 'read_write',
      areas: ['pages', 'tables'],
      expiresInDays: 30,
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const made = (await json(res)) as { id: string; prefix: string; secret: string };
    expect(made.secret).toMatch(/^mtlk_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    expect(made.secret.startsWith(`${made.prefix}_`)).toBe(true);

    const [row] = await sql<Row[]>`select * from access_keys where id = ${made.id}`;
    expect(row!.key_hash).toBe(createHash('sha256').update(made.secret).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(made.secret.slice(14));
    expect(row!.login_role).toBe('admin');
    expect(row!.access).toBe('read_write');
    expect(row!.areas).toEqual(['pages', 'tables']);

    const list = await call('/api/access-keys', { cookie: cookieOf(admin) });
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).not.toContain(made.secret.slice(14));
    expect(text).not.toContain(String(row!.key_hash));
    const body = JSON.parse(text) as { keys: Json[]; logins: Json[]; areas: string[] };
    const listed = body.keys.find((k) => k.id === made.id)!;
    expect(listed).toMatchObject({
      name: 'Backup script',
      prefix: made.prefix,
      access: 'read_write',
      areas: ['pages', 'tables'],
      status: 'active',
      lastUsedAt: null,
    });
    expect((listed.login as Json).role).toBe('admin');
    // The picker: the caller, members and clients; never another admin.
    const pick = body.logins.map((l) => l.id);
    expect(pick[0]).toBe(admin);
    expect(pick).toContain(member);
    expect(pick).toContain(client);
    expect(pick).not.toContain(admin2);

    const created = await audited('key.created', made.id);
    expect(created).toHaveLength(1);
    expect(created[0]!.actor_id).toBe(admin);
    expect(JSON.stringify(created[0]!.detail)).not.toContain(made.secret.slice(14));
  });

  it('never makes a key that acts as another admin', async () => {
    const res = await make({ name: 'x', loginId: admin2, access: 'read', areas: null });
    expect(res.status).toBe(403);
  });

  it('keeps risky tools for admin keys, and checks the body', async () => {
    const risky = await make({
      name: 'x',
      loginId: member,
      access: 'read',
      areas: null,
      riskyTools: ['email_send'],
    });
    expect(risky.status).toBe(400);
    for (const bad of [
      { name: '', loginId: admin, access: 'read', areas: null },
      { name: 'x', loginId: admin, access: 'write', areas: null },
      { name: 'x', loginId: admin, access: 'read', areas: [] },
      { name: 'x', loginId: admin, access: 'read', areas: ['admin'] },
      { name: 'x', loginId: admin, access: 'read', areas: null, expiresInDays: 0 },
      { name: 'x', loginId: randomUUID(), access: 'read', areas: null },
    ]) {
      expect([400, 404]).toContain((await make(bad)).status);
    }
  });

  it('refuses the key routes to a member and to a key', async () => {
    const memberCookie = cookieOf(member);
    expect((await call('/api/access-keys', { cookie: memberCookie })).status).toBe(403);
    expect(
      (
        await call('/api/access-keys', {
          method: 'POST',
          cookie: memberCookie,
          body: { name: 'x', loginId: member, access: 'read', areas: null },
        })
      ).status,
    ).toBe(403);
    const { secret } = await makeKey();
    expect((await call('/api/access-keys', { bearer: secret })).status).toBe(401);
  });

  // ── Use ───────────────────────────────────────────────────────────────────

  it('acts as its login on /api/v1 and stamps its last use', async () => {
    const made = await makeKey({ name: 'Reader', access: 'read', areas: ['search'] });
    const res = await whoami(made.secret);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      role: 'admin',
      loginId: admin,
      key: { id: made.id, prefix: made.prefix, name: 'Reader', access: 'read', areas: ['search'] },
    });
    for (let i = 0; i < 50; i += 1) {
      const [row] = await sql<Row[]>`select last_used_at from access_keys where id = ${made.id}`;
      if (row!.last_used_at) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const [row] = await sql<
      Row[]
    >`select last_used_at, last_used_ip from access_keys where id = ${made.id}`;
    expect(row!.last_used_at).not.toBeNull();
  });

  it('acts as a member or a client login at that role', async () => {
    const forMember = await makeKey({ loginId: member });
    expect(await json(await whoami(forMember.secret))).toMatchObject({
      role: 'member',
      loginId: member,
    });
    const forClient = await makeKey({ loginId: client });
    expect(await json(await whoami(forClient.secret))).toMatchObject({
      role: 'client',
      loginId: client,
    });
  });

  it('is no credential anywhere but /api/v1, cookie or not', async () => {
    const { secret } = await makeKey();
    for (const path of ['/api/shell', '/api/pages', '/api/users', '/api/keys']) {
      expect((await call(path, { bearer: secret })).status).toBe(401);
      expect((await call(path, { bearer: secret, cookie: cookieOf(admin) })).status).toBe(401);
    }
    // A public prefix lets the request through the gate; the route's login
    // lookup still refuses the key.
    expect((await call('/api/auth/whoami', { bearer: secret })).status).toBe(401);
    // The key is judged on itself: a cookie of another login does not mix in.
    const res = await whoami(secret, { cookie: cookieOf(member) });
    expect((await json(res)).loginId).toBe(admin);
  });

  it('refuses a wrong secret and a malformed key', async () => {
    const { secret, prefix } = await makeKey();
    const wrong = `${prefix}_${'A'.repeat(43)}`;
    expect((await whoami(wrong)).status).toBe(401);
    expect((await whoami(`${secret}x`)).status).toBe(401);
    expect((await whoami('mtlk_nope')).status).toBe(401);
  });

  // ── What ends a key ───────────────────────────────────────────────────────

  it('ends on revoke, and says so in the audit log', async () => {
    const made = await makeKey();
    expect((await whoami(made.secret)).status).toBe(200);
    const res = await call(`/api/access-keys/${made.id}`, {
      method: 'DELETE',
      cookie: cookieOf(admin),
    });
    expect(res.status).toBe(200);
    expect((await whoami(made.secret)).status).toBe(401);
    // A second revoke finds nothing.
    expect(
      (await call(`/api/access-keys/${made.id}`, { method: 'DELETE', cookie: cookieOf(admin) }))
        .status,
    ).toBe(404);
    const [row] = await sql<Row[]>`select revoked_by from access_keys where id = ${made.id}`;
    expect(row!.revoked_by).toBe(admin);
    expect(await audited('key.revoked', made.id)).toHaveLength(1);
    const refused = await audited('key.refused', made.id);
    expect((refused[0]!.detail as Json).reason).toBe('revoked');
  });

  it('ends at its expiry', async () => {
    const made = await makeKey();
    await sql`update access_keys set expires_at = now() - interval '1 second' where id = ${made.id}`;
    expect((await whoami(made.secret)).status).toBe(401);
    const list = (await json(await call('/api/access-keys', { cookie: cookieOf(admin) }))) as {
      keys: Json[];
    };
    expect(list.keys.find((k) => k.id === made.id)!.status).toBe('expired');
  });

  it('can be made with no expiry', async () => {
    const made = await makeKey({ expiresInDays: null });
    const [row] = await sql<Row[]>`select expires_at from access_keys where id = ${made.id}`;
    expect(row!.expires_at).toBeNull();
    expect((await whoami(made.secret)).status).toBe(200);
  });

  it("ends with its login's sessions, a disable and a role change", async () => {
    const signedOut = await makeKey({ loginId: member });
    await sql`update auth.users set session_epoch = session_epoch + 1 where id = ${member}`;
    expect((await whoami(signedOut.secret)).status).toBe(401);

    const disabled = await makeKey({ loginId: client });
    await sql`update auth.users set disabled_at = now() where id = ${client}`;
    expect((await whoami(disabled.secret)).status).toBe(401);
    await sql`update auth.users set disabled_at = null where id = ${client}`;
    expect((await whoami(disabled.secret)).status).toBe(200);

    // A role change ends the key, even one that (wrongly) kept the epoch.
    // A client's role never changes (a database rule), so a member's here.
    const promoted = await makeKey({ loginId: member2 });
    const [before] = await sql<Row[]>`select session_epoch from auth.users where id = ${member2}`;
    await sql`update auth.users set role = 'admin' where id = ${member2}`;
    await sql`update auth.users set session_epoch = ${Number(before!.session_epoch)}
              where id = ${member2}`;
    expect((await whoami(promoted.secret)).status).toBe(401);
  });

  // ── Budgets ───────────────────────────────────────────────────────────────

  it('holds a key to 120 requests a minute', async () => {
    const { secret } = await makeKey();
    let last = 0;
    for (let i = 0; i < 121; i += 1) last = (await whoami(secret)).status;
    expect(last).toBe(429);
  });

  it('holds an address to 20 failed keys a minute', async () => {
    const at = '192.0.2.77';
    const { secret, prefix } = await makeKey();
    for (let i = 0; i < 20; i += 1) {
      expect((await whoami(`${prefix}_${'B'.repeat(43)}`, { ip: at })).status).toBe(401);
    }
    const res = await whoami(secret, { ip: at });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).not.toBeNull();
  });
});
