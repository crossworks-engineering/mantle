import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/auth/sso — the owner bearer→cookie upgrade. What must hold:
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
 * auth resolver, which has its own tests.
 */

const getOwnerOr401 = vi.fn();
vi.mock('./auth', async () => {
  const actual = await vi.importActual<typeof import('./auth')>('./auth');
  return { ...actual, getOwnerOr401: () => getOwnerOr401() };
});

beforeAll(() => {
  process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-48chars!!';
});

const ANCHOR = '00000000-0000-4000-8000-00000000aaaa';
const ADDED_LOGIN = '00000000-0000-4000-8000-00000000bbbb';

/** A session for an ADDED login: `id` is the anchor (brain data is keyed to
 *  it), `actor.id` is the login that actually signed in. */
function addedLoginSession() {
  return {
    id: ANCHOR,
    email: 'second@example.com',
    actor: { id: ADDED_LOGIN, email: 'second@example.com', displayName: null, isOwner: false },
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
    getOwnerOr401.mockResolvedValue(addedLoginSession());

    const res = await post();

    expect(res.status).toBe(204);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('mantle_session=');
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');
  });

  it('mints for the ACTOR, not the anchor — the audit trail is the whole point', async () => {
    getOwnerOr401.mockResolvedValue(addedLoginSession());

    const res = await post();

    // Decode the signed session value's payload and read back which login it
    // names. Anchoring it would silently re-attribute this login's actions.
    const value = /mantle_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
    const payload = decodeURIComponent(value).split('.')[0] ?? '';
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    expect(claims.uid).toBe(ADDED_LOGIN);
    expect(claims.uid).not.toBe(ANCHOR);
  });

  it('unauthenticated caller is refused and gets NO cookie', async () => {
    const { NextResponse } = await import('../server/http-compat');
    getOwnerOr401.mockResolvedValue(NextResponse.json({ error: 'unauthorized' }, { status: 401 }));

    const res = await post();

    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie') ?? '').not.toContain('mantle_session=');
  });

  it('a foreign Origin is 403 — before the credential is even consulted', async () => {
    getOwnerOr401.mockResolvedValue(addedLoginSession());

    const res = await post({ origin: 'https://evil.example' });

    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie') ?? '').not.toContain('mantle_session=');
    // Order matters: a foreign page must not be able to use this to probe
    // whether the browser holds a valid session.
    expect(getOwnerOr401).not.toHaveBeenCalled();
  });

  it('our own origin is allowed', async () => {
    getOwnerOr401.mockResolvedValue(addedLoginSession());

    const res = await post({ origin: 'http://server.test' });

    expect(res.status).toBe(204);
  });

  it('the configured client origin is allowed (split topology)', async () => {
    vi.stubEnv('MANTLE_CLIENT_ORIGIN', 'https://app.server.test');
    getOwnerOr401.mockResolvedValue(addedLoginSession());

    const res = await post({ origin: 'https://app.server.test' });

    expect(res.status).toBe(204);
    vi.unstubAllEnvs();
  });
});
