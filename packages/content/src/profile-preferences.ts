/**
 * Per-user preferences — timezone + locale, persisted on
 * profiles.preferences.
 *
 * Lives in @mantle/content so both apps/web (settings page +
 * formatters) and apps/agent (system-prompt time context) can read
 * the same row without round-trip duplication.
 *
 * Why these two specifically: smallest set that makes time-aware UX
 * work end-to-end. Timezone tells the system what "tomorrow at 3pm"
 * means; locale tells it how to render dates (en-GB vs en-US, etc.).
 * The profile row is auto-created on first access — every
 * authenticated user has one row.
 *
 * Future preferences (display name, theme, default agent slug, …)
 * hang off the same jsonb. Keys we don't recognise on read are
 * silently ignored; the loader returns a typed subset.
 */

import { eq, sql } from 'drizzle-orm';
import { db, profiles } from '@mantle/db';

export type ProfilePreferences = {
  /** IANA timezone, e.g. 'Africa/Johannesburg'. UTC when not set. */
  timezone: string;
  /** BCP-47 locale, e.g. 'en-GB'. Drives date/number/currency
   *  formatting. Falls back to en-GB to match the legacy pinned
   *  format-datetime behaviour, so existing UI doesn't shift for
   *  users who haven't visited /settings/profile yet. */
  locale: string;
  /** DiceBear avatar style id (see apps/web/lib/dicebear). Undefined →
   *  the UI falls back to an initials avatar. */
  avatarStyle?: string;
  /** Seed for the DiceBear avatar; the UI defaults it to the user id when
   *  unset so an avatar still renders. */
  avatarSeed?: string;
};

export const DEFAULT_PREFERENCES: ProfilePreferences = {
  timezone: 'UTC',
  locale: 'en-GB',
};

/** Read prefs jsonb and project to typed shape. Missing keys fall
 *  back to DEFAULT_PREFERENCES. Auto-creates the profile row on
 *  first access. */
export async function loadProfilePreferences(
  userId: string,
): Promise<ProfilePreferences> {
  const [row] = await db
    .select({ preferences: profiles.preferences })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);
  if (!row) {
    // First time we've touched this user — insert with defaults so
    // future updates have a row to UPDATE. Best-effort; if another
    // request races us we'll just see the conflict and move on.
    try {
      await db.insert(profiles).values({
        userId,
        preferences: DEFAULT_PREFERENCES as unknown as Record<string, unknown>,
      });
    } catch {
      // race — fine
    }
    return { ...DEFAULT_PREFERENCES };
  }
  const prefs = (row.preferences ?? {}) as Partial<ProfilePreferences>;
  return {
    timezone:
      typeof prefs.timezone === 'string' && prefs.timezone.length > 0
        ? prefs.timezone
        : DEFAULT_PREFERENCES.timezone,
    locale:
      typeof prefs.locale === 'string' && prefs.locale.length > 0
        ? prefs.locale
        : DEFAULT_PREFERENCES.locale,
    avatarStyle:
      typeof prefs.avatarStyle === 'string' && prefs.avatarStyle.length > 0
        ? prefs.avatarStyle
        : undefined,
    avatarSeed:
      typeof prefs.avatarSeed === 'string' && prefs.avatarSeed.length > 0
        ? prefs.avatarSeed
        : undefined,
  };
}

/** IANA tz validation via Intl.DateTimeFormat — the runtime throws
 *  on unknown ids, so we use that as a 600KB-tz-database-free check. */
export function isValidTimezone(tz: string): boolean {
  if (!tz || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** BCP-47 locale validation via Intl.Locale. */
export function isValidLocale(loc: string): boolean {
  if (!loc || loc.length === 0) return false;
  try {
    new Intl.Locale(loc);
    return true;
  } catch {
    return false;
  }
}

/** Persist new preferences. Merges into the existing jsonb so future
 *  keys aren't wiped by an older-client write. Validates tz + locale
 *  before touching the DB so a typo doesn't store and then break
 *  date formatting downstream. */
export async function updateProfilePreferences(
  userId: string,
  patch: Partial<ProfilePreferences>,
): Promise<ProfilePreferences> {
  if (patch.timezone != null && !isValidTimezone(patch.timezone)) {
    throw new Error(
      `'${patch.timezone}' is not a recognised IANA timezone. Try e.g. 'Africa/Johannesburg' or 'UTC'.`,
    );
  }
  if (patch.locale != null && !isValidLocale(patch.locale)) {
    throw new Error(
      `'${patch.locale}' is not a recognised BCP-47 locale. Try e.g. 'en-GB' or 'en-US'.`,
    );
  }

  const merge = JSON.stringify(patch);
  const [row] = await db
    .insert(profiles)
    .values({
      userId,
      preferences: { ...DEFAULT_PREFERENCES, ...patch } as unknown as Record<
        string,
        unknown
      >,
    })
    .onConflictDoUpdate({
      target: profiles.userId,
      set: {
        preferences: sql`${profiles.preferences} || ${merge}::jsonb`,
        updatedAt: new Date(),
      },
    })
    .returning({ preferences: profiles.preferences });
  const merged = (row?.preferences ?? {}) as Partial<ProfilePreferences>;
  return {
    timezone: merged.timezone ?? DEFAULT_PREFERENCES.timezone,
    locale: merged.locale ?? DEFAULT_PREFERENCES.locale,
    avatarStyle: merged.avatarStyle || undefined,
    avatarSeed: merged.avatarSeed || undefined,
  };
}

/** Format a Date in the user's timezone + locale. Cached per-locale
 *  formatter would be a follow-up optimization; the runtime cost of
 *  constructing one per call is small enough not to bother today. */
export function formatInProfile(
  date: Date,
  prefs: ProfilePreferences,
  opts?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(prefs.locale, {
    timeZone: prefs.timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
    ...opts,
  }).format(date);
}

/** Build the one-line time context string injected into Saskia's
 *  system prompt. Goes ahead of the persona/skills so she has it
 *  available to resolve relative time references. */
export function buildTimeContextLine(prefs: ProfilePreferences, now = new Date()): string {
  // Two pieces of information we want her to have:
  //   1. Current time in the user's timezone (so "today", "tomorrow",
  //      "this Friday" resolve correctly).
  //   2. ISO instant in UTC (so when she calls event_create the
  //      startsAt field can be derived without ambiguity).
  const local = new Intl.DateTimeFormat(prefs.locale, {
    timeZone: prefs.timezone,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(now);
  return (
    `Current time: ${local} (${prefs.timezone}). ` +
    `UTC instant: ${now.toISOString()}. ` +
    `User locale: ${prefs.locale}. ` +
    `When scheduling events, convert the user's natural-language ` +
    `time references to UTC ISO 8601 before calling event_create.`
  );
}
