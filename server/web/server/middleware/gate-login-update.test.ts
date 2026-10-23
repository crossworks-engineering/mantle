/**
 * A request that changes a login through applyLoginChange (lib/login-update.ts)
 * and reads a guard inside the change's transaction (A4 step 3a re-audit
 * L-a), driven through the real gate and route loader with a stub handler.
 *
 * endLoginSessions forgets the request's logins inside the transaction, but
 * a guard read after that and before the commit finds the login again as it
 * is committed, and keeps it. Only the forget after the commit drops that
 * find: without it, the request's next guard read answers the login as it
 * was before the change. Here the change makes a member an admin, which
 * ends its sessions: after the commit the member's cookie is dead.
 *
 * No database: the login rows and the transaction are stood in. The
 * transaction keeps its writes (the role, the session epoch) until it
 * commits, as Postgres does for a read outside it.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteEntry } from '../route-loader';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const MEMBER = '22222222-2222-4222-8222-222222222222';

const state = vi.hoisted(() => ({
  /** The committed rows: what a read outside the transaction sees. */
  roles: new Map<string, 'admin' | 'member'>(),
  epochs: new Map<string, number>(),
  /** Whether the forget after the commit (login-update.ts) runs. */
  forgetAfterCommit: true,
  loginRows: 0,
}));

vi.mock('../../lib/auth/login-row', () => ({
  loadLoginRow: async (id: string) => {
    state.loginRows += 1;
    if (id !== ANCHOR && id !== MEMBER) return null;
    return {
      id,
      email: `${id.slice(0, 4)}@example.invalid`,
      isOwner: id === ANCHOR,
      displayName: null,
      role: state.roles.get(id) ?? (id === ANCHOR ? 'admin' : 'member'),
      adminMember: (state.roles.get(id) ?? (id === ANCHOR ? 'admin' : 'member')) === 'admin',
      contactId: null,
      disabledAt: null,
      sessionEpoch: state.epochs.get(id) ?? 0,
    };
  },
  loadAnchorId: async () => ANCHOR,
  loadPersonalSpaceId: async () => null,
  loadBearerToken: async () => null,
  touchBearerToken: async () => undefined,
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@mantle/db')>();
  /** The transaction's writes to auth.users, kept until it commits. */
  type Pending = { role?: 'admin' | 'member'; bumps: number; id: string | null };
  const chain = (result: () => unknown[]) => {
    const c = {
      where: () => c,
      returning: async () => result(),
      then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(ok, ko),
    };
    return c;
  };
  return {
    ...orig,
    db: {
      transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
        const pending: Pending = { bumps: 0, id: MEMBER };
        const tx = {
          update: (table: unknown) => ({
            set: (values: Record<string, unknown>) => {
              if (table !== orig.authUsers) return chain(() => []);
              if ('sessionEpoch' in values) {
                pending.bumps += 1;
                const epoch = (state.epochs.get(MEMBER) ?? 0) + pending.bumps;
                return chain(() => [{ epoch }]);
              }
              if (values.role === 'admin' || values.role === 'member') pending.role = values.role;
              return chain(() => []);
            },
          }),
          delete: () => chain(() => []),
          execute: async () => [],
        };
        const out = await fn(tx);
        // The commit: a read outside the transaction sees its writes now.
        if (pending.role) state.roles.set(MEMBER, pending.role);
        state.epochs.set(MEMBER, (state.epochs.get(MEMBER) ?? 0) + pending.bumps);
        return out;
      },
    },
    loginScopeFor: async (loginId: string) => ({ kind: 'user', loginId, ws: [], modWs: [] }),
  };
});

// What the change does besides the login row, stood in.
vi.mock('../../lib/oauth-lock', () => ({ lockOauthActor: async () => undefined }));
vi.mock('../../lib/peer-unbind', () => ({
  unbindPeersActingAs: async () => [],
  auditPeersUnbound: () => undefined,
}));
vi.mock('../../lib/access-keys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/access-keys')>()),
  lockLoginKeys: async () => undefined,
}));
vi.mock('../../lib/push/store', () => ({
  deleteLoginSubscriptions: async () => [],
  forgetRelayDevices: async () => undefined,
}));
vi.mock('../../lib/agents', () => ({ releaseAssignedAgent: async () => null }));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/content')>()),
  settleSpaceOnPromotion: async () => undefined,
  isFormerClientLogin: async () => false,
}));
// The forget after the commit, which login-update.ts calls through the
// façade; endLoginSessions' own forget (inside session.ts) is the real one.
vi.mock('../../lib/auth', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/auth')>();
  return {
    ...orig,
    forgetRequestLogins: () => {
      if (state.forgetAfterCommit) orig.forgetRequestLogins();
    },
  };
});

