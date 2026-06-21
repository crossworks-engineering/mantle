// Tests for the push-preferences input sanitizer — the write-side boundary for
// PUT /api/push/preferences. A device sends arbitrary JSON; only known, valid
// fields may reach the DB. These pin type-gating, the HH:MM clock format, IANA
// timezone validation, and that unknown/garbage fields are dropped.

import { describe, it, expect } from 'vitest';
import { sanitizePushPrefs } from './preferences-sanitize';

describe('sanitizePushPrefs', () => {
  it('passes through a fully valid patch', () => {
    const patch = {
      assistantMessages: false,
      approvals: true,
      quietEnabled: true,
      quietStart: '23:30',
      quietEnd: '06:15',
      timezone: 'Africa/Johannesburg',
    };
    expect(sanitizePushPrefs(patch)).toEqual(patch);
  });

  it('accepts a partial patch and omits absent fields', () => {
    expect(sanitizePushPrefs({ approvals: false })).toEqual({ approvals: false });
  });

  it('drops unknown fields entirely', () => {
    expect(sanitizePushPrefs({ wat: 1, singleton: true, __proto__: { polluted: true } })).toEqual({});
  });

  it('rejects non-boolean toggles', () => {
    // 'true'/1 are common JSON mistakes — must not be coerced.
    expect(sanitizePushPrefs({ assistantMessages: 'true', approvals: 1, quietEnabled: null })).toEqual({});
  });

  it('keeps a boolean false (not treated as absent)', () => {
    const out = sanitizePushPrefs({ assistantMessages: false, quietEnabled: false });
    expect(out).toEqual({ assistantMessages: false, quietEnabled: false });
  });

  describe('quietStart / quietEnd (HH:MM, 24h)', () => {
    it('accepts boundary-valid times', () => {
      expect(sanitizePushPrefs({ quietStart: '00:00', quietEnd: '23:59' })).toEqual({
        quietStart: '00:00',
        quietEnd: '23:59',
      });
    });

    it('rejects out-of-range, malformed, or non-string times', () => {
      for (const bad of ['24:00', '7:00', '07:0', '07:60', '7am', '', '0730', 700]) {
        expect(sanitizePushPrefs({ quietStart: bad as unknown as string })).toEqual({});
      }
    });
  });

  describe('timezone (IANA)', () => {
    it('accepts a real IANA zone and UTC', () => {
      expect(sanitizePushPrefs({ timezone: 'UTC' })).toEqual({ timezone: 'UTC' });
      expect(sanitizePushPrefs({ timezone: 'America/New_York' })).toEqual({ timezone: 'America/New_York' });
    });

    it('rejects a bogus or non-string zone', () => {
      expect(sanitizePushPrefs({ timezone: 'Not/AZone' })).toEqual({});
      expect(sanitizePushPrefs({ timezone: 42 as unknown as string })).toEqual({});
    });
  });

  it('keeps only the valid fields when a patch mixes good and bad', () => {
    expect(
      sanitizePushPrefs({
        approvals: true, // good
        quietStart: '99:99', // bad time
        timezone: 'Mars/Olympus', // bad zone
        assistantMessages: 'yes', // bad type
      }),
    ).toEqual({ approvals: true });
  });
});
