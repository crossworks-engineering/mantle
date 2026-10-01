/**
 * The admin private-space routes (member logins Phase 7) through the real
 * app: exactly the routes the plan names exist (no share, submit, recall or
 * comments for an admin's items), each refuses a request with no credential
 * (401) and a MEMBER login (403 `member-login`, the admin gate), and an
 * admin gets past the gate to their OWN space: the acting login's, never the
 * anchor's. The bytes route takes the owner `?at=` token, whose `act` claim
 * names the login.
 *
 * No database: the login rows, the anchor and the personal spaces come from
 * a stand-in (lib/auth/login-row is mocked). Malformed ids make each handler
 * answer its own 400 before any content read.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const ANCHOR_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_ID = '55555555-5555-4555-8555-555555555555';
const DISABLED_ADMIN_ID = '44444444-4444-4444-8444-444444444444';

const h = vi.hoisted(() => ({ spaceLookups: [] as string[] }));

vi.mock('../lib/auth/login-row', () => {
  const row = (id: string, role: 'admin' | 'member', disabled = false) => ({
    id,
    email: `${id.slice(0, 4)}@example.invalid`,
    isOwner: id === '33333333-3333-4333-8333-333333333333',
    displayName: null,
    role,
    contactId: null,
    disabledAt: disabled ? new Date('2026-09-01T00:00:00Z') : null,
    sessionEpoch: 0,
  });
  return {
    loadLoginRow: async (id: string) =>
      id === '22222222-2222-4222-8222-222222222222'
        ? row(id, 'member')
        : id === '55555555-5555-4555-8555-555555555555' ||
            id === '33333333-3333-4333-8333-333333333333'
          ? row(id, 'admin')
          : id === '44444444-4444-4444-8444-444444444444'
            ? row(id, 'admin', true)
            : null,
    loadAnchorId: async () => '33333333-3333-4333-8333-333333333333',
    loadPersonalSpaceId: async (loginId: string) => {
      h.spaceLookups.push(loginId);
      return `${loginId.slice(0, 8)}-0000-4000-8000-000000000000`;
    },
  };
});

import { SESSION_COOKIE_NAME } from '../lib/auth-constants';

const here = dirname(fileURLToPath(import.meta.url));
const hasManifest = existsSync(join(here, 'route-manifest.gen.ts'));
// vitest.global-setup.ts generates the manifest; in CI a missing one is a
// failure, never a silent skip of a security sweep.
if (!hasManifest && process.env.CI) {
  throw new Error('server/web/server/route-manifest.gen.ts is missing: the sweep cannot run');
}

/** Every admin private-space route, method by method. */
const ADMIN_SPACE_ROUTES = [
  'GET /api/admin/space',
  'POST /api/admin/space',
  'GET /api/admin/space/:id',
  'PATCH /api/admin/space/:id',
  'DELETE /api/admin/space/:id',
  'PUT /api/admin/space/:id/draft',
  'POST /api/admin/space/:id/save',
  'POST /api/admin/space/:id/accept',
  'POST /api/admin/space/:id/give-back',
  'GET /api/admin/space/:id/bytes',
  'POST /api/admin/space-files',
];

const concrete = (pattern: string) =>
  pattern.replace(/:[A-Za-z0-9_]+/g, '11111111-1111-4111-8111-111111111111');

