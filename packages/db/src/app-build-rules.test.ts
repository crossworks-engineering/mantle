import { describe, expect, it } from 'vitest';
import { APP_BUILD_RULES, buildMeetsRules } from './app-build-rules';

describe('buildMeetsRules', () => {
  it('takes the rules a build recorded', () => {
    expect(buildMeetsRules({ builtAt: '2026-01-01T00:00:00Z', rules: APP_BUILD_RULES })).toBe(true);
    expect(buildMeetsRules({ builtAt: '2026-11-01T00:00:00Z', rules: APP_BUILD_RULES - 1 })).toBe(
      false,
    );
    expect(buildMeetsRules({ builtAt: '2026-11-01T00:00:00Z', rules: APP_BUILD_RULES + 1 })).toBe(
      true,
    );
  });

  it('counts a build with no rules as rules 1 from 2026-10-27 on', () => {
    expect(buildMeetsRules({ builtAt: '2026-10-27T00:00:00.000Z' })).toBe(true);
    expect(buildMeetsRules({ builtAt: '2026-11-02T10:00:00Z' })).toBe(true);
    expect(buildMeetsRules({ builtAt: '2026-10-26T23:59:59.999Z' })).toBe(false);
    expect(buildMeetsRules({ builtAt: '2026-10-02T00:00:00.000Z' })).toBe(false);
  });

  it('refuses a build with no rules and a date it cannot read', () => {
    expect(buildMeetsRules({ builtAt: '' })).toBe(false);
    expect(buildMeetsRules({ builtAt: 'not a date' })).toBe(false);
  });
});
