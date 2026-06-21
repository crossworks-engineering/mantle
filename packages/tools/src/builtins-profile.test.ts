/**
 * set_timezone — the responder's in-conversation timezone switch. What matters:
 * a valid IANA id is persisted via updateProfilePreferences and the new local
 * time + previous zone come back for confirmation; an invalid id is rejected
 * BEFORE any write; and re-setting the current zone is a no-op (no write).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const loadProfilePreferences = vi.fn();
const updateProfilePreferences = vi.fn();
// isValidTimezone is a pure Intl check — use the real one so the test exercises
// the actual validation the tool relies on.
vi.mock('@mantle/content', async () => {
  const actual = await vi.importActual<typeof import('@mantle/content')>('@mantle/content');
  return {
    isValidTimezone: actual.isValidTimezone,
    loadProfilePreferences: (...a: unknown[]) => loadProfilePreferences(...a),
    updateProfilePreferences: (...a: unknown[]) => updateProfilePreferences(...a),
  };
});

import { PROFILE_TOOLS } from './builtins-profile';
import type { ToolHandlerResult } from './types';

const set_timezone = PROFILE_TOOLS.find((t) => t.slug === 'set_timezone')!;
const ctx = { ownerId: 'owner-1' } as never;

afterEach(() => {
  vi.restoreAllMocks();
  loadProfilePreferences.mockReset();
  updateProfilePreferences.mockReset();
});

describe('set_timezone', () => {
  it('persists a valid IANA zone and returns the new local time + previous zone', async () => {
    loadProfilePreferences.mockResolvedValue({ timezone: 'Africa/Johannesburg', locale: 'en-GB' });
    updateProfilePreferences.mockResolvedValue({ timezone: 'America/New_York', locale: 'en-GB' });

    const res = (await set_timezone.handler({ timezone: 'America/New_York' }, ctx)) as Extract<
      ToolHandlerResult,
      { ok: true }
    >;

    expect(res.ok).toBe(true);
    expect(updateProfilePreferences).toHaveBeenCalledWith('owner-1', { timezone: 'America/New_York' });
    expect(res.output).toMatchObject({
      timezone: 'America/New_York',
      previous_timezone: 'Africa/Johannesburg',
    });
    expect((res.output as { current_time_local: string }).current_time_local.length).toBeGreaterThan(0);
  });

  it('rejects an invalid timezone without writing', async () => {
    const res = await set_timezone.handler({ timezone: 'Mars/Olympus_Mons' }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not a recognised IANA timezone/i);
    expect(updateProfilePreferences).not.toHaveBeenCalled();
  });

  it('is a no-op write when the zone already matches', async () => {
    loadProfilePreferences.mockResolvedValue({ timezone: 'America/New_York', locale: 'en-US' });

    const res = (await set_timezone.handler({ timezone: 'America/New_York' }, ctx)) as Extract<
      ToolHandlerResult,
      { ok: true }
    >;

    expect(res.ok).toBe(true);
    expect((res.output as { unchanged?: boolean }).unchanged).toBe(true);
    expect(updateProfilePreferences).not.toHaveBeenCalled();
  });

  it('requires a timezone', async () => {
    const res = await set_timezone.handler({}, ctx);
    expect(res.ok).toBe(false);
  });
});
