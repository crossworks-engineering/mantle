/**
 * Role sweep (client logins, Phase C0: three roles, fail closed). Drives
 * EVERY manifest route, every method, member routes included, with a signed
 * session cookie for:
 *
 *  - a CLIENT login: every route outside CLIENT_ROUTES refuses it (403
 *    with reason client-login from the admin and member gates, 401 from the
 *    admin-only session reads and the byte routes, or the /login redirect
 *    for pages). Before C0 every role that was not member resolved as an
 *    ADMIN, so this is the test that would have caught it. The client
 *    routes themselves (C2) answer a client: server/client-sweep.test.ts.
 *    A client route answers the unknown role as a stranger here too.
 *  - a login whose role this code does not know: it is no login at all, so
 *    every route answers as to a stranger (401, or the /login redirect).
 *
 * The public routes (PUBLIC_PATHS: no gate in front) are skipped by the
 * sweep; the ones that read a session themselves (/api/auth, /api/oauth, and
 * the print and render pages) are driven one by one with an explicit answer
 * per role (server/public-session-routes.ts, audit A4), and a completeness
 * test fails when another public route starts reading the session.
 *
 * No database: the login row and the anchor come from a stand-in
 * (lib/auth/login-row is mocked), as in the member sweep. A handler that
 * touches the database BEFORE its gate would fail here with a 500.
 */
import { existsSync, readFileSync } from 'node:fs';
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
    id === CLIENT_ID
      ? row(CLIENT_ID, 'client')
      : id === UNKNOWN_ID
        ? row(UNKNOWN_ID, 'auditor')
        : null,
  loadAnchorId: async () => ANCHOR_ID,
  loadPersonalSpaceId: async () => SPACE_ID,
}));

// The MCP consent page checks that remote MCP is on and the client is
// registered before it reads the login: both stood in, so the page reaches
// its role refusals (the rest of lib/mcp-oauth is the real module).
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

// A client's plain sign-out ends its sessions (audit B23): the epoch bump is
// a database write, stood in here (proven on Postgres in
// lib/auth/client-session.db.test.ts).
vi.mock('../lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  endLoginSessions: async () => 1,
}));

// The share page's token lookup, stood in (no database): an unknown token,
// so /s/<token> answers its real not-found page (audit B24 probe below).
vi.mock('../lib/shares', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveActiveShareByToken: async () => null,
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isRetiredTeamLinkToken: async () => false,
  isRetiredClientLinkToken: async () => false,
}));

import { PUBLIC_PATHS, SESSION_COOKIE_NAME } from '../lib/auth-constants';
import { CLIENT_ROUTES, isClientRoute } from '../lib/auth/client-routes';
import {
  PUBLIC_SESSION_ROUTES,
  RENDER_PAGES,
  SESSION_READER_RE,
  drivePublic,
} from './public-session-routes';

const here = dirname(fileURLToPath(import.meta.url));
const hasManifest = existsSync(join(here, 'route-manifest.gen.ts'));
if (!hasManifest && process.env.CI) {
  throw new Error('server/web/server/route-manifest.gen.ts is missing: the sweep cannot run');
}

const IMAGE_EXT_RE = /\.(?:svg|png|jpg|jpeg|gif|webp)$/;

/** Routes that authenticate with their own short-lived ticket, minted only
 *  by an admin- or member-gated route; a plain-text 401 without it. */
const TICKET_GATED = new Set(['GET /api/apps/:id/frame', 'GET /api/member/apps/:id/frame']);

// Sign out (every role) and the MCP consent page (an HTML refusal) used to
// be allow-lists here, but both live under PUBLIC_PATHS, which the sweep
// skips: the lists were never consulted (audit A4). Their answers are now
// explicit per role in server/public-session-routes.ts, driven below.

function isPublic(path: string): boolean {
  return PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + '/'));
}

function concretePath(pattern: string): string {
  return pattern
    .replace(/:[A-Za-z0-9_]+\??/g, '11111111-1111-4111-8111-111111111111')
    .replace(/\*$/, 'a/b');
}

