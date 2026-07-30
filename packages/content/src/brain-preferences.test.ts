import { describe, expect, it } from 'vitest';
import { BRAIN_PREFERENCE_KEYS } from './profile-preferences';

/**
 * Mantle is multi-trusted-admin: a handful of peers, no privilege tiers. So a
 * preference either describes THE BRAIN (shared — every admin edits the one
 * record, everyone sees it) or A USER (personal — two admins differ freely).
 * This test pins which is which, because the failure mode of getting it wrong
 * is silent: a field that should be shared lands in a row nothing reads, and
 * the admin's edit simply does nothing.
 */
describe('BRAIN_PREFERENCE_KEYS', () => {
  it('carries every field the brand surfaces render', () => {
    // These are read by /api/appearance (first paint, all origins), the /s
    // share + /print surfaces, and /team — all from the ANCHOR row. Anything
    // rendered there but missing here becomes a per-user ghost setting.
    for (const k of [
      'siteName',
      'peerName',
      'colorTheme',
      'fontLogo',
      'fontTitle',
      'logoKey',
      'logoType',
      'logoDarkKey',
      'logoDarkType',
    ]) {
      expect(BRAIN_PREFERENCE_KEYS, k).toContain(k);
    }
  });

  it('shares the house style — one brain writes one way', () => {
    // composeSystemPromptWithSkills appends it to EVERY agent's prompt from the
    // anchor row. Keyed per login, a second admin's rule would silently apply
    // to the same agents the first admin reads, or not at all.
    expect(BRAIN_PREFERENCE_KEYS).toContain('houseStyle');
  });

  it('carries the brain mission, which every agent turn injects', () => {
    // identity-context builds "# Purpose of this brain" from the anchor's row.
    expect(BRAIN_PREFERENCE_KEYS).toContain('purpose');
    expect(BRAIN_PREFERENCE_KEYS).toContain('purposeArchetype');
  });

  it('leaves genuinely personal preferences alone', () => {
    // How ONE person works — two admins in different timezones, with
    // different avatars and reminder routing, must not fight over these.
    for (const k of [
      'timezone',
      'locale',
      'avatarStyle',
      'avatarSeed',
      'displayName',
      'reminderAgentSlug',
      'reminderChannel',
      'streamThoughts',
      'thoughtTrailMode',
      'persistThoughts',
      'thinkingBudget',
    ]) {
      expect(BRAIN_PREFERENCE_KEYS, k).not.toContain(k);
    }
  });

  it('shares onboarding — a brain is set up ONCE, not once per login', () => {
    // Keyed per login this was a trap: an added login had no onboardedAt, no
    // onboardingStep and owned no agents, so the shell walked it into the
    // first-run wizard on a fully provisioned brain — and finishing would
    // have provisioned a second agent set under that login's id.
    expect(BRAIN_PREFERENCE_KEYS).toContain('onboardedAt');
    expect(BRAIN_PREFERENCE_KEYS).toContain('onboardingStep');
    expect(BRAIN_PREFERENCE_KEYS).toContain('onboardingModels');
  });

  it('has no duplicates', () => {
    expect(new Set(BRAIN_PREFERENCE_KEYS).size).toBe(BRAIN_PREFERENCE_KEYS.length);
  });
});