describe.skipIf(!hasManifest)('admin private-space routes', () => {
  const saved = {
    secret: process.env.SESSION_SECRET,
    cors: process.env.MANTLE_API_CORS_ORIGINS,
    detached: process.env.MANTLE_DETACHED_DEV,
  };
  let app: import('hono').Hono;
  let manifest: Array<{ pattern: string; methods: string[] }>;
  let cookieFor: (id: string) => string;

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'admin-space-sweep-secret-at-least-32-chars';
    delete process.env.MANTLE_API_CORS_ORIGINS;
    delete process.env.MANTLE_DETACHED_DEV;
    const { buildSessionCookie } = await import('../lib/auth/tokens');
    cookieFor = (id) => `${SESSION_COOKIE_NAME}=${buildSessionCookie(id).value}`;
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

  beforeEach(() => {
    h.spaceLookups.length = 0;
  });

  it('routes exactly these under /api/admin: no share, submit, recall or comments', () => {
    const routed = manifest
      .filter((e) => e.pattern.startsWith('/api/admin/') || e.pattern === '/api/admin')
      .flatMap((e) => e.methods.filter((m) => m !== 'OPTIONS').map((m) => `${m} ${e.pattern}`))
      .sort();
    expect(routed).toEqual([...ADMIN_SPACE_ROUTES].sort());
  });

  it('refuses a request with no credential (401) and a member login (403)', async () => {
    const member = cookieFor(MEMBER_ID);
    for (const route of ADMIN_SPACE_ROUTES) {
      const [method, pattern] = route.split(' ') as [string, string];
      const anon = await app.request(concrete(pattern), { method });
      expect(anon.status, `${route} anonymous`).toBe(401);
      const res = await app.request(concrete(pattern), {
        method,
        headers: { cookie: member, 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : '{}',
      });
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        reason?: string;
      } | null;
      // The bytes route reads the owner asset gate: no admin session and no
      // token is a plain 401 for a member.
      const refused =
        route === 'GET /api/admin/space/:id/bytes'
          ? res.status === 401 && body?.error === 'unauthorized'
          : res.status === 403 && body?.reason === 'member-login';
      expect(refused, `${route} member -> ${res.status}`).toBe(true);
    }
    // Only the member's own session resolution read a space: no admin
    // space was opened for them.
    expect(h.spaceLookups.filter((id) => id !== MEMBER_ID)).toEqual([]);
  });

  it('refuses a disabled admin login', async () => {
    const res = await app.request('/api/admin/space', {
      headers: { cookie: cookieFor(DISABLED_ADMIN_ID) },
    });
    expect(res.status).toBe(401);
  });

  it('lets an admin through to their OWN space (the acting login, not the anchor)', async () => {
    const cookie = cookieFor(ADMIN_ID);
    for (const path of [
      '/api/admin/space/not-a-uuid',
      '/api/admin/space/not-a-uuid/bytes',
      '/api/admin/space?kind=nope',
    ]) {
      h.spaceLookups.length = 0;
      const res = await app.request(path, { headers: { cookie } });
      expect(res.status, path).toBe(400);
      expect(h.spaceLookups, path).toEqual([ADMIN_ID]);
    }
  });

  // Audit F07: Take over lands in the ACTING admin's own space.
  it("take-over: admin only, into the acting login's own space", async () => {
    const path = '/api/team-admin/submissions/not-a-uuid/take-over';
    expect((await app.request(path, { method: 'POST' })).status).toBe(401);
    const asMember = await app.request(path, {
      method: 'POST',
      headers: { cookie: cookieFor(MEMBER_ID) },
    });
    expect(asMember.status).toBe(403);
    expect(((await asMember.json()) as { reason?: string }).reason).toBe('member-login');
    h.spaceLookups.length = 0;
    const asAdmin = await app.request(path, {
      method: 'POST',
      headers: { cookie: cookieFor(ADMIN_ID) },
    });
    // A malformed id is a 404 before any content read, after the space.
    expect(asAdmin.status).toBe(404);
    expect(h.spaceLookups).toEqual([ADMIN_ID]);
  });

  it('bytes: an owner ?at= token acts for the login named in `act`', async () => {
    const { buildAssetToken } = await import('../lib/auth/tokens');
    const at = (uid: string, act?: string) =>
      app.request(
        `/api/admin/space/not-a-uuid/bytes?at=${encodeURIComponent(buildAssetToken(uid, act))}`,
      );
    expect((await at(ANCHOR_ID, ADMIN_ID)).status).toBe(400);
    expect(h.spaceLookups).toEqual([ADMIN_ID]);
    h.spaceLookups.length = 0;
    // The anchor's own token (no `act`): the anchor's space.
    expect((await at(ANCHOR_ID)).status).toBe(400);
    expect(h.spaceLookups).toEqual([ANCHOR_ID]);
    h.spaceLookups.length = 0;
    // A member or a disabled admin named in `act`: refused before any space.
    expect((await at(ANCHOR_ID, MEMBER_ID)).status).toBe(401);
    expect((await at(ANCHOR_ID, DISABLED_ADMIN_ID)).status).toBe(401);
    expect(h.spaceLookups).toEqual([]);
  });

  it('bytes: an admin ?at= token dies with a session epoch bump (F06)', async () => {
    const { buildAssetToken } = await import('../lib/auth/tokens');
    const at = (uid: string, act: string | undefined, epoch: number) =>
      app.request(
        `/api/admin/space/not-a-uuid/bytes?at=${encodeURIComponent(buildAssetToken(uid, act, epoch))}`,
      );
    // The stand-in rows are at epoch 0: a token from another epoch is stale,
    // for the anchor's own token (no `act`) and for another admin's.
    expect((await at(ANCHOR_ID, ADMIN_ID, 1)).status).toBe(401);
    expect((await at(ANCHOR_ID, undefined, 1)).status).toBe(401);
    expect(h.spaceLookups).toEqual([]);
    expect((await at(ANCHOR_ID, ADMIN_ID, 0)).status).toBe(400);
    expect((await at(ANCHOR_ID, undefined, 0)).status).toBe(400);
  });
});
