import { describe, expect, it } from 'vitest';
import { TEAM_TOKEN_LENGTH, generateTeamToken, hashTeamToken } from './team-tokens';

describe('generateTeamToken', () => {
  it('produces tokens of the fixed length', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateTeamToken()).toHaveLength(TEAM_TOKEN_LENGTH);
    }
  });

  it('never emits look-alike characters (0/O/o, 1/l/I)', () => {
    const banned = /[0Oo1lI]/;
    for (let i = 0; i < 200; i++) {
      expect(generateTeamToken()).not.toMatch(banned);
    }
  });

  it('stays within the mixed-case alphanumeric alphabet', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateTeamToken()).toMatch(/^[A-Za-z2-9]+$/);
    }
  });

  it('does not repeat (sanity check on entropy plumbing)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateTeamToken());
    expect(seen.size).toBe(1000);
  });
});

describe('hashTeamToken', () => {
  it('is deterministic sha256 hex', () => {
    const t = 'Akk34DMx';
    expect(hashTeamToken(t)).toBe(hashTeamToken(t));
    expect(hashTeamToken(t)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs across tokens', () => {
    expect(hashTeamToken('Akk34DMx')).not.toBe(hashTeamToken('Akk34DMy'));
  });
});
