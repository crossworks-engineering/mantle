/**
 * The cookie a password change gives back to a browser caller. The epoch
 * bump ends every other session, so the caller's cookie is re-minted at the
 * new epoch. A cookie that rides with a bearer is the web client's 7-day
 * upgrade of it (POST /api/auth/sso), and keeps that life: a year would
 * outlive the device's revocable bearer. A cookie on its own (a password
 * sign-in) keeps the year. The login and the password store are stood in.
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
  return Number(/max-age=(\d+)/i.exec(res.headers.get('set-cookie') ?? '')?.[1]);
}

beforeEach(() => {
  process.env.SESSION_SECRET = 'change-password-cookie-test-secret-32-chars!!';
});

describe('POST /api/auth/change-password, the cookie it gives back', () => {
  it('keeps the 7-day life of a cookie that rides with a bearer', async () => {
    const { OWNER_SSO_COOKIE_TTL_SECONDS } = await import('@/lib/owner-sso');
    expect(await change({ authorization: 'Bearer some.bearer' })).toBe(
      OWNER_SSO_COOKIE_TTL_SECONDS,
    );
  });

  it('keeps the year of a cookie on its own', async () => {
    expect(await change()).toBeGreaterThan(300 * 24 * 60 * 60);
  });
});
