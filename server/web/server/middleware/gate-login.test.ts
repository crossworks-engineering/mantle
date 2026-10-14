/**
 * The gate resolves the login (arch A4 step 3a), driven through the real
 * middleware and route loader with real manifest patterns and stub
 * handlers:
 *
 *  - the caller a handler reads (currentCaller()) carries the login the
 *    request's credential resolved to: its id, role, actor and the logins
 *    the guards read, while the request still runs as system(http:no-login)
 *    until a guard reads the login (a route that reads none runs as it did);
 *  - the login is found ONCE per request, however many guards read it, and
 *    each read applies what a guard's own lookup applied before (the device
 *    token stamp, the actor named);
 *  - a public row's login is found on its first guard read, once;
 *  - a call nested in the request with a caller of its own resolves as
 *    before (outside the bound caller);
 *  - an Admin login on an area row: the gate resolves what it holds of the
 *    area, and the guard answers from it (requireArea is asked once);
 *  - a public row that writes binds its named actor (row.actor).
 *
 * No database: the login rows come from a stand-in that counts its reads.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { actorSetting, currentActor, currentCaller, enterCall, systemActor } from '@mantle/db';
import type { RouteEntry } from '../route-loader';

const ADMIN = '55555555-5555-4555-8555-555555555555';
const ANCHOR = '33333333-3333-4333-8333-333333333333';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const LIMITED = '44444444-4444-4444-8444-444444444444';

const counts = vi.hoisted(() => ({
  loginRows: 0,
  bearerRows: 0,
  touches: 0,
  areas: 0,
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
    loadLoginRow: async (id: string) => {
      counts.loginRows += 1;
      if (id === ANCHOR) return row(ANCHOR, 'admin', true);
      if (id === ADMIN || id === LIMITED) return row(id, 'admin');
      if (id === MEMBER) return row(MEMBER, 'member');
      return null;
    },
    loadAnchorId: async () => ANCHOR,
    loadPersonalSpaceId: async () => null,
    loadBearerToken: async (jti: string) => {
      counts.bearerRows += 1;
      return counts.bearers.get(jti) ?? null;
    },
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
  requireArea: async (caller: { loginId: string }) => {
    counts.areas += 1;
    return caller.loginId !== LIMITED;
  },
}));

const here = dirname(fileURLToPath(import.meta.url));
const hasManifest = existsSync(join(here, '../route-manifest.gen.ts'));

/** What a handler sees of its caller and actor. */
function seen() {
  const caller = currentCaller();
  const actor = currentActor();
  return {
    via: caller?.via ?? null,
    loginId: caller?.loginId ?? null,
    role: caller?.role ?? null,
    callerActor: caller ? actorSetting(caller.actor) : null,
    actor: actor ? actorSetting(actor) : null,
  };
}

