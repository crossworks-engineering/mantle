/**
 * Member sweep (member logins, Phase 1; plan section 3, deny by default).
 * Drives EVERY manifest route, every method, with a signed session cookie for
 * a MEMBER login, through the real app, and proves each route not listed in
 * MEMBER_ROUTES refuses it: 403 from the admin gates (reason member-login),
 * 401 from the admin-only session reads, or the /login redirect for pages.
 *
 * The sweep runs twice: with the session cookie, and with a member's device
 * token (the phone app's or the web client's bearer). A member bearer
 * reaches the member routes and nothing else.
 *
 * No database: the login row, the anchor and the device token rows come from
 * a stand-in (lib/auth/login-row is mocked). A handler that touches the
 * database BEFORE its gate would fail here with a 500, which is also a
 * finding: gate first.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const ANCHOR_ID = '33333333-3333-4333-8333-333333333333';
const DISABLED_ADMIN_ID = '44444444-4444-4444-8444-444444444444';
const ADMIN_ID = '55555555-5555-4555-8555-555555555555';
const SPACE_ID = '66666666-6666-4666-8666-666666666666';
const DISABLED_MEMBER_ID = '77777777-7777-4777-8777-777777777777';
const OTHER_ANCHOR_ID = '88888888-8888-4888-8888-888888888888';
/** A member whose sessions were ended twice (session_epoch 2, 0181). */
const BUMPED_MEMBER_ID = '99999999-9999-4999-8999-999999999999';

/** The device token rows (mobile_tokens) the bearer passes stand in. */
const bearers = vi.hoisted(() => ({
  rows: new Map<string, { userId: string; revokedAt: Date | null; expiresAt: Date }>(),
}));

vi.mock('../lib/auth/login-row', () => ({
  loadBearerToken: async (jti: string) => bearers.rows.get(jti) ?? null,
  touchBearerToken: async () => undefined,
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
          sessionEpoch: 0,
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
            sessionEpoch: 0,
          }
        : id === DISABLED_MEMBER_ID
          ? {
              id: DISABLED_MEMBER_ID,
              email: 'left@example.invalid',
              isOwner: false,
              displayName: null,
              role: 'member',
              contactId: null,
              disabledAt: new Date('2026-09-01T00:00:00Z'),
              sessionEpoch: 0,
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
                sessionEpoch: 0,
              }
            : id === BUMPED_MEMBER_ID
              ? {
                  id: BUMPED_MEMBER_ID,
                  email: 'bumped@example.invalid',
                  isOwner: false,
                  displayName: null,
                  role: 'member',
                  contactId: null,
                  disabledAt: null,
                  sessionEpoch: 2,
                }
              : null,
  loadAnchorId: async () => ANCHOR_ID,
  loadPersonalSpaceId: async () => SPACE_ID,
}));

// The MCP consent page checks that remote MCP is on and the client is
// registered before it reads the login: both stood in (see role-sweep).
vi.mock('../lib/mcp-oauth', async (importOriginal) => {
  const { SWEEP_OAUTH_CLIENT } = await import('./public-session-routes');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    isRemoteMcpEnabled: async () => true,
    getClient: async (id: string) =>
      id === SWEEP_OAUTH_CLIENT.id
        ? { id, clientName: 'Sweep client', redirectUris: [SWEEP_OAUTH_CLIENT.redirectUri] }
        : null,
  };
});

import { PUBLIC_PATHS, SESSION_COOKIE_NAME } from '../lib/auth-constants';
import { MEMBER_ROUTES, isMemberRoute } from '../lib/auth/member-routes';
import { PUBLIC_SESSION_ROUTES, RENDER_PAGES, drivePublic } from './public-session-routes';

const here = dirname(fileURLToPath(import.meta.url));
const hasManifest = existsSync(join(here, 'route-manifest.gen.ts'));
// vitest.global-setup.ts generates the manifest; in CI a missing one is a
// failure, never a silent skip of a security sweep.
if (!hasManifest && process.env.CI) {
  throw new Error('server/web/server/route-manifest.gen.ts is missing: the sweep cannot run');
}

const IMAGE_EXT_RE = /\.(?:svg|png|jpg|jpeg|gif|webp)$/;

/** Routes that authenticate with their own short-lived ticket instead of the
 *  session, minted only by an admin- or client-gated route (so a member never
 *  holds one). They answer a plain-text 401 without it. */
