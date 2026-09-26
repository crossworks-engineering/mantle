/**
 * Member sweep (member logins, Phase 1; plan section 3, deny by default).
 * Drives EVERY manifest route, every method, with a signed session cookie for
 * a MEMBER login, through the real app, and proves each route not listed in
 * MEMBER_ROUTES refuses it: 403 from the admin gates (reason member-login),
 * 401 from the admin-only session reads, or the /login redirect for pages.
 *
 * No database: the login row and the anchor come from a stand-in
 * (lib/auth/login-row is mocked). A handler that touches the database BEFORE
 * its gate would fail here with a 500, which is also a finding: gate first.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const ANCHOR_ID = '33333333-3333-4333-8333-333333333333';
const DISABLED_ADMIN_ID = '44444444-4444-4444-8444-444444444444';
const ADMIN_ID = '55555555-5555-4555-8555-555555555555';
const SPACE_ID = '66666666-6666-4666-8666-666666666666';

vi.mock('../lib/auth/login-row', () => ({
  loadLoginRow: async (id: string) =>
    id === MEMBER_ID
      ? {
          id: MEMBER_ID,
          email: 'member@example.invalid',
          isOwner: false,
          displayName: 'Member',
          role: 'member',
          contactId: null,
          disabledAt: null,
        }
      : id === ADMIN_ID
        ? {
            id: ADMIN_ID,
            email: 'admin@example.invalid',
            isOwner: false,
            displayName: null,
            role: 'admin',
            contactId: null,
            disabledAt: null,
          }
        : id === DISABLED_ADMIN_ID
          ? {
              id: DISABLED_ADMIN_ID,
              email: 'gone@example.invalid',
              isOwner: false,
              displayName: null,
              role: 'admin',
              contactId: null,
              disabledAt: new Date('2026-09-01T00:00:00Z'),
            }
          : null,
  loadAnchorId: async () => ANCHOR_ID,
  loadPersonalSpaceId: async () => SPACE_ID,
}));

import { PUBLIC_PATHS, SESSION_COOKIE_NAME } from '../lib/auth-constants';
import { MEMBER_ROUTES, isMemberRoute } from '../lib/auth/member-routes';

const here = dirname(fileURLToPath(import.meta.url));
const hasManifest = existsSync(join(here, 'route-manifest.gen.ts'));

const IMAGE_EXT_RE = /\.(?:svg|png|jpg|jpeg|gif|webp)$/;

/** Routes that authenticate with their own short-lived ticket instead of the
 *  session, minted only by an admin-gated route (so a member never holds
 *  one). They answer a plain-text 401 without it. */
const TICKET_GATED = new Set(['GET /api/apps/:id/frame']);

function isPublic(path: string): boolean {
  return PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + '/'));
}

function concretePath(pattern: string): string {
  return pattern
    .replace(/:[A-Za-z0-9_]+\??/g, '11111111-1111-4111-8111-111111111111')
    .replace(/\*$/, 'a/b');
}

describe.skipIf(!hasManifest)('member sweep: a member login is refused everywhere else', () => {
  const saved = {
    secret: process.env.SESSION_SECRET,
    cors: process.env.MANTLE_API_CORS_ORIGINS,
    detached: process.env.MANTLE_DETACHED_DEV,
    members: process.env.MANTLE_MEMBERS,
  };
  let app: import('hono').Hono;
  let manifest: Array<{ pattern: string; methods: string[] }>;
  let cookie: string;

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'member-sweep-secret-that-is-at-least-32-chars';
    process.env.MANTLE_MEMBERS = '1';
    delete process.env.MANTLE_API_CORS_ORIGINS;
    delete process.env.MANTLE_DETACHED_DEV;
    const { buildSessionCookie } = await import('../lib/auth/tokens');
    cookie = `${SESSION_COOKIE_NAME}=${buildSessionCookie(MEMBER_ID).value}`;
    const { createApp } = await import('./app');
    app = await createApp();
    manifest = (await import('./route-manifest.gen')).routeManifest;
  }, 60_000);

  afterAll(() => {
    for (const [k, v] of [
      ['SESSION_SECRET', saved.secret],
      ['MANTLE_API_CORS_ORIGINS', saved.cors],
      ['MANTLE_DETACHED_DEV', saved.detached],
      ['MANTLE_MEMBERS', saved.members],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('refuses a member on every route not in MEMBER_ROUTES', async () => {
    const failures: string[] = [];
    let checked = 0;
    for (const entry of manifest) {
      const path = concretePath(entry.pattern);
      if (isPublic(path) || IMAGE_EXT_RE.test(path)) continue;
      const isApi = path === '/api' || path.startsWith('/api/');
      for (const method of entry.methods) {
        if (method === 'OPTIONS' || isMemberRoute(method, entry.pattern)) continue;
        checked += 1;
        const res = await app.request(path, {
          method,
          headers: { cookie, 'content-type': 'application/json' },
          body: method === 'GET' || method === 'HEAD' ? undefined : '{}',
        });
        if (isApi) {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
            reason?: string;
          } | null;
          const refused =
            (res.status === 403 && body?.reason === 'member-login') ||
            (res.status === 401 && body?.error === 'unauthorized') ||
            (res.status === 401 && TICKET_GATED.has(`${method} ${entry.pattern}`));
          if (!refused) failures.push(`${method} ${entry.pattern} → ${res.status}`);
        } else {
          const to = res.headers.get('location') ?? '';
          if (res.status !== 307 || !to.startsWith('/login')) {
            failures.push(`${method} ${entry.pattern} → ${res.status} ${to}`);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(300);
    expect(failures).toEqual([]);
  }, 300_000);

  it('lists only routes that exist', () => {
    const known = new Set(manifest.flatMap((e) => e.methods.map((mt) => `${mt} ${e.pattern}`)));
    expect(MEMBER_ROUTES.filter((r) => !known.has(r))).toEqual([]);
  });

  it('refuses an ADMIN on every member route (they are member-specific)', async () => {
    const { buildSessionCookie } = await import('../lib/auth/tokens');
    const adminCookie = `${SESSION_COOKIE_NAME}=${buildSessionCookie(ADMIN_ID).value}`;
    for (const route of MEMBER_ROUTES) {
      const [method, pattern] = route.split(' ') as [string, string];
      const res = await app.request(concretePath(pattern), {
        method,
        headers: { cookie: adminCookie },
      });
      const body = (await res.json().catch(() => null)) as { reason?: string } | null;
      // Byte routes answer a plain 401 to a non-member (no member session).
      const refused = (res.status === 403 && body?.reason === 'admin-login') || res.status === 401;
      expect(refused, `${route} → ${res.status}`).toBe(true);
    }
  });

  it('gives a disabled login no session at all', async () => {
    const { buildSessionCookie } = await import('../lib/auth/tokens');
    const gone = `${SESSION_COOKIE_NAME}=${buildSessionCookie(DISABLED_ADMIN_ID).value}`;
    const res = await app.request('/api/shell', { headers: { cookie: gone } });
    expect(res.status).toBe(401);
  });

  it('gives a member no session while member logins are off', async () => {
    delete process.env.MANTLE_MEMBERS;
    try {
      const res = await app.request('/api/shell', { headers: { cookie } });
      expect(res.status).toBe(401);
    } finally {
      process.env.MANTLE_MEMBERS = '1';
    }
  });
});
