/**
 * The caller the pipeline answers (arch A4 step 3b), driven through the
 * real gate and route loader with real manifest patterns and stub
 * handlers. Each route is served twice, by two apps: one whose handler
 * reads the pipeline's answer (ownerCaller(), the row's `caller`), one
 * whose handler calls the guard (getOwnerOr401), as before. For every
 * credential both give the same answer: the status and body, the owner,
 * the actor the request runs as, what was done with its scope, the audit
 * row of a write, the device token's stamp. Only where it runs differs: a
 * refusal is the gate's, and the handler does not run.
 *
 * Self rows (batch 1 of the codemod), and a content read and an area row,
 * which the same step answers when their batches come.
 *
 * No database: the login rows come from a stand-in.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { actorSetting, currentActor, currentRequestOutcome } from '@mantle/db';
import type { RouteEntry } from '../route-loader';

const ADMIN = '55555555-5555-4555-8555-555555555555';
const ANCHOR = '33333333-3333-4333-8333-333333333333';
const MEMBER = '22222222-2222-4222-8222-222222222222';
/** An admin that holds no Admin area. */
const LIMITED = '44444444-4444-4444-8444-444444444444';

const counts = vi.hoisted(() => ({
  touches: 0,
  handled: 0,
  audits: [] as string[],
  /** An error the audit row throws (the owner answer failing). */
  auditThrows: null as Error | null,
  bearers: new Map<string, { userId: string; revokedAt: Date | null; expiresAt: Date }>(),
}));

vi.mock('../../lib/auth/login-row', () => {
  const row = (id: string, role: 'admin' | 'member', isOwner = false) => ({
    id,
    email: `${role}@example.invalid`,
    isOwner,
    displayName: null,
    role,
    contactId: null,
    disabledAt: null,
    sessionEpoch: 0,
  });
  return {
    loadLoginRow: async (id: string) =>
      id === ANCHOR
        ? row(ANCHOR, 'admin', true)
        : id === ADMIN || id === LIMITED
          ? row(id, 'admin')
          : id === MEMBER
            ? row(MEMBER, 'member')
            : null,
    loadAnchorId: async () => ANCHOR,
    loadPersonalSpaceId: async () => null,
    loadBearerToken: async (jti: string) => counts.bearers.get(jti) ?? null,
    touchBearerToken: async () => {
      counts.touches += 1;
    },
  };
});
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/db')>()),
  loginScopeFor: async (loginId: string) => ({ kind: 'user', loginId, ws: [], modWs: [] }),
  brainOnWorkspacesNow: async () => true,
}));
vi.mock('../../lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/workspaces')>()),
  requireArea: async (caller: { loginId: string }) => caller.loginId !== LIMITED,
}));
vi.mock('../../lib/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/audit')>()),
  auditFireAndForget: (e: { action: string; method?: string; path?: string; actorId: string }) => {
    if (counts.auditThrows) throw counts.auditThrows;
    counts.audits.push(`${e.action} ${e.method ?? ''} ${e.path ?? ''} ${e.actorId}`);
  },
}));

const here = dirname(fileURLToPath(import.meta.url));
const hasManifest = existsSync(join(here, '../route-manifest.gen.ts'));

/** What a handler sees once it has its owner. */
function seen(owner: unknown) {
  const actor = currentActor();
  const out = currentRequestOutcome();
  return {
    owner,
    actor: actor ? actorSetting(actor) : null,
    out: out ? JSON.stringify(out) : null,
  };
}

