/**
 * Profile builtins — let the responder adjust the owner's profile preferences
 * that shape time-aware behaviour. Currently just the timezone, which is the one
 * that bites when the user travels: the per-turn "Current time:" context line,
 * event scheduling defaults, reminders, and quiet-hours all read
 * profiles.preferences.timezone (see @mantle/content profile-preferences). When
 * the user is physically in another timezone the displayed time goes wrong until
 * this is changed — so the agent can fix it in-conversation instead of sending
 * the user to Settings → Profile.
 *
 * The change is PERSISTENT (it's the profile setting, not a per-turn override);
 * the user changes it back when they're home. updateProfilePreferences validates
 * the IANA id before writing, so a typo can't poison downstream formatting.
 */

import { loadProfilePreferences, updateProfilePreferences, isValidTimezone } from '@mantle/content';
import type { BuiltinToolDef } from './types';

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

const set_timezone: BuiltinToolDef = {
  slug: 'set_timezone',
  name: 'Set the profile timezone',
  description:
    "Change the user's profile timezone. Use when the user is in — or travelling to — a different timezone and the 'Current time:' context line is wrong for where they actually are, or when they ask. If you know their location (the Current location line / a reverse-geocoded city), derive the correct IANA zone yourself and set it. PERSISTENT — all times, event scheduling, reminders, and quiet hours follow it until it's changed back — so say what you changed and offer to switch it back when they head home. Returns the new timezone and the current local time in it so you can confirm.",
  inputSchema: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: "IANA timezone id, e.g. 'America/New_York', 'Africa/Johannesburg', 'UTC'",
      },
    },
    required: ['timezone'],
  },
  handler: async (input, ctx) => {
    const timezone = str(input.timezone);
    if (!timezone)
      return { ok: false, error: 'timezone is required (an IANA id like America/New_York)' };
    if (!isValidTimezone(timezone)) {
      return {
        ok: false,
        error: `'${timezone}' is not a recognised IANA timezone. Use a region/city id, e.g. 'America/New_York' or 'Africa/Johannesburg'.`,
      };
    }
    try {
      const before = await loadProfilePreferences(ctx.ownerId);
      if (before.timezone === timezone) {
        const nowLocal = new Intl.DateTimeFormat(before.locale, {
          timeZone: timezone,
          dateStyle: 'full',
          timeStyle: 'short',
        }).format(new Date());
        return {
          ok: true,
          output: { timezone, unchanged: true, current_time_local: nowLocal },
        };
      }
      const after = await updateProfilePreferences(ctx.ownerId, { timezone });
      const nowLocal = new Intl.DateTimeFormat(after.locale, {
        timeZone: after.timezone,
        dateStyle: 'full',
        timeStyle: 'short',
      }).format(new Date());
      ctx.step?.setMeta({ from: before.timezone, to: after.timezone });
      return {
        ok: true,
        output: {
          timezone: after.timezone,
          previous_timezone: before.timezone,
          current_time_local: nowLocal,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const PROFILE_TOOLS: readonly BuiltinToolDef[] = [set_timezone];

export const PROFILE_TOOL_SLUGS: readonly string[] = PROFILE_TOOLS.map((t) => t.slug);
