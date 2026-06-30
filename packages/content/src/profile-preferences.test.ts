import { describe, expect, it } from 'vitest';
import {
  isReminderChannel,
  isStreamThoughtsEnabled,
  isPersistThoughtsEnabled,
  resolveThinkingBudget,
  resolveThoughtTrailMode,
} from './profile-preferences';

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

// Persistence defaults ON (the trail survives a reload unless turned off); the
// display mode defaults to 'list' (stacking) unless explicitly 'replace'.
describe('isPersistThoughtsEnabled', () => {
  it('defaults on when unset', () => {
    expect(isPersistThoughtsEnabled({})).toBe(true);
    expect(isPersistThoughtsEnabled({ persistThoughts: undefined })).toBe(true);
  });
  it('is off ONLY for an explicit false', () => {
    expect(isPersistThoughtsEnabled({ persistThoughts: false })).toBe(false);
    expect(isPersistThoughtsEnabled({ persistThoughts: true })).toBe(true);
  });
});

// Thinking is requested only when BOTH gates are open: the live-thinking switch
// is ON (streamThoughts !== false) AND the budget is a positive number. Either
// missing ⇒ 0 (no thinking). This is the per-user replacement for the old
// MANTLE_THINKING_BUDGET env gate.
describe('resolveThinkingBudget', () => {
  it('is 0 when the switch is off, regardless of budget', () => {
    expect(resolveThinkingBudget({ streamThoughts: false, thinkingBudget: 4096 })).toBe(0);
  });

  it('is 0 when the switch is on but the budget is unset or non-positive', () => {
    expect(resolveThinkingBudget({ streamThoughts: true })).toBe(0);
    expect(resolveThinkingBudget({ streamThoughts: true, thinkingBudget: 0 })).toBe(0);
    expect(resolveThinkingBudget({ streamThoughts: true, thinkingBudget: -5 })).toBe(0);
  });

  it('is the budget when the switch is on (incl. default-on) and the budget is positive', () => {
    expect(resolveThinkingBudget({ streamThoughts: true, thinkingBudget: 4096 })).toBe(4096);
    // streamThoughts defaults ON when unset, so a positive budget alone activates.
    expect(resolveThinkingBudget({ thinkingBudget: 1024 })).toBe(1024);
  });

  it('floors a fractional budget', () => {
    expect(resolveThinkingBudget({ streamThoughts: true, thinkingBudget: 1024.9 })).toBe(1024);
  });
});

describe('resolveThoughtTrailMode', () => {
  it("defaults to 'list' when unset or anything but 'replace'", () => {
    expect(resolveThoughtTrailMode({})).toBe('list');
    expect(resolveThoughtTrailMode({ thoughtTrailMode: undefined })).toBe('list');
  });
  it("is 'replace' only when explicitly set", () => {
    expect(resolveThoughtTrailMode({ thoughtTrailMode: 'replace' })).toBe('replace');
    expect(resolveThoughtTrailMode({ thoughtTrailMode: 'list' })).toBe('list');
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
