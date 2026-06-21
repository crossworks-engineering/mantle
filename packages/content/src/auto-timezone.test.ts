/**
 * Auto-timezone — the trust gate, deterministic lat/lon→IANA derivation, and the
 * hysteresis-aware decision. The decider is pure (real tz-lookup, real
 * coordinates), so these assert the actual behaviour a travelling user sees.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decideAutoTimezone,
  locationTrustedForTimezone,
  timezoneForCoords,
} from './auto-timezone';
import type { LocationPing } from './location-ping';
import type { ProfilePreferences } from './profile-preferences';

const BOSTON = { latitude: 42.3601, longitude: -71.0589 };
const JOBURG = { latitude: -26.2041, longitude: 28.0473 };

function ping(p: Partial<LocationPing>): LocationPing {
  return { latitude: 0, longitude: 0, timestamp: '2026-06-21T12:00:00Z', ...p };
}
function prefs(p: Partial<ProfilePreferences>): ProfilePreferences {
  return { timezone: 'UTC', locale: 'en-GB', ...p };
}

describe('locationTrustedForTimezone', () => {
  it('trusts GPS / fused fixes (mobile-grade) regardless of accuracy', () => {
    expect(locationTrustedForTimezone(ping({ ...BOSTON, source: 'gps' }))).toBe(true);
    expect(locationTrustedForTimezone(ping({ ...BOSTON, source: 'fused', accuracy: 9000 }))).toBe(true);
  });

  it('never trusts a mock fix', () => {
    expect(locationTrustedForTimezone(ping({ ...BOSTON, source: 'gps', isMock: true }))).toBe(false);
  });

  it('trusts a network fix only when accuracy is bounded (filters IP/VPN fallback)', () => {
    expect(locationTrustedForTimezone(ping({ ...BOSTON, source: 'network', accuracy: 40 }))).toBe(true);
    expect(locationTrustedForTimezone(ping({ ...BOSTON, source: 'network', accuracy: 60_000 }))).toBe(false);
    expect(locationTrustedForTimezone(ping({ ...BOSTON, source: 'network' }))).toBe(false); // no accuracy
  });
});

describe('timezoneForCoords', () => {
  it('resolves IANA zones deterministically, incl. the no-DST edge case', () => {
    expect(timezoneForCoords(BOSTON.latitude, BOSTON.longitude)).toBe('America/New_York');
    expect(timezoneForCoords(JOBURG.latitude, JOBURG.longitude)).toBe('Africa/Johannesburg');
    expect(timezoneForCoords(33.4484, -112.074)).toBe('America/Phoenix');
  });

  it('returns null for out-of-range coordinates', () => {
    expect(timezoneForCoords(999, 999)).toBeNull();
  });
});

describe('decideAutoTimezone', () => {
  it('does nothing without a ping or when the fix is untrusted', () => {
    expect(decideAutoTimezone(null, prefs({}))).toEqual({ action: 'none' });
    expect(
      decideAutoTimezone(ping({ ...BOSTON, source: 'network', accuracy: 90_000 }), prefs({})),
    ).toEqual({ action: 'none' });
  });

  it('switches when a trusted fix is in a different zone than the profile', () => {
    const d = decideAutoTimezone(
      ping({ ...BOSTON, source: 'gps' }),
      prefs({ timezone: 'Africa/Johannesburg' }),
    );
    expect(d).toEqual({ action: 'switch', zone: 'America/New_York', previous: 'Africa/Johannesburg' });
  });

  it('only records (no switch) when the derived zone already matches the profile', () => {
    const d = decideAutoTimezone(ping({ ...BOSTON, source: 'gps' }), prefs({ timezone: 'America/New_York' }));
    expect(d).toEqual({ action: 'record', zone: 'America/New_York' });
  });

  it('respects a manual override via hysteresis (lastAutoTimezone already this zone)', () => {
    // User auto-switched to NY earlier, then manually set it back to Joburg.
    // Same place next turn → leave their choice alone.
    const d = decideAutoTimezone(
      ping({ ...BOSTON, source: 'gps' }),
      prefs({ timezone: 'Africa/Johannesburg', lastAutoTimezone: 'America/New_York' }),
    );
    expect(d).toEqual({ action: 'none' });
  });

  it('switches again when the user actually travels to a new zone', () => {
    // Was in the US (lastAuto NY, currently NY); now physically in Joburg.
    const d = decideAutoTimezone(
      ping({ ...JOBURG, source: 'gps' }),
      prefs({ timezone: 'America/New_York', lastAutoTimezone: 'America/New_York' }),
    );
    expect(d).toEqual({ action: 'switch', zone: 'Africa/Johannesburg', previous: 'America/New_York' });
  });
});

describe('applyAutoTimezone', () => {
  afterEach(() => vi.restoreAllMocks());

  it('persists timezone + lastAutoTimezone on a switch and reports it', async () => {
    const mod = await import('./profile-preferences');
    const spy = vi
      .spyOn(mod, 'updateProfilePreferences')
      .mockResolvedValue(prefs({ timezone: 'America/New_York', lastAutoTimezone: 'America/New_York' }));
    const { applyAutoTimezone } = await import('./auto-timezone');

    const res = await applyAutoTimezone(
      'user-1',
      ping({ ...BOSTON, source: 'gps' }),
      prefs({ timezone: 'Africa/Johannesburg' }),
    );

    expect(spy).toHaveBeenCalledWith('user-1', {
      timezone: 'America/New_York',
      lastAutoTimezone: 'America/New_York',
    });
    expect(res.switched).toEqual({ timezone: 'America/New_York', previous: 'Africa/Johannesburg' });
  });
});
