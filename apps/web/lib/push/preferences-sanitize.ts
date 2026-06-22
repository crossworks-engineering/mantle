// Input sanitizer for PUT /api/push/preferences. Accepts an arbitrary JSON body
// and returns a clean partial patch: only known fields with the right type
// survive. Unknown/invalid fields are dropped, never trusted. Kept pure (no
// DB/auth) so it's unit-testable.

import type { PushPreferences } from './store';

export function sanitizePushPrefs(body: Record<string, unknown>): Partial<PushPreferences> {
  const patch: Partial<PushPreferences> = {};
  if (typeof body['assistantMessages'] === 'boolean') patch.assistantMessages = body['assistantMessages'];
  if (typeof body['approvals'] === 'boolean') patch.approvals = body['approvals'];
  return patch;
}
