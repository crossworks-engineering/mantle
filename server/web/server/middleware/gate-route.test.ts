/**
 * The gate middleware's routed requests (arch A4 step 1 fix round 1, M1 and
 * L7), driven through the real middleware and route loader with real
 * manifest patterns (their real ROUTE_POLICY rows) and stub handlers:
 *
 *  - a cookie, a mobile bearer, an API key and an asset token each run the
 *    handler with its row on the request, the caller's `via`, and the
 *    request slot open;
 *  - a call nested inside the request with a caller of its own (enterCall
 *    with a job ref, as an MCP tool or a turn will in A5) still reads the
 *    request's row, and the session guard serves it by that row;
 *  - a request slot with no row is refused ('unclassified'), never taken
 *    for outside a request; outside a slot nothing changes.
 *
 * No database: the key checks are stubbed past the key itself (the key's
 * scope is judged for real, on the row), and the session guard resolves
 * the detached-dev login (MANTLE_DETACHED_DEV), which needs no lookup.
 */
import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  currentCaller,
  currentRequestOutcome,
  enterCall,
  hasRequestSlot,
  runInRequestSlot,
  systemActor,
} from '@mantle/db';
import { currentRoute } from '../../lib/auth/route-policy';
import { runWithRequestContext } from '../request-context';
import type { RouteEntry } from '../route-loader';

/** What getOwnerOr401 answered before it went (A4 exit): the owner guard's
 *  user, or its refusal. */
async function ownerGuard(): Promise<import('../../lib/auth/session').SessionUser | Response> {
  const { getOwnerOr401WithLogin } = await import('../../lib/auth/session');
  const got = await getOwnerOr401WithLogin();
  return got instanceof Response ? got : got.user;
}

const GRANT = vi.hoisted(() => ({
  id: 'key-1',
  prefix: 'mtlk_test',
  name: 'test key',
  loginId: '22222222-2222-4222-8222-222222222222',
  role: 'admin',
  access: 'read',
  areas: ['pages'],
}));

// Past the key itself (its hash, revoke and expiry: a database lookup) and
// its budgets, every key check is the real one.
vi.mock('../../lib/access-keys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/access-keys')>()),
  failedKeyBudget: () => ({ ok: true }),
  countFailedKey: () => undefined,
  verifyAccessKey: async () => ({ ok: true, grant: GRANT }),
  rateLimitAccessKey: () => ({ ok: true }),
  rateLimitKeySearch: () => ({ ok: true }),
  touchAccessKey: () => undefined,
  auditKeyRefusal: () => undefined,
}));

const here = dirname(fileURLToPath(import.meta.url));
const hasManifest = existsSync(join(here, '../route-manifest.gen.ts'));

const SECRET = 'g'.repeat(48);
const OWNER = '11111111-1111-4111-8111-111111111111';

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A token in the app's signed format: b64url(payload).b64url(hmac). */
function mint(payload: Record<string, unknown>): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(createHmac('sha256', SECRET).update(body).digest());
  return `${body}.${sig}`;
}

const exp = () => Math.floor(Date.now() / 1000) + 3600;

/** What a handler runs in. */
function seen() {
  const outcome = currentRequestOutcome();
  return {
    route: currentRoute()?.key ?? null,
    via: currentCaller()?.via ?? null,
    slot: hasRequestSlot(),
    outcome: outcome?.kind === 'system' ? outcome.why : (outcome?.kind ?? null),
  };
}

