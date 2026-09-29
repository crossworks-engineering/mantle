/**
 * Email sign-in codes (client logins C2b) on a real, migrated Postgres:
 * a code is made only for an active client login, stored only as an HMAC
 * bound to its request, one open code per email and address, capped per
 * email plus address (an hour and a day), per login (a day) and brain-wide,
 * with every cap skip counted; it redeems once, only in the browser that
 * asked (its request id), only with the login's email, only while the login
 * is an active client, within 10 minutes, and dies after 5 wrong tries,
 * however many guesses race (the row lock). What became of each mail is
 * recorded, and old rows are reaped.
 *
 * Every call runs at a fixed time far in the future (`at`), so rows other
 * test files make now never count toward these caps; the reaper runs at a
 * time far in the past, so it only ever sees this file's rows. Uses the
 * shared test anchor (ensureTestAnchor), so it also passes alone on a fresh
 * database (audit B7). Seeds its own logins and removes them (their codes
 * cascade).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/client-codes.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

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
  let savedSecret: string | undefined;
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
  const sent = async (who: string, opts: { ip?: string; t?: number; requestId?: string } = {}) => {
    const d = await ask(who, opts);
    if (d.kind !== 'send') throw new Error(`expected a code, got ${JSON.stringify(d)}`);
    return d;
  };
  const attemptsOf = async (id: string) =>
    (
      await rows<{ attempts: number }>(
        sqlTag`select attempts from client_signin_codes where id = ${id}`,
      )
    )[0]!.attempts;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    savedSecret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'client-codes-db-test-secret-at-least-32-chars';
    m = await import('@mantle/db');
    c = await import('./client-codes');
    sqlTag = (await import('drizzle-orm')).sql;
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    await ensureTestAnchor(
      (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] }).$client,
    );
    base = Date.UTC(2099, 0, 1) + Math.floor(Math.random() * 1_000_000) * MIN;
    for (const [name, role, disabled] of [
      ['ada', 'client', false],
      ['bea', 'client', false],
      ['cy', 'client', false],
      ['di', 'client', false],
      ['eve', 'client', false],
      ['fay', 'client', false],
      ['gil', 'client', false],
      ['hal', 'client', false],
      ['ivy', 'client', false],
      ['old', 'client', false],
      ['gone', 'client', true],
      ['staff', 'member', false],
      ['fill', 'client', false],
    ] as const) {
      login[name] = randomUUID();
      await exec(sqlTag`
        insert into auth.users (id, email, password_hash, role, disabled_at)
        values (${login[name]}, ${email(name)}, 'x', ${role}, ${disabled ? sqlTag`now()` : null})`);
    }
  }, 60_000);

  afterAll(async () => {
    if (!m) return;
    for (const id of Object.values(login)) {
      await exec(sqlTag`delete from spaces where login_id = ${id}`);
      await exec(sqlTag`delete from auth.users where id = ${id}`);
    }
    await exec(sqlTag`delete from client_signin_code_skips
                       where created_at >= ${at(-DAY).toISOString()}::timestamptz
                         and created_at <= ${at(400 * HOUR).toISOString()}::timestamptz`);
    if (savedSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = savedSecret;
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

  it('makes an 8-digit code for a client, stored only as an HMAC of request and code (B21)', async () => {
    const d = await sent('ada');
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
      sent_at: null,
      send_error: null,
    });
    expect(row!.code_hash).toBe(c.hashClientCode(d.requestId, d.code));
    // Not the bare SHA-256 the request id and 10^8 tries would recover.
    const bare = createHash('sha256').update(`${d.requestId}:${d.code}`, 'utf8').digest('hex');
    expect(row!.code_hash).not.toBe(bare);
    expect(JSON.stringify(row)).not.toContain(`"${d.code}"`);
  });

  it('redeems once, only for this request and this email, and records the sign-in', async () => {
    const d = await sent('bea');
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

  it('a wrong code costs a try; the fifth wrong try kills the code', async () => {
    const d = await sent('cy');
    const wrong = d.code === '00000000' ? '00000001' : '00000000';
    const t = at(MIN);
    // A wrong email finds no code of this request at all: nothing counted.
    expect(
      await c.redeemClientEmailCode(
        { requestId: d.requestId, email: email('ada'), code: d.code },
        t,
      ),
    ).toBeNull();
    expect(await attemptsOf(d.codeId)).toBe(0);
    for (let i = 0; i < 5; i += 1) {
      expect(
        await c.redeemClientEmailCode(
          { requestId: d.requestId, email: email('cy'), code: wrong },
          t,
        ),
      ).toBeNull();
    }
    expect(await attemptsOf(d.codeId)).toBe(5);
    expect(
      await c.redeemClientEmailCode(
        { requestId: d.requestId, email: email('cy'), code: d.code },
        t,
      ),
    ).toBeNull();
  });

  it('expires after 10 minutes', async () => {
    const d = await sent('di', { t: 0 });
    const input = { requestId: d.requestId, email: email('di'), code: d.code };
    expect(await c.redeemClientEmailCode(input, at(10 * MIN + 1000))).toBeNull();
    expect(await c.redeemClientEmailCode(input, at(9 * MIN))).not.toBeNull();
  });

  it('refuses the right code of a disabled login, or of one that is no longer a client (B28)', async () => {
    const t = 3 * HOUR;
    const f = await sent('fay', { t });
    const g = await sent('gil', { t });
    await exec(sqlTag`update auth.users set disabled_at = now() where id = ${login.fay}`);
    await exec(sqlTag`update auth.users set role = 'member' where id = ${login.gil}`);
    try {
      expect(
        await c.redeemClientEmailCode(
          { requestId: f.requestId, email: email('fay'), code: f.code },
          at(t + MIN),
        ),
      ).toBeNull();
      expect(
        await c.redeemClientEmailCode(
          { requestId: g.requestId, email: email('gil'), code: g.code },
          at(t + MIN),
        ),
      ).toBeNull();
      const state = await rows<{ id: string; used_at: Date | null; last_login_at: Date | null }>(
        sqlTag`select c.id, c.used_at, u.last_login_at
                 from client_signin_codes c join auth.users u on u.id = c.login_id
                where c.id in (${f.codeId}, ${g.codeId})`,
      );
      expect(state).toHaveLength(2);
      for (const s of state) {
        expect(s.used_at).toBeNull();
        expect(s.last_login_at).toBeNull();
      }
      // The refusal cost each code a try, as a wrong code would.
      expect(await attemptsOf(f.codeId)).toBe(1);
      expect(await attemptsOf(g.codeId)).toBe(1);
    } finally {
      await exec(sqlTag`update auth.users set disabled_at = null where id = ${login.fay}`);
      await exec(sqlTag`update auth.users set role = 'client' where id = ${login.gil}`);
    }
  });

  it('one open code per email and address; another address gets its own', async () => {
    const t = 2 * HOUR;
    await sent('ada', { ip: '198.51.100.1', t });
    expect(await ask('ada', { ip: '198.51.100.1', t: t + MIN })).toMatchObject({
      kind: 'skip',
      reason: 'code-open',
    });
    expect((await ask('ada', { ip: '198.51.100.2', t: t + MIN })).kind).toBe('send');
    // After it expires, the same address gets a new one.
    expect((await ask('ada', { ip: '198.51.100.1', t: t + 11 * MIN })).kind).toBe('send');
  });

  it('the same browser asking again keeps its open code; after it expires it gets a new one', async () => {
    const t = 4 * HOUR;
    const first = await sent('bea', { ip: '198.51.100.3', t });
    // Asked again (Send a new code, a double click, a retried job), from
    // another address too: no second code, and the mailed one still works.
    const again = await ask('bea', { ip: '198.51.100.4', t: t + MIN, requestId: first.requestId });
    expect(again).toMatchObject({ kind: 'skip', reason: 'duplicate' });
    const input = { requestId: first.requestId, email: email('bea'), code: first.code };
    expect(await c.redeemClientEmailCode(input, at(t + 2 * MIN))).not.toBeNull();
    // Used now: the same browser asks again and gets a new code.
    const next = await sent('bea', {
      ip: '198.51.100.3',
      t: t + 3 * MIN,
      requestId: first.requestId,
    });
    expect(
      await c.redeemClientEmailCode(
        { requestId: first.requestId, email: email('bea'), code: next.code },
        at(t + 4 * MIN),
      ),
    ).not.toBeNull();
  });

  it('one browser asking for two emails gets a code for each, each redeems its own', async () => {
    const t = 8 * HOUR;
    const requestId = randomUUID();
    const a = await sent('ada', { ip: '198.51.100.8', t, requestId });
    const b = await sent('bea', { ip: '198.51.100.8', t, requestId });
    // Each email with the other's code fails and costs its own code a try.
    expect(
      await c.redeemClientEmailCode({ requestId, email: email('ada'), code: b.code }, at(t)),
    ).toBeNull();
    expect(
      await c.redeemClientEmailCode({ requestId, email: email('bea'), code: b.code }, at(t)),
    ).toMatchObject({ loginId: login.bea });
    expect(
      await c.redeemClientEmailCode({ requestId, email: email('ada'), code: a.code }, at(t)),
    ).toMatchObject({ loginId: login.ada });
  });

  it('caps codes per email and address: 3 an hour, 5 a day (B2)', async () => {
    const t0 = 12 * HOUR;
    const ip = '198.51.100.5';
    // Three in an hour, each after the last expired: the fourth is capped.
    for (let i = 0; i < 3; i += 1) await sent('cy', { ip, t: t0 + i * 11 * MIN });
    expect(await ask('cy', { ip, t: t0 + 40 * MIN })).toMatchObject({
      kind: 'skip',
      reason: 'cap-email-ip-hour',
    });
    // The next hour gives two more, then the day is full.
    await sent('cy', { ip, t: t0 + 61 * MIN });
    await sent('cy', { ip, t: t0 + 72 * MIN });
    expect(await ask('cy', { ip, t: t0 + 130 * MIN })).toMatchObject({
      kind: 'skip',
      reason: 'cap-email-ip',
    });
    // A day later the address may ask again.
    expect((await ask('cy', { ip, t: t0 + DAY + 11 * MIN })).kind).toBe('send');
  });

  it("two addresses cannot use up a client's codes at the client's own address (B2)", async () => {
    const t0 = 16 * HOUR;
    // A stranger asks for di's codes from two addresses until both are capped.
    for (const ip of ['192.0.2.10', '192.0.2.11']) {
      for (let i = 0; i < 3; i += 1) await sent('di', { ip, t: t0 + i * 11 * MIN });
      expect(await ask('di', { ip, t: t0 + 35 * MIN })).toMatchObject({
        kind: 'skip',
        reason: 'cap-email-ip-hour',
      });
    }
    // di, at their own address, in the same hour: a code.
    expect((await ask('di', { ip: '198.51.100.77', t: t0 + 36 * MIN })).kind).toBe('send');
  });

  it('caps one login at 20 codes a day from all addresses, except at an address it signed in from (B2)', async () => {
    const t0 = 20 * HOUR;
    // eve signs in from home once.
    const home = await sent('eve', { ip: '198.51.100.90', t: t0 });
    expect(
      await c.redeemClientEmailCode(
        { requestId: home.requestId, email: email('eve'), code: home.code },
        at(t0 + MIN),
      ),
    ).not.toBeNull();
    // Strangers use up the rest of eve's day from 19 addresses.
    for (let i = 0; i < c.CLIENT_CODE_PER_LOGIN_DAILY - 1; i += 1) {
      await sent('eve', { ip: `192.0.2.${100 + i}`, t: t0 + 2 * MIN });
    }
    const before = (await c.clientCodeStats(at(t0 + 3 * MIN))).capSkips;
    expect(await ask('eve', { ip: '192.0.2.250', t: t0 + 3 * MIN })).toMatchObject({
      kind: 'skip',
      reason: 'cap-login',
    });
    // The skip is counted for the admin card.
    expect((await c.clientCodeStats(at(t0 + 3 * MIN))).capSkips).toBe(before + 1);
    // Home still works: strangers cannot lock eve out of it.
    expect((await ask('eve', { ip: '198.51.100.90', t: t0 + 4 * MIN })).kind).toBe('send');
  });

  it('50 wrong guesses at once count exactly 5 tries, and the right code then fails (B18)', async () => {
    const d = await sent('hal', { t: 30 * HOUR });
    const wrong = d.code === '11111111' ? '22222222' : '11111111';
    const input = { requestId: d.requestId, email: email('hal'), code: wrong };
    const results = await Promise.all(
      Array.from({ length: 50 }, () => c.redeemClientEmailCode(input, at(30 * HOUR + MIN))),
    );
    expect(results.filter(Boolean)).toHaveLength(0);
    expect(await attemptsOf(d.codeId)).toBe(c.CLIENT_CODE_MAX_ATTEMPTS);
    expect(
      await c.redeemClientEmailCode({ ...input, code: d.code }, at(30 * HOUR + 2 * MIN)),
    ).toBeNull();
  });

  it('20 right codes at once sign in exactly once (B18)', async () => {
    const d = await sent('ivy', { t: 31 * HOUR });
    const input = { requestId: d.requestId, email: email('ivy'), code: d.code };
    const results = await Promise.all(
      Array.from({ length: 20 }, () => c.redeemClientEmailCode(input, at(31 * HOUR + MIN))),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('stops sending brain-wide at the daily cap, and not before', async () => {
    const t = 60 * HOUR;
    const cap = c.CLIENT_CODE_DAILY_CAP;
    await exec(sqlTag`
      insert into client_signin_codes (owner_id, login_id, kind, code_hash, expires_at, created_at)
      select ${login.fill}, ${login.fill}, 'email', ${tag} || '-' || g, ${at(t).toISOString()}::timestamptz, ${at(t - 60 * MIN).toISOString()}::timestamptz
        from generate_series(1, ${cap - 1}) g`);
    expect(await c.clientCodesSentLast24h(at(t))).toBe(cap - 1);
    expect((await ask('ada', { ip: '198.51.100.6', t })).kind).toBe('send');
    expect(await ask('bea', { ip: '198.51.100.6', t })).toMatchObject({
      kind: 'skip',
      reason: 'cap-brain',
    });
    // A day later the window has moved on.
    expect((await ask('bea', { ip: '198.51.100.6', t: t + 25 * HOUR })).kind).toBe('send');
  });

  it('a revoked code no longer redeems and no longer blocks a new one', async () => {
    const t = 100 * HOUR;
    const d = await sent('ada', { ip: '198.51.100.7', t });
    await c.revokeClientEmailCode(d.codeId, at(t));
    expect(
      await c.redeemClientEmailCode(
        { requestId: d.requestId, email: email('ada'), code: d.code },
        at(t),
      ),
    ).toBeNull();
    expect((await ask('ada', { ip: '198.51.100.7', t: t + MIN })).kind).toBe('send');
  });

  it('records what became of each mail, and the card counts delivered and failed apart (B3)', async () => {
    const t = 200 * HOUR;
    const ok1 = await sent('ada', { ip: '198.51.100.30', t });
    const ok2 = await sent('bea', { ip: '198.51.100.30', t });
    const bad = await sent('cy', { ip: '198.51.100.30', t });
    await c.markClientEmailCodeSent(ok1.codeId, at(t));
    await c.markClientEmailCodeSent(ok2.codeId, at(t));
    await c.revokeClientEmailCode(
      bad.codeId,
      at(t + MIN),
      `550 5.1.1 mailbox unavailable (code ${bad.code})`,
    );
    const stats = await c.clientCodeStats(at(t + 2 * MIN));
    expect(stats).toMatchObject({ created: 3, delivered: 2, failed: 1 });
    expect(stats.lastFailure?.reason).toBe('550 5.1.1 mailbox unavailable (code ########)');
    expect(stats.lastFailure?.at.getTime()).toBe(at(t + MIN).getTime());
    const [row] = await rows<{ revoked_at: Date | null; sent_at: Date | null }>(
      sqlTag`select revoked_at, sent_at from client_signin_codes where id = ${bad.codeId}`,
    );
    expect(row!.revoked_at).not.toBeNull();
    expect(row!.sent_at).toBeNull();
  });

  it('the reaper deletes finished rows after 30 days, blanks addresses after 7, keeps used links (B21)', async () => {
    // Far in the PAST: no other test file has rows before these cutoffs.
    const now = new Date(Date.UTC(2001, 1, 1) + Math.floor(Math.random() * 1000) * MIN);
    const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
    const ids: Record<string, string> = {};
    const add = async (
      name: string,
      kind: 'email' | 'admin_link',
      created: string,
      opts: { used?: boolean; revoked?: boolean; expires?: string } = {},
    ) => {
      ids[name] = randomUUID();
      await exec(sqlTag`
        insert into client_signin_codes
          (id, owner_id, login_id, kind, code_hash, request_ip, expires_at, used_at, revoked_at, created_at)
        values (${ids[name]}, ${login.old}, ${login.old}, ${kind}, ${`${tag}-reap-${name}`},
                '192.0.2.1', ${opts.expires ?? created}::timestamptz,
                ${opts.used ? created : null}::timestamptz, ${opts.revoked ? created : null}::timestamptz,
                ${created}::timestamptz)`);
    };
    await add('emailUsed', 'email', ago(40), { used: true, expires: ago(39) });
    await add('emailRevoked', 'email', ago(40), { revoked: true, expires: ago(39) });
    await add('emailExpired', 'email', ago(40));
    await add('linkUsed', 'admin_link', ago(40), { used: true, expires: ago(37) });
    await add('linkExpired', 'admin_link', ago(40), { expires: ago(37) });
    await add('emailTenDays', 'email', ago(10), { used: true });
    await add('emailThreeDays', 'email', ago(3), { used: true });
    const skipOld = randomUUID();
    const skipNew = randomUUID();
    await exec(sqlTag`insert into client_signin_code_skips (id, reason, created_at) values
      (${skipOld}, 'cap-login', ${ago(40)}::timestamptz),
      (${skipNew}, 'cap-login', ${ago(3)}::timestamptz)`);
    try {
      const dry = await c.reapClientSigninCodes({ now, dryRun: true });
      expect(dry).toEqual({ deleted: 4, ipsCleared: 2, skipsDeleted: 1 });
      // The dry run wrote nothing.
      const [still] = await rows<{ n: number }>(sqlTag`
        select count(*)::int as n from client_signin_codes where login_id = ${login.old}`);
      expect(still!.n).toBe(7);

      expect(await c.reapClientSigninCodes({ now })).toEqual({
        deleted: 4,
        ipsCleared: 2,
        skipsDeleted: 1,
      });
      const left = await rows<{ id: string; request_ip: string | null }>(sqlTag`
        select id, request_ip from client_signin_codes where login_id = ${login.old}`);
      const byId = new Map(left.map((r) => [r.id, r.request_ip]));
      expect([...byId.keys()].sort()).toEqual(
        [ids.linkUsed!, ids.emailTenDays!, ids.emailThreeDays!].sort(),
      );
      expect(byId.get(ids.linkUsed!)).toBeNull();
      expect(byId.get(ids.emailTenDays!)).toBeNull();
      expect(byId.get(ids.emailThreeDays!)).toBe('192.0.2.1');
      const skips = await rows<{ id: string }>(sqlTag`
        select id from client_signin_code_skips where id in (${skipOld}, ${skipNew})`);
      expect(skips.map((r) => r.id)).toEqual([skipNew]);
      // Idempotent.
      expect(await c.reapClientSigninCodes({ now })).toEqual({
        deleted: 0,
        ipsCleared: 0,
        skipsDeleted: 0,
      });
    } finally {
      await exec(sqlTag`delete from client_signin_code_skips where id in (${skipOld}, ${skipNew})`);
    }
  });
});
