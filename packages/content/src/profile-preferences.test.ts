import { describe, expect, it } from 'vitest';
import { isReminderChannel, isStreamThoughtsEnabled } from './profile-preferences';

// Live turn streaming defaults ON: only an explicit `false` disables it, so a
// brain that never touched the toggle (undefined) streams. The server gates
// (turn route 202/blocking + SSE 404) and the Profile UI all key off this.
describe('isStreamThoughtsEnabled', () => {
  it('defaults on when unset', () => {
    expect(isStreamThoughtsEnabled({})).toBe(true);
    expect(isStreamThoughtsEnabled({ streamThoughts: undefined })).toBe(true);
  });

  it('stays on when explicitly true', () => {
    expect(isStreamThoughtsEnabled({ streamThoughts: true })).toBe(true);
  });

  it('is off ONLY for an explicit false', () => {
    expect(isStreamThoughtsEnabled({ streamThoughts: false })).toBe(false);
  });
});

// isReminderChannel is the gate that decides whether an inbound turn's channel
// becomes the user's reminder destination (noteInboundChannel) and whether a
// manual profile write is accepted (updateProfilePreferences). The two
// reminder-capable transports must stick; everything else — including 'web'
// (a browser can't receive an out-of-band push) — must be rejected.
describe('isReminderChannel', () => {
  it('accepts the reminder-capable channels', () => {
    expect(isReminderChannel('telegram')).toBe(true);
    expect(isReminderChannel('mobile')).toBe(true);
  });

  it('rejects the web browser surface', () => {
    // The crux: using the web UI must not steal the reminder target from the
    // phone, since a browser has no push path.
    expect(isReminderChannel('web')).toBe(false);
  });

  it('rejects other channels and junk values', () => {
    for (const v of ['whatsapp', '', 'Telegram', 'MOBILE', null, undefined, 0, {}, []]) {
      expect(isReminderChannel(v)).toBe(false);
    }
  });
});
