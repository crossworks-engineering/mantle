/**
 * Role sweep (client logins, Phase C0: three roles, fail closed). Drives
 * EVERY manifest route, every method, member routes included, with a signed
 * session cookie for:
 *
 *  - a CLIENT login: no route serves a client yet, so each refuses it (403
 *    with reason client-login from the admin and member gates, 401 from the
 *    admin-only session reads and the byte routes, or the /login redirect
 *    for pages). Before C0 every role that was not member resolved as an
 *    ADMIN, so this is the test that would have caught it.
 *  - a login whose role this code does not know: it is no login at all, so
 *    every route answers as to a stranger (401, or the /login redirect).
 *
 * No database: the login row and the anchor come from a stand-in
 * (lib/auth/login-row is mocked), as in the member sweep. A handler that
 * touches the database BEFORE its gate would fail here with a 500.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const CLIENT_ID = '12121212-1212-4212-8212-121212121212';
const UNKNOWN_ID = '13131313-1313-4313-8313-131313131313';
const ANCHOR_ID = '33333333-3333-4333-8333-333333333333';
const SPACE_ID = '66666666-6666-4666-8666-666666666666';

const row = (id: string, role: string) => ({
  id,
  email: `${role}@example.invalid`,
  isOwner: false,
  displayName: null,
  role,
  contactId: null,
  disabledAt: null,
  sessionEpoch: 0,
});

vi.mock('../lib/auth/login-row', () => ({
  loadLoginRow: async (id: string) =>
    id === CLIENT_ID ? row(CLIENT_ID, 'client') : id === UNKNOWN_ID ? row(UNKNOWN_ID, 'auditor') : null,
  loadAnchorId: async () => ANCHOR_ID,
  loadPersonalSpaceId: async () => SPACE_ID,
}));

import { PUBLIC_PATHS, SESSION_COOKIE_NAME } from '../lib/auth-constants';

const here = dirname(fileURLToPath(import.meta.url));
const hasManifest = existsSync(join(here, 'route-manifest.gen.ts'));
if (!hasManifest && process.env.CI) {
  throw new Error('server/web/server/route-manifest.gen.ts is missing: the sweep cannot run');
}

const IMAGE_EXT_RE = /\.(?:svg|png|jpg|jpeg|gif|webp)$/;

/** Routes that authenticate with their own short-lived ticket, minted only
 *  by an admin- or member-gated route; a plain-text 401 without it. */
const TICKET_GATED = new Set(['GET /api/apps/:id/frame', 'GET /api/member/apps/:id/frame']);

/** Routes about the login itself, which answer every signed-in login. Sign
 *  out is for every role (it only ends the caller's own sessions). */
const ANY_LOGIN = new Set(['POST /api/auth/logout']);

/** The MCP consent page answers an HTML refusal (403) to a signed-in login
 *  that is not an admin, and a stranger its sign-in redirect. */
const HTML_CONSENT = new Set(['GET /api/oauth/authorize', 'POST /api/oauth/authorize']);

function isPublic(path: string): boolean {
  return PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + '/'));
}

function concretePath(pattern: string): string {
  return pattern
    .replace(/:[A-Za-z0-9_]+\??/g, '11111111-1111-4111-8111-111111111111')
    .replace(/\*$/, 'a/b');
}

describe.skipIf(!hasManifest)('role sweep: only admin and member logins are served', () => {
  const saved = {
    secret: process.env.SESSION_SECRET,
    cors: process.env.MANTLE_API_CORS_ORIGINS,
    detached: process.env.MANTLE_DETACHED_DEV,
  };
  let app: import('hono').Hono;
  let manifest: Array<{ pattern: string; methods: string[] }>;
  let cookieFor: (id: string) => string;

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'role-sweep-secret-that-is-at-least-32-chars!';
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

  /** Drive every route with `cookie`; collect those whose answer `refused`
   *  does not accept. */
  async function sweep(
    cookie: string,
    refused: (a: { key: string; status: number; body: { error?: string; reason?: string } | null }) => boolean,
  ): Promise<{ checked: number; failures: string[] }> {
    const failures: string[] = [];
    let checked = 0;
    for (const entry of manifest) {
      const path = concretePath(entry.pattern);
      if (isPublic(path) || IMAGE_EXT_RE.test(path)) continue;
      const isApi = path === '/api' || path.startsWith('/api/');
      for (const method of entry.methods) {
        if (method === 'OPTIONS') continue;
        const key = `${method} ${entry.pattern}`;
        checked += 1;
        const res = await app.request(path, {
          method,
          headers: { cookie, 'content-type': 'application/json' },
          body: method === 'GET' || method === 'HEAD' ? undefined : '{}',
        });
        if (isApi) {
          const body = HTML_CONSENT.has(key)
            ? null
            : ((await res.json().catch(() => null)) as { error?: string; reason?: string } | null);
          if (!refused({ key, status: res.status, body })) {
            failures.push(`${key} → ${res.status} ${body?.reason ?? body?.error ?? ''}`);
          }
        } else {
          const to = res.headers.get('location') ?? '';
          if (res.status !== 307 || !to.startsWith('/login')) {
            failures.push(`${key} → ${res.status} ${to}`);
          }
        }
      }
    }
    return { checked, failures };
  }

  it('refuses a CLIENT login on every route, member routes included', async () => {
    const { checked, failures } = await sweep(cookieFor(CLIENT_ID), ({ key, status, body }) => {
      if (ANY_LOGIN.has(key)) return status === 200;
      if (HTML_CONSENT.has(key)) return status === 403 || status === 404;
      return (
        (status === 403 && body?.reason === 'client-login') ||
        (status === 401 && body?.error === 'unauthorized') ||
        (status === 401 && TICKET_GATED.has(key))
      );
    });
    expect(checked).toBeGreaterThan(300);
    expect(failures).toEqual([]);
  }, 300_000);

  it('treats a login with an UNKNOWN role as no login at all', async () => {
    const { checked, failures } = await sweep(cookieFor(UNKNOWN_ID), ({ key, status, body }) => {
      if (ANY_LOGIN.has(key)) return status === 200;
      // A stranger on the consent page: sent to sign in, or the feature is off.
      if (HTML_CONSENT.has(key)) return [302, 307, 401, 404].includes(status);
      return (
        (status === 401 && body?.error === 'unauthorized') ||
        (status === 401 && TICKET_GATED.has(key)) ||
        // Routes about the login itself answer a stranger their own 401.
        (status === 401 && typeof body?.error === 'string')
      );
    });
    expect(checked).toBeGreaterThan(300);
    expect(failures).toEqual([]);
  }, 300_000);

  it('never answers a client with an admin or member answer on the gates', async () => {
    const cookie = cookieFor(CLIENT_ID);
    // An admin read and a member read, each past its gate for its own role.
    for (const path of ['/api/shell', '/api/member/shell', '/api/member/space/not-a-uuid']) {
      const res = await app.request(path, { headers: { cookie } });
      const body = (await res.json().catch(() => null)) as { reason?: string } | null;
      expect(res.status, path).toBe(403);
      expect(body?.reason, path).toBe('client-login');
    }
  });

  describe('asset tokens (?at=) minted for a client login', () => {
    it('open no admin bytes and no member bytes', async () => {
      const { buildAssetToken } = await import('../lib/auth/tokens');
      const at = encodeURIComponent(buildAssetToken(ANCHOR_ID, CLIENT_ID));
      for (const path of ['/api/files/not-a-uuid', '/api/member/files/not-a-uuid']) {
        const res = await app.request(`${path}?at=${at}`);
        expect(res.status, path).toBe(401);
      }
    });
  });
});
