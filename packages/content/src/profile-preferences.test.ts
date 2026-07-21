import { describe, expect, it } from 'vitest';
import {
  isReminderChannel,
  isStreamThoughtsEnabled,
  isPersistThoughtsEnabled,
  projectSiteName,
  projectTeamHubAppId,
  projectTeamHubTags,
  projectThinkingBudget,
  TEAM_HUB_TAGS_MAX,
  TEAM_HUB_TAG_MAX_LEN,
  resolveThinkingBudget,
  SITE_NAME_MAX,
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

// projectThinkingBudget is the SHARED jsonb→typed projection used by both the
// read (loadProfilePreferences) and return (updateProfilePreferences) paths. It
// guards the exact round-trip regression the feature was written to prevent: a
// stored budget being silently stripped on read. Both projections delegate here
// so they can't drift.
describe('projectThinkingBudget', () => {
  it('keeps a positive integer', () => {
    expect(projectThinkingBudget(4096)).toBe(4096);
  });
  it('floors a fractional value', () => {
    expect(projectThinkingBudget(4096.7)).toBe(4096);
  });
  it('maps unset / zero / negative / non-number to undefined', () => {
    expect(projectThinkingBudget(undefined)).toBeUndefined();
    expect(projectThinkingBudget(0)).toBeUndefined();
    expect(projectThinkingBudget(-100)).toBeUndefined();
    expect(projectThinkingBudget('4096')).toBeUndefined();
    expect(projectThinkingBudget(null)).toBeUndefined();
    expect(projectThinkingBudget(NaN)).toBeUndefined();
  });
});

// projectSiteName follows the same shared-projection contract: read and write
// both delegate here, and unset/blank/garbage means "fall back to the Mantle
// wordmark" rather than rendering an empty header.
describe('projectSiteName', () => {
  it('keeps a plain name, trimmed', () => {
    expect(projectSiteName('Refinery')).toBe('Refinery');
    expect(projectSiteName('  Refinery  ')).toBe('Refinery');
  });
  it('caps at SITE_NAME_MAX chars', () => {
    expect(projectSiteName('x'.repeat(SITE_NAME_MAX + 10))).toBe('x'.repeat(SITE_NAME_MAX));
  });
  it('maps unset / blank / non-string to undefined', () => {
    expect(projectSiteName(undefined)).toBeUndefined();
    expect(projectSiteName('')).toBeUndefined();
    expect(projectSiteName('   ')).toBeUndefined();
    expect(projectSiteName(42)).toBeUndefined();
    expect(projectSiteName(null)).toBeUndefined();
  });
});

// projectTeamHubAppId follows the same shared-projection contract: read and
// write both delegate here. Unset/garbage/'' all mean "no designated hub app"
// (⇒ the built-in hub) — '' is specifically the deliberate clear write, and a
// non-UUID must never survive into the typed prefs where the hub route would
// query with it.
describe('projectTeamHubAppId', () => {
  it('keeps a canonical UUID, case-normalised and trimmed', () => {
    expect(projectTeamHubAppId('4fbc2a5e-9a1d-4f5e-8b3a-0c9d8e7f6a5b')).toBe(
      '4fbc2a5e-9a1d-4f5e-8b3a-0c9d8e7f6a5b',
    );
    expect(projectTeamHubAppId('  4FBC2A5E-9A1D-4F5E-8B3A-0C9D8E7F6A5B  ')).toBe(
      '4fbc2a5e-9a1d-4f5e-8b3a-0c9d8e7f6a5b',
    );
  });
  it("maps '' (the clear write), garbage, and non-strings to undefined", () => {
    expect(projectTeamHubAppId('')).toBeUndefined();
    expect(projectTeamHubAppId('not-a-uuid')).toBeUndefined();
    expect(projectTeamHubAppId('4fbc2a5e9a1d4f5e8b3a0c9d8e7f6a5b')).toBeUndefined();
    expect(projectTeamHubAppId(42)).toBeUndefined();
    expect(projectTeamHubAppId(null)).toBeUndefined();
    expect(projectTeamHubAppId(undefined)).toBeUndefined();
  });
});

// projectTeamHubTags follows the same shared-projection contract: read and
// write both delegate here. The canonical form must match how page tags are
// stored (dedupeTags in pages.ts: trimmed + lowercased) or the curated
// Dashboard sections' `= ANY(nodes.tags)` match silently finds nothing.
describe('projectTeamHubTags', () => {
  it('canonicalises to the stored page-tag form: trimmed, lowercased, deduped, ordered', () => {
    expect(projectTeamHubTags(['  Engineering ', 'features', 'ENGINEERING'])).toEqual([
      'engineering',
      'features',
    ]);
  });
  it('drops blanks and non-strings, keeps the rest', () => {
    expect(projectTeamHubTags(['', '  ', 42, null, 'ok'])).toEqual(['ok']);
  });
  it('caps entries at TEAM_HUB_TAGS_MAX and tag length at TEAM_HUB_TAG_MAX_LEN', () => {
    const many = Array.from({ length: TEAM_HUB_TAGS_MAX + 5 }, (_, i) => `t${i}`);
    expect(projectTeamHubTags(many)).toHaveLength(TEAM_HUB_TAGS_MAX);
    expect(projectTeamHubTags(['x'.repeat(TEAM_HUB_TAG_MAX_LEN + 10)])).toEqual([
      'x'.repeat(TEAM_HUB_TAG_MAX_LEN),
    ]);
  });
  it('maps [] (the clear write), all-garbage arrays, and non-arrays to undefined', () => {
    expect(projectTeamHubTags([])).toBeUndefined();
    expect(projectTeamHubTags(['', 42])).toBeUndefined();
    expect(projectTeamHubTags('engineering')).toBeUndefined();
    expect(projectTeamHubTags(null)).toBeUndefined();
    expect(projectTeamHubTags(undefined)).toBeUndefined();
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
