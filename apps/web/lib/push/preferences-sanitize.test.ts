// Tests for the push-preferences input sanitizer — the write-side boundary for
// PUT /api/push/preferences. A device sends arbitrary JSON; only known, valid
// fields may reach the DB. These pin type-gating and that unknown/garbage fields
// are dropped. (Quiet hours were removed — docs/reminder-delivery-routing.md §C.)

import { describe, it, expect } from 'vitest';
import { sanitizePushPrefs } from './preferences-sanitize';

describe('sanitizePushPrefs', () => {
  it('passes through a fully valid patch', () => {
    const patch = { assistantMessages: false, approvals: true };
    expect(sanitizePushPrefs(patch)).toEqual(patch);
  });

  it('accepts a partial patch and omits absent fields', () => {
    expect(sanitizePushPrefs({ approvals: false })).toEqual({ approvals: false });
  });

  it('drops unknown fields entirely', () => {
    expect(sanitizePushPrefs({ wat: 1, singleton: true, __proto__: { polluted: true } })).toEqual({});
  });

  it('drops removed quiet-hours fields', () => {
    // These used to be accepted; after §C they're unknown and must not survive.
    expect(
      sanitizePushPrefs({ quietEnabled: true, quietStart: '23:30', quietEnd: '06:15', timezone: 'UTC' }),
    ).toEqual({});
  });

  it('rejects non-boolean toggles', () => {
    // 'true'/1 are common JSON mistakes — must not be coerced.
    expect(sanitizePushPrefs({ assistantMessages: 'true', approvals: 1 })).toEqual({});
  });

  it('keeps a boolean false (not treated as absent)', () => {
    expect(sanitizePushPrefs({ assistantMessages: false, approvals: false })).toEqual({
      assistantMessages: false,
      approvals: false,
    });
  });

  it('keeps only the valid fields when a patch mixes good and bad', () => {
    expect(
      sanitizePushPrefs({
        approvals: true, // good
        assistantMessages: 'yes', // bad type
        quietStart: '08:00', // removed field
      }),
    ).toEqual({ approvals: true });
  });
});
