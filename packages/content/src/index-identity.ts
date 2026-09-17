/**
 * @mantle/content · identity
 *
 * Identity — profile preferences, the always-on identity block, persona and onboarding.
 *
 * Split out of the 962-line index.ts on 2026-09-02 (audit, tier 3). The
 * export lists are UNCHANGED — this package's public surface is exactly what
 * it was. What changed is that adding one export now touches one small file
 * instead of the single barrel that saw 102 commits in 90 days, so two
 * sessions adding a DTO no longer collide. Curation is deliberate here: the
 * alternative, `export *`, would publish every module's internals (tuning
 * constants like EMBED_TEXT_PER_FILE, helpers like renderIdentityBlock) as
 * API nobody chose to promise.
 */

export {
  DEFAULT_PREFERENCES,
  loadProfilePreferences,
  updateProfilePreferences,
  noteInboundChannel,
  isValidTimezone,
  isValidLocale,
  isReminderChannel,
  isStreamThoughtsEnabled,
  resolveThoughtTrailMode,
  isPersistThoughtsEnabled,
  isTeamPrivateReadsEnabled,
  TEAM_PRIVATE_READ_SLUGS,
  resolveThinkingBudget,
  projectThinkingBudget,
  resolveThinkingEffort,
  thinkingEffortForBudget,
  THINKING_EFFORTS,
  THINKING_TIERS,
  type ThinkingEffort,
  projectSiteName,
  projectPeerName,
  PEER_NAME_MAX,
  projectHouseStyle,
  HOUSE_STYLE_MAX,
  projectFontKey,
  projectLogoKey,
  projectLogoType,
  logoVersion,
  LOGO_TYPES,
  projectAvatarPhotoType,
  AVATAR_PHOTO_TYPES,
  BRAIN_PREFERENCE_KEYS,
  loadPreferencesFor,
  savePreferencesFor,
  projectNeatBackground,
  NEAT_BACKGROUND_MAX,
  projectDefaultMode,
  projectTeamHubAppId,
  projectTeamHubTags,
  TEAM_HUB_TAGS_MAX,
  SITE_NAME_MAX,
  type ThoughtTrailMode,
  formatInProfile,
  buildTimeContextLine,
  type ProfilePreferences,
  type ReminderChannel,
} from './profile-preferences';

export {
  applyAutoTimezone,
  decideAutoTimezone,
  locationTrustedForTimezone,
  timezoneForCoords,
  TZ_TRUST_ACCURACY_M,
  type AutoTzDecision,
} from './auto-timezone';

export { buildIdentityContext, buildWorkingNotesContext } from './identity-context';

export {
  PURPOSE_ARCHETYPES,
  PURPOSE_ARCHETYPE_KEYS,
  isPurposeArchetype,
  purposeArchetypeLabel,
  deriveDisplayName,
  type PurposeArchetype,
} from '@mantle/content-core/onboarding-questions';

export {
  PERSONA_PRESETS,
  DEFAULT_PERSONA_NAMES,
  PERSONA_NAME_TOKEN,
  buildPersonaPrompt,
  type PersonaGender,
  type PersonaPresetKey,
  type PersonaPreset,
} from '@mantle/content-core/persona-bank';
