/**
 * Ending a login's sessions (final audit F06), on a real migrated Postgres,
 * through the real app (createApp): the session cookie and the `?at=` asset
 * token carry the login's session_epoch (0181), every request compares it
 * with the row, and these bump it:
 *
 *   - a password change (the caller's own cookie is re-issued; a bearer
 *     caller keeps its own bearer, every other bearer is revoked);
 *   - an admin disabling the login (and enabling it again);
 *   - a role change;
 *   - "sign out everywhere": POST /api/auth/logout {everywhere:true}, and an
 *     admin's PATCH /api/users/:id {signOut:true}.
 *
 * Probes: GET /api/member/space/not-a-uuid (a member past the gate gets the
 * handler's 400; no session is 401) and GET /api/admin/space/not-a-uuid (the
 * same for an admin).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/auth/session-epoch.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;

describe.skipIf(!URL)('session epoch: ending a login’s sessions', () => {
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let app: import('hono').Hono;
  let tokens: typeof import('./tokens');
  const tag = `epoch-${randomUUID().slice(0, 8)}`;
  const member = randomUUID();
  const admin = randomUUID(); // the caller of the admin routes
  const demoted = randomUUID(); // an admin, demoted below
  const logins = [member, admin, demoted];
  let createdAnchor: string | null = null;
  let anchor = '';
  let password = 'first password 1';
  const emailOf = (id: string) => `${tag}-${id.slice(0, 8)}@example.com`;
  let ip = 0;

  const call = (
    path: string,
    init: { method?: string; cookie?: string; bearer?: string; body?: unknown } = {},
  ) => {
    ip += 1;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // A fresh address per call keeps the per-IP limits out of the way.
      'x-forwarded-for': `203.0.113.${ip % 250}`,
    };
    if (init.cookie) headers.cookie = init.cookie;
    if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
    return Promise.resolve(
      app.request(path, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
    );
  };
  const cookieFrom = (res: Response): string | null => {
    const set = res.headers.get('set-cookie') ?? '';
    const m1 = /mantle_session=([^;]*)/.exec(set);
    return m1 && m1[1] ? `mantle_session=${m1[1]}` : null;
  };
  const cookieAt = (id: string, epoch: number) =>
    `mantle_session=${tokens.buildSessionCookie(id, { epoch }).value}`;
  const epochOf = async (id: string) =>
    Number(
      (await sql<Row[]>`select session_epoch from auth.users where id = ${id}`)[0]!.session_epoch,
    );
  const memberProbe = (auth: { cookie?: string; bearer?: string }) =>
    call('/api/member/space/not-a-uuid', auth).then((r) => r.status);
  const adminProbe = (auth: { cookie?: string; bearer?: string }) =>
    call('/api/admin/space/not-a-uuid', auth).then((r) => r.status);
  /** A bearer for `login`: a mobile_tokens row and its signed token. */
  const bearerFor = async (login: string) => {
    const jti = randomUUID();
    const t = tokens.buildMobileToken(login, jti, 3600);
    await sql`insert into mobile_tokens (id, user_id, label, expires_at)
              values (${jti}, ${login}, ${tag}, ${t.expiresAt})`;
    return { jti, token: t.value };
  };
  const revoked = async (jti: string) =>
    (await sql<Row[]>`select revoked_at from mobile_tokens where id = ${jti}`)[0]!.revoked_at !==
    null;
  const signIn = async (id: string) => {
    const res = await call('/api/auth/login', {
      method: 'POST',
      body: { email: emailOf(id), password },
    });
    expect(res.status).toBe(200);
    return cookieFrom(res)!;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'session-epoch-db-test-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    tokens = await import('./tokens');
    // A member resolves against the brain's anchor: use the one there is,
    // or make one for this file.
    const [a] = await sql<Row[]>`select id from auth.users where is_owner limit 1`;
    if (a) anchor = a.id as string;
    else {
      anchor = randomUUID();
      createdAnchor = anchor;
      await sql`insert into auth.users (id, email, password_hash, role, is_owner)
                values (${anchor}, ${emailOf(anchor)}, 'x', 'admin', true)`;
    }
    const hash = bcrypt.hashSync(password, 4);
    await sql`insert into auth.users (id, email, password_hash, role) values
      (${member}, ${emailOf(member)}, ${hash}, 'member'),
      (${admin}, ${emailOf(admin)}, ${hash}, 'admin'),
      (${demoted}, ${emailOf(demoted)}, ${hash}, 'admin')`;
    const { createApp } = await import('../../server/app');
    app = await createApp();
  }, 120_000);

  afterAll(async () => {
    if (!sql) return;
    const all = createdAnchor ? [...logins, createdAnchor] : logins;
    await sql`delete from audit_log where actor_email like ${`${tag}%`}`;
    await sql`delete from mobile_tokens where user_id in ${sql(all)}`;
    await sql`delete from spaces where login_id in ${sql(all)}`;
    await sql`delete from auth.users where id in ${sql(all)}`;
  });

  it('a password change ends every other session, and keeps the caller signed in', async () => {
    const c1 = await signIn(member);
    const other = await signIn(member); // a second browser
    const phone = await bearerFor(member);
    expect(await memberProbe({ cookie: c1 })).toBe(400);
    expect(await memberProbe({ bearer: phone.token })).toBe(400);
    const before = await epochOf(member);

    const next = 'second password 2';
    const res = await call('/api/auth/change-password', {
      method: 'POST',
      cookie: c1,
      body: { oldPassword: password, newPassword: next },
    });
    expect(res.status).toBe(200);
    password = next;
    expect(await epochOf(member)).toBe(before + 1);

    // The copied cookie from before the change: the audit's replay.
    expect(await memberProbe({ cookie: c1 })).toBe(401);
    expect(await memberProbe({ cookie: other })).toBe(401);
    expect(await memberProbe({ bearer: phone.token })).toBe(401);
    expect(await revoked(phone.jti)).toBe(true);
    // The caller got a fresh cookie at the new epoch.
    const c2 = cookieFrom(res);
    expect(c2).toBeTruthy();
    expect(await memberProbe({ cookie: c2! })).toBe(400);
  });

  it('a password change from a bearer keeps that bearer and ends the rest', async () => {
    const mine = await bearerFor(member);
    const sibling = await bearerFor(member);
    const cookie = await signIn(member);
    const next = 'third password 3';
    const res = await call('/api/auth/change-password', {
      method: 'POST',
      bearer: mine.token,
      body: { oldPassword: password, newPassword: next },
    });
    expect(res.status).toBe(200);
    password = next;
    expect(cookieFrom(res)).toBeNull();
    expect(await memberProbe({ bearer: mine.token })).toBe(400);
    expect(await revoked(mine.jti)).toBe(false);
    expect(await memberProbe({ bearer: sibling.token })).toBe(401);
    expect(await memberProbe({ cookie })).toBe(401);
  });

  it('disable then enable again: the old cookie stays dead', async () => {
    const old = await signIn(member);
    const phone = await bearerFor(member);
    expect(await memberProbe({ cookie: old })).toBe(400);
    const asAdmin = cookieAt(admin, await epochOf(admin));

    const off = await call(`/api/users/${member}`, {
      method: 'PATCH',
      cookie: asAdmin,
      body: { disabled: true },
    });
    expect(off.status).toBe(200);
    expect(await memberProbe({ cookie: old })).toBe(401);
    const on = await call(`/api/users/${member}`, {
      method: 'PATCH',
      cookie: asAdmin,
      body: { disabled: false },
    });
    expect(on.status).toBe(200);
    expect(await memberProbe({ cookie: old })).toBe(401);
    expect(await memberProbe({ bearer: phone.token })).toBe(401);
    // Signing in again works.
    expect(await memberProbe({ cookie: await signIn(member) })).toBe(400);
  });

  it('a role change ends the sessions; an unchanged role does not', async () => {
    const asAdmin = cookieAt(admin, await epochOf(admin));
    const theirs = await signIn(demoted);
    expect(await adminProbe({ cookie: theirs })).toBe(400);
    const same = await call(`/api/users/${demoted}`, {
      method: 'PATCH',
      cookie: asAdmin,
      body: { role: 'admin' },
    });
    expect(same.status).toBe(200);
    expect(await adminProbe({ cookie: theirs })).toBe(400);
    const res = await call(`/api/users/${demoted}`, {
      method: 'PATCH',
      cookie: asAdmin,
      body: { role: 'member' },
    });
    expect(res.status).toBe(200);
    expect(await memberProbe({ cookie: theirs })).toBe(401);
    expect(await memberProbe({ cookie: await signIn(demoted) })).toBe(400);
  });

  it('an admin can sign a login out everywhere', async () => {
    const asAdmin = cookieAt(admin, await epochOf(admin));
    const theirs = await signIn(member);
    const res = await call(`/api/users/${member}`, {
      method: 'PATCH',
      cookie: asAdmin,
      body: { signOut: true },
    });
    expect(res.status).toBe(200);
    expect(await memberProbe({ cookie: theirs })).toBe(401);
  });

  it('a login signs itself out everywhere', async () => {
    const here = await signIn(member);
    const there = await signIn(member);
    const phone = await bearerFor(member);
    const res = await call('/api/auth/logout', {
      method: 'POST',
      cookie: here,
      body: { everywhere: true },
    });
    expect(res.status).toBe(200);
    expect(await memberProbe({ cookie: there })).toBe(401);
    expect(await memberProbe({ bearer: phone.token })).toBe(401);
    // A plain logout ends only this browser.
    const a = await signIn(member);
    const b = await signIn(member);
    expect((await call('/api/auth/logout', { method: 'POST', cookie: a })).status).toBe(200);
    expect(await memberProbe({ cookie: b })).toBe(400);
  });

  it('an ?at= asset token minted before a bump fails after it', async () => {
    const { mintAssetToken, endLoginSessions } = await import('./session');
    const file = (at: string) =>
      call(`/api/member/files/not-a-uuid?at=${encodeURIComponent(at)}`).then((r) => r.status);
    const at = await mintAssetToken(anchor, member);
    expect(await file(at)).toBe(400);
    await endLoginSessions(member);
    expect(await file(at)).toBe(401);
    expect(await file(await mintAssetToken(anchor, member))).toBe(400);
  });

  it('an admin password reset ends the target’s sessions', async () => {
    const asAdmin = cookieAt(admin, await epochOf(admin));
    const theirs = await signIn(member);
    const res = await call(`/api/users/${member}/password`, {
      method: 'POST',
      cookie: asAdmin,
      body: { newPassword: 'reset password 4' },
    });
    expect(res.status).toBe(200);
    password = 'reset password 4';
    expect(cookieFrom(res)).toBeNull();
    expect(await memberProbe({ cookie: theirs })).toBe(401);
    expect(await adminProbe({ cookie: asAdmin })).toBe(400);
  });
});