const TICKET_GATED = new Set(['GET /api/apps/:id/frame', 'GET /api/client/apps/:id/frame']);

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
  };
  let app: import('hono').Hono;
  let manifest: Array<{ pattern: string; methods: string[] }>;
  let cookie: string;
  /** A device token for `id` (no epoch, as a password sign-in mints it). */
  let bearerFor: (id: string, opts?: { revoked?: boolean }) => Record<string, string>;

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'member-sweep-secret-that-is-at-least-32-chars';
    delete process.env.MANTLE_API_CORS_ORIGINS;
    delete process.env.MANTLE_DETACHED_DEV;
    const { buildSessionCookie, buildMobileToken } = await import('../lib/auth/tokens');
    cookie = `${SESSION_COOKIE_NAME}=${buildSessionCookie(MEMBER_ID).value}`;
    bearerFor = (id, opts = {}) => {
      const jti = randomUUID();
      const t = buildMobileToken(id, jti, 30 * 24 * 60 * 60);
      bearers.rows.set(jti, {
        userId: id,
        revokedAt: opts.revoked ? new Date() : null,
        expiresAt: t.expiresAt,
      });
      return { authorization: `Bearer ${t.value}` };
    };
    const { createApp } = await import('./app');
    app = await createApp();
    manifest = (await import('./route-manifest.gen')).routeManifest;
  }, 60_000);

  afterAll(() => {
    for (const [k, v] of [
      ['SESSION_SECRET', saved.secret],
      ['MANTLE_API_CORS_ORIGINS', saved.cors],
      ['MANTLE_DETACHED_DEV', saved.detached],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // The public routes the sweep below skips, driven one by one where they
  // read the session themselves (audit A4; server/public-session-routes.ts).
  it('answers a member on each session-reading public route as listed', async () => {
    const failures: string[] = [];
    for (const route of [...PUBLIC_SESSION_ROUTES, ...RENDER_PAGES]) {
      const failure = await drivePublic(app, route, 'member', cookie);
      if (failure) failures.push(failure);
    }
    expect(failures).toEqual([]);
  });

  it.each(['cookie', 'bearer'] as const)(
    'refuses a member (%s) on every route not in MEMBER_ROUTES',
    async (how) => {
      const auth: Record<string, string> = how === 'cookie' ? { cookie } : bearerFor(MEMBER_ID);
      const failures: string[] = [];
      const visited = new Set<string>();
      let checked = 0;
      for (const entry of manifest) {
        const path = concretePath(entry.pattern);
        if (isPublic(path) || IMAGE_EXT_RE.test(path)) continue;
        const isApi = path === '/api' || path.startsWith('/api/');
        for (const method of entry.methods) {
          if (method === 'OPTIONS' || isMemberRoute(method, entry.pattern)) continue;
          checked += 1;
          visited.add(`${method} ${entry.pattern}`);
          const res = await app.request(path, {
            method,
            headers: { ...auth, 'content-type': 'application/json' },
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
      // The allow-list the check consults was reached (it is not dead).
      expect([...TICKET_GATED].filter((k) => !visited.has(k))).toEqual([]);
    },
    300_000,
  );

  it('a member device token reaches member routes, and a revoked one nothing', async () => {
    const headers = bearerFor(MEMBER_ID);
    for (const path of PAST_THE_GATE) {
      const res = await app.request(path, { headers });
      expect(res.status, path).toBe(400);
    }
    const who = await app.request('/api/auth/whoami', { headers });
    expect(who.status).toBe(200);
    expect(await who.json()).toMatchObject({
      role: 'member',
      loginId: MEMBER_ID,
      shell: '/api/member/shell',
      pushBase: '/api/member/push',
    });
    const dead = bearerFor(MEMBER_ID, { revoked: true });
    expect((await app.request(PAST_THE_GATE[0]!, { headers: dead })).status).toBe(401);
    expect((await app.request('/api/auth/whoami', { headers: dead })).status).toBe(401);
    expect(
      (await app.request(PAST_THE_GATE[0]!, { headers: bearerFor(DISABLED_MEMBER_ID) })).status,
    ).toBe(401);
  });

  it('a member device token is refused by the admin and the client gates', async () => {
    const headers = bearerFor(MEMBER_ID);
    for (const path of ['/api/shell', '/api/client/shell', '/api/push/subscriptions']) {
      const res = await app.request(path, { headers });
      const body = (await res.json().catch(() => null)) as { reason?: string } | null;
      expect(res.status, path).toBe(403);
      expect(body?.reason, path).toBe('member-login');
    }
    // Admin and client bytes: a plain 401 (no session of that role).
    for (const path of ['/api/files/files/not-a-uuid?raw=1', '/api/client/files/not-a-uuid']) {
      expect((await app.request(path, { headers })).status, path).toBe(401);
    }
  });

  it('refuses an ADMIN device token on every member route', async () => {
    const headers = bearerFor(ADMIN_ID);
    for (const route of MEMBER_ROUTES) {
      const [method, pattern] = route.split(' ') as [string, string];
      const res = await app.request(concretePath(pattern), { method, headers });
      const body = (await res.json().catch(() => null)) as { reason?: string } | null;
      const refused = (res.status === 403 && body?.reason === 'admin-login') || res.status === 401;
      expect(refused, `${route} → ${res.status}`).toBe(true);
    }
  });

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

  // The positive half: a member session gets PAST the gate on member routes.
  // A malformed id is used so each handler answers its own 400 before any
  // database read; the admin on the same path is stopped at the gate.
  const PAST_THE_GATE = [
    '/api/member/library/not-a-uuid',
    '/api/member/space/not-a-uuid',
    '/api/member/team-drafts/not-a-uuid',
    '/api/member/files/not-a-uuid',
    '/api/member/space/not-a-uuid/bytes',
    // Client requests and the client thread (client logins C5).
    '/api/member/client-requests/not-a-uuid',
    '/api/member/client-requests/not-a-uuid/bytes',
    '/api/member/library/not-a-uuid/comments',
  ];

  it('lets a member session through to member routes', async () => {
    const { buildSessionCookie } = await import('../lib/auth/tokens');
    const adminCookie = `${SESSION_COOKIE_NAME}=${buildSessionCookie(ADMIN_ID).value}`;
    for (const path of PAST_THE_GATE) {
      const res = await app.request(path, { headers: { cookie } });
      const body = (await res.json().catch(() => null)) as { reason?: string } | null;
      expect(res.status, path).toBe(400);
      expect(body?.reason, path).not.toBe('member-login');
      const asAdmin = await app.request(path, { headers: { cookie: adminCookie } });
      expect([401, 403], `${path} as admin`).toContain(asAdmin.status);
    }
  });

  describe('getMemberForAsset: a member ?at= token (no session)', () => {
    const fileWith = async (anchor: string, login: string) => {
      const { buildAssetToken } = await import('../lib/auth/tokens');
      const at = encodeURIComponent(buildAssetToken(anchor, login));
      return app.request(`/api/member/files/not-a-uuid?at=${at}`);
    };

    it("is accepted for a live member of this brain's anchor", async () => {
      expect((await fileWith(ANCHOR_ID, MEMBER_ID)).status).toBe(400);
    });

    it('is refused when minted under another anchor', async () => {
      expect((await fileWith(OTHER_ANCHOR_ID, MEMBER_ID)).status).toBe(401);
    });

    it('is refused for a disabled member login', async () => {
      expect((await fileWith(ANCHOR_ID, DISABLED_MEMBER_ID)).status).toBe(401);
    });

    it('is refused for an admin login', async () => {
      expect((await fileWith(ANCHOR_ID, ADMIN_ID)).status).toBe(401);
    });
  });

  it('gives a disabled login no session at all', async () => {
    const { buildSessionCookie } = await import('../lib/auth/tokens');
    const gone = `${SESSION_COOKIE_NAME}=${buildSessionCookie(DISABLED_ADMIN_ID).value}`;
    const res = await app.request('/api/shell', { headers: { cookie: gone } });
    expect(res.status).toBe(401);
  });

  it('gives a disabled member login no session at all', async () => {
    const { buildSessionCookie } = await import('../lib/auth/tokens');
    const left = `${SESSION_COOKIE_NAME}=${buildSessionCookie(DISABLED_MEMBER_ID).value}`;
    const res = await app.request('/api/member/space/not-a-uuid', { headers: { cookie: left } });
    expect(res.status).toBe(401);
  });

  // F06: a session ends when the login's epoch moves on. The cookie and the
  // `?at=` token carry the epoch they were minted at; the row is re-read.
  describe('session epoch', () => {
    const PAST = '/api/member/space/not-a-uuid';

    it('refuses a cookie minted before the last bump', async () => {
      const { buildSessionCookie } = await import('../lib/auth/tokens');
      for (const epoch of [0, 1, 3]) {
        const stale = `${SESSION_COOKIE_NAME}=${buildSessionCookie(BUMPED_MEMBER_ID, { epoch }).value}`;
        const res = await app.request(PAST, { headers: { cookie: stale } });
        expect(res.status, `epoch ${epoch}`).toBe(401);
      }
      const now = `${SESSION_COOKIE_NAME}=${buildSessionCookie(BUMPED_MEMBER_ID, { epoch: 2 }).value}`;
      expect((await app.request(PAST, { headers: { cookie: now } })).status).toBe(400);
    });

    it('reads a cookie without the claim (minted before 0181) as epoch 0', async () => {
      const { buildSessionCookie } = await import('../lib/auth/tokens');
      // buildSessionCookie always signs `ep` now: strip it to get an old one.
      const old = (id: string) => {
        const v = buildSessionCookie(id).value;
        const claims = JSON.parse(Buffer.from(v.split('.')[0]!, 'base64url').toString('utf8'));
        delete claims.ep;
        const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
        const sig = createHmac('sha256', process.env.SESSION_SECRET!).update(payload).digest();
        return `${SESSION_COOKIE_NAME}=${payload}.${sig.toString('base64url')}`;
      };
      expect((await app.request(PAST, { headers: { cookie: old(MEMBER_ID) } })).status).toBe(400);
      expect((await app.request(PAST, { headers: { cookie: old(BUMPED_MEMBER_ID) } })).status).toBe(
        401,
      );
    });

    it('refuses a member ?at= token minted before the last bump', async () => {
      const { buildAssetToken } = await import('../lib/auth/tokens');
      const file = (epoch: number) =>
        app.request(
          `/api/member/files/not-a-uuid?at=${encodeURIComponent(buildAssetToken(ANCHOR_ID, BUMPED_MEMBER_ID, epoch))}`,
        );
      expect((await file(0)).status).toBe(401);
      expect((await file(2)).status).toBe(400);
    });
  });
});
