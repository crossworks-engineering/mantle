/**
 * Login CSRF on the public /api/auth POSTs (client logins audit B15). A
 * cross-site page must not be able to sign a victim's browser into a login
 * of the attacker's choosing (a `text/plain` form carrying a JSON body), nor
 * drive the cookie-setting routes from another site. Every JSON auth POST
 * that sets or uses the session cookie refuses a non-JSON body (415) and a
 * cross-site browser request (403), before any lookup; the brain's own
 * origin, the split owner UI and a named CORS origin still pass, and so does
 * a non-browser client that sends no Origin at all (the mobile app).
 *
 * No database: the guard runs first, so a refused request never reaches one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BRAIN = 'https://brain.example.invalid';

const ROUTES = [
  ['client-link', () => import('./client-link/route')],
  ['client-code', () => import('./client-code/route')],
  ['client-code/verify', () => import('./client-code/verify/route')],
  ['login', () => import('./login/route')],
  ['signup', () => import('./signup/route')],
  ['invite/accept', () => import('./invite/accept/route')],
  ['change-password', () => import('./change-password/route')],
] as const;

type Post = (req: Request) => Promise<Response>;

const post = (path: string, headers: Record<string, string>, body = '{"code":"x"}') =>
  new Request(`${BRAIN}/api/auth/${path}`, {
    method: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.9', ...headers },
    body,
  });

const saved = {
  client: process.env.MANTLE_CLIENT_ORIGIN,
  cors: process.env.MANTLE_API_CORS_ORIGINS,
};
beforeEach(() => {
  delete process.env.MANTLE_CLIENT_ORIGIN;
  delete process.env.MANTLE_API_CORS_ORIGINS;
});
afterEach(() => {
  for (const [k, v] of [
    ['MANTLE_CLIENT_ORIGIN', saved.client],
    ['MANTLE_API_CORS_ORIGINS', saved.cors],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

describe('JSON auth POSTs refuse a cross-site form (audit B15)', () => {
  it.each(ROUTES)('%s: 415 for a non-JSON body, no cookie', async (path, load) => {
    const POST = (await load()).POST as Post;
    for (const type of [
      'text/plain',
      'text/plain;charset=UTF-8',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
    ]) {
      const res = await POST(post(path, { 'content-type': type }));
      expect(res.status, type).toBe(415);
      expect(res.headers.get('set-cookie'), type).toBeNull();
    }
    // No content type at all is not JSON either.
    const bare = await POST(
      new Request(`${BRAIN}/api/auth/${path}`, {
        method: 'POST',
        body: new Uint8Array([123, 125]),
      }),
    );
    expect(bare.status).toBe(415);
  });

  it.each(ROUTES)('%s: 403 for a cross-site browser request, even as JSON', async (path, load) => {
    const POST = (await load()).POST as Post;
    const json = { 'content-type': 'application/json' };
    for (const headers of [
      { ...json, origin: 'https://evil.example.invalid' },
      { ...json, origin: 'https://brain.example.invalid.evil.example' },
      { ...json, origin: 'null', 'sec-fetch-site': 'cross-site' },
      { ...json, 'sec-fetch-site': 'cross-site' },
    ]) {
      const res = await POST(post(path, headers));
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(((await res.json()) as { reason?: string }).reason).toBe('cross-site');
      expect(res.headers.get('set-cookie')).toBeNull();
    }
  });
});

describe('refuseCrossSiteAuthPost lets the real callers through', () => {
  const guard = async () => (await import('@/lib/auth/preflight')).refuseCrossSiteAuthPost;
  const json = { 'content-type': 'application/json; charset=utf-8' };

  it('the brain itself, same-origin, and a non-browser client', async () => {
    const refuse = await guard();
    for (const headers of [
      { ...json, origin: BRAIN, 'sec-fetch-site': 'same-origin' },
      { ...json, 'sec-fetch-site': 'same-origin' },
      { ...json, 'sec-fetch-site': 'none' },
      json, // the mobile app, curl: no Origin, no Sec-Fetch-Site
      { ...json, origin: 'null', 'sec-fetch-site': 'same-origin' },
    ]) {
      expect(refuse(post('login', headers)), JSON.stringify(headers)).toBeNull();
    }
  });

  it('the split owner UI and a named CORS origin, never the wildcard', async () => {
    const refuse = await guard();
    const app = 'https://app.example.invalid';
    const cross = { ...json, origin: app, 'sec-fetch-site': 'same-site' };
    expect(refuse(post('login', cross))?.status).toBe(403);
    process.env.MANTLE_CLIENT_ORIGIN = `${app}/`;
    expect(refuse(post('login', cross))).toBeNull();
    delete process.env.MANTLE_CLIENT_ORIGIN;
    process.env.MANTLE_API_CORS_ORIGINS = `https://other.example.invalid, ${app}`;
    expect(refuse(post('login', cross))).toBeNull();
    process.env.MANTLE_API_CORS_ORIGINS = '*';
    expect(refuse(post('login', cross))?.status).toBe(403);
  });

  it('json: false checks only the origin (logout)', async () => {
    const refuse = await guard();
    expect(refuse(post('logout', {}), { json: false })).toBeNull();
    expect(
      refuse(post('logout', { origin: 'https://evil.example.invalid' }), { json: false })?.status,
    ).toBe(403);
  });
});
