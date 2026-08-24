import { describe, expect, it } from 'vitest';
import { BRAIN_PREFERENCE_KEYS, projectNeatBackground } from './profile-preferences';

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
      'fontUi',
      'fontSize',
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

  it('shares the avatar STYLE and TINT but not the avatar', () => {
    // The style is the visual language every generated avatar in the brain is
    // drawn in — branding, like the theme and the fonts, and set in the same
    // Appearance screen. Personal, it would mean one admin's pick silently
    // failed to apply to the agents everyone sees. The SEED stays personal, so
    // two admins still share a style and never an avatar.
    expect(BRAIN_PREFERENCE_KEYS).toContain('avatarStyle');
    expect(BRAIN_PREFERENCE_KEYS).toContain('avatarTint');
    expect(BRAIN_PREFERENCE_KEYS).not.toContain('avatarSeed');
  });

  it('leaves genuinely personal preferences alone', () => {
    // How ONE person works — two admins in different timezones, with
    // different avatars and reminder routing, must not fight over these.
    for (const k of [
      'timezone',
      'locale',
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

  it('shares the generated background — the look of the product', () => {
    // Rendered by /api/appearance for every visitor's first paint (and the
    // login screen), so it lives with backgrounds/colorTheme on the anchor row.
    expect(BRAIN_PREFERENCE_KEYS).toContain('neatBackground');
  });

  it('has no duplicates', () => {
    expect(new Set(BRAIN_PREFERENCE_KEYS).size).toBe(BRAIN_PREFERENCE_KEYS.length);
  });
});

describe('projectNeatBackground', () => {
  it('passes a well-formed spec through untouched', () => {
    const spec = '{"v":1,"seed":123456,"tone":"auto","speed":2}';
    expect(projectNeatBackground(spec)).toBe(spec);
  });

  it('stores garbage as unset, never as an error', () => {
    for (const bad of [
      undefined,
      42,
      '',
      'not json',
      '{"v":2,"seed":1,"tone":"auto","speed":2}', // unknown version
      '{"v":1,"seed":-1,"tone":"auto","speed":2}', // negative seed
      '{"v":1,"seed":1.5,"tone":"auto","speed":2}', // fractional seed
      '{"v":1,"seed":1,"tone":"loud","speed":2}', // unknown tone
      '{"v":1,"seed":1,"tone":"auto","speed":-3}', // negative speed
      `{"v":1,"seed":1,"tone":"auto","speed":2,"pad":"${'x'.repeat(300)}"}`, // over cap
    ]) {
      expect(projectNeatBackground(bad), String(bad).slice(0, 40)).toBeUndefined();
    }
  });
});
