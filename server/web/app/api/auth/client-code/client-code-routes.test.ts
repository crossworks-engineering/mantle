/**
 * The email sign-in code routes (client logins C2b) without a database: the
 * queue and the redeem are stood in, so these pin what the ROUTES do.
 *
 * Request: the same 200 and a FRESH request cookie for every body (a
 * client's email, a stranger's, garbage), the job queued with the cookie's
 * request id and never a code, 200 even when the queue is down; per-address
 * 429. Verify: one 401 for every failure, no session without this browser's
 * request cookie, the 30-day client session at the login's epoch and the
 * request cookie cleared on success; failed tries capped per email plus
 * address, and NO brain-wide lockout. The code logic is proven on Postgres
 * in packages/content/src/client-codes.db.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const LOGIN = '12121212-1212-4212-8212-121212121212';
const REQ = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';

const h = vi.hoisted(() => ({
  queued: [] as Array<Record<string, unknown>>,
  queueDown: false,
  sender: null as null | { id: string },
  redeemed: null as null | Record<string, unknown>,
  redeemCalls: [] as Array<{ requestId: string; email: string; code: string }>,
  audits: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/client-codes', () => ({
  enqueueClientCode: vi.fn(async (job: Record<string, unknown>) => {
    if (h.queueDown) throw new Error('queue down');
    h.queued.push(job);
  }),
  loadClientSigninSender: vi.fn(async () => h.sender),
}));

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  redeemClientEmailCode: vi.fn(
    async (input: { requestId: string; email: string; code: string }) => {
      h.redeemCalls.push(input);
      return h.redeemed;
    },
  ),
}));

vi.mock('@/lib/audit', () => ({
  auditFireAndForget: (e: Record<string, unknown>) => h.audits.push(e),
  requestMetaFrom: () => ({}),
}));

const SECRET = 'client-code-routes-secret-that-is-at-least-32-chars';
let savedSecret: string | undefined;
beforeAll(() => {
  savedSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = SECRET;
});
afterAll(() => {
  if (savedSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = savedSecret;
});

beforeEach(() => {
  vi.resetModules();
  h.queued = [];
  h.queueDown = false;
  h.sender = null;
  h.redeemed = null;
  h.redeemCalls = [];
  h.audits = [];
});

const request = async (body: unknown, ip = '203.0.113.1', cookie?: string) => {
  const { POST } = await import('./route');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': ip,
  };
  if (cookie) headers.cookie = cookie;
  return POST(
    new Request('https://brain.example.invalid/api/auth/client-code', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
};

const verify = async (body: unknown, opts: { ip?: string; cookie?: string | null } = {}) => {
  const { POST } = await import('./verify/route');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': opts.ip ?? '203.0.113.1',
  };
  if (opts.cookie !== null) headers.cookie = opts.cookie ?? `mantle_code_req=${REQ}`;
  return POST(
    new Request('https://brain.example.invalid/api/auth/client-code/verify', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
};

const requestCookie = (res: Response): string | null =>
  /mantle_code_req=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? null;

describe('GET /api/auth/client-code', () => {
  it('says whether codes are on, nothing more', async () => {
    const { GET } = await import('./route');
    expect(await (await GET()).json()).toEqual({ enabled: false });
    h.sender = { id: 'acc' };
    expect(await (await GET()).json()).toEqual({ enabled: true });
  });

  it('says off, never 500, when the sender cannot be read', async () => {
    const { loadClientSigninSender } = await import('@/lib/client-codes');
    vi.mocked(loadClientSigninSender).mockRejectedValueOnce(new Error('db down'));
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });
});

describe('POST /api/auth/client-code', () => {
  it('answers every body the same way, with a new request cookie for a new browser', async () => {
    const bodies: unknown[] = [
      { email: 'client@example.invalid' },
      { email: 'stranger@example.invalid' },
      { email: 'not an email' },
      {},
      'not json',
    ];
    const answers = new Set<string>();
    const cookies = new Set<string>();
    for (const body of bodies) {
      const res = await request(body);
      expect(res.status).toBe(200);
      answers.add(JSON.stringify(await res.json()));
      const set = res.headers.get('set-cookie') ?? '';
      expect(set).toMatch(/HttpOnly/i);
      expect(set).toMatch(/SameSite=Strict/i);
      expect(set).toMatch(/Path=\/api\/auth\/client-code/);
      cookies.add(requestCookie(res)!);
    }
    expect(answers).toEqual(new Set([JSON.stringify({ ok: true })]));
    expect(cookies.size).toBe(bodies.length);
    // Every request is queued, whatever it holds: the worker decides.
    expect(h.queued).toHaveLength(bodies.length);
  });

  it('queues the email and the cookie request id, never a code', async () => {
    const res = await request({ email: ' Client@Example.invalid ' });
    const job = h.queued[0]!;
    expect(job).toMatchObject({ email: 'Client@Example.invalid', requestId: requestCookie(res) });
    expect(Object.keys(job).sort()).toEqual(['email', 'ip', 'requestId', 'requestedAt']);
  });

  it("keeps this browser's request id when it asks again (the mailed code stays good)", async () => {
    const first = requestCookie(await request({ email: 'client@example.invalid' }))!;
    const again = await request(
      { email: 'client@example.invalid' },
      '203.0.113.1',
      `mantle_code_req=${first}`,
    );
    expect(again.status).toBe(200);
    expect(requestCookie(again)).toBe(first);
    expect(h.queued.map((j) => j.requestId)).toEqual([first, first]);
    // A cookie that is not a request id is replaced, never trusted.
    const odd = await request(
      { email: 'client@example.invalid' },
      '203.0.113.1',
      'mantle_code_req=abc',
    );
    expect(requestCookie(odd)).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestCookie(odd)).not.toBe('abc');
  });

  it('answers 200 with a cookie even when the queue is down', async () => {
    h.queueDown = true;
    const res = await request({ email: 'client@example.invalid' });
    expect(res.status).toBe(200);
    expect(requestCookie(res)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('limits one address, and only that address', async () => {
    for (let i = 0; i < 10; i += 1)
      expect((await request({ email: 'a@example.invalid' }, '198.51.100.7')).status).toBe(200);
    expect((await request({ email: 'a@example.invalid' }, '198.51.100.7')).status).toBe(429);
    expect((await request({ email: 'a@example.invalid' }, '198.51.100.8')).status).toBe(200);
  });
});

const GOOD = { email: 'client@example.invalid', code: '01234567' };
const REDEEMED = { loginId: LOGIN, email: 'client@example.invalid', codeId: 'c1', sessionEpoch: 2 };

describe('POST /api/auth/client-code/verify', () => {
  it('signs the client in for 30 days at its epoch and clears the request cookie', async () => {
    h.redeemed = REDEEMED;
    const before = Math.floor(Date.now() / 1000);
    const res = await verify(GOOD);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.redeemCalls).toEqual([{ requestId: REQ, email: GOOD.email, code: GOOD.code }]);
    const set = res.headers.get('set-cookie') ?? '';
    expect(set).toMatch(/mantle_code_req=;[^,]*Max-Age=0/);
    const session = /mantle_session=([^;]*)/.exec(set)![1]!;
    const { verifySessionCookie } = await import('@/lib/auth');
    const claims = verifySessionCookie(decodeURIComponent(session))!;
    expect(claims).toMatchObject({ uid: LOGIN, ep: 2 });
    expect(claims.exp).toBeLessThanOrEqual(before + 30 * 24 * 60 * 60 + 5);
    expect(claims.exp).toBeGreaterThanOrEqual(before + 30 * 24 * 60 * 60);
    expect(h.audits.map((a) => a.action)).toEqual(['auth.client_code_signin']);
  });

  it('never redeems without this browser request cookie', async () => {
    h.redeemed = REDEEMED;
    const res = await verify(GOOD, { cookie: null });
    expect(res.status).toBe(401);
    expect(h.redeemCalls).toHaveLength(0);
    expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mantle_session=[^;]/);
  });

  it('answers every failure with the same 401 and no session', async () => {
    const cases: Array<[unknown, { cookie?: string | null }]> = [
      [GOOD, {}], // the redeem says no
      [GOOD, { cookie: null }],
      [GOOD, { cookie: 'mantle_code_req=' }],
      [{ email: GOOD.email }, {}],
      [{ code: GOOD.code }, {}],
      ['not json', {}],
    ];
    const seen = new Set<string>();
    for (const [body, opts] of cases) {
      const res = await verify(body, opts);
      expect(res.status).toBe(401);
      expect(res.headers.get('set-cookie') ?? '').not.toMatch(/mantle_session=[^;]/);
      seen.add(JSON.stringify(await res.json()));
    }
    expect(seen.size).toBe(1);
  });

  it('caps failed tries per email and address, not the email from elsewhere', async () => {
    for (let i = 0; i < 5; i += 1)
      expect((await verify(GOOD, { ip: '198.51.100.20' })).status).toBe(401);
    expect((await verify(GOOD, { ip: '198.51.100.20' })).status).toBe(429);
    // Another email from the same address, and the same email elsewhere, still try.
    expect(
      (await verify({ ...GOOD, email: 'other@example.invalid' }, { ip: '198.51.100.20' })).status,
    ).toBe(401);
    h.redeemed = REDEEMED;
    expect((await verify(GOOD, { ip: '198.51.100.21' })).status).toBe(200);
  });

  it('has no brain-wide lockout: many failing addresses do not stop a client', async () => {
    for (let i = 0; i < 400; i += 1) {
      await verify(
        { ...GOOD, email: `x${i % 50}@example.invalid` },
        { ip: `198.51.100.${(i % 40) + 50}` },
      );
    }
    h.redeemed = REDEEMED;
    expect((await verify(GOOD, { ip: '198.51.100.200' })).status).toBe(200);
  });
});
