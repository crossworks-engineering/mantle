import { describe, expect, it } from 'vitest';
import { shareModeForLevel, shareServedIds, TeamLinkRetiredError } from './shares';

describe('the link the old level path asks for', () => {
  // Team links are retired (member logins Phase 6 stage 6); client means
  // signed-in clients (client logins C1), never a link.
  it('is an open one at public only', () => {
    expect(shareModeForLevel('admin')).toBeNull();
    expect(shareModeForLevel('team')).toBeNull();
    expect(shareModeForLevel('client')).toBeNull();
    expect(shareModeForLevel('public')).toBe('public');
  });
});

describe('shareServedIds (plan 8.1)', () => {
  const A = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
  const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('reads the served list lower-case, in order, no repeats, uuids only', () => {
    expect(shareServedIds({ served: [A, B, A.toLowerCase(), 'nope', 3, null] })).toEqual([
      A.toLowerCase(),
      B,
    ]);
  });

  it('reads no list as empty', () => {
    for (const settings of [{}, null, undefined, { served: 'x' }, { mode: 'public' }]) {
      expect(shareServedIds(settings)).toEqual([]);
    }
  });
});

describe('TeamLinkRetiredError', () => {
  it('names the reason and says members use their own logins', () => {
    const err = new TeamLinkRetiredError();
    expect(err.reason).toBe('team-links-retired');
    expect(err.message).toMatch(/own logins/);
    expect(err.message).toMatch(/Grant Access/);
  });
});
