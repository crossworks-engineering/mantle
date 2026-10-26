/**
 * GET /api/shell answers 200 when a chrome read throws (audit A13): a failed preferences read, pending count, onboarding check or asset
 * token used to fail the whole route and lock the login out of the app. Each
 * part now answers empty on its own; the login gate in front is never caught.
 *
 * Since workspaces W5c the one shell serves every login (plan 7.1): an
 * admin and a member get the same shape, `role` says which, and the
 * admin-only parts answer empty for a member (there is no client login since
 * W8a). The old member and client shells answer 410 code gone.
 *
 * No database: the gates and every read are stood in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const LOGIN = '22222222-2222-4222-8222-222222222222';

const h = vi.hoisted(() => ({
  fail: new Set<string>(),
  gate: 'pass' as 'pass' | 'refuse',
  role: 'admin' as 'admin' | 'member',
  minted: [] as Array<{ anchorId: string; loginId: string; ttlSeconds?: number }>,
  /** The login's saved Desk on its own row (undefined: never saved). */
  desk: undefined as Record<string, unknown> | undefined,
}));

const boom = (part: string) => {
  if (h.fail.has(part)) throw new Error(`${part} is down`);
};

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const ACTOR = '55555555-5555-4555-8555-555555555555';

vi.mock('@/lib/auth', async () => {
  const { NextResponse } = await import('@/server/http-compat');
  const refused = () => NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const wrongRole = () => NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const admin = {
    id: ANCHOR,
    email: 'anchor@example.invalid',
    actor: { id: ACTOR, email: 'actor@example.invalid', displayName: 'Actor', isOwner: false },
  };
  const member = {
    role: 'member',
    loginId: LOGIN,
    anchorId: ANCHOR,
    email: 'member@example.invalid',
    displayName: 'Member',
    contactId: null,
  };
  const base = { source: 'web', sessionEpoch: 0 };
  const login = () =>
    h.role === 'member'
      ? { kind: 'member', loginId: LOGIN, email: member.email, member, ...base }
      : { kind: 'admin', loginId: ACTOR, email: admin.actor.email, user: admin, ...base };
  return {
    getLoginOr401: async () => (h.gate === 'refuse' ? refused() : login()),
    // The Login reader GET /api/shell calls (A4 hand batch A; plan v3.2
    // section 2.2): the gate refused before the handler, so with no login it
    // throws, as the real reader does where the pipeline answered none.
    anyLoginCaller: () => {
      if (h.gate === 'refuse') throw new Error('anyLoginCaller(): the pipeline answered no login');
      const l = login();
      return l.kind === 'admin'
        ? {
            loginId: l.loginId,
            brainId: admin.id,
            email: admin.actor.email,
            displayName: admin.actor.displayName,
            contactId: null,
            ...base,
            actor: admin.actor,
          }
        : {
            loginId: l.loginId,
            brainId: ANCHOR,
            email: member.email,
            displayName: member.displayName,
            contactId: null,
            ...base,
            actor: {
              id: LOGIN,
              email: member.email,
              displayName: member.displayName,
              isOwner: false,
            },
          };
    },
    // The display role of that Login (the row's membership).
    sessionRole: () => login().kind,
    getOwnerOr401: async () =>
      h.gate === 'refuse' ? refused() : h.role === 'admin' ? admin : wrongRole(),
    getMemberOr401: async () =>
      h.gate === 'refuse' ? refused() : h.role === 'member' ? member : wrongRole(),
    // The member reader a gone stub reads (lib/gone.ts, A4 hand batch A):
    // the gate refused anyone but a member before the handler.
    memberCaller: () => {
      if (h.gate === 'refuse' || h.role !== 'member') {
        throw new Error('memberCaller(): the pipeline answered no member');
      }
      return member;
    },
    mintAssetToken: (
      anchorId: string,
      loginId: string,
      _epoch: number,
      opts?: { ttlSeconds?: number },
    ) => {
      boom('asset token');
      h.minted.push({ anchorId, loginId, ttlSeconds: opts?.ttlSeconds });
      return 'asset-token';
    },
  };
});

// adminFacts as the scope answers it: an Admin user for the admin login.
vi.mock('@/lib/auth/login', () => ({
  adminFacts: async () => ({ admin: h.role === 'admin', areas: new Set() }),
}));

vi.mock('@mantle/content', () => ({
  loadPreferencesFor: async (id: string) => {
    boom(id === '33333333-3333-4333-8333-333333333333' ? 'brand' : 'own preferences');
    return id === '33333333-3333-4333-8333-333333333333'
      ? { siteName: 'Brand', onboardedAt: '2026-01-01' }
      : { avatarSeed: 'seed', ...(h.desk ? { homeDesk: h.desk } : {}) };
  },
  logoVersion: (key: string | undefined) => (key ? 'v1' : null),
}));

vi.mock('@mantle/tools', () => ({
  countPending: async () => {
    boom('pending count');
    return 4;
  },
}));

vi.mock('@/lib/onboarding', () => ({
  isOnboarded: async () => {
    boom('onboarding');
    return true;
  },
}));

vi.mock('@mantle/files', () => ({ maxStreamedUploadBytes: () => 1024 }));

const WS = {
  id: '77777777-7777-4777-8777-777777777777',
  name: 'Team',
  isAdmin: false,
  moderator: true,
};
vi.mock('@/lib/workspaces', () => ({
  // The caller projection (lib/workspaces.ts workspaceCaller, A4 hand batch
  // A), as it answers.
  workspaceCaller: (login: { loginId: string; brainId: string }) => ({
    loginId: login.loginId,
    anchorId: login.brainId,
    login,
  }),
  shellWorkspaces: async () => {
    boom('workspaces');
    return { workspaces: [WS], areas: ['users'] };
  },
}));

