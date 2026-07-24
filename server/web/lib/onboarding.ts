import { db, agents, eq, and } from '@mantle/db';
import {
  loadProfilePreferences,
  updateProfilePreferences,
  type ProfilePreferences,
} from '@mantle/content';

/**
 * Onboarding state. Completion is a single flag on `profiles.preferences`
 * (`onboardedAt`, ISO) — no migration, jsonb-merged like every other pref.
 * Unset ⇒ the (app) shell sends the user to the first-run wizard at
 * `/onboarding`; set ⇒ the app renders normally.
 *
 * `prefs` may be passed in by callers that already loaded it (the (app) layout
 * loads it for the avatar) to avoid a second round-trip on the hot path.
 */
export async function isOnboarded(userId: string, prefs?: ProfilePreferences): Promise<boolean> {
  const p = prefs ?? (await loadProfilePreferences(userId));
  if (p.onboardedAt) return true;
  // A wizard in flight (step pref saved, not finished) also has an enabled
  // agent once the provision step ran — the auto-stamp below would bounce a
  // mid-wizard reload out of onboarding with the later steps unseen. Legacy
  // installs never wrote `onboardingStep`, so they still take the stamp path.
  if (p.onboardingStep) return false;
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
