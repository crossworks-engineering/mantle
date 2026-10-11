/**
 * W7a fix round 1, L2: loadProfilePreferences leaves a scope that holds
 * Admin for the system pool ('owner-preferences') only to read the brain
 * owner's (the anchor login's) row, never another user's: any other login's
 * row is read in the scope, where the row rule decides.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '00000000-0000-4000-8000-00000000000a';
const L = '00000000-0000-4000-8000-00000000000b';
const MEMBER = '00000000-0000-4000-8000-00000000000c';

const h = vi.hoisted(() => ({ exits: [] as string[] }));

vi.mock('@mantle/db', () => {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: async () => [{ preferences: { timezone: 'Europe/Berlin' } }],
  };
  return {
    db: chain,
    profiles: { preferences: 'preferences', userId: 'user_id' },
    asSystem: async (fn: () => Promise<unknown>, reason?: string) => {
      h.exits.push(reason ?? '');
      return fn();
    },
    currentWorkspaceScope: () => ({ kind: 'user', loginId: L, ws: ['w'], modWs: [] }),
    scopeHoldsAdmin: async () => true,
    resolveSingleOwnerId: async () => ANCHOR,
  };
});

describe('loadProfilePreferences in a scope that holds Admin', () => {
  beforeEach(() => {
    h.exits.length = 0;
  });

  it('reads the anchor login’s row by the named reason', async () => {
    const { loadProfilePreferences } = await import('./profile-preferences');
    expect((await loadProfilePreferences(ANCHOR)).timezone).toBe('Europe/Berlin');
    expect(h.exits).toEqual(['owner-preferences']);
  });

  it('reads any other login’s row in the scope, never on the system pool', async () => {
    const { loadProfilePreferences } = await import('./profile-preferences');
    await loadProfilePreferences(MEMBER);
    await loadProfilePreferences(L);
    expect(h.exits).toEqual([]);
  });
});
