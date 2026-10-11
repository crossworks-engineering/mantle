/**
 * GET /api/shell answers 200 when a chrome read throws (client logins audit
 * A13): a failed preferences read, pending count, onboarding check or asset
 * token used to fail the whole route and lock the login out of the app. Each
 * part now answers empty on its own; the login gate in front is never caught.
 *
 * Since workspaces W5c the one shell serves every login (plan 7.1): an
 * admin, a member and a client get the same shape, `role` says which, and
 * the admin-only parts answer empty for the others. The old member and
 * client shells answer 410 code gone.
 *
 * No database: the gates and every read are stood in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const LOGIN = '22222222-2222-4222-8222-222222222222';

const h = vi.hoisted(() => ({
  fail: new Set<string>(),
  gate: 'pass' as 'pass' | 'refuse',
  role: 'admin' as 'admin' | 'member' | 'client',
  minted: [] as Array<{ anchorId: string; loginId: string; ttlSeconds?: number }>,
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
    spaceId: '66666666-6666-4666-8666-666666666666',
    email: 'member@example.invalid',
    displayName: 'Member',
    contactId: null,
  };
  const client = {
    role: 'client',
    loginId: LOGIN,
    anchorId: ANCHOR,
    spaceId: '66666666-6666-4666-8666-666666666666',
    email: 'client@example.invalid',
    displayName: 'Client',
    sessionEpoch: 0,
  };
  const base = { source: 'web', sessionEpoch: 0 };
  return {
    getLoginOr401: async () => {
      if (h.gate === 'refuse') return refused();
      if (h.role === 'member')
        return { kind: 'member', loginId: LOGIN, email: member.email, member, ...base };
      if (h.role === 'client')
        return { kind: 'client', loginId: LOGIN, email: client.email, client, ...base };
      return { kind: 'admin', loginId: ACTOR, email: admin.actor.email, user: admin, ...base };
    },
    getOwnerOr401: async () =>
      h.gate === 'refuse' ? refused() : h.role === 'admin' ? admin : wrongRole(),
    getMemberOr401: async () =>
      h.gate === 'refuse' ? refused() : h.role === 'member' ? member : wrongRole(),
    getClientOr401: async () =>
      h.gate === 'refuse' ? refused() : h.role === 'client' ? client : wrongRole(),
    mintAssetToken: async (anchorId: string, loginId: string, opts?: { ttlSeconds?: number }) => {
      boom('asset token');
      h.minted.push({ anchorId, loginId, ttlSeconds: opts?.ttlSeconds });
      return 'asset-token';
    },
  };
});

vi.mock('@mantle/content', () => ({
  loadPreferencesFor: async (id: string) => {
    boom(id === '33333333-3333-4333-8333-333333333333' ? 'brand' : 'own preferences');
    return id === '33333333-3333-4333-8333-333333333333'
      ? { siteName: 'Brand', onboardedAt: '2026-01-01' }
      : { avatarSeed: 'seed' };
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

    it('still refuses without a login: the gate is never caught', async () => {
      h.gate = 'refuse';
      h.fail.add('pending count');
      expect((await shell()).status).toBe(401);
    });
  });

  describe.each(['member', 'client'] as const)('/api/shell (%s)', (role) => {
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
        displayName: role === 'member' ? 'Member' : 'Client',
        siteName: 'Brand',
        avatar: { seed: 'seed' },
        assetToken: 'asset-token',
        workspaces: [WS],
        // Admin areas are an admin's only, whatever the workspaces read says.
        areas: [],
        onboarded: true,
        pendingApprovals: 0,
        navFavorites: [],
        maxUploadBytes: 1024,
        features: { recallV2: true },
      });
      const { READER_TREE_KINDS } = await import('@mantle/content/tree');
      expect(body.treeKinds).toEqual([...READER_TREE_KINDS]);
      // A non-Admin login's asset token is the short one (10 minutes): a
      // client's (audit B23), a member's too (W7e fix round 1, L3).
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
        if (part === 'workspaces') expect(body).toMatchObject({ workspaces: [], areas: [] });
        if (part === 'asset token') expect(body).not.toHaveProperty('assetToken');
      },
    );

    it('still refuses without a login', async () => {
      h.gate = 'refuse';
      expect((await shell()).status).toBe(401);
    });
  });

  describe('the old member and client shells are gone (W5c)', () => {
    const shells = {
      member: () => import('../member/shell/route'),
      client: () => import('../client/shell/route'),
    };
    it.each(['member', 'client'] as const)(
      '/api/%s/shell answers its own role 410 code gone',
      async (role) => {
        h.role = role;
        const { status, body } = await get(shells[role]());
        expect(status).toBe(410);
        expect(body).toMatchObject({ code: 'gone' });
        h.role = 'admin';
        expect((await get(shells[role]())).status).toBe(403);
      },
    );
  });
});
