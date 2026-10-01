/**
 * The email sign-in code routes (client logins C2b) without a database: the
 * queue and the redeem are stood in, so these pin what the ROUTES do.
 *
 * Request: the same 200 and a FRESH request cookie for every body (a
 * client's email, a stranger's, garbage), the job queued with the cookie's
 * request id and never a code, 200 even when the queue is down, nothing
 * queued while no sender is chosen (the same answer); per-address 429, an
 * IPv6 caller by its /64. Availability: on only with a sender AND an email
 * worker. Verify: one 401 for every failure, no session without this browser's
 * request cookie, the 30-day client session at the login's epoch and the
 * request cookie cleared on success; failed tries capped per email plus
 * address, and NO brain-wide lockout. The code logic is proven on Postgres
 * in packages/content/src/client-codes.db.test.ts.
 *
 * Device mode (the phone app): the request answers its request id in the
 * body and sets no cookie, the same for every email; the verify takes that
 * id from the body, never from the cookie, answers a 30-day device token at
 * the login's session epoch and sets no session cookie.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const LOGIN = '12121212-1212-4212-8212-121212121212';
const REQ = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';

const h = vi.hoisted(() => ({
  queued: [] as Array<Record<string, unknown>>,
  queueDown: false,
  sender: null as null | { id: string },
  worker: true,
  redeemed: null as null | Record<string, unknown>,
  redeemCalls: [] as Array<{ requestId: string; email: string; code: string }>,
  redeemOpts: [] as Array<{ device?: { id: string; label: string; ttlSeconds: number } }>,
  audits: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/client-codes', () => ({
  enqueueClientCode: vi.fn(async (job: Record<string, unknown>) => {
    if (h.queueDown) throw new Error('queue down');
    h.queued.push(job);
  }),
  loadClientSigninSender: vi.fn(async () => h.sender),
  emailWorkerServesCodes: vi.fn(async () => h.worker),
}));

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  redeemClientEmailCode: vi.fn(
    async (
      input: { requestId: string; email: string; code: string },
      _now?: Date,
      opts: { device?: { id: string; label: string; ttlSeconds: number } } = {},
    ) => {
      h.redeemCalls.push(input);
      h.redeemOpts.push(opts);
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
  h.worker = true;
  h.redeemed = null;
  h.redeemCalls = [];
  h.audits = [];
  h.redeemOpts = [];
});

const request = async (
  body: unknown,
  ip = '203.0.113.1',
  cookie?: string,
  extra: Record<string, string> = {},
) => {
  const { POST } = await import('./route');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': ip,
    ...extra,
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

const verify = async (
  body: unknown,
  opts: { ip?: string; cookie?: string | null; headers?: Record<string, string> } = {},
) => {
  const { POST } = await import('./verify/route');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': opts.ip ?? '203.0.113.1',
    ...opts.headers,
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

  it('says off when no email worker serves the code queue, whatever the sender (B3)', async () => {
    h.sender = { id: 'acc' };
    h.worker = false;
    const { GET } = await import('./route');
    expect(await (await GET()).json()).toEqual({ enabled: false });
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
  beforeEach(() => {
    h.sender = { id: 'acc' };
  });

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

  it('queues nothing while no sender is chosen, and answers the same (B21)', async () => {
    const withSender = await request({ email: 'client@example.invalid' });
    h.sender = null;
    const without = await request({ email: 'client@example.invalid' });
    expect(without.status).toBe(200);
    expect(await without.json()).toEqual(await withSender.json());
    expect(requestCookie(without)).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.queued).toHaveLength(1);
  });

  it('queues an IPv6 caller by its /64 (B2)', async () => {
    await request({ email: 'client@example.invalid' }, '2001:db8:7:8::1234');
    expect(h.queued[0]).toMatchObject({ ip: '2001:db8:7:8::/64' });
  });

  it('limits a whole IPv6 /64 as one address (B2)', async () => {
    for (let i = 0; i < 10; i += 1) {
      const ip = `2001:db8:9:9::${(i + 1).toString(16)}`;
      expect((await request({ email: 'a@example.invalid' }, ip)).status).toBe(200);
    }
    expect((await request({ email: 'a@example.invalid' }, '2001:db8:9:9::ff')).status).toBe(429);
    expect((await request({ email: 'a@example.invalid' }, '2001:db8:9:a::1')).status).toBe(200);
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

describe('POST /api/auth/client-code, device mode', () => {
  beforeEach(() => {
    h.sender = { id: 'acc' };
  });

  it('answers the request id in the body and sets no cookie, the same for every email', async () => {
    const shapes = new Set<string>();
    for (const email of ['client@example.invalid', 'stranger@example.invalid', 'not an email']) {
      const res = await request({ email, device: true });
      expect(res.status).toBe(200);
      expect(res.headers.get('set-cookie')).toBeNull();
      const body = (await res.json()) as { ok: boolean; requestId: string };
      expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
      shapes.add(JSON.stringify(Object.keys(body).sort()));
    }
    expect(shapes).toEqual(new Set([JSON.stringify(['ok', 'requestId'])]));
    // Queued with the id the body answered, never a code.
    expect(h.queued).toHaveLength(3);
  });

  it('keeps an id the app sends back, and stores the code under a DERIVED id', async () => {
    const { deviceRequestId } = await import('@/lib/client-logins');
    const first = (await (await request({ email: 'c@example.invalid', device: true })).json()) as {
      requestId: string;
    };
    const again = (await (
      await request({ email: 'c@example.invalid', device: true, requestId: first.requestId })
    ).json()) as { requestId: string };
    expect(again.requestId).toBe(first.requestId);
    // Queued under the derived id, never the one the app holds: a browser's
    // id and a device's id cannot open each other's code.
    const stored = deviceRequestId(first.requestId);
    expect(stored).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(stored).not.toBe(first.requestId);
    expect(h.queued.map((j) => j.requestId)).toEqual([stored, stored]);
    // Not an id: replaced, never trusted.
    const odd = (await (
      await request({ email: 'c@example.invalid', device: true, requestId: 'abc' })
    ).json()) as { requestId: string };
    expect(odd.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is for the phone app: a request from a page is refused before any work', async () => {
    const pages: Array<Record<string, string>> = [
      { origin: 'https://brain.example.invalid' },
      { 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-mode': 'cors' },
    ];
    for (const extra of pages) {
      const res = await request(
        { email: 'c@example.invalid', device: true },
        '203.0.113.1',
        undefined,
        extra,
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ reason: 'device-only' });
    }
    expect(h.queued).toHaveLength(0);
    // The browser flow from the same page is untouched.
    const web = await request({ email: 'c@example.invalid' }, '203.0.113.1', undefined, {
      origin: 'https://brain.example.invalid',
    });
    expect(web.status).toBe(200);
  });

  it('never reads the browser cookie in device mode', async () => {
    const res = await request(
      { email: 'c@example.invalid', device: true },
      '203.0.113.1',
      `mantle_code_req=${REQ}`,
    );
    const body = (await res.json()) as { requestId: string };
    expect(body.requestId).not.toBe(REQ);
  });
});

const GOOD = { email: 'client@example.invalid', code: '01234567' };
const REDEEMED = { loginId: LOGIN, email: 'client@example.invalid', codeId: 'c1', sessionEpoch: 2 };

describe('POST /api/auth/client-code/verify', () => {
  it('signs the client in for 30 days at its epoch and clears the request cookie', async () => {
    h.redeemed = REDEEMED;
    // Import first, so a slow import under a busy run is not billed to the
    // expiry window (audit B28: this flaked 8 of 35 runs); bound it by the
    // times around the call itself.
    await import('./verify/route');
    const before = Math.floor(Date.now() / 1000);
    const res = await verify(GOOD);
    const after = Math.ceil(Date.now() / 1000);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.redeemCalls).toEqual([{ requestId: REQ, email: GOOD.email, code: GOOD.code }]);
    const set = res.headers.get('set-cookie') ?? '';
    expect(set).toMatch(/mantle_code_req=;[^,]*Max-Age=0/);
    const session = /mantle_session=([^;]*)/.exec(set)![1]!;
    const { verifySessionCookie } = await import('@/lib/auth');
    const claims = verifySessionCookie(decodeURIComponent(session))!;
    expect(claims).toMatchObject({ uid: LOGIN, ep: 2 });
    expect(claims.exp).toBeLessThanOrEqual(after + 30 * 24 * 60 * 60);
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

  it('a refused redeem (a disabled or non-client login, a wrong code) writes no sign-in audit', async () => {
    h.redeemed = null;
    const res = await verify(GOOD);
    expect(res.status).toBe(401);
    expect(h.audits.map((a) => a.action)).toEqual(['auth.client_code_failed']);
  });

  it('caps failed tries per email and a whole IPv6 /64 as one address (B2)', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await verify(GOOD, { ip: `2001:db8:4:4::${i + 1}` })).status).toBe(401);
    }
    expect((await verify(GOOD, { ip: '2001:db8:4:4::99' })).status).toBe(429);
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

describe('POST /api/auth/client-code/verify, device mode', () => {
  const DEVICE_REQ = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';

  it('answers a 30-day device token at the login epoch, and no cookie', async () => {
    const { deviceRequestId } = await import('@/lib/client-logins');
    h.redeemed = REDEEMED;
    await import('./verify/route');
    const before = Math.floor(Date.now() / 1000);
    const res = await verify(
      { ...GOOD, requestId: DEVICE_REQ, deviceName: 'Test phone' },
      { cookie: null },
    );
    const after = Math.ceil(Date.now() / 1000);
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, role: 'client', loginId: LOGIN, expiresIn: 2592000 });
    // Redeemed by the id DERIVED from the body's request id.
    expect(h.redeemCalls).toEqual([
      { requestId: deviceRequestId(DEVICE_REQ), email: GOOD.email, code: GOOD.code },
    ]);
    // The token row is the redeem's to write, in its own transaction.
    expect(h.redeemOpts).toEqual([
      { device: { id: body.deviceId, label: 'Test phone', ttlSeconds: 2592000 } },
    ]);
    const { verifyMobileToken } = await import('@/lib/auth');
    const claims = verifyMobileToken(body.token as string)!;
    expect(claims).toMatchObject({ uid: LOGIN, jti: body.deviceId, ep: 2 });
    expect(claims.exp).toBeLessThanOrEqual(after + 30 * 24 * 60 * 60);
    expect(claims.exp).toBeGreaterThanOrEqual(before + 30 * 24 * 60 * 60);
    // The sign-in is logged after the redeem, with the device.
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      action: 'auth.client_code_signin',
      detail: { channel: 'mobile', device: 'Test phone', deviceId: body.deviceId },
    });
  });

  it('uses only the body request id: a cookie is no fallback', async () => {
    const { deviceRequestId } = await import('@/lib/client-logins');
    h.redeemed = REDEEMED;
    // A malformed id in the body with a good cookie: a failure, no redeem.
    const res = await verify({ ...GOOD, requestId: 'not-an-id' }, {});
    expect(res.status).toBe(401);
    expect(h.redeemCalls).toHaveLength(0);
    // Both present: the body's id (derived) is the one redeemed, never the cookie's.
    await verify({ ...GOOD, requestId: DEVICE_REQ }, {});
    expect(h.redeemCalls.map((c) => c.requestId)).toEqual([deviceRequestId(DEVICE_REQ)]);
  });

  it("a browser's request id sent in the body is not the id its code is stored under", async () => {
    const { deviceRequestId } = await import('@/lib/client-logins');
    h.redeemed = REDEEMED;
    // REQ is the id a browser's cookie holds (its code is stored under REQ).
    await verify({ ...GOOD, requestId: REQ }, { cookie: null });
    expect(h.redeemCalls[0]!.requestId).toBe(deviceRequestId(REQ));
    expect(h.redeemCalls[0]!.requestId).not.toBe(REQ);
    // And a device's id in a cookie is looked up as it is, so it finds
    // nothing either (the device's code is under the derived id).
    h.redeemCalls = [];
    await verify(GOOD, { cookie: `mantle_code_req=${DEVICE_REQ}` });
    expect(h.redeemCalls[0]!.requestId).toBe(DEVICE_REQ);
    expect(h.redeemOpts.at(-1)).toEqual({});
  });

  it('is for the phone app: a verify from a page is refused before any lookup', async () => {
    h.redeemed = REDEEMED;
    const pages: Array<Record<string, string>> = [
      { origin: 'https://brain.example.invalid' },
      { 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-dest': 'empty' },
    ];
    for (const headers of pages) {
      const res = await verify({ ...GOOD, requestId: DEVICE_REQ }, { cookie: null, headers });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ reason: 'device-only' });
    }
    expect(h.redeemCalls).toHaveLength(0);
  });

  it('a device name is a label: clamped or defaulted, never a failed sign-in', async () => {
    h.redeemed = REDEEMED;
    const names: Array<[unknown, string]> = [
      ['x'.repeat(200), 'x'.repeat(80)],
      ['   ', 'Mobile device'],
      ['', 'Mobile device'],
      [42, 'Mobile device'],
      [undefined, 'Mobile device'],
      ['  Ada phone  ', 'Ada phone'],
    ];
    for (const [deviceName, label] of names) {
      h.redeemOpts = [];
      const res = await verify({ ...GOOD, requestId: DEVICE_REQ, deviceName }, { cookie: null });
      expect(res.status, String(deviceName)).toBe(200);
      expect(h.redeemOpts[0]!.device!.label).toBe(label);
    }
  });

  it('a refused redeem mints nothing and answers the same 401 as the browser flow', async () => {
    h.redeemed = null;
    const device = await verify({ ...GOOD, requestId: DEVICE_REQ }, { cookie: null });
    const browser = await verify(GOOD, { ip: '203.0.113.9' });
    expect(device.status).toBe(401);
    expect(await device.json()).toEqual(await browser.json());
  });

  it('shares the failure cap with the browser flow: five failed tries, either way', async () => {
    const ip = '198.51.100.77';
    for (let i = 0; i < 3; i += 1) {
      expect((await verify({ ...GOOD, requestId: DEVICE_REQ }, { cookie: null, ip })).status).toBe(
        401,
      );
    }
    for (let i = 0; i < 2; i += 1) expect((await verify(GOOD, { ip })).status).toBe(401);
    // The sixth, in either mode, from that address for that email: held.
    expect((await verify({ ...GOOD, requestId: DEVICE_REQ }, { cookie: null, ip })).status).toBe(
      429,
    );
    expect((await verify(GOOD, { ip })).status).toBe(429);
  });

  it('the browser flow still sets the cookie and asks for no device token', async () => {
    h.redeemed = REDEEMED;
    const res = await verify(GOOD);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('set-cookie') ?? '').toMatch(/mantle_session=[^;]/);
    expect(h.redeemOpts).toEqual([{}]);
  });
});
