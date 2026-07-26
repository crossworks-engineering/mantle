import { db, agents, eq, and, resolveSingleOwnerId } from '@mantle/db';
import { loadPreferencesFor, savePreferencesFor, type ProfilePreferences } from '@mantle/content';

/**
 * Onboarding state — a property of the BRAIN, not of a login.
 *
 * Mantle isn't multi-user in the tenant sense: it's ONE brain with one or more
 * logins into it. A brain is set up once, so completion lives on the shared
 * brain-level preferences (`onboardedAt`, ISO — see BRAIN_PREFERENCE_KEYS;
 * jsonb-merged, no migration). Unset ⇒ the (app) shell sends you to the
 * first-run wizard at `/onboarding`; set ⇒ the app renders normally, for
 * EVERY login.
 *
 * That sharing fixes a real trap: keyed per login, a second login had no
 * `onboardedAt`, no `onboardingStep` and owned no agents, so it was walked
 * into the wizard on a fully provisioned brain — and completing it would have
 * provisioned a second agent set under that login's id.
 *
 * `prefs` may be passed in by callers that already loaded it (the shell route
 * loads it for the avatar) to avoid a second round-trip on the hot path — it
 * must come from `loadPreferencesFor`, which resolves the brain-level fields.
 */
export async function isOnboarded(userId: string, prefs?: ProfilePreferences): Promise<boolean> {
  const p = prefs ?? (await loadPreferencesFor(userId));
  if (p.onboardedAt) return true;
  // A wizard in flight (step pref saved, not finished) also has an enabled
  // agent once the provision step ran — the auto-stamp below would bounce a
  // mid-wizard reload out of onboarding with the later steps unseen. Legacy
  // installs never wrote `onboardingStep`, so they still take the stamp path.
  if (p.onboardingStep) return false;
  // Existing installs predate onboarding (no `onboardedAt` was ever stamped).
  // If the BRAIN already has an enabled agent it's clearly set up — treat it
  // as onboarded and stamp it, so the gate never drags a working install into
  // the wizard. Checked against the brain's anchor id, not the caller's: a
  // second login owns no agents of its own and would fail this test forever.
  const brainId = await brainOwnerId(userId);
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.ownerId, brainId), eq(agents.enabled, true)))
    .limit(1);
  if (agent) {
    await markOnboarded(userId);
    return true;
  }
  return false;
}

/** The brain's anchor id, falling back to the caller when there's no anchor to
 *  resolve (fresh install) or the lookup throws (corrupt multi-login state) —
 *  degrading to per-login is better than failing the shell's onboarding gate. */
async function brainOwnerId(userId: string): Promise<string> {
  try {
    return (await resolveSingleOwnerId()) ?? userId;
  } catch {
    return userId;
  }
}

/** Stamp onboarding as complete — on the BRAIN (savePreferencesFor routes
 *  `onboardedAt` to the shared row). Idempotent. */
export async function markOnboarded(userId: string): Promise<void> {
  await savePreferencesFor(userId, { onboardedAt: new Date().toISOString() });
}
