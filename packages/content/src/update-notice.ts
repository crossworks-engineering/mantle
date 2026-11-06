/**
 * The update notice's one stored value (@mantle/client-types
 * dto/update-notice.ts): a brain preference on the anchor row, so every
 * admin switches the same one and every login reads the same one. Whether it
 * still counts is updateNoticeOn's to say, at read time.
 */
import type { StoredUpdateNotice } from '@mantle/client-types';
import { APP_VERSION } from '@mantle/client-types/version';
import { resolveSingleOwnerId } from '@mantle/db';
import { loadProfilePreferences, savePreferencesFor } from './profile-preferences';

/** Switch the notice on (now, on this version) or off, as `userId` (an admin:
 *  the caller's own gate has said so). Returns what is stored now. */
export async function setUpdateNotice(
  userId: string,
  on: boolean,
): Promise<StoredUpdateNotice | undefined> {
  const updateNotice = on ? { setAt: new Date().toISOString(), version: APP_VERSION } : null;
  const prefs = await savePreferencesFor(userId, { updateNotice });
  return prefs.updateNotice ?? undefined;
}

/** The stored notice, from the anchor row (no login needed: the public
 *  GET /api/update-notice reads it). Undefined on a fresh install. */
export async function readUpdateNotice(): Promise<StoredUpdateNotice | undefined> {
  const ownerId = await resolveSingleOwnerId();
  if (!ownerId) return undefined;
  return (await loadProfilePreferences(ownerId)).updateNotice ?? undefined;
}
