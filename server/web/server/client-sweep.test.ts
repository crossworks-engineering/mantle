/**
 * Client sweep (client logins C2; plan section 5, deny by default). The twin
 * of the member sweep, for the routes in CLIENT_ROUTES:
 *
 *  - admins and members are refused on every client route (client routes
 *    are client-specific, never shared);
 *  - a client session gets PAST the gate on its routes;
 *  - a client `?at=` token opens the client byte routes only for a live
 *    client of this brain's anchor, at the login's current session epoch;
 *  - a client cookie ends with the login's epoch, and one that claims to
 *    last longer than 30 days is refused;
 *  - a client DEVICE TOKEN (the phone app's bearer) gets past the gate on
 *    the same routes under the same rules: it must carry the login's current
 *    session epoch, last at most 30 days, and have a live row of its own
 *    login; an admin's or a member's bearer is refused on every client route.
 *
 * The other half, "every route NOT in CLIENT_ROUTES refuses a client", is
 * the client sweep in role-sweep.test.ts (every manifest route, member
 * routes included).
 *
 * No database: the login rows and the anchor come from a stand-in
 * (lib/auth/login-row is mocked). A handler that touches the database BEFORE
 * its gate would fail here with a 500, which is also a finding: gate first.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const CLIENT_ID = '12121212-1212-4212-8212-121212121212';
const DISABLED_CLIENT_ID = '14141414-1414-4414-8414-141414141414';
/** A client whose sessions were ended twice (session_epoch 2). */
const BUMPED_CLIENT_ID = '15151515-1515-4515-8515-151515151515';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const ANCHOR_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_ID = '55555555-5555-4555-8555-555555555555';
const SPACE_ID = '66666666-6666-4666-8666-666666666666';
const OTHER_ANCHOR_ID = '88888888-8888-4888-8888-888888888888';

const row = (
  id: string,
  role: string,
  extra: { disabledAt?: Date; sessionEpoch?: number } = {},
) => ({
  id,
  email: `${role}-${id.slice(0, 4)}@example.invalid`,
  isOwner: false,
  displayName: null,
  role,
  contactId: null,
  disabledAt: extra.disabledAt ?? null,
  sessionEpoch: extra.sessionEpoch ?? 0,
});

/** The device token rows (mobile_tokens) the bearer tests stand in. */
const bearers = vi.hoisted(() => ({
  rows: new Map<string, { userId: string; revokedAt: Date | null; expiresAt: Date }>(),
}));

vi.mock('../lib/auth/login-row', () => ({
  loadBearerToken: async (jti: string) => bearers.rows.get(jti) ?? null,
  touchBearerToken: async () => undefined,
  loadLoginRow: async (id: string) =>
    ({
      [CLIENT_ID]: row(CLIENT_ID, 'client'),
      [DISABLED_CLIENT_ID]: row(DISABLED_CLIENT_ID, 'client', {
        disabledAt: new Date('2026-09-01T00:00:00Z'),
      }),
      [BUMPED_CLIENT_ID]: row(BUMPED_CLIENT_ID, 'client', { sessionEpoch: 2 }),
      [MEMBER_ID]: row(MEMBER_ID, 'member'),
      [ADMIN_ID]: row(ADMIN_ID, 'admin'),
    })[id] ?? null,
  loadAnchorId: async () => ANCHOR_ID,
  loadPersonalSpaceId: async () => SPACE_ID,
}));

import { SESSION_COOKIE_NAME } from '../lib/auth-constants';
import { CLIENT_ROUTES } from '../lib/auth/client-routes';
import { CLIENT_SESSION_TTL_SECONDS } from '../lib/auth/session';

const here = dirname(fileURLToPath(import.meta.url));
const hasManifest = existsSync(join(here, 'route-manifest.gen.ts'));
if (!hasManifest && process.env.CI) {
  throw new Error('server/web/server/route-manifest.gen.ts is missing: the sweep cannot run');
}

