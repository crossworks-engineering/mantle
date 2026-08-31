import { describe, it, expect } from 'vitest';
import {
  XP_WEIGHTS,
  experienceFromComponents,
  levelFromXp,
  xpForLevel,
  zeroExperience,
} from './agent-experience';

describe('xpForLevel', () => {
  it('level 1 is free, level 2 costs 100', () => {
    expect(xpForLevel(1)).toBe(0);
    expect(xpForLevel(0)).toBe(0);
    expect(xpForLevel(2)).toBe(100);
  });

  it('is strictly increasing (soft cap)', () => {
    for (let n = 1; n < 100; n++) {
      expect(xpForLevel(n + 1)).toBeGreaterThan(xpForLevel(n));
    }
  });
});

describe('levelFromXp', () => {
  it('inverts xpForLevel exactly at every boundary', () => {
    for (let n = 1; n <= 80; n++) {
      const need = xpForLevel(n);
      // At the boundary you ARE that level; one XP short you are not.
      expect(levelFromXp(need).level).toBe(Math.max(1, n));
      if (need > 0) expect(levelFromXp(need - 1).level).toBe(n - 1);
    }
  });

  it('returns the bracket the progress ring needs', () => {
    const r = levelFromXp(150);
    expect(r.level).toBe(2);
    expect(r.levelXp).toBe(100);
    expect(r.nextLevelXp).toBe(xpForLevel(3));
    expect(r.nextLevelXp).toBeGreaterThan(150);
  });

  it('never goes below level 1 on junk input', () => {
    expect(levelFromXp(0).level).toBe(1);
    expect(levelFromXp(-50).level).toBe(1);
  });
});

describe('experienceFromComponents', () => {
  it('weighs the components per XP_WEIGHTS and keeps them on the DTO', () => {
    const c = { turns: 3, toolSuccesses: 5, delegations: 1, heartbeats: 2 };
    const e = experienceFromComponents(c);
    expect(e.xp).toBe(
      3 * XP_WEIGHTS.turn +
        5 * XP_WEIGHTS.toolSuccess +
        1 * XP_WEIGHTS.delegation +
        2 * XP_WEIGHTS.heartbeat,
    );
    expect(e.components).toEqual(c);
    expect(e.level).toBe(levelFromXp(e.xp).level);
  });

  it('a fresh agent is honestly level 1 with zero everything', () => {
    const e = zeroExperience();
    expect(e.level).toBe(1);
    expect(e.xp).toBe(0);
    expect(e.levelXp).toBe(0);
    expect(e.nextLevelXp).toBe(100);
  });
});