describe.skipIf(!hasManifest)('the gate resolves the login once (A4 step 3a)', () => {
  const saved = { ...process.env };
  let app: Hono;
  let cookieFor: (id: string) => string;
  let bearerFor: (id: string) => string;

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'gate-login-test-secret-at-least-32-characters';
    delete process.env.MANTLE_API_CORS_ORIGINS;
    delete process.env.MANTLE_DETACHED_DEV;
    const tokens = await import('../../lib/auth/tokens');
    const { SESSION_COOKIE_NAME } = await import('../../lib/auth-constants');
    cookieFor = (id) => `${SESSION_COOKIE_NAME}=${tokens.buildSessionCookie(id).value}`;
    let n = 0;
    bearerFor = (id) => {
      n += 1;
      const jti = `0000000${n}-0000-4000-8000-00000000000${n}`;
      const t = tokens.buildMobileToken(id, jti, 3600, 0);
      counts.bearers.set(jti, { userId: id, revokedAt: null, expiresAt: t.expiresAt });
      return `Bearer ${t.value}`;
    };
    const { gate } = await import('./gate');
    const { registerRoutes } = await import('../route-loader');
    const session = await import('../../lib/auth/session');
    const unread = async () => Response.json(seen());
    const twice = async () => {
      const before = seen();
      const a = await session.getOwnerOr401();
      const b = await session.getLoginOr401();
      return Response.json({
        before,
        after: seen(),
        first: a instanceof Response ? a.status : a.actor.id,
        second: b instanceof Response ? b.status : b.loginId,
      });
    };
    const nested = async () => {
      const out = await enterCall(
        { actor: systemActor('test:nested'), via: 'process', admin: null },
        { kind: 'job', name: 'test:nested' },
        async () => {
          const owner = await session.getOwnerOr401();
          return owner instanceof Response ? owner.status : owner.actor.id;
        },
      );
      return Response.json(out.ok ? { nested: out.value } : { refused: out.refusal.http });
    };
    const area = async () => {
      const owner = await session.getOwnerOr401();
      return owner instanceof Response ? owner : Response.json({ ok: true, ...seen() });
    };
    const routes: RouteEntry[] = [
      // Real manifest patterns: registerRoutes builds their real rows.
      { pattern: '/api/notes', methods: ['GET'], load: async () => ({ GET: twice }) },
      { pattern: '/api/tasks', methods: ['GET'], load: async () => ({ GET: unread }) },
      { pattern: '/api/changelog', methods: ['GET'], load: async () => ({ GET: nested }) },
      // An area row (users).
      { pattern: '/api/users', methods: ['GET'], load: async () => ({ GET: area }) },
      // A public row that reads the session (sign out), and one that writes.
      { pattern: '/api/auth/whoami', methods: ['GET'], load: async () => ({ GET: twice }) },
      { pattern: '/api/auth/signup', methods: ['POST'], load: async () => ({ POST: unread }) },
    ].map((r) => ({ catchAll: null, catchAllOptional: false, ...r }));
    app = new Hono();
    app.use('*', gate());
    registerRoutes(app, routes);
  });

  afterAll(() => {
    process.env = saved;
  });

  beforeEach(() => {
    counts.loginRows = 0;
    counts.bearerRows = 0;
    counts.touches = 0;
    counts.areas = 0;
  });

  const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

  it('binds the login on the caller; the request runs as before until a guard reads it', async () => {
    const res = await app.request('/api/tasks', { headers: { cookie: cookieFor(ADMIN) } });
    expect(await json(res)).toEqual({
      via: 'cookie',
      loginId: ADMIN,
      role: 'admin',
      callerActor: `login:rw:${ADMIN}`,
      // No guard read it: the request slot's first actor, as before.
      actor: 'system:http:no-login',
    });
    expect(counts.loginRows).toBe(1);
  });

  it('finds the login once however many guards read it; each read names the actor', async () => {
    const res = await app.request('/api/notes', { headers: { cookie: cookieFor(MEMBER) } });
    const body = await json(res);
    expect(body.before).toMatchObject({
      loginId: MEMBER,
      role: 'member',
      actor: 'system:http:no-login',
    });
    // A member on an owner route it may read, then the any-login guard.
    expect(body.first).toBe(MEMBER);
    expect(body.second).toBe(MEMBER);
    expect((body.after as { actor: string }).actor).toBe(`login:rw:${MEMBER}`);
    expect(counts.loginRows).toBe(1);
  });

  it('stamps a device token on each guard read, as each lookup did, and reads its row once', async () => {
    const res = await app.request('/api/notes', { headers: { authorization: bearerFor(ADMIN) } });
    const body = await json(res);
    expect(body.before).toMatchObject({ via: 'bearer', loginId: ADMIN });
    expect(body.first).toBe(ADMIN);
    expect(counts.bearerRows).toBe(1);
    expect(counts.loginRows).toBe(1);
    expect(counts.touches).toBe(2);
  });

  it('a public row: no login on the caller; found on the first guard read, once', async () => {
    const res = await app.request('/api/auth/whoami', { headers: { cookie: cookieFor(ADMIN) } });
    const body = await json(res);
    expect(body.before).toMatchObject({ via: 'public', loginId: null, role: null });
    expect(body.second).toBe(ADMIN);
    expect(counts.loginRows).toBe(1);
  });

  it('a public row that writes binds its named actor: the one it ran as before', async () => {
    const res = await app.request('/api/auth/signup', {
      method: 'POST',
      headers: { cookie: cookieFor(ADMIN) },
    });
    expect(await json(res)).toMatchObject({
      via: 'public',
      loginId: null,
      callerActor: 'system:http:no-login',
      actor: 'system:http:no-login',
    });
    // A public row finds no login until a guard reads it.
    expect(counts.loginRows).toBe(0);
  });

  it('a call nested in the request with a caller of its own resolves the login itself', async () => {
    const res = await app.request('/api/changelog', { headers: { cookie: cookieFor(ADMIN) } });
    expect(await json(res)).toEqual({ nested: ADMIN });
    // The gate's find, and the nested guard's own.
    expect(counts.loginRows).toBe(2);
  });

  it('an area row: the gate resolves the area once and the guard answers from it', async () => {
    const ok = await app.request('/api/users', { headers: { cookie: cookieFor(ADMIN) } });
    expect(await json(ok)).toMatchObject({ ok: true, actor: 'system:http:admin-area' });
    expect(counts.areas).toBe(1);
    counts.areas = 0;
    const refused = await app.request('/api/users', { headers: { cookie: cookieFor(LIMITED) } });
    expect(refused.status).toBe(403);
    expect(await json(refused)).toEqual({
      error: 'forbidden',
      reason: 'area',
      area: 'users',
      message: 'You cannot manage this part of the brain.',
    });
    expect(counts.areas).toBe(1);
    // A member has no Admin view: the guard refuses it as before.
    const member = await app.request('/api/users', { headers: { cookie: cookieFor(MEMBER) } });
    expect(member.status).toBe(403);
    expect(await json(member)).toMatchObject({ reason: 'member-login' });
  });
});
