import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mountRetiredTeamPages, mountStubs } from './stubs';

/**
 * The /n/<id> stub is the one that carries STORED links: nodeUrl() mints
 * `${MANTLE_PUBLIC_URL}/n/<id>` — the server origin — while /n/[id] itself
 * lives in client/web. Without the forward, a split deployment writes permanent
 * 404s into chat replies, pages, emails and every /api/search `url`.
 */
describe('mountStubs — /n/<id> node permalinks', () => {
  const app = new Hono();
  mountStubs(app);
  const original = process.env.MANTLE_CLIENT_ORIGIN;

  beforeEach(() => {
    process.env.MANTLE_CLIENT_ORIGIN = 'https://app.example.com';
  });
  afterEach(() => {
    if (original === undefined) delete process.env.MANTLE_CLIENT_ORIGIN;
    else process.env.MANTLE_CLIENT_ORIGIN = original;
  });

  it('forwards the id and query to the client origin', async () => {
    const res = await app.request('/n/8d0a1f2e-0000-4000-8000-000000000000?tab=backlinks');
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'https://app.example.com/n/8d0a1f2e-0000-4000-8000-000000000000?tab=backlinks',
    );
  });

  it('tolerates a trailing slash on the configured origin', async () => {
    process.env.MANTLE_CLIENT_ORIGIN = 'https://app.example.com/';
    const res = await app.request('/n/abc');
    expect(res.headers.get('location')).toBe('https://app.example.com/n/abc');
  });

  it('serves an explanation rather than looping when no client origin is set', async () => {
    delete process.env.MANTLE_CLIENT_ORIGIN;
    const res = await app.request('/n/abc');
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    await expect(res.text()).resolves.toContain('This item lives in the app');
  });
});

describe('mountStubs: /login with no client origin', () => {
  const original = process.env.MANTLE_CLIENT_ORIGIN;
  afterEach(() => {
    if (original === undefined) delete process.env.MANTLE_CLIENT_ORIGIN;
    else process.env.MANTLE_CLIENT_ORIGIN = original;
  });

  // It used to redirect to /team, which now redirects back to /login: a loop.
  it('explains instead of redirecting', async () => {
    delete process.env.MANTLE_CLIENT_ORIGIN;
    const app = new Hono();
    mountRetiredTeamPages(app);
    mountStubs(app);
    const res = await app.request('/login?next=%2Fsettings');
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    await expect(res.text()).resolves.toContain('Sign in from the app');
  });

  it('forwards to the client login, keeping next, when an origin is set', async () => {
    process.env.MANTLE_CLIENT_ORIGIN = 'https://app.example.com';
    const app = new Hono();
    mountStubs(app);
    const res = await app.request('/login?next=%2Fsettings');
    expect(res.headers.get('location')).toBe('https://app.example.com/login?next=%2Fsettings');
  });
});

describe('mountRetiredTeamPages', () => {
  it('sends /team, anything under it, and /hub to /login with no query', async () => {
    const app = new Hono();
    mountRetiredTeamPages(app);
    for (const path of ['/team', '/team/forum/1?code=ABCD2345', '/hub', '/hub/apps?x=1']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(307);
      expect(res.headers.get('location'), path).toBe('/login');
    }
    expect((await app.request('/team-admin')).status).toBe(404);
  });
});