describe.skipIf(!hasManifest)('the gate middleware runs a routed request with its row', () => {
  const saved = { ...process.env };
  let app: Hono;

  beforeAll(async () => {
    process.env.SESSION_SECRET = SECRET;
    delete process.env.MANTLE_API_CORS_ORIGINS;
    // The detached-dev login: an Admin user the guard resolves with no
    // database (lib/auth/session.ts detachedDevUser).
    process.env.MANTLE_DETACHED_DEV = '1';
    process.env.MANTLE_API_TOKEN = `${b64url(Buffer.from(JSON.stringify({ uid: OWNER })))}.x`;
    const { gate } = await import('./gate');
    const { registerRoutes } = await import('../route-loader');
    const getOwnerOr401 = ownerGuard;
    const report = async () => Response.json(seen());
    // A call nested inside the request with a caller of its own, then the
    // session guard inside it.
    const nested = async () => {
      const out = await enterCall(
        { actor: systemActor('test:nested'), via: 'process', admin: null },
        { kind: 'job', name: 'test:nested' },
        async () => {
          const inner = seen();
          const owner = await getOwnerOr401();
          return {
            ...inner,
            guard: owner instanceof Response ? owner.status : 'ok',
            outcomeAfterGuard: seen().outcome,
          };
        },
      );
      return Response.json(out.ok ? out.value : { refused: out.refusal.http });
    };
    const routes: RouteEntry[] = [
      // Real manifest patterns: registerRoutes builds their real rows.
      { pattern: '/api/notes', methods: ['GET'], load: async () => ({ GET: report }) },
      { pattern: '/api/v1/pages', methods: ['GET'], load: async () => ({ GET: report }) },
      { pattern: '/api/v1/notes', methods: ['GET'], load: async () => ({ GET: report }) },
      { pattern: '/api/v1/search', methods: ['GET'], load: async () => ({ GET: report }) },
      {
        pattern: '/api/v1/pages/:id',
        methods: ['GET', 'PATCH'],
        load: async () => ({ GET: report, PATCH: report }),
      },
      { pattern: '/api/files/files/:id', methods: ['GET'], load: async () => ({ GET: report }) },
      { pattern: '/api/changelog', methods: ['GET'], load: async () => ({ GET: nested }) },
    ].map((r) => ({ catchAll: null, catchAllOptional: false, ...r }));
    app = new Hono();
    app.use('*', gate());
    registerRoutes(app, routes, { standIn: true });
  });

  afterAll(() => {
    process.env = saved;
  });

  const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

  it('a cookie: the row, via cookie, the request slot open', async () => {
    const res = await app.request('/api/notes', {
      headers: { cookie: `mantle_session=${mint({ uid: OWNER, exp: exp() })}` },
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ route: 'GET /api/notes', via: 'cookie', slot: true });
  });

  it('a mobile bearer: the row, via bearer, the request slot open', async () => {
    const res = await app.request('/api/notes', {
      headers: { authorization: `Bearer ${mint({ uid: OWNER, k: 'm', exp: exp() })}` },
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ route: 'GET /api/notes', via: 'bearer', slot: true });
  });

  it('an API key: judged on the row (in its areas, out of them), via key', async () => {
    const auth = { authorization: 'Bearer mtlk_test_secret' };
    const res = await app.request('/api/v1/pages', { headers: auth });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ route: 'GET /api/v1/pages', via: 'key', slot: true });
    // The same key on a row outside its areas: the gate's 403, before any
    // handler; on a path the key table does not list: not in the API.
    const notes = await app.request('/api/v1/notes', { headers: auth });
    expect(notes.status).toBe(403);
    expect(await json(notes)).toMatchObject({ reason: 'key-area' });
    const none = await app.request('/api/v1/settings', { headers: auth });
    expect(none.status).toBe(404);
    // Off /api/v1 a key is no credential.
    expect((await app.request('/api/notes', { headers: auth })).status).toBe(401);
  });

  it("an API key on an encoded v1 spelling: main's answer, judged on the raw path (fix round 2)", async () => {
    // Hono decodes the path before routing, so each of these finds a row;
    // a key is judged where the raw path names the same v1 route, as before
    // A4 (matchApiV1Route on the raw path).
    const auth = { authorization: 'Bearer mtlk_test_secret' };
    // An encoded segment in the route's name: not in the API, the 404 and
    // its body, whether the key's areas hold the route (pages) or not
    // (search), never the handler or a 403.
    for (const path of ['/api/v1/pag%65s', '/api/v1/%73earch', '/api/v1/%70ages/x']) {
      const res = await app.request(path, { headers: auth });
      expect(res.status, path).toBe(404);
      expect(await json(res), path).toEqual({ error: 'not found' });
    }
    // An encoded UUID in the id segment: the raw path names the route, so
    // the key is judged on it as before. A read key in the pages area
    // reads; it does not write (key-read-only).
    const id = `%31${OWNER.slice(1)}`;
    const read = await app.request(`/api/v1/pages/${id}`, { headers: auth });
    expect(read.status).toBe(200);
    expect(await json(read)).toMatchObject({ route: 'GET /api/v1/pages/:id', via: 'key' });
    const write = await app.request(`/api/v1/pages/${id}`, { method: 'PATCH', headers: auth });
    expect(write.status).toBe(403);
    expect(await json(write)).toMatchObject({ error: 'forbidden', reason: 'key-read-only' });
  });

  it('an API key on a trailing slash: no row answers it, so not in the API', async () => {
    // The one spelling the key table reads (matchApiV1Route takes `/?$`)
    // and the spelling test does not: the router is strict, so no row
    // answers it and requestKeyRoute never meets it (route-policy.test.ts).
    const auth = { authorization: 'Bearer mtlk_test_secret' };
    for (const path of ['/api/v1/pages/', `/api/v1/pages/${OWNER}/`]) {
      const res = await app.request(path, { headers: auth });
      expect(res.status, path).toBe(404);
      expect(await json(res), path).toEqual({ error: 'not found' });
    }
  });

  it('outside a routed request the login lookup holds a key to the raw path too (keyOnRow)', async () => {
    const getOwnerOr401 = ownerGuard;
    const { buildRouteRow } = await import('../../lib/auth/route-policy');
    const path = '/api/v1/pag%65s';
    const req = new Request(`http://x${path}`, {
      headers: { authorization: 'Bearer mtlk_test_secret' },
    });
    const ctx = {
      req,
      path,
      method: 'GET',
      accessKey: GRANT as never,
      route: buildRouteRow('GET', '/api/v1/pages', () => false, { reads: 'owner' }),
    };
    // A key the gate let in on an encoded spelling (it does not) is no
    // login here: the 401. (Not the detached-dev login, which comes first.)
    delete process.env.MANTLE_DETACHED_DEV;
    const res = await runWithRequestContext(ctx, () => getOwnerOr401()).finally(() => {
      process.env.MANTLE_DETACHED_DEV = '1';
    });
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(401);
  });

  it('through the full pipeline (runRoute, A4 step 3a): a key on an encoded v1 spelling never reaches a guard', async () => {
    // The key is judged once, on the row (keyOnRow): the gate answers an
    // encoded spelling "not in the API", with the real app and its real
    // handlers behind it, so no guard is asked to let the key's login in.
    const { runRoute } = await import('../run-route');
    for (const path of ['/api/v1/pag%65s', '/api/v1/%73earch', '/api/v1/%70ages/x']) {
      const res = await runRoute({ key: 'mtlk_test_secret' }, 'GET', path);
      expect(res.status, path).toBe(404);
      expect(await json(res), path).toEqual({ error: 'not found' });
    }
  }, 60_000);

  it('an asset token: the row, via token, the request slot open', async () => {
    const at = mint({ uid: OWNER, k: 'a', exp: exp() });
    const res = await app.request(`/api/files/files/f1?at=${at}`);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      route: 'GET /api/files/files/:id',
      via: 'token',
      slot: true,
    });
  });

  it('a call nested inside the request still reads its row; the guard serves it by the row', async () => {
    const res = await app.request('/api/changelog', {
      headers: { cookie: `mantle_session=${mint({ uid: OWNER, exp: exp() })}` },
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      // The nested caller is the job's, the row the request's.
      route: 'GET /api/changelog',
      via: 'process',
      slot: true,
      outcome: null,
      guard: 'ok',
      // A 'self' row: the Admin login's own things, on the system pool. A
      // guard that lost the row would have taken "outside a request" and
      // noted nothing.
      outcomeAfterGuard: 'login-self',
    });
  });

  it('a request slot with no row is refused; outside a slot nothing changes', async () => {
    const getOwnerOr401 = ownerGuard;
    const { getLoginOr401 } = await import('../../lib/auth/session');
    const req = new Request('http://x/api/changelog');
    const ctx = { req, path: '/api/changelog', method: 'GET' };
    const inSlot = await runWithRequestContext(ctx, () =>
      runInRequestSlot(async () => ({
        owner: await getOwnerOr401(),
        login: await getLoginOr401(),
      })),
    );
    for (const res of [inSlot.owner, inSlot.login]) {
      expect(res).toBeInstanceOf(Response);
      const r = res as Response;
      expect(r.status).toBe(403);
      expect(await r.json()).toMatchObject({ reason: 'unclassified-route' });
    }
    const outside = await runWithRequestContext(ctx, () => getOwnerOr401());
    expect(outside).not.toBeInstanceOf(Response);
    expect((outside as { id: string }).id).toBe(OWNER);
  });
});
