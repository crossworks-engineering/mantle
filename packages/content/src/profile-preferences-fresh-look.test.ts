import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The brain projection of the fresh-install look, end to end through
 * loadProfilePreferences: what a stored row reads as. The DB is stubbed to
 * return one preferences row, so this pins the projection, not SQL.
 */
const state = vi.hoisted(() => ({
  row: undefined as { preferences: Record<string, unknown> } | undefined,
  inserted: [] as unknown[],
}));

vi.mock('@mantle/db', () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => (state.row ? [state.row] : []),
  };
  return {
    db: {
      select: () => chain,
      insert: () => ({
        values: async (v: unknown) => {
          state.inserted.push(v);
        },
      }),
    },
    profiles: { preferences: 'preferences', userId: 'user_id' },
    resolveSingleOwnerId: async () => null,
  };
});

const { loadProfilePreferences } = await import('./profile-preferences');

const NEAT = '{"v":1,"seed":55361,"tone":"auto","speed":2}';

beforeEach(() => {
  state.row = undefined;
  state.inserted = [];
});

describe('loadProfilePreferences: the fresh-install look', () => {
  it('a new brain reads and stores the default look', async () => {
    const prefs = await loadProfilePreferences('u1');
    expect(prefs.colorTheme).toBe('jackdaw');
    expect(prefs.avatarStyle).toBe('lorelei');
    expect(prefs.neatBackground).toBe(NEAT);
    // shareNeat is default-on: only an explicit false hides it on shares.
    expect(prefs.shareNeat).not.toBe(false);
    const seeded = (state.inserted[0] as { preferences: Record<string, unknown> }).preferences;
    expect(seeded).toMatchObject({
      colorTheme: 'jackdaw',
      avatarStyle: 'lorelei',
      neatBackground: NEAT,
    });
  });

  it('an existing row that never chose reads as the default look', async () => {
    state.row = { preferences: { timezone: 'Africa/Johannesburg' } };
    const prefs = await loadProfilePreferences('u1');
    expect(prefs.colorTheme).toBe('jackdaw');
    expect(prefs.avatarStyle).toBe('lorelei');
    expect(prefs.neatBackground).toBe(NEAT);
    // Read-time only: nothing is written to an existing row.
    expect(state.inserted).toEqual([]);
  });

  it('keeps every choice already made, including the old defaults', async () => {
    const mine = '{"v":1,"seed":7,"tone":"darker","speed":0}';
    state.row = {
      preferences: { colorTheme: 'clean-slate', avatarStyle: 'thumbs', neatBackground: mine },
    };
    const prefs = await loadProfilePreferences('u1');
    expect(prefs.colorTheme).toBe('clean-slate');
    expect(prefs.avatarStyle).toBe('thumbs');
    expect(prefs.neatBackground).toBe(mine);
  });

  it('keeps a background switched off', async () => {
    state.row = { preferences: { neatBackground: '' } };
    expect((await loadProfilePreferences('u1')).neatBackground).toBeUndefined();
  });
});
