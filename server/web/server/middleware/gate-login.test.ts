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
 *  - a public row that writes binds its named actor (row.actor);
 *  - a request that ends a login's sessions, or changes its role or
 *    switch, finds the login afresh on its next guard read (audit L1);
 *  - a frame document's row finds no login, and a find that fails is
 *    answered to the first guard read, not asked again (audit L4);
 *  - an Admin login whose area is taken away in the request (its role
 *    stays admin) is refused the area on its next guard read: the gate's
 *    Admin view is not read after the request forgot its logins (re-audit
 *    L-a);
 *  - a find the request forgot that fails after a fresh one was kept does
 *    not drop the fresh one (re-audit L-c).
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

/** What getOwnerOr401 answered before it went (A4 exit): the owner guard's
 *  user, or its refusal. */
async function ownerGuard(): Promise<import('../../lib/auth/session').SessionUser | Response> {
  const { getOwnerOr401WithLogin } = await import('../../lib/auth/session');
  const got = await getOwnerOr401WithLogin();
  return got instanceof Response ? got : got.user;
}

const ADMIN = '55555555-5555-4555-8555-555555555555';
const ANCHOR = '33333333-3333-4333-8333-333333333333';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const LIMITED = '44444444-4444-4444-8444-444444444444';
/** A login whose row cannot be read (the database is down). */
const FAILING = '66666666-6666-4666-8666-666666666666';
/** A login whose row reads answer what the test queues (counts.slow). */
const SLOW = '77777777-7777-4777-8777-777777777777';

const counts = vi.hoisted(() => ({
  loginRows: 0,
  bearerRows: 0,
  touches: 0,
  areas: 0,
  bearers: new Map<string, { userId: string; revokedAt: Date | null; expiresAt: Date }>(),
  // What a request changed on a login row (L1): its epoch, role, switch.
  epochs: new Map<string, number>(),
  roles: new Map<string, 'admin' | 'member'>(),
  disabled: new Set<string>(),
  // The login endLoginSessions is ending, while the stand-in db runs it.
  ending: null as string | null,
  // Logins whose Admin area was taken away (their role stays admin).
  arealess: new Set<string>(),
  // The answers of SLOW's next row reads, in order (then its row).
  slow: [] as Array<() => Promise<unknown>>,
}));