const here = dirname(fileURLToPath(import.meta.url));
const hasManifest = existsSync(join(here, '../route-manifest.gen.ts'));

describe.skipIf(!hasManifest)('a guard read inside a login change (A4 step 3a, L-a)', () => {
  const saved = { ...process.env };
  let app: Hono;
  let cookieFor: (id: string) => string;

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'gate-login-update-test-secret-at-least-32-chars';
    delete process.env.MANTLE_API_CORS_ORIGINS;
    delete process.env.MANTLE_DETACHED_DEV;
    const tokens = await import('../../lib/auth/tokens');
    const { SESSION_COOKIE_NAME } = await import('../../lib/auth-constants');
    cookieFor = (id) => `${SESSION_COOKIE_NAME}=${tokens.buildSessionCookie(id).value}`;
    const { gate } = await import('./gate');
    const { registerRoutes } = await import('../route-loader');
    const session = await import('../../lib/auth/session');
    const { applyLoginChange } = await import('../../lib/login-update');
    const guard = async () => {
      const r = await session.getLoginOr401();
      return r instanceof Response ? r.status : `${session.legacyLogin(r).kind}:${r.loginId}`;
    };
    // The member is made an admin (its sessions end); inside the change's
    // transaction, after its sessions ended there, a guard reads the login.
    const promotes = async () => {
      const first = await guard();
      const anchor = {
        id: ANCHOR,
        email: 'anchor@example.invalid',
        actor: { id: ANCHOR, email: 'anchor@example.invalid', displayName: null, isOwner: true },
      };
      let inside: string | number = 0;
      const done = await applyLoginChange(
        anchor,
        { id: MEMBER, email: 'member@example.invalid', isOwner: false, role: 'member' },
        { role: 'admin' },
        async () => {
          inside = await guard();
        },
      );
      return Response.json({ first, inside, ok: done.ok, second: await guard() });
    };
    const routes: RouteEntry[] = [
      // A real any-login row: its guard serves a member and an admin.
      { pattern: '/api/shell', methods: ['GET'], load: async () => ({ GET: promotes }) },
    ].map((r) => ({ catchAll: null, catchAllOptional: false, ...r }));
    app = new Hono();
    app.use('*', gate());
    registerRoutes(app, routes, { standIn: true });
  });

  afterAll(() => {
    process.env = saved;
  });

  beforeEach(() => {
    state.roles.clear();
    state.epochs.clear();
    state.forgetAfterCommit = true;
    state.loginRows = 0;
  });

  const run = async () =>
    (await (
      await app.request('/api/shell', { headers: { cookie: cookieFor(MEMBER) } })
    ).json()) as Record<string, unknown>;

  it('a guard read after the commit finds the login afresh: its cookie is dead', async () => {
    expect(await run()).toEqual({
      first: `member:${MEMBER}`,
      // Before the commit the read outside the transaction sees the login
      // as it was: still a member, its cookie's epoch current.
      inside: `member:${MEMBER}`,
      ok: true,
      second: 401,
    });
    expect(state.epochs.get(MEMBER)).toBe(1);
    // applyLoginChange writes no role since S8b: the Admin definer does, in
    // the route's own step (adminMembershipChange), which this stand-in
    // leaves out; the session still ends.
    expect(state.roles.get(MEMBER)).toBeUndefined();
    // The gate's find, the read inside the transaction, the one after.
    expect(state.loginRows).toBe(3);
  });

  it('without the forget after the commit, the read inside the transaction is kept', async () => {
    state.forgetAfterCommit = false;
    // What the forget after the commit is for: the find made before the
    // commit answers the read after it, a member whose cookie is dead.
    expect(await run()).toMatchObject({ inside: `member:${MEMBER}`, second: `member:${MEMBER}` });
    expect(state.loginRows).toBe(2);
  });
});
