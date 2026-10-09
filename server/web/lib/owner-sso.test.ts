import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/auth/sso — the bearer→cookie upgrade (an admin or a member). What
 * must hold:
 *   - an authenticated caller gets a fresh session cookie and a 204;
 *   - the cookie identifies the ACTOR (the login), not the anchor the brain's
 *     data is keyed to — otherwise every audit row an added login writes gets
 *     re-attributed to the anchor, destroying the only thing that
 *     distinguishes one login from another;
 *   - an unauthenticated caller is refused and gets NO cookie (this route
 *     mints sessions — a leak here is a free session);
 *   - a cross-origin Origin that isn't ours is 403 (login-CSRF hardening),
 *     checked BEFORE the credential so a foreign page can't probe it.
 * The credential gate itself is mocked — this is the route contract, not the
 * auth resolver. Which roles it takes (admin and member yes, client no) is
 * driven for real by the role sweeps (server/public-session-routes.ts).
 */

const getCookieUpgradeLoginOr401 = vi.fn();
vi.mock('./auth', async () => {
  const actual = await vi.importActual<typeof import('./auth')>('./auth');
  return {
    ...actual,
    getCookieUpgradeLoginOr401: () => getCookieUpgradeLoginOr401(),
  };
});

const audited = vi.fn();
vi.mock('./audit', async () => {
  const actual = await vi.importActual<typeof import('./audit')>('./audit');
  return { ...actual, auditFireAndForget: (e: unknown) => audited(e) };
});

beforeAll(() => {
  process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-48chars!!';
});

const ANCHOR = '00000000-0000-4000-8000-00000000aaaa';
const ADDED_LOGIN = '00000000-0000-4000-8000-00000000bbbb';

/** The gate's answer for an ADDED login: the login that actually signed in
 *  (never the anchor), and the session epoch (0181) its credential was
 *  verified at. */
function addedLoginSession(role: 'admin' | 'member' = 'admin') {
  return {
    loginId: ADDED_LOGIN,
    email: 'second@example.com',
    role,
    epoch: 3,
    deviceJti: '00000000-0000-4000-8000-00000000cccc',
  };
}

let ipCounter = 0;
async function post(headers: Record<string, string> = {}) {
  const { handleOwnerSso } = await import('./owner-sso');
  // Unique IP per call keeps the per-IP rate limiter out of these tests.
  ipCounter += 1;
  return handleOwnerSso(
    new Request('http://server.test/api/auth/sso', {
      method: 'POST',
      headers: {
        'x-forwarded-for': `10.1.0.${ipCounter}`,
        'x-forwarded-proto': 'http', // requestOrigin defaults non-localhost hosts to https
        host: 'server.test',
        ...headers,
      },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/auth/sso', () => {
  it('authenticated caller → 204 with a fresh session cookie', async () => {
    getCookieUpgradeLoginOr401.mockResolvedValue(addedLoginSession());

    const res = await post();

    expect(res.status).toBe(204);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('mantle_session=');
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');
  });

  it('mints for the ACTOR, not the anchor — the audit trail is the whole point', async () => {
    getCookieUpgradeLoginOr401.mockResolvedValue(addedLoginSession());

    const res = await post();

    // Decode the signed session value's payload and read back which login it
    // names. Anchoring it would silently re-attribute this login's actions.
    const value = /mantle_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
    const payload = decodeURIComponent(value).split('.')[0] ?? '';
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    expect(claims.uid).toBe(ADDED_LOGIN);
    expect(claims.uid).not.toBe(ANCHOR);
    // Signed at the epoch the credential was verified at, or the next
    // request would refuse the cookie it was just given.
    expect(claims.ep).toBe(3);
    // Bound to the device token it was upgraded from: a revoke of that
    // device ends the cookie (access matrix T2).
    expect(claims.dj).toBe('00000000-0000-4000-8000-00000000cccc');
  });

  it('mints a SHORT cookie, not the password login’s year', async () => {
    getCookieUpgradeLoginOr401.mockResolvedValue(addedLoginSession());

    const res = await post();

    // The bearer this upgrades is 30-day and revocable per device; the session
    // cookie only for the whole login (its session epoch). A year here would convert a revocable
    // credential into an irrevocable one that outlives it — the short TTL is
    // safe only because the shell re-mints on every page load.
    const maxAge = /max-age=(\d+)/i.exec(res.headers.get('set-cookie') ?? '')?.[1];
    const { OWNER_SSO_COOKIE_TTL_SECONDS } = await import('./owner-sso');
    expect(Number(maxAge)).toBe(OWNER_SSO_COOKIE_TTL_SECONDS);
    expect(Number(maxAge)).toBeLessThanOrEqual(7 * 24 * 60 * 60);
  });

  it('logs a member cookie mint as auth.sso; an admin is on the trail at the gate', async () => {
    getCookieUpgradeLoginOr401.mockResolvedValue(addedLoginSession('member'));
    expect((await post()).status).toBe(204);
    expect(audited).toHaveBeenCalledOnce();
    expect(audited.mock.calls[0]![0]).toMatchObject({
      actorId: ADDED_LOGIN,
      action: 'auth.sso',
      path: '/api/auth/sso',
    });

    audited.mockClear();
    getCookieUpgradeLoginOr401.mockResolvedValue(addedLoginSession('admin'));
    expect((await post()).status).toBe(204);
    expect(audited).not.toHaveBeenCalled();
  });

  it('unauthenticated caller is refused and gets NO cookie', async () => {
    const { NextResponse } = await import('../server/http-compat');
    getCookieUpgradeLoginOr401.mockResolvedValue(
      NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
    );

    const res = await post();

    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie') ?? '').not.toContain('mantle_session=');
  });

  it('a foreign Origin is 403 — before the credential is even consulted', async () => {
    getCookieUpgradeLoginOr401.mockResolvedValue(addedLoginSession());

    const res = await post({ origin: 'https://evil.example' });

    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie') ?? '').not.toContain('mantle_session=');
    // Order matters: a foreign page must not be able to use this to probe
    // whether the browser holds a valid session.
    expect(getCookieUpgradeLoginOr401).not.toHaveBeenCalled();
  });

  it('our own origin is allowed', async () => {
    getCookieUpgradeLoginOr401.mockResolvedValue(addedLoginSession());

    const res = await post({ origin: 'http://server.test' });

    expect(res.status).toBe(204);
  });

  it('the configured client origin is allowed (split topology)', async () => {
    vi.stubEnv('MANTLE_CLIENT_ORIGIN', 'https://app.server.test');
    getCookieUpgradeLoginOr401.mockResolvedValue(addedLoginSession());

    const res = await post({ origin: 'https://app.server.test' });

    expect(res.status).toBe(204);
    vi.unstubAllEnvs();
  });
});
