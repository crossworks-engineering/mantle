/**
 * A6b: loadProfilePreferences reads every login's row in the caller's scope,
 * the brain owner's (the anchor login's) too: the workspace role's own-login
 * rule (0266) shows the brain's row to every scope and every row to a scope
 * that holds Admin. It never leaves for the system pool (W7a's
 * 'owner-preferences' exit is gone; a6b-exit-sweep.db.test.ts records the
 * answers before and after).
 */
import { describe, expect, it, vi } from 'vitest';

const ANCHOR = '00000000-0000-4000-8000-00000000000a';
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
    resolveSingleOwnerId: async () => ANCHOR,
  };
});

describe('loadProfilePreferences', () => {
  it('reads the anchor login’s row and any other in the scope, never on the system pool', async () => {
    const { loadProfilePreferences } = await import('./profile-preferences');
    expect((await loadProfilePreferences(ANCHOR)).timezone).toBe('Europe/Berlin');
    await loadProfilePreferences(MEMBER);
    expect(h.exits).toEqual([]);
  });
});