type Body = Record<string, unknown>;
const get = async (mod: Promise<{ GET: () => Promise<Response> }>) => {
  const res = await (await mod).GET();
  return { status: res.status, body: (await res.json()) as Body };
};

describe('shell chrome reads never fail the shell', () => {
  beforeEach(() => {
    h.fail.clear();
    h.gate = 'pass';
    h.role = 'admin';
    h.minted.length = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('/api/shell (admin)', () => {
    const shell = () => get(import('./route'));

    it('answers everything when every read works', async () => {
      const { status, body } = await shell();
      expect(status).toBe(200);
      expect(body).toMatchObject({
        onboarded: true,
        pendingApprovals: 4,
        assetToken: 'asset-token',
        siteName: 'Brand',
        avatar: { seed: 'seed' },
        email: 'actor@example.invalid',
        workspaces: [WS],
        areas: ['users'],
        role: 'admin',
        loginId: ACTOR,
        // An Admin user who is not the anchor login (W6b fix round 2).
        isOwner: false,
      });
      expect(h.minted).toEqual([{ anchorId: ANCHOR, loginId: ACTOR, ttlSeconds: undefined }]);
    });

    it.each(['pending count', 'onboarding', 'asset token', 'own preferences', 'workspaces'])(
      'answers 200 when the %s read throws, that part empty',
      async (part) => {
        h.fail.add(part);
        const { status, body } = await shell();
        expect(status).toBe(200);
        expect(body.email).toBe('actor@example.invalid');
        expect(body.siteName).toBe('Brand');
        if (part === 'pending count') expect(body.pendingApprovals).toBe(0);
        if (part === 'onboarding') expect(body.onboarded).toBe(true);
        if (part === 'asset token') expect(body).not.toHaveProperty('assetToken');
        if (part === 'own preferences') expect(body.avatar).toBeNull();
        // A failed read of the login's own row leaves the desk out: never
        // read as "never saved" (null), which would move a stale local desk up.
        if (part === 'own preferences') expect(body).not.toHaveProperty('homeDesk');
        else expect(body.homeDesk).toBeNull();
        if (part === 'workspaces') expect(body).toMatchObject({ workspaces: [], areas: [] });
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`[shell] ${part}`));
      },
    );

    it('answers 200 when the brand read throws: the brand unset, onboarding not asked', async () => {
      h.fail.add('brand');
      const { status, body } = await shell();
      expect(status).toBe(200);
      expect(body).toMatchObject({ siteName: null, onboarded: true, pendingApprovals: 4 });
    });

    it('answers 200 with every part failing at once', async () => {
      for (const p of [
        'brand',
        'own preferences',
        'pending count',
        'onboarding',
        'asset token',
        'workspaces',
      ])
        h.fail.add(p);
      const { status, body } = await shell();
      expect(status).toBe(200);
      expect(body).toMatchObject({ onboarded: true, pendingApprovals: 0, siteName: null });
    });

    it('never catches a missing login (the gate refuses before the handler)', async () => {
      h.gate = 'refuse';
      h.fail.add('pending count');
      await expect(shell()).rejects.toThrow(/answered no login/);
    });
  });

  describe.each(['member'] as const)('/api/shell (%s)', (role) => {
    const shell = () => get(import('./route'));
    beforeEach(() => {
      h.role = role;
    });

    it('answers the same shape: own face, brand, workspaces, no admin parts', async () => {
      const { status, body } = await shell();
      expect(status).toBe(200);
      expect(body).toMatchObject({
        role,
        loginId: LOGIN,
        email: `${role}@example.invalid`,
        displayName: 'Member',
        siteName: 'Brand',
        avatar: { seed: 'seed' },
        assetToken: 'asset-token',
        workspaces: [WS],
        // Admin areas are an admin's only, whatever the workspaces read says.
        areas: [],
        onboarded: true,
        pendingApprovals: 0,
        navFavorites: [],
        homeDesk: null,
        maxUploadBytes: 1024,
        features: { recallV2: true, treeCustomOrder: true },
      });
      const { READER_TREE_KINDS } = await import('@mantle/content/tree');
      expect(body.treeKinds).toEqual([...READER_TREE_KINDS]);
      // A non-Admin login's asset token is the short one (10 minutes): a
      // member's (W7e fix round 1, L3).
      expect(h.minted).toEqual([{ anchorId: ANCHOR, loginId: LOGIN, ttlSeconds: 600 }]);
    });

    it.each(['brand', 'own preferences', 'workspaces', 'asset token'])(
      'answers 200 when the %s read throws',
      async (part) => {
        h.fail.add(part);
        const { status, body } = await shell();
        expect(status).toBe(200);
        expect(body).toMatchObject({ role, loginId: LOGIN });
        if (part === 'brand') expect(body.siteName).toBeNull();
        if (part === 'own preferences') expect(body.avatar).toBeNull();
        if (part === 'own preferences') expect(body).not.toHaveProperty('homeDesk');
        else expect(body.homeDesk).toBeNull();
        if (part === 'workspaces') expect(body).toMatchObject({ workspaces: [], areas: [] });
        if (part === 'asset token') expect(body).not.toHaveProperty('assetToken');
      },
    );

    it("answers the login's own saved desk", async () => {
      const desk = { v: 1, items: [], counts: {}, icons: false, clock: 'analog' };
      h.desk = desk;
      try {
        const { status, body } = await shell();
        expect(status).toBe(200);
        expect(body.homeDesk).toEqual(desk);
      } finally {
        h.desk = undefined;
      }
    });

    it('never catches a missing login', async () => {
      h.gate = 'refuse';
      await expect(shell()).rejects.toThrow(/answered no login/);
    });
  });
});
