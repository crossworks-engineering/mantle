// This brain's own stable id (migration 0226, `brain_identity`). A device may
// hold logins on several brains with one OS push token; whoami and every push
// payload name this id so the app can tell the brains apart
// (docs/mobile-companion-backend.md, "Push routing on a device with several
// logins"). A random uuid, not a secret: it names the brain and nothing else.

import { brainIdentity, db } from '@mantle/db';
import { errorMessage } from '@mantle/std';

let cached: Promise<string> | null = null;
let warned = false;

async function load(): Promise<string> {
  const [row] = await db.select({ brainId: brainIdentity.brainId }).from(brainIdentity).limit(1);
  if (row) return row.brainId;
  // Migration 0226 made the row. Only a hand-deleted row lands here: make a
  // new one (another process may have made it first, then theirs stands).
  await db.insert(brainIdentity).values({ singleton: true }).onConflictDoNothing();
  const [made] = await db.select({ brainId: brainIdentity.brainId }).from(brainIdentity).limit(1);
  if (!made) throw new Error('brain_identity has no row');
  return made.brainId;
}

/** The brain id. Read once per process: the id never changes while it runs
 *  (a hand-set new id needs a restart). A failed read is not remembered. */
export function getBrainId(): Promise<string> {
  if (!cached) {
    cached = load().catch((err: unknown) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}

/**
 * The brain id, or null when it cannot be read (the database is behind the
 * code: migration 0226 not applied). The callers leave the field out rather
 * than fail: whoami still answers the role, a push still goes, and the app
 * treats a missing `brainId` as an older brain (it never guesses a session).
 * Said once per process, loudly.
 */
export async function brainIdOrNull(): Promise<string | null> {
  try {
    return await getBrainId();
  } catch (err) {
    if (!warned) {
      warned = true;
      console.error(
        `[brain-identity] cannot read the brain id; whoami and pushes go out without it. ` +
          `Is migration 0226_brain_identity applied? ${errorMessage(err)}`,
      );
    }
    return null;
  }
}

/** `{ brainId }` to spread into an answer, or nothing when the id cannot be
 *  read (whoami and the sign-in answers: additive, never a failure). */
export async function brainIdField(): Promise<{ brainId?: string }> {
  const brainId = await brainIdOrNull();
  return brainId ? { brainId } : {};
}

/** Tests only: forget the cached id and the warning. */
export function resetBrainIdCache(): void {
  cached = null;
  warned = false;
}
