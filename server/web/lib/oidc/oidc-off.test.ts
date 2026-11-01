/**
 * The hard rule of the corporate plan (section 2.1), as an acceptance test:
 * with MANTLE_OIDC_MODE empty or off, company sign-in does nothing a person
 * or a provider could see. The sign-in screen's reads say off, every other
 * company sign-in route answers 404, password sign-in answers the same bytes
 * with the same one-year session, and nothing reads the company sign-in
 * tables or calls a provider (each would throw here).
 *
 * The settings that would turn it on are all set (issuer, client, secret,
 * label, public URL): the mode alone decides.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  storeCalls: [] as string[],
  providerCalls: 0,
  fetchCalls: 0,
}));

// Every company sign-in read and write: none may run while the mode is off.
vi.mock('./store', () => {
  const trap =
    (name: string) =>
    (..._args: unknown[]): never => {
      h.storeCalls.push(name);
      throw new Error(`company sign-in store read while off: ${name}`);
    };
  return {
    oidcLoginRow: trap('oidcLoginRow'),
    oidcRuleFacts: trap('oidcRuleFacts'),
    signInTarget: trap('signInTarget'),
    loginIsAdminUser: trap('loginIsAdminUser'),
    loginHasPassword: trap('loginHasPassword'),
    linkForSubject: trap('linkForSubject'),
    loginLinked: trap('loginLinked'),
    loginOidcState: trap('loginOidcState'),
    createLink: trap('createLink'),
    touchLink: trap('touchLink'),
    removeLink: trap('removeLink'),
    setOutside: trap('setOutside'),
    dismissOffer: trap('dismissOffer'),
    activeLoginsWithLinks: trap('activeLoginsWithLinks'),
    issueHandoffCode: trap('issueHandoffCode'),
    spendHandoffCode: trap('spendHandoffCode'),
  };
});

// The provider library: no discovery, no token call while off.
vi.mock('openid-client', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const trap = () => {
    h.providerCalls++;
    throw new Error('a provider call while off');
  };
  return { ...real, discovery: trap, authorizationCodeGrant: trap };
});

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  publicLoginItself: vi.fn(async () => ({
    loginId: '00000000-0000-4000-8000-000000000001',
    email: 'person@example.invalid',
    sessionEpoch: 0,
    source: 'web',
  })),
  ownerCaller: vi.fn(() => ({
    id: '00000000-0000-4000-8000-000000000002',
    email: 'admin@example.invalid',
    actor: { id: '00000000-0000-4000-8000-000000000002' },
  })),
  authenticatePassword: vi.fn(async () => ({
    id: '00000000-0000-4000-8000-000000000001',
    sessionEpoch: 3,
  })),
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  // The login route stamps last_login_at: the one write it made before.
  const chain = { set: () => chain, where: async () => [] };
  return { ...real, db: { update: () => chain } };
});

vi.mock('@/lib/audit', () => ({
  auditFireAndForget: () => {},
  requestMetaFrom: () => ({}),
}));

const BRAIN = 'https://brain.example.invalid';
const LOGIN = '00000000-0000-4000-8000-000000000001';

const realFetch = globalThis.fetch;
beforeEach(() => {
  h.storeCalls = [];
  h.providerCalls = 0;
  h.fetchCalls = 0;
  globalThis.fetch = (async () => {
    h.fetchCalls++;
    throw new Error('an outbound call while off');
  }) as typeof fetch;
  vi.stubEnv('SESSION_SECRET', 'x'.repeat(48));
  vi.stubEnv('MANTLE_PUBLIC_URL', BRAIN);
  vi.stubEnv('MANTLE_OIDC_ISSUER', 'https://idp.example.invalid/realms/company');
  vi.stubEnv('MANTLE_OIDC_CLIENT_ID', 'mantle');
  vi.stubEnv('MANTLE_OIDC_CLIENT_SECRET', 'not-a-real-secret');
  vi.stubEnv('MANTLE_OIDC_LABEL', 'Company');
  vi.stubEnv('MANTLE_OIDC_SESSION_HOURS', '12');
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
  // Nothing company sign-in keeps may have been touched.
  expect(h.storeCalls).toEqual([]);
  expect(h.providerCalls).toBe(0);
  expect(h.fetchCalls).toBe(0);
});

const req = (path: string, init: RequestInit = {}) =>
  new Request(`${BRAIN}${path}`, {
    ...init,
    headers: {
      origin: BRAIN,
      'content-type': 'application/json',
      cookie: 'mantle_oidc_ticket=x; mantle_oidc_flow=y',
      ...(init.headers ?? {}),
    },
  });
const ctx = { params: Promise.resolve({ id: LOGIN }) };

// The ways a box leaves it off: unset, empty, spaces, and the off words.
const OFF_VALUES: (string | undefined)[] = [undefined, '', '  ', 'off', 'OFF', '0', 'false', 'no'];

describe.each(OFF_VALUES)('company sign-in with MANTLE_OIDC_MODE=%j', (mode) => {
  beforeEach(() => {
    if (mode === undefined) vi.stubEnv('MANTLE_OIDC_MODE', undefined as unknown as string);
    else vi.stubEnv('MANTLE_OIDC_MODE', mode);
  });

  it('the sign-in screen reads off, and nothing more', async () => {
    const { GET } = await import('../../app/api/auth/oidc/config/route');
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: 'off' });
  });

  it('the status read says off, and reads no login', async () => {
    const auth = await import('@/lib/auth');
    vi.mocked(auth.publicLoginItself).mockClear();
    const { GET } = await import('../../app/api/auth/oidc/status/route');
    const res = await GET();
    expect(await res.json()).toEqual({ mode: 'off' });
    expect(auth.publicLoginItself).not.toHaveBeenCalled();
  });

  it('every other company sign-in route is not there (404), and sets no cookie', async () => {
    const start = await import('../../app/api/auth/oidc/start/route');
    const callback = await import('../../app/api/auth/oidc/callback/route');
    const link = await import('../../app/api/auth/oidc/link/route');
    const offer = await import('../../app/api/auth/oidc/offer/route');
    const fresh = await import('../../app/api/auth/oidc/fresh/route');
    const exchange = await import('../../app/api/auth/oidc/exchange/route');
    const userLink = await import('../../app/api/users/[id]/oidc/route');
    const answers = [
      await start.GET(req('/api/auth/oidc/start?return=/')),
      await callback.GET(req('/api/auth/oidc/callback?code=c&state=s')),
      await link.POST(req('/api/auth/oidc/link', { method: 'POST', body: '{}' })),
      await link.DELETE(req('/api/auth/oidc/link', { method: 'DELETE' })),
      await offer.POST(req('/api/auth/oidc/offer', { method: 'POST' })),
      await fresh.POST(req('/api/auth/oidc/fresh', { method: 'POST', body: '{}' })),
      await exchange.POST(req('/api/auth/oidc/exchange', { method: 'POST', body: '{}' })),
      await userLink.PATCH(
        req(`/api/users/${LOGIN}/oidc`, { method: 'PATCH', body: '{"outside":true}' }),
        ctx,
      ),
      await userLink.DELETE(req(`/api/users/${LOGIN}/oidc`, { method: 'DELETE' }), ctx),
    ];
    for (const res of answers) {
      expect(res.status).toBe(404);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(res.headers.get('location')).toBeNull();
    }
  });

  it("the users area's list says off", async () => {
    const { GET } = await import('../../app/api/users/oidc/route');
    expect(await (await GET()).json()).toEqual({ mode: 'off' });
  });

  it('the password rule allows every login, with no read', async () => {
    const { passwordSignInRule } = await import('./rules');
    expect(await passwordSignInRule(LOGIN)).toBe('allow');
  });

  it('a password sign-in answers as before: { ok: true } and one one-year session cookie', async () => {
    const { POST } = await import('../../app/api/auth/login/route');
    const res = await POST(
      req('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'person@example.invalid', password: 'right' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^mantle_session=/);
    expect(cookies[0]).toMatch(/Max-Age=31536000/i);
    expect(cookies.join(';')).not.toMatch(/oidc/);
  });

  it('a sign out answers as before: only the session cookie cleared', async () => {
    const { POST } = await import('../../app/api/auth/logout/route');
    const res = await POST(req('/api/auth/logout', { method: 'POST' }));
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^mantle_session=;/);
  });

  it('the boot check says nothing and reads nothing', async () => {
    const { oidcBootCheck } = await import('./boot');
    await expect(oidcBootCheck()).resolves.toBeUndefined();
  });
});