vi.mock('../../lib/auth/login-row', () => {
  const row = (id: string, role: 'admin' | 'member', isOwner = false) => ({
    id,
    email: `${role}@example.invalid`,
    isOwner,
    displayName: null,
    role: counts.roles.get(id) ?? role,
    adminMember: (counts.roles.get(id) ?? role) === 'admin',
    contactId: null,
    disabledAt: counts.disabled.has(id) ? new Date(0) : null,
    sessionEpoch: counts.epochs.get(id) ?? 0,
  });
  return {
    loadLoginRow: async (id: string) => {
      counts.loginRows += 1;
      if (id === FAILING) throw new Error('the database is down');
      if (id === SLOW) return (await counts.slow.shift()?.()) ?? row(SLOW, 'admin');
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

vi.mock('@mantle/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@mantle/db')>();
  // endLoginSessions' statements (no keys ended), stood in: the epoch bump
  // on auth.users returns the new epoch; the rest change nothing here.
  const chain = (result: () => unknown[]) => {
    const c = {
      set: () => c,
      where: () => c,
      returning: async () => result(),
      then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(ok, ko),
    };
    return c;
  };
  const bump = () => {
    const id = counts.ending;
    if (!id) return [];
    const epoch = (counts.epochs.get(id) ?? 0) + 1;
    counts.epochs.set(id, epoch);
    return [{ epoch }];
  };
  const tx = {
    update: (table: unknown) => chain(table === orig.authUsers ? bump : () => []),
    delete: () => chain(() => []),
  };
  return {
    ...orig,
    db: { transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) },
    loginScopeFor: async (loginId: string) => ({ kind: 'user', loginId, ws: [], modWs: [] }),
  };
});
vi.mock('../../lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/workspaces')>()),
  requireArea: async (caller: { loginId: string }) => {
    counts.areas += 1;
    return caller.loginId !== LIMITED && !counts.arealess.has(caller.loginId);
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
    callerActor: caller?.actor ? actorSetting(caller.actor) : null,
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
      const a = await ownerGuard();
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
          const owner = await ownerGuard();
          return owner instanceof Response ? owner.status : owner.actor.id;
        },
      );
      return Response.json(out.ok ? { nested: out.value } : { refused: out.refusal.http });
    };
    const area = async () => {
      const owner = await ownerGuard();
      return owner instanceof Response ? owner : Response.json({ ok: true, ...seen() });
    };
    const guard = async () => {
      const r = await session.getLoginOr401();
      return r instanceof Response ? r.status : r.loginId;
    };
    // A request that ends its own login's sessions (sign out everywhere, a
    // password change): the next guard read finds the dead cookie.
    const ends = async () => {
      const first = await guard();
      if (typeof first === 'string') {
        counts.ending = first;
        try {
          await session.endLoginSessions(first);
        } finally {
          counts.ending = null;
        }
      }
      return Response.json({ first, second: await guard() });
    };
    // A request that disables its login (updateLogin forgets after its
    // commit; the stand-in changes the row, then forgets as it does).
    const disables = async () => {
      const first = await guard();
      if (typeof first === 'string') counts.disabled.add(first);
      session.forgetRequestLogins();
      return Response.json({ first, second: await guard() });
    };
    // An Admin login made a member on an area row: the gate's Admin view of
    // the area is not read again; the owner guard refuses the member.
    const demotes = async () => {
      const a = await ownerGuard();
      const first = a instanceof Response ? a.status : a.actor.id;
      counts.roles.set(ADMIN, 'member');
      session.forgetRequestLogins();
      const b = await ownerGuard();
      return Response.json({
        first,
        second: b instanceof Response ? b.status : b.actor.id,
        reason: b instanceof Response ? ((await b.json()) as { reason?: string }).reason : null,
      });
    };
    // An Admin login whose area is taken away in the request (a workspace
    // change, not a role change): the gate's Admin view of the area is not
    // read again; holdsArea asks requireArea (re-audit L-a).
    const unareas = async () => {
      const a = await ownerGuard();
      const first = a instanceof Response ? a.status : a.actor.id;
      counts.arealess.add(ADMIN);
      session.forgetRequestLogins();
      const b = await ownerGuard();
      return Response.json({
        first,
        second: b instanceof Response ? b.status : b.actor.id,
        reason: b instanceof Response ? ((await b.json()) as { reason?: string }).reason : null,
      });
    };
    const routes: RouteEntry[] = [
      // Real manifest patterns: registerRoutes builds their real rows.
      { pattern: '/api/notes', methods: ['GET'], load: async () => ({ GET: twice }) },
      { pattern: '/api/tasks', methods: ['GET'], load: async () => ({ GET: unread }) },
      { pattern: '/api/changelog', methods: ['GET'], load: async () => ({ GET: nested }) },
      // An area row (users).
      // POST: its handler takes its login's area away (re-audit L-a).
      {
        pattern: '/api/users',
        methods: ['GET', 'POST'],
        load: async () => ({ GET: area, POST: unareas }),
      },
      // A public row that reads the session (sign out), and one that writes.
      { pattern: '/api/auth/whoami', methods: ['GET'], load: async () => ({ GET: twice }) },
      { pattern: '/api/auth/signup', methods: ['POST'], load: async () => ({ POST: unread }) },
      // Rows whose handler changes a login, then reads a guard again (L1).
      { pattern: '/api/profile', methods: ['PUT'], load: async () => ({ PUT: ends }) },
      { pattern: '/api/auth/logout', methods: ['POST'], load: async () => ({ POST: disables }) },
      { pattern: '/api/users/:id', methods: ['PATCH'], load: async () => ({ PATCH: demotes }) },
      // A frame document: its handler reads no guard (L4).
      { pattern: '/api/apps/:id/frame', methods: ['GET'], load: async () => ({ GET: unread }) },
    ].map((r) => ({ catchAll: null, catchAllOptional: false, ...r }));
    app = new Hono();
    app.use('*', gate());
    registerRoutes(app, routes, { standIn: true });
  });

  afterAll(() => {
    process.env = saved;
  });

  beforeEach(() => {
    counts.loginRows = 0;
    counts.bearerRows = 0;
    counts.touches = 0;
    counts.areas = 0;
    counts.epochs.clear();
    counts.roles.clear();
    counts.disabled.clear();
    counts.arealess.clear();
    counts.slow.length = 0;
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

  it('a guard read after the request ends its sessions sees the login afresh (L1)', async () => {
    const res = await app.request('/api/profile', {
      method: 'PUT',
      headers: { cookie: cookieFor(MEMBER) },
    });
    // The cookie's epoch is the old one: the second read refuses it, as a
    // guard that looked the login up itself did before step 3a.
    expect(await json(res)).toEqual({ first: MEMBER, second: 401 });
    expect(counts.epochs.get(MEMBER)).toBe(1);
    expect(counts.loginRows).toBe(2);
  });

  it('a guard read after the request disables its login sees it disabled (L1)', async () => {
    const res = await app.request('/api/auth/logout', {
      method: 'POST',
      headers: { authorization: bearerFor(MEMBER) },
    });
    expect(await json(res)).toEqual({ first: MEMBER, second: 401 });
    // The device token is found afresh too.
    expect(counts.bearerRows).toBe(2);
  });

  it('an Admin login demoted in the request: the owner guard reads the new role (L1)', async () => {
    const res = await app.request(`/api/users/${MEMBER}`, {
      method: 'PATCH',
      headers: { cookie: cookieFor(ADMIN) },
    });
    expect(await json(res)).toEqual({ first: ADMIN, second: 403, reason: 'member-login' });
  });

  it('an Admin login whose area is taken away, its role kept: the guard asks again (L-a)', async () => {
    const res = await app.request('/api/users', {
      method: 'POST',
      headers: { cookie: cookieFor(ADMIN) },
    });
    // The role is still admin, so only the area answers: from the gate's
    // view the second read would let the login in.
    expect(await json(res)).toEqual({ first: ADMIN, second: 403, reason: 'area' });
    // The gate's question, and the second read's own.
    expect(counts.areas).toBe(2);
  });

  it('a forgotten find that fails after a fresh one was kept leaves the fresh one (L-c)', async () => {
    const { RequestLogins } = await import('../../lib/auth/session');
    const { runWithRequestContext } = await import('../request-context');
    let fail: (err: Error) => void = () => undefined;
    counts.slow.push(
      () =>
        new Promise((_ok, ko) => {
          fail = ko;
        }),
    );
    const req = new Request('http://brain.example.invalid/api/tasks', {
      headers: { cookie: cookieFor(SLOW) },
    });
    await runWithRequestContext({ req, path: '/api/tasks', method: 'GET' }, async () => {
      const logins = new RequestLogins();
      const first = logins.login();
      // The request changed a login while the first find was in flight.
      logins.forget();
      const fresh = logins.login();
      expect((await fresh).resolved).not.toBeNull();
      fail(new Error('the database is down'));
      await expect(first).rejects.toThrow('the database is down');
      // The fresh find is still the request's: no third read.
      expect(logins.login()).toBe(fresh);
    });
    expect(counts.loginRows).toBe(2);
  });

  it('a frame document finds no login: its handler reads none (L4)', async () => {
    const res = await app.request(`/api/apps/${MEMBER}/frame`, {
      headers: { cookie: cookieFor(ADMIN) },
    });
    expect(await json(res)).toEqual({
      via: 'cookie',
      loginId: null,
      role: null,
      callerActor: 'system:http:no-login',
      actor: 'system:http:no-login',
    });
    expect(counts.loginRows).toBe(0);
  });

  it("a find that fails is the first guard read's answer, not asked again (L4)", async () => {
    const res = await app.request('/api/notes', { headers: { cookie: cookieFor(FAILING) } });
    // The guard throws what the gate's find threw, as its own lookup did.
    expect(res.status).toBe(500);
    expect(counts.loginRows).toBe(1);
  });
});