function concretePath(pattern: string): string {
  return pattern.replace(/:[A-Za-z0-9_]+\??/g, '11111111-1111-4111-8111-111111111111');
}

describe.skipIf(!hasManifest)('client sweep: client routes serve clients only', () => {
  const saved = {
    secret: process.env.SESSION_SECRET,
    cors: process.env.MANTLE_API_CORS_ORIGINS,
    detached: process.env.MANTLE_DETACHED_DEV,
  };
  let app: import('hono').Hono;
  let manifest: Array<{ pattern: string; methods: string[] }>;
  let tokens: typeof import('../lib/auth/tokens');
  const cookieFor = (id: string, opts: { epoch?: number; ttlSeconds?: number } = {}) =>
    `${SESSION_COOKIE_NAME}=${
      tokens.buildSessionCookie(id, { ttlSeconds: CLIENT_SESSION_TTL_SECONDS, ...opts }).value
    }`;

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'client-sweep-secret-that-is-at-least-32-chars';
    delete process.env.MANTLE_API_CORS_ORIGINS;
    delete process.env.MANTLE_DETACHED_DEV;
    tokens = await import('../lib/auth/tokens');
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

  it('lists only routes that exist, all under /api/client/', () => {
    const known = new Set(manifest.flatMap((e) => e.methods.map((mt) => `${mt} ${e.pattern}`)));
    expect(CLIENT_ROUTES.filter((r) => !known.has(r))).toEqual([]);
    expect(CLIENT_ROUTES.filter((r) => !r.split(' ')[1]!.startsWith('/api/client/'))).toEqual([]);
  });

  it('every /api/client/ route in the manifest is on the list (nothing unlisted)', () => {
    const listed = new Set(CLIENT_ROUTES);
    const unlisted = manifest
      .filter((e) => e.pattern.startsWith('/api/client/'))
      .flatMap((e) => e.methods.filter((mt) => mt !== 'OPTIONS').map((mt) => `${mt} ${e.pattern}`))
      .filter((r) => !listed.has(r));
    expect(unlisted).toEqual([]);
  });

  it('refuses an ADMIN and a MEMBER on every client route', async () => {
    for (const [id, reason] of [
      [ADMIN_ID, 'admin-login'],
      [MEMBER_ID, 'member-login'],
    ] as const) {
      const cookie = `${SESSION_COOKIE_NAME}=${tokens.buildSessionCookie(id).value}`;
      for (const route of CLIENT_ROUTES) {
        const [method, pattern] = route.split(' ') as [string, string];
        const res = await app.request(concretePath(pattern), { method, headers: { cookie } });
        const body = (await res.json().catch(() => null)) as { reason?: string } | null;
        // Byte routes answer a plain 401 to a non-client (no client session).
        const refused = (res.status === 403 && body?.reason === reason) || res.status === 401;
        expect(refused, `${route} as ${reason} → ${res.status}`).toBe(true);
      }
    }
  });

  it('refuses a stranger (no session) on every client route', async () => {
    for (const route of CLIENT_ROUTES) {
      const [method, pattern] = route.split(' ') as [string, string];
      const res = await app.request(concretePath(pattern), { method });
      expect(res.status, route).toBe(401);
    }
  });

  // The positive half: a client session gets PAST the gate on its routes. A
  // malformed id is used so each handler answers its own 400 before any
  // database read; an admin and a member on the same path are stopped.
  const PAST_THE_GATE = [
    '/api/client/shared/not-a-uuid',
    '/api/client/files/not-a-uuid',
    '/api/client/draws/not-a-uuid/svg',
    // The client's own space (C5): a bad id, or a kind a client never lists.
    '/api/client/space/not-a-uuid',
    '/api/client/space/not-a-uuid/bytes',
    '/api/client/space/not-a-uuid/comments',
    '/api/client/space?kind=draw',
    '/api/client/items?kind=table',
    '/api/client/accepted/not-a-uuid',
    '/api/client/shared/not-a-uuid/comments',
  ];

  it('lets a client session through to client routes', async () => {
    for (const path of PAST_THE_GATE) {
      const res = await app.request(path, { headers: { cookie: cookieFor(CLIENT_ID) } });
      const body = (await res.json().catch(() => null)) as { reason?: string } | null;
      expect(res.status, path).toBe(400);
      expect(body?.reason, path).not.toBe('client-login');
      for (const other of [ADMIN_ID, MEMBER_ID]) {
        const cookie = `${SESSION_COOKIE_NAME}=${tokens.buildSessionCookie(other).value}`;
        const res2 = await app.request(path, { headers: { cookie } });
        expect([401, 403], `${path} as ${other}`).toContain(res2.status);
      }
    }
  });

  // The client app routes (C6): a client session gets past the gate on the
  // POST routes (a malformed id is the same 404 as a team app; an empty body
  // is the brokers' own 400, before any read).
  it('lets a client session through to the client app routes', async () => {
    const cookie = cookieFor(CLIENT_ID);
    const postTo = (path: string, body: unknown) =>
      app.request(path, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await postTo('/api/client/apps/not-a-uuid/frame-ticket', {})).status).toBe(404);
    expect((await postTo('/api/client/apps/not-a-uuid/tool-broker', {})).status).toBe(400);
    expect((await postTo('/api/client/apps/not-a-uuid/db-broker', {})).status).toBe(400);
  });

  describe('the client app frame: a ticket with the client session epoch', () => {
    // A malformed app id: past the ticket and liveness checks, the route's
    // lookup answers its 404 before any read. A refusal is a 401.
    const frameWith = (ticket: string | null) =>
      app.request(
        `/api/client/apps/not-a-uuid/frame${ticket ? `?t=${encodeURIComponent(ticket)}` : ''}`,
      );
    const clientTicket = (loginId: string, clientEpoch?: number) =>
      tokens.buildAppFrameTicket({
        ownerId: ANCHOR_ID,
        appId: 'not-a-uuid',
        loginId,
        ...(clientEpoch === undefined ? {} : { clientEpoch }),
      });

    it("opens for a live client at the login's current epoch", async () => {
      expect((await frameWith(clientTicket(CLIENT_ID, 0))).status).toBe(404);
      expect((await frameWith(clientTicket(BUMPED_CLIENT_ID, 2))).status).toBe(404);
    });

    it('is refused after End sessions or sign out (an older epoch)', async () => {
      for (const epoch of [0, 1, 3]) {
        const res = await frameWith(clientTicket(BUMPED_CLIENT_ID, epoch));
        expect(res.status, `epoch ${epoch}`).toBe(401);
      }
    });

    it('is refused for a disabled client, a member or an admin login', async () => {
      expect((await frameWith(clientTicket(DISABLED_CLIENT_ID, 0))).status).toBe(401);
      expect((await frameWith(clientTicket(MEMBER_ID, 0))).status).toBe(401);
      expect((await frameWith(clientTicket(ADMIN_ID, 0))).status).toBe(401);
    });

    it('is refused without a ticket, and with a member ticket (no epoch)', async () => {
      expect((await frameWith(null)).status).toBe(401);
      expect((await frameWith(clientTicket(CLIENT_ID))).status).toBe(401);
      const owner = tokens.buildAppFrameTicket({ ownerId: ANCHOR_ID, appId: 'not-a-uuid' });
      expect((await frameWith(owner)).status).toBe(401);
    });

    it('a client session cookie alone is no ticket', async () => {
      const res = await app.request('/api/client/apps/not-a-uuid/frame', {
        headers: { cookie: cookieFor(CLIENT_ID) },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('getClientForAsset: a client ?at= token (no session)', () => {
    const fileWith = (anchor: string, login: string, epoch?: number) =>
      app.request(
        `/api/client/files/not-a-uuid?at=${encodeURIComponent(tokens.buildAssetToken(anchor, login, epoch))}`,
      );
    const svgWith = (anchor: string, login: string) =>
      app.request(
        `/api/client/draws/not-a-uuid/svg?at=${encodeURIComponent(tokens.buildAssetToken(anchor, login))}`,
      );
    // The client's own file bytes (C5): listed in the gate's asset paths.
    const ownWith = (anchor: string, login: string) =>
      app.request(
        `/api/client/space/not-a-uuid/bytes?at=${encodeURIComponent(tokens.buildAssetToken(anchor, login))}`,
      );

    it("is accepted for a live client of this brain's anchor", async () => {
      expect((await fileWith(ANCHOR_ID, CLIENT_ID)).status).toBe(400);
      expect((await svgWith(ANCHOR_ID, CLIENT_ID)).status).toBe(400);
      expect((await ownWith(ANCHOR_ID, CLIENT_ID)).status).toBe(400);
    });

    it('is refused when minted under another anchor', async () => {
      expect((await fileWith(OTHER_ANCHOR_ID, CLIENT_ID)).status).toBe(401);
      expect((await svgWith(OTHER_ANCHOR_ID, CLIENT_ID)).status).toBe(401);
      expect((await ownWith(OTHER_ANCHOR_ID, CLIENT_ID)).status).toBe(401);
    });

    it('is refused for a disabled client login', async () => {
      expect((await fileWith(ANCHOR_ID, DISABLED_CLIENT_ID)).status).toBe(401);
    });

    it('is refused for an admin or a member login', async () => {
      expect((await fileWith(ANCHOR_ID, ADMIN_ID)).status).toBe(401);
      expect((await fileWith(ANCHOR_ID, MEMBER_ID)).status).toBe(401);
      expect((await ownWith(ANCHOR_ID, ADMIN_ID)).status).toBe(401);
      expect((await ownWith(ANCHOR_ID, MEMBER_ID)).status).toBe(401);
    });

    it('is refused when minted before the last epoch bump', async () => {
      expect((await fileWith(ANCHOR_ID, BUMPED_CLIENT_ID, 0)).status).toBe(401);
      expect((await fileWith(ANCHOR_ID, BUMPED_CLIENT_ID, 1)).status).toBe(401);
      expect((await fileWith(ANCHOR_ID, BUMPED_CLIENT_ID, 2)).status).toBe(400);
    });

    // Audit B8: these are the REAL byte routes, driven with a well-formed id,
    // so the gate lets an asset token through and the route's own check
    // (getOwnerForAsset, getMemberForAsset) is what answers. An admin-act
    // token gets past it (the positive control): if a client-act one ever
    // did too, the token every client holds would open every file by id.
    const ID = '11111111-1111-4111-8111-111111111111';
    const ADMIN_BYTES = [
      `/api/files/files/${ID}?raw=1`,
      `/api/draws/${ID}/svg`,
      `/api/attachments/${ID}`,
      `/api/export/${ID}`,
      '/api/profile/photo',
      `/api/admin/space/${ID}/bytes`,
    ];
    const MEMBER_BYTES = [
      `/api/member/files/${ID}`,
      `/api/member/draws/${ID}/svg`,
      `/api/member/space/${ID}/bytes`,
      `/api/member/team-drafts/${ID}/bytes`,
      `/api/member/client-requests/${ID}/bytes`,
    ];
    const withAt = (path: string, at: string) =>
      `${path}${path.includes('?') ? '&' : '?'}at=${encodeURIComponent(at)}`;

    it('opens no admin bytes and no member bytes', async () => {
      const at = tokens.buildAssetToken(ANCHOR_ID, CLIENT_ID);
      for (const path of [...ADMIN_BYTES, ...MEMBER_BYTES]) {
        const res = await app.request(withAt(path, at));
        expect(res.status, path).toBe(401);
      }
    });

    it('an admin-act token on the same routes gets past the gate (the control)', async () => {
      const at = tokens.buildAssetToken(ANCHOR_ID, ADMIN_ID);
      for (const path of ADMIN_BYTES) {
        const res = await app.request(withAt(path, at));
        // Past the gate: the route reads (a missing item, or no database
        // here), never the gate's 401.
        expect(res.status, path).not.toBe(401);
      }
    });
  });

  describe('client sessions', () => {
    const PAST = '/api/client/shared/not-a-uuid';

    it('gives a disabled client no session', async () => {
      const res = await app.request(PAST, { headers: { cookie: cookieFor(DISABLED_CLIENT_ID) } });
      expect(res.status).toBe(401);
    });

    it('refuses a cookie minted before the last epoch bump', async () => {
      for (const epoch of [0, 1, 3]) {
        const res = await app.request(PAST, {
          headers: { cookie: cookieFor(BUMPED_CLIENT_ID, { epoch }) },
        });
        expect(res.status, `epoch ${epoch}`).toBe(401);
      }
      const now = await app.request(PAST, {
        headers: { cookie: cookieFor(BUMPED_CLIENT_ID, { epoch: 2 }) },
      });
      expect(now.status).toBe(400);
    });

    it('refuses a client cookie that claims to last longer than 30 days', async () => {
      const day = 24 * 60 * 60;
      const long = await app.request(PAST, {
        headers: { cookie: cookieFor(CLIENT_ID, { ttlSeconds: 31 * day }) },
      });
      expect(long.status).toBe(401);
      const year = await app.request(PAST, {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${tokens.buildSessionCookie(CLIENT_ID).value}` },
      });
      expect(year.status).toBe(401);
      const ok = await app.request(PAST, { headers: { cookie: cookieFor(CLIENT_ID) } });
      expect(ok.status).toBe(400);
    });

    it('keeps the year-long cookie for admins and members (only clients are capped)', async () => {
      const member = await app.request('/api/member/space/not-a-uuid', {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${tokens.buildSessionCookie(MEMBER_ID).value}` },
      });
      expect(member.status).toBe(400);
    });
  });
  describe('client device tokens (the phone app bearer)', () => {
    const PAST = '/api/client/shared/not-a-uuid';
    const DAY = 24 * 60 * 60;
    /** A bearer for `id` with its mobile_tokens row. Defaults: what the
     *  client code sign-in mints (30 days, the given epoch). */
    const bearerFor = (
      id: string,
      opts: {
        epoch?: number | null;
        ttlSeconds?: number;
        revoked?: boolean;
        rowUser?: string;
        rowExpiresAt?: Date;
        noRow?: boolean;
      } = {},
    ): Record<string, string> => {
      const jti = randomUUID();
      const t = tokens.buildMobileToken(
        id,
        jti,
        opts.ttlSeconds ?? CLIENT_SESSION_TTL_SECONDS,
        opts.epoch === null ? undefined : (opts.epoch ?? 0),
      );
      if (!opts.noRow) {
        bearers.rows.set(jti, {
          userId: opts.rowUser ?? id,
          revokedAt: opts.revoked ? new Date() : null,
          expiresAt: opts.rowExpiresAt ?? t.expiresAt,
        });
      }
      return { authorization: `Bearer ${t.value}` };
    };
    const statusWith = async (headers: Record<string, string>, path = PAST) =>
      (await app.request(path, { headers })).status;

    it('gets past the gate on client routes, bytes included (no ?at= needed)', async () => {
      const headers = bearerFor(CLIENT_ID);
      for (const path of PAST_THE_GATE) expect(await statusWith(headers, path), path).toBe(400);
    });

    it('is refused without the session epoch, or at any epoch but the current one', async () => {
      expect(await statusWith(bearerFor(CLIENT_ID, { epoch: null }))).toBe(401);
      expect(await statusWith(bearerFor(CLIENT_ID, { epoch: 1 }))).toBe(401);
      for (const epoch of [0, 1, 3]) {
        expect(await statusWith(bearerFor(BUMPED_CLIENT_ID, { epoch })), `epoch ${epoch}`).toBe(
          401,
        );
      }
      expect(await statusWith(bearerFor(BUMPED_CLIENT_ID, { epoch: 2 }))).toBe(400);
    });

    it('is refused when it claims to last longer than 30 days', async () => {
      expect(await statusWith(bearerFor(CLIENT_ID, { ttlSeconds: 31 * DAY }))).toBe(401);
      expect(await statusWith(bearerFor(CLIENT_ID, { ttlSeconds: 365 * DAY }))).toBe(401);
      // The signed token says 30 days but its row says a year: refused too.
      const longRow = new Date(Date.now() + 365 * DAY * 1000);
      expect(await statusWith(bearerFor(CLIENT_ID, { rowExpiresAt: longRow }))).toBe(401);
    });

    it("is refused when its row is revoked, expired, missing or another login's", async () => {
      expect(await statusWith(bearerFor(CLIENT_ID, { revoked: true }))).toBe(401);
      expect(
        await statusWith(bearerFor(CLIENT_ID, { rowExpiresAt: new Date(Date.now() - 1000) })),
      ).toBe(401);
      expect(await statusWith(bearerFor(CLIENT_ID, { noRow: true }))).toBe(401);
      expect(await statusWith(bearerFor(CLIENT_ID, { rowUser: MEMBER_ID }))).toBe(401);
      expect(await statusWith(bearerFor(DISABLED_CLIENT_ID))).toBe(401);
    });

    it('reaches no admin route and no member route', async () => {
      const headers = bearerFor(CLIENT_ID);
      for (const path of ['/api/shell', '/api/member/shell', '/api/push/subscriptions']) {
        const res = await app.request(path, { headers });
        const body = (await res.json().catch(() => null)) as { reason?: string } | null;
        expect(res.status, path).toBe(403);
        expect(body?.reason, path).toBe('client-login');
      }
      // Member and admin bytes: a plain 401 (no session of that role).
      for (const path of ['/api/member/files/not-a-uuid', '/api/files/files/not-a-uuid?raw=1']) {
        expect(await statusWith(headers, path), path).toBe(401);
      }
    });

    it('refuses an ADMIN bearer and a MEMBER bearer on every client route', async () => {
      for (const [id, reason] of [
        [ADMIN_ID, 'admin-login'],
        [MEMBER_ID, 'member-login'],
      ] as const) {
        // A password login's bearer: no epoch, as device-login mints it.
        const headers = bearerFor(id, { epoch: null });
        for (const route of CLIENT_ROUTES) {
          const [method, pattern] = route.split(' ') as [string, string];
          const res = await app.request(concretePath(pattern), { method, headers });
          const body = (await res.json().catch(() => null)) as { reason?: string } | null;
          const refused = (res.status === 403 && body?.reason === reason) || res.status === 401;
          expect(refused, `${route} as ${reason} → ${res.status}`).toBe(true);
        }
      }
    });

    it('the push enrol step needs the bearer; a cookie session is told so', async () => {
      const body = JSON.stringify({ routingToken: 'r', publicKey: 'k', platform: 'ios' });
      const res = await app.request('/api/client/push/subscriptions', {
        method: 'POST',
        headers: { cookie: cookieFor(CLIENT_ID), 'content-type': 'application/json' },
        body,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bearer_required' });
      // A cookie of one login with another login's bearer in the header: the
      // bearer is not this login's, so it enrols nothing.
      const mixed = await app.request('/api/client/push/subscriptions', {
        method: 'POST',
        headers: {
          cookie: cookieFor(CLIENT_ID),
          ...bearerFor(BUMPED_CLIENT_ID, { epoch: 2 }),
          'content-type': 'application/json',
        },
        body,
      });
      expect(mixed.status).toBe(400);
      expect(await mixed.json()).toEqual({ error: 'bearer_required' });
    });
  });
});
