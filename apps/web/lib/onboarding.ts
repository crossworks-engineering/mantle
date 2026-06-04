import { redirect } from 'next/navigation';
import { db, agents, eq, and } from '@mantle/db';
import { loadProfilePreferences, updateProfilePreferences } from '@mantle/content';

/**
 * Onboarding state. Completion is a single flag on `profiles.preferences`
 * (`onboardedAt`, ISO) — no migration, jsonb-merged like every other pref.
 * Unset ⇒ the (app) shell sends the user to the first-run wizard at
 * `/onboarding`; set ⇒ the app renders normally.
 */

export async function isOnboarded(userId: string): Promise<boolean> {
  const prefs = await loadProfilePreferences(userId);
  if (prefs.onboardedAt) return true;
  // Existing installs predate onboarding (no `onboardedAt` was ever stamped).
  // If the user already has an enabled agent, they're clearly set up — treat
  // them as onboarded and stamp it, so the gate never drags a working install
  // into the wizard.
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.ownerId, userId), eq(agents.enabled, true)))
    .limit(1);
  if (agent) {
    await markOnboarded(userId);
    return true;
  }
  return false;
}

/** Stamp onboarding as complete. Idempotent. */
export async function markOnboarded(userId: string): Promise<void> {
  await updateProfilePreferences(userId, { onboardedAt: new Date().toISOString() });
}

/**
 * Page-level gate: send a logged-in but not-yet-onboarded user to the wizard.
 * Call AFTER requireOwner() in the (app) layout. The wizard lives outside the
 * (app) group so it isn't gated by itself (no redirect loop).
 */
export async function requireOnboarded(userId: string): Promise<void> {
  if (!(await isOnboarded(userId))) redirect('/onboarding');
}
