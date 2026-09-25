import { describe, expect, it } from 'vitest';
import { levelForShareMode, shareCascadeOf, shareModeForLevel, shareModeOf } from './shares';

describe('shareModeOf', () => {
  it('defaults every pre-existing share to public', () => {
    expect(shareModeOf({ settings: {} })).toBe('public');
    expect(shareModeOf({ settings: null as unknown as Record<string, unknown> })).toBe('public');
  });

  it('reads team mode from settings', () => {
    expect(shareModeOf({ settings: { mode: 'team' } })).toBe('team');
  });

  it('treats junk modes as public (fail-open to the WEAKER capability set)', () => {
    // 'public' is the more restricted tier on the brokers (read-only tools,
    // query-only db), so unknown values degrade safely.
    expect(shareModeOf({ settings: { mode: 'admin' } })).toBe('public');
    expect(shareModeOf({ settings: { mode: 42 } })).toBe('public');
  });
});

describe('shareCascadeOf', () => {
  it('defaults to false when unset (pre-existing shares never cascade)', () => {
    expect(shareCascadeOf({ settings: {} })).toBe(false);
    expect(shareCascadeOf({ settings: null as unknown as Record<string, unknown> })).toBe(false);
    expect(shareCascadeOf({ settings: { mode: 'team' } })).toBe(false);
  });

  it('reads cascade only from a strict boolean true', () => {
    expect(shareCascadeOf({ settings: { cascade: true } })).toBe(true);
    expect(shareCascadeOf({ settings: { mode: 'team', cascade: true } })).toBe(true);
    expect(shareCascadeOf({ settings: { cascade: false } })).toBe(false);
    expect(shareCascadeOf({ settings: { cascade: 'yes' } })).toBe(false);
  });
});

describe('levels drive links', () => {
  it('maps each level to the link it needs', () => {
    expect(shareModeForLevel('admin')).toBeNull();
    expect(shareModeForLevel('team')).toBe('team');
    expect(shareModeForLevel('client')).toBe('public');
    expect(shareModeForLevel('public')).toBe('public');
  });

  it('derives admin from no link and team from a team-only link', () => {
    expect(levelForShareMode('public', null)).toBe('admin');
    expect(levelForShareMode('admin', 'team')).toBe('team');
    expect(levelForShareMode('public', 'team')).toBe('team');
  });

  it('keeps client or public under an open link, drops anything higher to public', () => {
    expect(levelForShareMode('client', 'public')).toBe('client');
    expect(levelForShareMode('public', 'public')).toBe('public');
    expect(levelForShareMode('admin', 'public')).toBe('public');
    expect(levelForShareMode('team', 'public')).toBe('public');
  });

  it("puts a cascading parent's sub-pages at the parent's open level", () => {
    expect(levelForShareMode('public', 'public', 'client')).toBe('client');
    expect(levelForShareMode('admin', 'public', 'client')).toBe('client');
    expect(levelForShareMode('client', 'public', 'public')).toBe('public');
    // A team parent's sub-pages carry team-only links: the mode decides.
    expect(levelForShareMode('admin', 'team', 'team')).toBe('team');
  });

  it('round-trips every level through its link', () => {
    for (const level of ['admin', 'team', 'client', 'public'] as const) {
      expect(levelForShareMode(level, shareModeForLevel(level))).toBe(level);
    }
  });
});