describe.skipIf(!hasManifest)('role sweep: three roles, fail closed', () => {
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
    // 30 days, as the client sign-in mints it: a longer client cookie is
    // refused outright (a 401 everywhere would hide the gates' answers).
    const ttlSeconds = 30 * 24 * 60 * 60;
    cookieFor = (id) => `${SESSION_COOKIE_NAME}=${buildSessionCookie(id, { ttlSeconds }).value}`;
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
   *  does not accept, and every key driven (so an allow-list the callback
   *  consults can be checked for keys the sweep never reaches). */
  async function sweep(
    cookie: string,
    refused: (a: {
      key: string;
      status: number;
      body: { error?: string; reason?: string } | null;
    }) => boolean,
  ): Promise<{ checked: number; failures: string[]; visited: Set<string> }> {
    const failures: string[] = [];
    const visited = new Set<string>();
    let checked = 0;
    for (const entry of manifest) {
      const path = concretePath(entry.pattern);
      if (isPublic(path) || IMAGE_EXT_RE.test(path)) continue;
      const isApi = path === '/api' || path.startsWith('/api/');
      for (const method of entry.methods) {
        if (method === 'OPTIONS') continue;
        const key = `${method} ${entry.pattern}`;
        checked += 1;
        visited.add(key);
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
    return { checked, failures, visited };
  }

  // Fast first (audit A4): the full sweeps take minutes, and a regression in
  // resolvedFor (an unknown role read as an admin) was once caught only by
  // their timeout. Each shell answers a login it cannot name with 401.
  it('answers an UNKNOWN role 401 on every shell (fast)', async () => {
    const cookie = cookieFor(UNKNOWN_ID);
    for (const path of ['/api/shell', '/api/member/shell', '/api/client/shell']) {
      const res = await app.request(path, { headers: { cookie } });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      expect(res.status, path).toBe(401);
      expect(body?.error, path).toBe('unauthorized');
    }
  });

  describe('public routes that read a session (audit A4)', () => {
    const table = [...PUBLIC_SESSION_ROUTES, ...RENDER_PAGES];

    it.each(['client', 'unknown'] as const)('each answers a %s cookie as listed', async (role) => {
      const cookie = cookieFor(role === 'client' ? CLIENT_ID : UNKNOWN_ID);
      const failures: string[] = [];
      for (const route of table) {
        const failure = await drivePublic(app, route, role, cookie);
        if (failure) failures.push(failure);
      }
      expect(failures).toEqual([]);
    });

    it('lists only public manifest routes, each once', () => {
      const known = new Set(
        manifest
          .filter((e) => isPublic(concretePath(e.pattern)))
          .flatMap((e) => e.methods.map((mt) => `${mt} ${e.pattern}`)),
      );
      const keys = PUBLIC_SESSION_ROUTES.map((r) => r.key);
      expect(keys.filter((k) => !known.has(k))).toEqual([]);
      expect(new Set(keys).size).toBe(keys.length);
    });

    // The scan below reads only the route files themselves; a session read
    // deeper in (an import) would slip past it. So the pages a client is
    // most likely to land on are also DRIVEN (audit B24): a client cookie
    // must buy nothing. The share page and /login are public: the client
    // gets exactly a stranger's answer. /n/<id> is behind the gate, which
    // checks only the cookie's signature, so any signed cookie reaches its
    // static "lives in the app" card: the client gets exactly what a cookie
    // of an unknown role (no login at all) gets, and none of it is data.
    it('the share page, /login and a node link answer a client cookie as they answer no login', async () => {
      const client = cookieFor(CLIENT_ID);
      const noLogin = cookieFor(UNKNOWN_ID);
      // Per-response noise only: CSP nonces.
      const norm = (t: string) => t.replace(/nonce="[^"]*"/g, 'nonce=""');
      const same = async (path: string, base: Record<string, string>) => {
        const a = await app.request(path, { headers: base });
        const b = await app.request(path, { headers: { cookie: client } });
        expect(b.status, path).toBe(a.status);
        expect(b.headers.get('location'), path).toBe(a.headers.get('location'));
        expect(b.headers.get('set-cookie'), path).toBe(a.headers.get('set-cookie'));
        expect(norm(await b.text()), path).toBe(norm(await a.text()));
        return a.status;
      };
      expect(await same('/s/not-a-real-share-token', {})).toBe(404);
      expect(await same('/s/x', {})).toBe(404);
      expect([200, 307]).toContain(await same('/login', {}));
      expect([200, 307]).toContain(await same('/n/x', { cookie: noLogin }));
      // And the stranger is still sent to sign in from the node link.
      const stranger = await app.request('/n/x');
      expect(stranger.status).toBe(307);
      expect(stranger.headers.get('location') ?? '').toContain('/login');
    });

    it('every other public route reads no session (else it belongs in the table)', () => {
      const listed = new Set(PUBLIC_SESSION_ROUTES.map((r) => r.key.split(' ')[1]));
      const readers: string[] = [];
      for (const entry of manifest) {
        if (!isPublic(concretePath(entry.pattern)) || listed.has(entry.pattern)) continue;
        // The manifest's generator maps app/<dirs>/route.ts to a pattern
        // with [param] as :param; map it back.
        const file = join(here, '..', 'app', entry.pattern.replace(/:(\w+)/g, '[$1]'), 'route.ts');
        expect(existsSync(file), `${entry.pattern}: ${file}`).toBe(true);
        const src = readFileSync(file, 'utf8');
        if (SESSION_READER_RE.test(src)) readers.push(entry.pattern);
      }
      expect(readers).toEqual([]);
    });
  });

  it('refuses a CLIENT login on every route but its own, member routes included', async () => {
    const { checked, failures, visited } = await sweep(
      cookieFor(CLIENT_ID),
      ({ key, status, body }) => {
        // The client routes answer a client (client-sweep.test.ts proves it).
        const [method, pattern] = key.split(' ') as [string, string];
        if (isClientRoute(method, pattern)) return true;
        return (
          (status === 403 && body?.reason === 'client-login') ||
          (status === 401 && body?.error === 'unauthorized') ||
          (status === 401 && TICKET_GATED.has(key))
        );
      },
    );
    expect(checked).toBeGreaterThan(300);
    expect(failures).toEqual([]);
    // Every allow-list the callback consults was reached (none is dead).
    expect([...TICKET_GATED, ...CLIENT_ROUTES].filter((k) => !visited.has(k))).toEqual([]);
  }, 300_000);

  it('treats a login with an UNKNOWN role as no login at all', async () => {
    const { checked, failures, visited } = await sweep(
      cookieFor(UNKNOWN_ID),
      ({ key, status, body }) =>
        (status === 401 && body?.error === 'unauthorized') ||
        (status === 401 && TICKET_GATED.has(key)) ||
        // Routes about the login itself answer a stranger their own 401.
        (status === 401 && typeof body?.error === 'string'),
    );
    expect(checked).toBeGreaterThan(300);
    expect(failures).toEqual([]);
    expect([...TICKET_GATED].filter((k) => !visited.has(k))).toEqual([]);
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
    // The REAL byte routes with a well-formed id (audit B8): the gate lets
    // the token through, so the route's own asset check answers. The
    // positive control (an admin-act token gets past it) is in
    // client-sweep.test.ts, which stands in an admin login.
    it('open no admin bytes and no member bytes', async () => {
      const { buildAssetToken } = await import('../lib/auth/tokens');
      const at = encodeURIComponent(buildAssetToken(ANCHOR_ID, CLIENT_ID));
      const ID = '11111111-1111-4111-8111-111111111111';
      for (const path of [
        `/api/files/files/${ID}?raw=1`,
        `/api/draws/${ID}/svg`,
        `/api/attachments/${ID}`,
        `/api/export/${ID}`,
        '/api/profile/photo',
        `/api/admin/space/${ID}/bytes`,
        `/api/member/files/${ID}`,
        `/api/member/draws/${ID}/svg`,
      ]) {
        const res = await app.request(`${path}${path.includes('?') ? '&' : '?'}at=${at}`);
        expect(res.status, path).toBe(401);
      }
    });
  });
});
