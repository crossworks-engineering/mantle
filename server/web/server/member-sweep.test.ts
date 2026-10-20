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
/** A member whose sessions were ended twice (session_epoch 2, 0181). */
const BUMPED_MEMBER_ID = '99999999-9999-4999-8999-999999999999';

/** The device token rows (mobile_tokens) the bearer passes stand in. */
const bearers = vi.hoisted(() => ({
  rows: new Map<string, { userId: string; revokedAt: Date | null; expiresAt: Date }>(),
}));

// This brain's id (migration 0226): a stand-in, as the login rows are.
vi.mock('../lib/brain-identity', () => ({
  brainIdOrNull: async () => '0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f',
  getBrainId: async () => '0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f',
  brainIdField: async () => ({ brainId: '0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f' }),
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
          adminMember: false,
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
            adminMember: true,
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
              adminMember: false,
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
                adminMember: true,
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
                  adminMember: false,
                  contactId: null,
                  disabledAt: null,
                  sessionEpoch: 2,
                }
              : null,
  loadAnchorId: async () => ANCHOR_ID,
  loadPersonalSpaceId: async () => SPACE_ID,
}));

// QR pairing (W7e: a member pairs its own phone): the code store stood in.
vi.mock('../lib/pair-code', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  issuePairCode: async () => ({
    id: '00000000-0000-4000-8000-0000000000c0',
    code: 'sweep-code-sweep-code-sweep',
    expiresAt: new Date(Date.now() + 90_000),
  }),
  pairCodeStatus: async () => ({ status: 'pending', deviceLabel: null }),
}));

// MCP as a login: a member's or client's MCP access is off here (the
// default), so the consent page refuses them as it always did.
vi.mock('../lib/mcp-auth', () => ({
  mcpLoginUsable: async () => false,
  mcpTargetLogin: async () => null,
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
import { isAnyLoginRoute } from '../lib/auth/any-login-routes';
import { buildRoutePolicy, memberOpenRead, memberOpenWrite } from '../lib/auth/route-policy';
import { PUBLIC_SESSION_ROUTES, RENDER_PAGES, drivePublic } from './public-session-routes';

// W6a: the session guard reads the login's workspaces (loginScopeFor) and,
// on a management route, its area (requireArea) from the database. This
// file runs without one: an empty scope and every area stand in (the scope
// itself is proved in w6a-route-sweep.db.test.ts).
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/db')>()),
  loginScopeFor: async (loginId: string) => ({ kind: 'user', loginId, ws: [], modWs: [] }),
}));
vi.mock('../lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/workspaces')>()),
  requireArea: async () => true,
}));

