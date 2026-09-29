/**
 * Email sign-in codes (client logins C2b) on a real, migrated Postgres:
 * a code is made only for an active client login, stored only as a hash
 * bound to its request, one open code per email and address, capped per
 * email plus address, per email and brain-wide; it redeems once, only in
 * the browser that asked (its request id), only with the login's email,
 * within 10 minutes, and dies after 5 wrong tries.
 *
 * Every call runs at a fixed time far in the future (`at`), so rows other
 * test files make now never count toward these caps. Seeds its own logins
 * and removes them (their codes cascade).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/client-codes.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const MIN = 60 * 1000;

describe.skipIf(!URL)('client email sign-in codes', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let c: typeof import('./client-codes');
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `ccode-${randomUUID().slice(0, 8)}`;
  const email = (s: string) => `${tag}-${s}@example.invalid`;
  const login: Record<string, string> = {};
  const exec = (q: ReturnType<typeof sqlTag>) => m.systemDb.execute(q);
  const rows = async <T>(q: ReturnType<typeof sqlTag>) => (await exec(q)) as unknown as T[];
  /** A time no other test file writes at. */
  let base = 0;
  const at = (offsetMs = 0) => new Date(base + offsetMs);
  const ask = (who: string, opts: { ip?: string; t?: number; requestId?: string } = {}) => {
    const requestId = opts.requestId ?? randomUUID();
    return c
      .createClientEmailCode(
        {
          email: email(who).toUpperCase(),
          requestId,
          ip: opts.ip ?? '203.0.113.9',
          requestedAt: at(opts.t ?? 0).toISOString(),
        },
        at(opts.t ?? 0),
      )
      .then((d) => ({ ...d, requestId }));
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    c = await import('./client-codes');
    sqlTag = (await import('drizzle-orm')).sql;
    base = Date.UTC(2099, 0, 1) + Math.floor(Math.random() * 1_000_000) * MIN;
    for (const [name, role, disabled] of [
      ['ada', 'client', false],
      ['bea', 'client', false],
      ['cy', 'client', false],
      ['di', 'client', false],
      ['gone', 'client', true],
      ['staff', 'member', false],
      ['fill', 'client', false],
    ] as const) {
      login[name] = randomUUID();
      await exec(sqlTag`
        insert into auth.users (id, email, password_hash, role, disabled_at)
        values (${login[name]}, ${email(name)}, 'x', ${role}, ${disabled ? sqlTag`now()` : null})`);
    }
  });

  afterAll(async () => {
    for (const id of Object.values(login)) {
      await exec(sqlTag`delete from spaces where login_id = ${id}`);
      await exec(sqlTag`delete from auth.users where id = ${id}`);
    }
    await m.closeDb();
  });

  it('makes no code for a stranger, a member, a disabled client, bad or stale input', async () => {
    expect(await ask('nobody')).toMatchObject({ kind: 'skip', reason: 'not-a-client' });
    expect(await ask('staff')).toMatchObject({ kind: 'skip', reason: 'not-a-client' });
    expect(await ask('gone')).toMatchObject({ kind: 'skip', reason: 'not-a-client' });
    const bad = await c.createClientEmailCode(
      { email: 'not an email', requestId: randomUUID(), ip: 'x', requestedAt: at().toISOString() },
      at(),
    );
    expect(bad).toEqual({ kind: 'skip', reason: 'invalid' });
    const stale = await c.createClientEmailCode(
      {
        email: email('ada'),
        requestId: randomUUID(),
        ip: 'x',
        requestedAt: at(-11 * MIN).toISOString(),
      },
      at(),
    );
    expect(stale).toEqual({ kind: 'skip', reason: 'stale' });
    const [n] = await rows<{ n: number }>(sqlTag`
      select count(*)::int as n from client_signin_codes
       where login_id in (${login.staff}, ${login.gone}, ${login.ada})`);
    expect(n!.n).toBe(0);
  });

  it('makes an 8-digit code for a client, stored only as a hash of request and code', async () => {
    const d = await ask('ada');
    expect(d.kind).toBe('send');
    if (d.kind !== 'send') return;
    expect(d.code).toMatch(/^\d{8}$/);
    expect(d.email).toBe(email('ada'));
    expect(d.expiresAt.getTime() - base).toBe(10 * MIN);
    const [row] = await rows<Record<string, unknown>>(
      sqlTag`select * from client_signin_codes where id = ${d.codeId}`,
    );
    expect(row).toMatchObject({
      kind: 'email',
      login_id: login.ada,
      request_id: d.requestId,
      request_ip: '203.0.113.9',
      attempts: 0,
      used_at: null,
    });
    const hash = createHash('sha256').update(`${d.requestId}:${d.code}`, 'utf8').digest('hex');
    expect(row!.code_hash).toBe(hash);
    expect(JSON.stringify(row)).not.toContain(`"${d.code}"`);
  });

  it('redeems once, only for this request and this email, and records the sign-in', async () => {
    const d = await ask('bea');
    if (d.kind !== 'send') throw new Error('expected a code');
    const t = at(MIN);
    const other = randomUUID();
    expect(
      await c.redeemClientEmailCode({ requestId: other, email: email('bea'), code: d.code }, t),
    ).toBeNull();
    const ok = await c.redeemClientEmailCode(
      { requestId: d.requestId, email: ` ${email('bea').toUpperCase()} `, code: d.code },
      t,
    );
    expect(ok).toMatchObject({ loginId: login.bea, codeId: d.codeId, sessionEpoch: 0 });
    expect(
      await c.redeemClientEmailCode(
        { requestId: d.requestId, email: email('bea'), code: d.code },
        t,
      ),
    ).toBeNull();
    const [u] = await rows<{ last_login_at: Date | null }>(
      sqlTag`select last_login_at from auth.users where id = ${login.bea}`,
    );
    expect(u!.last_login_at).not.toBeNull();
  });

  it('a wrong email or code costs a try; the fifth wrong try kills the code', async () => {
    const d = await ask('cy');
    if (d.kind !== 'send') throw new Error('expected a code');
    const wrong = d.code === '00000000' ? '00000001' : '00000000';
    const t = at(MIN);
    expect(
      await c.redeemClientEmailCode(
        { requestId: d.requestId, email: email('ada'), code: d.code },
        t,
      ),
    ).toBeNull();
    for (let i = 0; i < 4; i += 1) {
      expect(
        await c.redeemClientEmailCode(
          { requestId: d.requestId, email: email('cy'), code: wrong },
          t,
        ),
      ).toBeNull();
    }
    const [row] = await rows<{ attempts: number }>(
      sqlTag`select attempts from client_signin_codes where id = ${d.codeId}`,
    );
    expect(row!.attempts).toBe(5);
    expect(
      await c.redeemClientEmailCode(
        { requestId: d.requestId, email: email('cy'), code: d.code },
        t,
      ),
    ).toBeNull();
  });

  it('expires after 10 minutes', async () => {
    const d = await ask('di', { t: 0 });
    if (d.kind !== 'send') throw new Error('expected a code');
    const input = { requestId: d.requestId, email: email('di'), code: d.code };
    expect(await c.redeemClientEmailCode(input, at(10 * MIN + 1000))).toBeNull();
    expect(await c.redeemClientEmailCode(input, at(9 * MIN))).not.toBeNull();
  });

  it('one open code per email and address; another address gets its own', async () => {
    const t = 2 * 60 * MIN;
    const first = await ask('ada', { ip: '198.51.100.1', t });
    expect(first.kind).toBe('send');
    expect(await ask('ada', { ip: '198.51.100.1', t: t + MIN })).toMatchObject({
      kind: 'skip',
      reason: 'code-open',
    });
    expect((await ask('ada', { ip: '198.51.100.2', t: t + MIN })).kind).toBe('send');
    // After it expires, the same address gets a new one.
    expect((await ask('ada', { ip: '198.51.100.1', t: t + 11 * MIN })).kind).toBe('send');
  });

  it('a retried job for the same request makes no second code', async () => {
    const t = 4 * 60 * MIN;
    const first = await ask('bea', { ip: '198.51.100.3', t });
    expect(first.kind).toBe('send');
    const again = await ask('bea', { ip: '198.51.100.4', t, requestId: first.requestId });
    expect(again).toMatchObject({ kind: 'skip', reason: 'duplicate' });
  });

  it('caps codes per email and address (5 a day) and per email (10 an hour)', async () => {
    const t0 = 6 * 60 * MIN;
    // Five from one address, each after the last expired: the sixth is capped.
    for (let i = 0; i < 5; i += 1) {
      expect((await ask('cy', { ip: '198.51.100.5', t: t0 + i * 11 * MIN })).kind).toBe('send');
    }
    expect(await ask('cy', { ip: '198.51.100.5', t: t0 + 60 * MIN })).toMatchObject({
      kind: 'skip',
      reason: 'cap-email-ip',
    });
    // Ten in an hour from many addresses: the eleventh is capped.
    const t1 = 30 * 60 * MIN;
    for (let i = 0; i < 10; i += 1) {
      expect((await ask('di', { ip: `198.51.101.${i}`, t: t1 + i * MIN })).kind).toBe('send');
    }
    expect(await ask('di', { ip: '198.51.101.99', t: t1 + 20 * MIN })).toMatchObject({
      kind: 'skip',
      reason: 'cap-email',
    });
  });

  it('stops sending brain-wide at the daily cap, and not before', async () => {
    const t = 60 * 60 * MIN;
    const cap = c.CLIENT_CODE_DAILY_CAP;
    await exec(sqlTag`
      insert into client_signin_codes (owner_id, login_id, kind, code_hash, expires_at, created_at)
      select ${login.fill}, ${login.fill}, 'email', ${tag} || '-' || g, ${at(t)}, ${at(t - 60 * MIN)}
        from generate_series(1, ${cap - 1}) g`);
    expect(await c.clientCodesSentLast24h(at(t))).toBe(cap - 1);
    expect((await ask('ada', { ip: '198.51.100.6', t })).kind).toBe('send');
    expect(await ask('bea', { ip: '198.51.100.6', t })).toMatchObject({
      kind: 'skip',
      reason: 'cap-brain',
    });
    // A day later the window has moved on.
    expect((await ask('bea', { ip: '198.51.100.6', t: t + 25 * 60 * MIN })).kind).toBe('send');
  });

  it('a revoked code no longer redeems and no longer blocks a new one', async () => {
    const t = 100 * 60 * MIN;
    const d = await ask('ada', { ip: '198.51.100.7', t });
    if (d.kind !== 'send') throw new Error('expected a code');
    await c.revokeClientEmailCode(d.codeId, at(t));
    expect(
      await c.redeemClientEmailCode(
        { requestId: d.requestId, email: email('ada'), code: d.code },
        at(t),
      ),
    ).toBeNull();
    expect((await ask('ada', { ip: '198.51.100.7', t: t + MIN })).kind).toBe('send');
  });
});
