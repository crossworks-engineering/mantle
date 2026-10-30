/**
 * The box password rule on a real migrated Postgres, through the real app
 * (createApp), with MANTLE_POLICY_PASSWORD_MIN=12 (docs/policy.md):
 *
 *   - a sign-in with a password that fails the rule sets
 *     must_change_password and records the rule (0347); the login then
 *     reaches the change step and whoami, every other route answers 403
 *     password_change_required;
 *   - the change refuses a common password (400 password_common) and takes
 *     a good one, which clears the flag;
 *   - a login never checked under the rule answers 401
 *     password_recheck_required (but signs out), until it signs in once.
 *
 * Under the runtime role lane too: the new columns are read on the login
 * lookup and written at the full-route spot login-credential.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/auth/password-hold.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asSuperuser,
  createMigratedScratchDatabase,
  ensureTestAnchor,
  runWorkspacesSwitch,
} from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;

describe.skipIf(!URL)('the box password rule on a real database', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let app: import('hono').Hono;
  let tokens: typeof import('./tokens');
  const savedMin = process.env.MANTLE_POLICY_PASSWORD_MIN;
  const tag = `pwhold-${randomUUID().slice(0, 8)}`;
  const weak = randomUUID(); // a member whose password fails the rule
  const old = randomUUID(); // a member never checked under the rule
  const WEAK = 'password1234';
  const GOOD = 'blue kettle under the stairs';
  const emailOf = (id: string) => `${tag}-${id.slice(0, 8)}@example.com`;
  let ip = 0;

  const call = (path: string, init: { method?: string; cookie?: string; body?: unknown } = {}) => {
    ip += 1;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-forwarded-for': `203.0.113.${ip % 250}`,
      origin: 'http://localhost',
    };
    if (init.cookie) headers.cookie = init.cookie;
    return Promise.resolve(
      app.request(`http://localhost${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
    );
  };
  const cookieFrom = (res: Response): string | null => {
    const m1 = /mantle_session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '');
    return m1 && m1[1] ? `mantle_session=${m1[1]}` : null;
  };
  const stateOf = async (id: string) =>
    (
      await sql<Row[]>`select must_change_password as flag, password_checked_min as checked
                         from auth.users where id = ${id}`
    )[0]!;
  /** A member route past the gate: its handler's answer, else the hold's. */
  const probe = (cookie: string) => call('/api/member/push/preferences', { cookie });

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'password-hold-db-test-secret-at-least-32-chars';
    process.env.MANTLE_POLICY_PASSWORD_MIN = '12';
    delete process.env.MANTLE_DETACHED_DEV;
    const config = await import('@mantle/config');
    config.resetBoxPolicyForTests();
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    tokens = await import('./tokens');
    await ensureTestAnchor(sql);
    await asSuperuser()`insert into auth.users (id, email, password_hash, role) values
      (${weak}, ${emailOf(weak)}, ${bcrypt.hashSync(WEAK, 4)}, 'member'),
      (${old}, ${emailOf(old)}, ${bcrypt.hashSync(GOOD, 4)}, 'member')`;
    await runWorkspacesSwitch(scratch.url);
    const { createApp } = await import('../../server/app');
    app = await createApp();
  }, 120_000);

  afterAll(async () => {
    if (savedMin === undefined) delete process.env.MANTLE_POLICY_PASSWORD_MIN;
    else process.env.MANTLE_POLICY_PASSWORD_MIN = savedMin;
    (await import('@mantle/config')).resetBoxPolicyForTests();
    await m?.closeDb();
    await scratch?.drop();
  });

  it('a weak password: held to the change step, then free once changed', async () => {
    const signIn = await call('/api/auth/login', {
      method: 'POST',
      body: { email: emailOf(weak), password: WEAK },
    });
    expect(signIn.status).toBe(200);
    const cookie = cookieFrom(signIn)!;
    expect(await stateOf(weak)).toEqual({ flag: true, checked: 12 });

    const held = await probe(cookie);
    expect(held.status).toBe(403);
    expect(await held.json()).toMatchObject({ code: 'password_change_required', min: 12 });

    const who = await call('/api/auth/whoami', { cookie });
    expect(who.status).toBe(200);
    expect(await who.json()).toMatchObject({
      mustChangePassword: true,
      passwordRule: { min: 12, commonList: true },
    });

    const common = await call('/api/auth/change-password', {
      method: 'POST',
      cookie,
      body: { oldPassword: WEAK, newPassword: 'Password2026!' },
    });
    expect(common.status).toBe(400);
    expect(await common.json()).toMatchObject({ code: 'password_common', min: 12 });

    const changed = await call('/api/auth/change-password', {
      method: 'POST',
      cookie,
      body: { oldPassword: WEAK, newPassword: GOOD },
    });
    expect(changed.status).toBe(200);
    expect(await stateOf(weak)).toEqual({ flag: false, checked: 12 });
    const fresh = cookieFrom(changed)!;
    const past = await probe(fresh);
    expect([401, 403]).not.toContain(past.status);
  });

  it('a login never checked under the rule signs in once, then is free', async () => {
    expect(await stateOf(old)).toEqual({ flag: false, checked: null });
    const epoch = Number(
      (await sql<Row[]>`select session_epoch from auth.users where id = ${old}`)[0]!.session_epoch,
    );
    const before = `mantle_session=${tokens.buildSessionCookie(old, { epoch }).value}`;
    const held = await probe(before);
    expect(held.status).toBe(401);
    expect(await held.json()).toMatchObject({ code: 'password_recheck_required' });
    // Signing out is open under every hold.
    expect((await call('/api/auth/logout', { method: 'POST', cookie: before })).status).toBe(200);

    const signIn = await call('/api/auth/login', {
      method: 'POST',
      body: { email: emailOf(old), password: GOOD },
    });
    expect(signIn.status).toBe(200);
    expect(await stateOf(old)).toEqual({ flag: false, checked: 12 });
    const past = await probe(cookieFrom(signIn)!);
    expect([401, 403]).not.toContain(past.status);
  });
});
