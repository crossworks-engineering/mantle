import { describe, expect, it } from 'vitest';
import { shareModeOf } from './shares';

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
