// Input sanitizer for PUT /api/push/preferences. Accepts an arbitrary JSON body
// and returns a clean partial patch: only known fields with the right type (and,
// for times/timezone, a valid value) survive. Unknown/invalid fields are
// dropped, never trusted. Kept pure (no DB/auth) so it's unit-testable.

import type { PushPreferences } from './store';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function sanitizePushPrefs(body: Record<string, unknown>): Partial<PushPreferences> {
  const patch: Partial<PushPreferences> = {};
  if (typeof body['assistantMessages'] === 'boolean') patch.assistantMessages = body['assistantMessages'];
  if (typeof body['approvals'] === 'boolean') patch.approvals = body['approvals'];
  if (typeof body['quietEnabled'] === 'boolean') patch.quietEnabled = body['quietEnabled'];
  if (typeof body['quietStart'] === 'string' && HHMM.test(body['quietStart'])) patch.quietStart = body['quietStart'];
  if (typeof body['quietEnd'] === 'string' && HHMM.test(body['quietEnd'])) patch.quietEnd = body['quietEnd'];
  if (typeof body['timezone'] === 'string' && isValidTimezone(body['timezone'])) patch.timezone = body['timezone'];
  return patch;
}
