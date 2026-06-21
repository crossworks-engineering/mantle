/**
 * Auto-set the profile timezone from the device's location, so a travelling
 * user's clock (and event scheduling / reminders / quiet hours, which all read
 * the profile timezone) stays correct without anyone touching Settings. Driven
 * by the per-turn `location` ping; runs in the turn pipeline (apps/web
 * assistant.ts), which both web and the companion flow through.
 *
 * Two safeguards make this safe to do automatically:
 *
 *  1. Trust gate (locationTrustedForTimezone). We use the device's geolocation
 *     fix, NOT IP — so a VPN doesn't move it. The only way a web fix lands in
 *     the wrong place is the browser's IP fallback (no wifi/GPS), which always
 *     comes back coarse. So: trust GPS/fused unconditionally (mobile-grade);
 *     for a network/other fix require a bounded accuracy, which filters exactly
 *     that IP-fallback case. Mock fixes are never trusted.
 *
 *  2. Hysteresis (lastAutoTimezone). We only act when the freshly-derived zone
 *     differs from the last zone we derived — never re-switching every turn at
 *     the same place, and never fighting a manual override (if the user sets the
 *     zone back by hand, we won't undo it until they actually travel somewhere
 *     new).
 *
 * Derivation is deterministic + offline via tz-lookup (lat/lon → IANA), so it's
 * exact even at DST-edge zones (e.g. Phoenix → America/Phoenix) and costs no API
 * call. The decision (decideAutoTimezone) is a pure function so it's fully
 * unit-testable; applyAutoTimezone is the thin DB-writing wrapper.
 */

/// <reference path="./tz-lookup.d.ts" />
import tzlookup from 'tz-lookup';
import type { LocationPing } from './location-ping';
import {
  isValidTimezone,
  updateProfilePreferences,
  type ProfilePreferences,
} from './profile-preferences';

/** Accuracy ceiling (metres) for trusting a non-GPS fix to pick a timezone.
 *  Generous on purpose — zones are hundreds of km wide, so a city-scale wifi fix
 *  is plenty; the point is only to reject IP-fallback fixes that can land in the
 *  wrong country. */
export const TZ_TRUST_ACCURACY_M = 50_000;

/** Is this fix trustworthy enough to silently change the timezone from? */
export function locationTrustedForTimezone(ping: LocationPing): boolean {
  if (ping.isMock) return false;
  // Mobile-grade fixes are physical by construction.
  if (ping.source === 'gps' || ping.source === 'fused') return true;
  // network / other / unknown (e.g. browser): require a bounded accuracy so an
  // IP-fallback (the VPN/no-signal case) doesn't move the user's clock.
  return ping.accuracy !== undefined && ping.accuracy <= TZ_TRUST_ACCURACY_M;
}

/** Deterministic IANA zone for a coordinate, or null if the lib can't resolve
 *  it (out-of-range / open ocean throws). */
export function timezoneForCoords(latitude: number, longitude: number): string | null {
  try {
    const zone = tzlookup(latitude, longitude);
    return zone && isValidTimezone(zone) ? zone : null;
  } catch {
    return null;
  }
}

export type AutoTzDecision =
  | { action: 'none' }
  /** Derived zone already matches `timezone` — just record it as the last seen
   *  zone (so a later manual override isn't immediately re-derived/acted on). */
  | { action: 'record'; zone: string }
  | { action: 'switch'; zone: string; previous: string };

/** Pure decision: what (if anything) the hook should do for this ping + prefs. */
export function decideAutoTimezone(
  ping: LocationPing | null | undefined,
  prefs: ProfilePreferences,
): AutoTzDecision {
  if (!ping || !locationTrustedForTimezone(ping)) return { action: 'none' };
  const zone = timezoneForCoords(ping.latitude, ping.longitude);
  if (!zone) return { action: 'none' };
  // Hysteresis: we've already handled this derived zone — leave the user's
  // current setting (possibly a manual override) alone.
  if (prefs.lastAutoTimezone === zone) return { action: 'none' };
  if (prefs.timezone === zone) return { action: 'record', zone };
  return { action: 'switch', zone, previous: prefs.timezone };
}

/** Apply the decision, persisting via updateProfilePreferences. Returns the
 *  (possibly updated) prefs and, when a switch happened, the before/after so the
 *  caller can tell the agent to mention it. */
export async function applyAutoTimezone(
  userId: string,
  ping: LocationPing | null | undefined,
  prefs: ProfilePreferences,
): Promise<{ prefs: ProfilePreferences; switched?: { timezone: string; previous: string } }> {
  const decision = decideAutoTimezone(ping, prefs);
  if (decision.action === 'none') return { prefs };
  if (decision.action === 'record') {
    const updated = await updateProfilePreferences(userId, { lastAutoTimezone: decision.zone });
    return { prefs: updated };
  }
  const updated = await updateProfilePreferences(userId, {
    timezone: decision.zone,
    lastAutoTimezone: decision.zone,
  });
  return { prefs: updated, switched: { timezone: decision.zone, previous: decision.previous } };
}