describe.skipIf(!hasManifest)('the caller the pipeline answers (A4 step 3b)', () => {
  const saved = { ...process.env };
  let pipeline: Hono;
  let guarded: Hono;
  let creds: Array<{ name: string; headers: () => Record<string, string> }>;

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'gate-caller-test-secret-at-least-32-characters';
    delete process.env.MANTLE_API_CORS_ORIGINS;
    delete process.env.MANTLE_DETACHED_DEV;
    const tokens = await import('../../lib/auth/tokens');
    const { SESSION_COOKIE_NAME } = await import('../../lib/auth-constants');
    const cookie = (id: string) => () => ({
      cookie: `${SESSION_COOKIE_NAME}=${tokens.buildSessionCookie(id).value}`,
    });
    let n = 0;
    const bearer = (id: string, revoked = false) => {
      n += 1;
      const jti = `0000000${n}-0000-4000-8000-00000000000${n}`;
      const t = tokens.buildMobileToken(id, jti, 3600, 0);
      counts.bearers.set(jti, {
        userId: id,
        revokedAt: revoked ? new Date() : null,
        expiresAt: t.expiresAt,
      });
      return () => ({ authorization: `Bearer ${t.value}` });
    };
    creds = [
      { name: 'owner-cookie', headers: cookie(ANCHOR) },
      { name: 'admin-cookie', headers: cookie(ADMIN) },
      { name: 'limited-cookie', headers: cookie(LIMITED) },
      { name: 'member-cookie', headers: cookie(MEMBER) },
      { name: 'gone-cookie', headers: cookie('99999999-9999-4999-8999-999999999999') },
      { name: 'admin-bearer', headers: bearer(ADMIN) },
      { name: 'member-bearer', headers: bearer(MEMBER) },
      { name: 'revoked-bearer', headers: bearer(ADMIN, true) },
    ];
    const { gate } = await import('./gate');
    const { registerRoutes } = await import('../route-loader');
    const session = await import('../../lib/auth/session');
    const reads = async () => {
      counts.handled += 1;
      return Response.json(seen(session.ownerCaller()));
    };
    const guards = async () => {
      counts.handled += 1;
      const owner = await session.getOwnerOr401();
      if (owner instanceof Response) return owner;
      return Response.json(seen(owner));
    };
    // Real manifest patterns, so registerRoutes builds their real rows.
    const entries = (handle: () => Promise<Response>, read: boolean): RouteEntry[] =>
      [
        // Self rows (batch 1): a read and a write.
        { pattern: '/api/profile', methods: ['GET', 'PUT'] },
        // A content read a member may make, and an area row (users).
        { pattern: '/api/notes', methods: ['GET'] },
        { pattern: '/api/users', methods: ['GET'] },
      ].map((e) => ({
        ...e,
        catchAll: null,
        catchAllOptional: false,
        ...(read ? { reads: e.methods } : {}),
        load: async () => Object.fromEntries(e.methods.map((m) => [m, handle])),
      }));
    // The app's error path (server/app.ts onError): busy is a 409, the
    // rest an opaque 500.
    const { BUSY_MESSAGE, isBusy } = await import('@mantle/db');
    const onError = (err: Error) =>
      isBusy(err)
        ? Response.json({ error: BUSY_MESSAGE }, { status: 409 })
        : Response.json({ error: 'internal error' }, { status: 500 });
    pipeline = new Hono();
    pipeline.use('*', gate());
    registerRoutes(pipeline, entries(reads, true));
    pipeline.onError(onError);
    guarded = new Hono();
    guarded.use('*', gate());
    registerRoutes(guarded, entries(guards, false));
    guarded.onError(onError);
  });

  afterAll(() => {
    process.env = saved;
  });

  beforeEach(() => {
    counts.touches = 0;
    counts.handled = 0;
    counts.audits.length = 0;
  });

  /** One request: its answer and what it did on the side. */
  async function drive(app: Hono, method: string, path: string, headers: Record<string, string>) {
    counts.touches = 0;
    counts.handled = 0;
    counts.audits.length = 0;
    const res = await app.request(path, { method, headers });
    return {
      status: res.status,
      type: res.headers.get('content-type'),
      cache: res.headers.get('cache-control'),
      body: await res.text(),
      touches: counts.touches,
      audits: [...counts.audits],
      handled: counts.handled,
    };
  }

  it('answers every credential as the guard does, on each row', async () => {
    const cells: Array<[string, string]> = [
      ['GET', '/api/profile'],
      ['HEAD', '/api/profile'],
      ['PUT', '/api/profile'],
      ['GET', '/api/notes'],
      ['GET', '/api/users'],
    ];
    let refused = 0;
    for (const [method, path] of cells) {
      for (const cred of creds) {
        const a = await drive(pipeline, method, path, cred.headers());
        const b = await drive(guarded, method, path, cred.headers());
        const label = `${method} ${path} ${cred.name}`;
        // Where it runs: the gate refuses before the handler; the guard
        // refused inside it.
        if (a.status >= 400) {
          refused += 1;
          expect(a.handled, label).toBe(0);
          expect(b.handled, label).toBe(1);
        } else {
          expect(a.handled, label).toBe(1);
        }
        expect({ ...a, handled: 0 }, label).toEqual({ ...b, handled: 0 });
      }
    }
    // Every kind of answer was met: refusals (401, 403) and owners.
    expect(refused).toBeGreaterThan(5);
  });

  it('the pipeline names the actor, notes the self row and writes the audit row', async () => {
    const res = await drive(pipeline, 'PUT', '/api/profile', creds[1]!.headers());
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      owner: { id: ANCHOR, actor: { id: ADMIN } },
      actor: 'system:http:login-self',
      out: JSON.stringify({ kind: 'system', why: 'login-self' }),
    });
    expect(res.audits).toEqual([`api.write PUT /api/profile ${ADMIN}`]);
  });

  it('a member on a self row is refused by the gate; the handler never runs', async () => {
    const res = await drive(pipeline, 'GET', '/api/profile', creds[3]!.headers());
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ reason: 'member-login' });
    expect(res.handled).toBe(0);
  });

  it('an error the owner answer throws keeps the CORS headers, as the guard did', async () => {
    process.env.MANTLE_API_CORS_ORIGINS = 'https://client.example';
    const busy = Object.assign(new Error('could not obtain lock'), { code: '55P03' });
    try {
      for (const error of [busy, new Error('database down')]) {
        counts.auditThrows = error;
        const headers = { ...creds[1]!.headers(), origin: 'https://client.example' };
        const answers = [];
        for (const app of [pipeline, guarded]) {
          const res = await app.request('/api/profile', { method: 'PUT', headers });
          answers.push({
            status: res.status,
            body: await res.text(),
            cors: [...res.headers.entries()].filter(([k]) => k.startsWith('access-control-')),
            vary: res.headers.get('vary'),
          });
        }
        const [a, b] = answers;
        expect(a, error.message).toEqual(b);
        expect(a!.status).toBe(error === busy ? 409 : 500);
        expect(a!.cors).toContainEqual(['access-control-allow-origin', 'https://client.example']);
      }
    } finally {
      counts.auditThrows = null;
      delete process.env.MANTLE_API_CORS_ORIGINS;
    }
  });

  it('a device token is stamped once, by the pipeline', async () => {
    const res = await drive(pipeline, 'GET', '/api/profile', creds[5]!.headers());
    expect(res.status).toBe(200);
    expect(res.touches).toBe(1);
  });

  it('ownerCaller() where the pipeline answered no owner throws: fail closed', async () => {
    const session = await import('../../lib/auth/session');
    expect(() => session.ownerCaller()).toThrow(/answered no owner/);
    // A row whose handler reads it, but the manifest does not say so: the
    // gate does not answer, and the read fails rather than run unchecked.
    const { gate } = await import('./gate');
    const { registerRoutes } = await import('../route-loader');
    const app = new Hono();
    app.use('*', gate());
    registerRoutes(app, [
      {
        pattern: '/api/profile',
        methods: ['GET'],
        catchAll: null,
        catchAllOptional: false,
        load: async () => ({ GET: async () => Response.json(session.ownerCaller()) }),
      },
    ]);
    app.onError(() => new Response('failed', { status: 500 }));
    const res = await app.request('/api/profile', { headers: creds[1]!.headers() });
    expect(res.status).toBe(500);
  });

  it('a row the owner guard does not serve cannot read the owner caller', async () => {
    const { buildRoutePolicy } = await import('../../lib/auth/route-policy');
    // An any-login route (its own guard), a member route, a public route.
    for (const pattern of ['/api/shell', '/api/member/mcp', '/api/auth/whoami']) {
      expect(() => buildRoutePolicy([{ pattern, methods: ['GET'], reads: ['GET'] }])).toThrow(
        /the owner guard does not serve its row/,
      );
    }
    // A catch-all route keeps its guard.
    expect(() =>
      buildRoutePolicy([{ pattern: '/api/docs/:collection/*', methods: ['GET'], reads: ['GET'] }]),
    ).toThrow(/is a catch-all/);
    // A HEAD row reads what its GET reads.
    const rows = buildRoutePolicy([{ pattern: '/api/profile', methods: ['GET'], reads: ['GET'] }]);
    expect(rows.get('GET /api/profile')?.caller).toBe('owner');
    expect(rows.get('HEAD /api/profile')?.caller).toBe('owner');
  });
});
