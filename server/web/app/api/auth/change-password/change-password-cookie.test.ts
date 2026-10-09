/**
 * The cookie a password change gives back to a browser caller. The epoch
 * bump ends every other session, so the caller's cookie is re-minted at the
 * new epoch. A cookie that rides with a bearer is the web client's 7-day
 * upgrade of it (POST /api/auth/sso), and keeps that life: a year would
 * outlive the device's revocable bearer, and is bound to that device token,
 * which the change keeps (access matrix T15). A cookie on its own (a
 * password sign-in) keeps the year. The login, the password store and the
 * device token lookup are stood in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getLoginOr401: vi.fn(async () => ({
    kind: 'member',
    loginId: '00000000-0000-4000-8000-00000000cccc',
    email: 'm@example.invalid',
    source: 'web',
    sessionEpoch: 4,
  })),
  verifyPassword: vi.fn(async () => true),
  updatePassword: vi.fn(async () => undefined),
  endLoginSessions: vi.fn(async () => 5),
}));
const DEVICE = '00000000-0000-4000-8000-00000000dddd';
const kept = vi.hoisted(() => ({ jti: null as string | null }));
vi.mock('@/lib/auth/own-device', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ownLiveDeviceJti: vi.fn(async (req: Request) =>
    req.headers.get('authorization') ? kept.jti : null,
  ),
}));
vi.mock('@/lib/audit', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auditFireAndForget: vi.fn(),
}));

let ip = 0;
async function change(headers: Record<string, string> = {}) {
  const { POST } = await import('./route');
  ip += 1;
  const res = await POST(
    new Request('http://brain.test/api/auth/change-password', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': `10.2.0.${ip}`,
        ...headers,
      },
      body: JSON.stringify({ oldPassword: 'old-password', newPassword: 'new-password' }),
    }),
  );
  expect(res.status).toBe(200);
  return res;
}
const maxAge = (res: Response) =>
  Number(/max-age=(\d+)/i.exec(res.headers.get('set-cookie') ?? '')?.[1]);
const claimsOf = async (res: Response) => {
  const { verifySessionCookie } = await import('@/lib/auth/tokens');
  const value = /mantle_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
  return verifySessionCookie(decodeURIComponent(value));
};

beforeEach(async () => {
  process.env.SESSION_SECRET = 'change-password-cookie-test-secret-32-chars!!';
  kept.jti = DEVICE;
  const auth = await import('@/lib/auth');
  vi.mocked(auth.endLoginSessions).mockClear();
});

describe('POST /api/auth/change-password, the cookie it gives back', () => {
  it('keeps the 7-day life of a cookie that rides with a bearer', async () => {
    const { OWNER_SSO_COOKIE_TTL_SECONDS } = await import('@/lib/owner-sso');
    expect(maxAge(await change({ authorization: 'Bearer some.bearer' }))).toBe(
      OWNER_SSO_COOKIE_TTL_SECONDS,
    );
  });

  it("keeps the tab's own bearer, and binds the cookie to it (T15)", async () => {
    const res = await change({ authorization: 'Bearer some.bearer' });
    const { endLoginSessions } = await import('@/lib/auth');
    expect(vi.mocked(endLoginSessions).mock.calls[0]![1]).toMatchObject({ keepJti: DEVICE });
    expect((await claimsOf(res))?.dj).toBe(DEVICE);
  });

  it('binds the cookie to no device when the bearer is not a live one of the login', async () => {
    kept.jti = null;
    const res = await change({ authorization: 'Bearer some.bearer' });
    const { endLoginSessions } = await import('@/lib/auth');
    expect(vi.mocked(endLoginSessions).mock.calls[0]![1]).toMatchObject({ keepJti: null });
    const claims = await claimsOf(res);
    expect(claims?.ep).toBe(5);
    expect(claims?.dj).toBeUndefined();
  });

  it('keeps the year of a cookie on its own', async () => {
    const res = await change();
    expect(maxAge(res)).toBeGreaterThan(300 * 24 * 60 * 60);
    expect((await claimsOf(res))?.dj).toBeUndefined();
  });
});
