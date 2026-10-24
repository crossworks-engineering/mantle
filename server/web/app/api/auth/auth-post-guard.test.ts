/**
 * Login CSRF on the public /api/auth POSTs (audit B15). A
 * cross-site page must not be able to sign a victim's browser into a login
 * of the attacker's choosing (a `text/plain` form carrying a JSON body), nor
 * drive the cookie-setting routes from another site. Every JSON auth POST
 * that sets or uses the session cookie refuses a non-JSON body (415) and a
 * cross-site browser request (403), before any lookup; the brain's own
 * origin, the split owner UI and a named CORS origin still pass, and so does
 * a non-browser client that sends no Origin at all (the mobile app).
 *
 * No database: the guard runs first, so a refused request never reaches one.
 * The gate answers it from the row (A10 #8), so each route is driven
 * through the gate and the loader.
 * (client-link is gone since workspaces W5c, and the email-code sign-in
 * (client-code, client-code/verify) since W8a: each answers 410 to everyone,
 * before any guard or work.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BRAIN = 'https://brain.example.invalid';

const ROUTES = [
  ['login', () => routed('login')],
  ['signup', () => routed('signup')],
  ['invite/accept', () => routed('invite/accept')],
  ['change-password', () => routed('change-password')],
] as const;

type Post = (req: Request) => Promise<Response>;

/**
 * The route as the app serves it: the gate refuses a cross-site post from
 * the row (the route file's `limits.crossSite`, A10 #8), before the
 * row's limits and the handler, so the route is driven through the gate and
 * the loader with its real row, not by calling its handler.
 */
async function routed(path: string): Promise<{ POST: Post }> {
  const { Hono } = await import('hono');
  const { gate } = await import('@/server/middleware/gate');
  const { registerRoutes } = await import('@/server/route-loader');
  const { routeManifest } = await import('@/server/route-manifest.gen');
  const app = new Hono();
  app.use('*', gate());
  registerRoutes(
    app,
    routeManifest.filter((e) => e.pattern === `/api/auth/${path}`),
  );
  return { POST: async (req: Request) => app.request(req) };
}

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

describe('sign-out refuses a cross-site browser request by its row (A10 #8 L5)', () => {
  // The logout row's crossSite is 'origin' (its route file's limits.crossSite):
  // the gate refuses a cross-site browser post, whatever its body, and takes
  // any body from the brain's own origin or a client that sends no Origin.
  it('logout: 403 cross-site for any body, no cookie; its own callers pass', async () => {
    const POST = (await routed('logout')).POST;
    for (const type of ['application/json', 'text/plain']) {
      const cross: Record<string, string>[] = [
        { 'content-type': type, origin: 'https://evil.example.invalid' },
        { 'content-type': type, origin: 'null', 'sec-fetch-site': 'cross-site' },
        { 'content-type': type, 'sec-fetch-site': 'cross-site' },
      ];
      for (const headers of cross) {
        const res = await POST(post('logout', headers, '{}'));
        expect(res.status, JSON.stringify(headers)).toBe(403);
        expect(((await res.json()) as { reason?: string }).reason).toBe('cross-site');
        expect(res.headers.get('set-cookie')).toBeNull();
      }
    }
    const own: Record<string, string>[] = [
      { 'content-type': 'text/plain', origin: BRAIN, 'sec-fetch-site': 'same-origin' },
      { 'content-type': 'application/json' },
    ];
    for (const headers of own) {
      const res = await POST(post('logout', headers, 'x'));
      expect(res.status, JSON.stringify(headers)).toBe(200);
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