const here = dirname(fileURLToPath(import.meta.url));
const hasManifest = existsSync(join(here, 'route-manifest.gen.ts'));
// vitest.global-setup.ts generates the manifest; in CI a missing one is a
// failure, never a silent skip of a security sweep.
if (!hasManifest && process.env.CI) {
  throw new Error('server/web/server/route-manifest.gen.ts is missing: the sweep cannot run');
}

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
  };
  let app: import('hono').Hono;
  let manifest: Array<{ pattern: string; methods: string[] }>;
  let policy: ReturnType<typeof buildRoutePolicy>;
  /** A row open to a login outside Admin (the owner lists, and a v1 row
   *  whose base route is one: D3). */
  const memberOpen = (method: string, pattern: string) => {
    const row = policy.get(`${method} ${pattern}`);
    return !!row && (memberOpenRead(row) || memberOpenWrite(row));
  };
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
    policy = buildRoutePolicy((await import('./route-manifest.gen')).routeManifest);
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
      if (route.cookieOnly) continue;
      // The same member with its device token: the same answer, never more.
      const asBearer = await drivePublic(app, route, 'member', bearerFor(MEMBER_ID));
      if (asBearer) failures.push(asBearer);
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
          if (
            method === 'OPTIONS' ||
            isMemberRoute(method, entry.pattern) ||
            isAnyLoginRoute(method, entry.pattern) ||
            // Open to every login in its scope since W6a (reads) and W6b
            // (writes): proved against a database in w6a-route-sweep.db.test.ts
            // and w6b-member-writes.db.test.ts. A v1 row is open where its
            // base route is (D3, the A8 finding F1): its ROUTE_POLICY row
            // says so (a8-findings.db.test.ts proves it on a database).
            memberOpen(method, entry.pattern)
          ) {
            continue;
          }
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
      expect(pastTheGate(res.status), `${path} ${res.status}`).toBe(true);
    }
    const who = await app.request('/api/auth/whoami', { headers });
    expect(who.status).toBe(200);
    expect(await who.json()).toMatchObject({
      role: 'member',
      loginId: MEMBER_ID,
      // One shell for every login since W5c.
      shell: '/api/shell',
      pushBase: '/api/member/push',
      // The pair a device files this session under, and every push names.
      brainId: '0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f',
    });
    const dead = bearerFor(MEMBER_ID, { revoked: true });
    expect((await app.request(PAST_THE_GATE[0]!, { headers: dead })).status).toBe(401);
    expect((await app.request('/api/auth/whoami', { headers: dead })).status).toBe(401);
    expect(
      (await app.request(PAST_THE_GATE[0]!, { headers: bearerFor(DISABLED_MEMBER_ID) })).status,
    ).toBe(401);
  });

  it('a member device token is refused by the admin gate; the client portal is gone', async () => {
    const headers = bearerFor(MEMBER_ID);
    // The one shell (W5c) answers a member as a member.
    const shell = await app.request('/api/shell', { headers });
    expect(shell.status).toBe(200);
    expect(await shell.json()).toMatchObject({
      role: 'member',
      loginId: MEMBER_ID,
      areas: [],
      pendingApprovals: 0,
    });
    const refused = await app.request('/api/push/subscriptions', { headers });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { reason?: string }).reason).toBe('member-login');
    // The client portal (W5c, W8a) is no route since arch A7: a 404.
    for (const path of ['/api/client/shell', '/api/client/files/not-a-uuid']) {
      const res = await app.request(path, { headers });
      expect(res.status, path).toBe(404);
    }
    // The brain's byte route serves every login in its scope since W7e: a
    // member device token gets past the gate. Since pre-check removal part
    // 2 the route declares its uuid param, so the bad id is the params
    // gateway's 404 (it runs after the session guard, whose refusal would
    // be the 401 or 403), where the handler answered 400 "invalid id".
    for (const path of ['/api/files/files/not-a-uuid?raw=1']) {
      const res = await app.request(path, { headers });
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toBe('{"error":"not found"}');
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

  // The positive half: a member session gets PAST the gate on member routes:
  // the handler runs (it reads the push preferences, no database here: its
  // own error, never the gate's 401 or 403); the admin on the same path is
  // stopped at the gate. The member routes retired over W5c to W8d (410
  // stubs until arch A7) are pinned in a7-gone-routes.test.ts.
  const PAST_THE_GATE = ['/api/member/push/preferences'];
  const pastTheGate = (status: number) => status !== 401 && status !== 403;

  it('lets a member session through to member routes', async () => {
    const { buildSessionCookie } = await import('../lib/auth/tokens');
    const adminCookie = `${SESSION_COOKIE_NAME}=${buildSessionCookie(ADMIN_ID).value}`;
    for (const path of PAST_THE_GATE) {
      const res = await app.request(path, { headers: { cookie } });
      const body = (await res.json().catch(() => null)) as { reason?: string } | null;
      expect(pastTheGate(res.status), `${path} ${res.status}`).toBe(true);
      expect(body?.reason, path).not.toBe('member-login');
      const asAdmin = await app.request(path, { headers: { cookie: adminCookie } });
      expect([401, 403], `${path} as admin`).toContain(asAdmin.status);
    }
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
    const res = await app.request(PAST_THE_GATE[0]!, { headers: { cookie: left } });
    expect(res.status).toBe(401);
  });

  // F06: a session ends when the login's epoch moves on. The cookie and the
  // `?at=` token carry the epoch they were minted at; the row is re-read.
  describe('session epoch', () => {
    const PAST = PAST_THE_GATE[0]!;

    it('refuses a cookie minted before the last bump', async () => {
      const { buildSessionCookie } = await import('../lib/auth/tokens');
      for (const epoch of [0, 1, 3]) {
        const stale = `${SESSION_COOKIE_NAME}=${buildSessionCookie(BUMPED_MEMBER_ID, { epoch }).value}`;
        const res = await app.request(PAST, { headers: { cookie: stale } });
        expect(res.status, `epoch ${epoch}`).toBe(401);
      }
      const now = `${SESSION_COOKIE_NAME}=${buildSessionCookie(BUMPED_MEMBER_ID, { epoch: 2 }).value}`;
      expect(pastTheGate((await app.request(PAST, { headers: { cookie: now } })).status)).toBe(
        true,
      );
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
      expect(
        pastTheGate((await app.request(PAST, { headers: { cookie: old(MEMBER_ID) } })).status),
      ).toBe(true);
      expect((await app.request(PAST, { headers: { cookie: old(BUMPED_MEMBER_ID) } })).status).toBe(
        401,
      );
    });
  });
});
