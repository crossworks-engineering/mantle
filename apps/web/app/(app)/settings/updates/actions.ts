'use server';

import { requireOwner } from '@/lib/auth';
import {
  checkForUpdate,
  requestUpdate,
  type UpdateCheck,
} from '@/lib/updates';

/** Force-refresh the release check (the cached path renders with the page). */
export async function checkNowAction(): Promise<UpdateCheck> {
  await requireOwner();
  return checkForUpdate(true);
}

/** Ask the updater sidecar to pull + roll to `target` (tag or "latest"). */
export async function requestUpdateAction(
  target: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireOwner();
  return requestUpdate(target);
}
