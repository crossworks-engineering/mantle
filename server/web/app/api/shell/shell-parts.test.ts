/**
 * The shells answer 200 when a chrome read throws (client logins audit A13).
 * The client learns the login's ROLE from which shell answers, so a failed
 * preferences read, pending count, onboarding check or asset token used to
 * fail the whole route and lock the login out of the app. Each part now
 * answers empty on its own; the role gate in front is never caught.
 *
 * No database: the gates and every read are stood in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const LOGIN = '22222222-2222-4222-8222-222222222222';

const h = vi.hoisted(() => ({
  fail: new Set<string>(),
  gate: 'pass' as 'pass' | 'refuse',
}));

const boom = (part: string) => {
  if (h.fail.has(part)) throw new Error(`${part} is down`);
};

vi.mock('@/lib/auth', async () => {
  const { NextResponse } = await import('@/server/http-compat');
  const refused = () => NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return {
    getOwnerOr401: async () =>
      h.gate === 'refuse'
        ? refused()
        : {
            id: '33333333-3333-4333-8333-333333333333',
            email: 'anchor@example.invalid',
            actor: {
              id: '55555555-5555-4555-8555-555555555555',
              email: 'actor@example.invalid',
              displayName: 'Actor',
              isOwner: false,
            },
          },
    getMemberOr401: async () =>
      h.gate === 'refuse'
        ? refused()
        : {
            role: 'member',
            loginId: '22222222-2222-4222-8222-222222222222',
            anchorId: '33333333-3333-4333-8333-333333333333',
            spaceId: '66666666-6666-4666-8666-666666666666',
            email: 'member@example.invalid',
            displayName: 'Member',
            contactId: null,
          },
    getClientOr401: async () =>
      h.gate === 'refuse'
        ? refused()
        : {
            role: 'client',
            loginId: '22222222-2222-4222-8222-222222222222',
            anchorId: '33333333-3333-4333-8333-333333333333',
            spaceId: '66666666-6666-4666-8666-666666666666',
            email: 'client@example.invalid',
            displayName: 'Client',
            contactId: null,
          },
    mintAssetToken: async () => {
      boom('asset token');
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

type Body = Record<string, unknown>;
const get = async (mod: Promise<{ GET: () => Promise<Response> }>) => {
  const res = await (await mod).GET();
  return { status: res.status, body: (await res.json()) as Body };
};

describe('shell chrome reads never fail the shell', () => {
  beforeEach(() => {
    h.fail.clear();
    h.gate = 'pass';
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
      });
    });

    it.each(['pending count', 'onboarding', 'asset token', 'own preferences'])(
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
      for (const p of ['brand', 'own preferences', 'pending count', 'onboarding', 'asset token'])
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

  describe('/api/member/shell', () => {
    const shell = () => get(import('../member/shell/route'));

    it.each(['brand', 'own preferences'])('answers 200 when the %s read throws', async (part) => {
      h.fail.add(part);
      const { status, body } = await shell();
      expect(status).toBe(200);
      expect(body).toMatchObject({ role: 'member', loginId: LOGIN, assetToken: 'asset-token' });
      if (part === 'brand') expect(body.siteName).toBeNull();
      else expect(body.avatar).toBeNull();
    });

    it('still refuses without a member login', async () => {
      h.gate = 'refuse';
      expect((await shell()).status).toBe(401);
    });
  });

  describe('/api/client/shell', () => {
    const shell = () => get(import('../client/shell/route'));

    it('answers 200 when the brand read throws', async () => {
      h.fail.add('brand');
      const { status, body } = await shell();
      expect(status).toBe(200);
      expect(body).toMatchObject({ role: 'client', loginId: LOGIN, siteName: null });
    });

    it('still refuses without a client login', async () => {
      h.gate = 'refuse';
      expect((await shell()).status).toBe(401);
    });
  });
});
