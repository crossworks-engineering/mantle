/**
 * Per-user preferences — timezone + locale, persisted on
 * profiles.preferences.
 *
 * Lives in @mantle/content so both server/web (settings page +
 * formatters) and server/api (system-prompt time context) can read
 * the same row without round-trip duplication.
 *
 * Why these two specifically: smallest set that makes time-aware UX
 * work end-to-end. Timezone tells the system what "tomorrow at 3pm"
 * means; locale tells it how to render dates (en-GB vs en-US, etc.).
 * The profile row is auto-created on first access — every
 * authenticated user has one row.
 *
 * Future preferences (display name, theme, default agent slug, …)
 * hang off the same jsonb. Keys we don't recognise on read are
 * silently ignored; the loader returns a typed subset.
 */

// The PURE projections moved to @mantle/content-core/profile-projections
// (audit 2026-09-02, tier 3) so the settings UI can use them without dragging
// @mantle/db into the browser bundle. Re-exported wholesale: every name this
// module used to export still comes from this module.
export * from '@mantle/content-core/profile-projections';

import {
  DEFAULT_PREFERENCES,
  isReminderChannel,
  isValidLocale,
  isValidTimezone,
  projectAvatarParts,
  projectAvatarPhotoType,
  projectAvatarStyle,
  projectAvatarTint,
  projectBackgrounds,
  projectColorTheme,
  projectDefaultMode,
  projectFontKey,
  projectFontSize,
  projectHouseStyle,
  projectLogoKey,
  projectLogoType,
  projectNeatBackground,
  projectOnboardingModels,
  projectPeerName,
  projectSiteName,
  projectTeamHubAppId,
  projectTeamHubTags,
  projectThinkingBudget,
  type ProfilePreferences,
} from '@mantle/content-core/profile-projections';

import { eq, sql } from 'drizzle-orm';
import { db, profiles, resolveSingleOwnerId, type ConversationChannel } from '@mantle/db';

/** Read prefs jsonb and project to typed shape. Missing keys fall
 *  back to DEFAULT_PREFERENCES. Auto-creates the profile row on
 *  first access. */
export async function loadProfilePreferences(userId: string): Promise<ProfilePreferences> {
  const [row] = await db
    .select({ preferences: profiles.preferences })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);
  if (!row) {
    // First time we've touched this user — insert with defaults so
    // future updates have a row to UPDATE. Best-effort; if another
    // request races us we'll just see the conflict and move on.
    try {
      await db.insert(profiles).values({
        userId,
        preferences: DEFAULT_PREFERENCES as unknown as Record<string, unknown>,
      });
    } catch {
      // race — fine
    }
    return { ...DEFAULT_PREFERENCES };
  }
  const prefs = (row.preferences ?? {}) as Partial<ProfilePreferences>;
  return {
    timezone:
      typeof prefs.timezone === 'string' && prefs.timezone.length > 0
        ? prefs.timezone
        : DEFAULT_PREFERENCES.timezone,
    lastAutoTimezone:
      typeof prefs.lastAutoTimezone === 'string' && prefs.lastAutoTimezone.length > 0
        ? prefs.lastAutoTimezone
        : undefined,
    locale:
      typeof prefs.locale === 'string' && prefs.locale.length > 0
        ? prefs.locale
        : DEFAULT_PREFERENCES.locale,
    avatarStyle: projectAvatarStyle(prefs.avatarStyle),
    avatarTint: projectAvatarTint(prefs.avatarTint),
    backgrounds: projectBackgrounds(prefs.backgrounds),
    neatBackground: projectNeatBackground(prefs.neatBackground),
    defaultMode: projectDefaultMode(prefs.defaultMode),
    // Default ON: only an explicit `false` disables (the streamThoughts contract).
    shareNeat: prefs.shareNeat !== false,
    avatarSeed:
      typeof prefs.avatarSeed === 'string' && prefs.avatarSeed.length > 0
        ? prefs.avatarSeed
        : undefined,
    avatarParts: projectAvatarParts(prefs.avatarParts),
    avatarPhotoKey: projectLogoKey(prefs.avatarPhotoKey),
    avatarPhotoType: projectAvatarPhotoType(prefs.avatarPhotoType),
    reminderAgentSlug:
      typeof prefs.reminderAgentSlug === 'string' && prefs.reminderAgentSlug.length > 0
        ? prefs.reminderAgentSlug
        : undefined,
    reminderChannel: isReminderChannel(prefs.reminderChannel) ? prefs.reminderChannel : undefined,
    displayName:
      typeof prefs.displayName === 'string' && prefs.displayName.length > 0
        ? prefs.displayName
        : undefined,
    siteName: projectSiteName(prefs.siteName),
    peerName: projectPeerName(prefs.peerName),
    houseStyle: projectHouseStyle(prefs.houseStyle),
    colorTheme: projectColorTheme(prefs.colorTheme),
    fontLogo: projectFontKey(prefs.fontLogo),
    fontTitle: projectFontKey(prefs.fontTitle),
    fontUi: projectFontKey(prefs.fontUi),
    fontProse: projectFontKey(prefs.fontProse),
    fontSize: projectFontSize(prefs.fontSize),
    fontLogoSize: projectFontSize(prefs.fontLogoSize),
    fontTitleSize: projectFontSize(prefs.fontTitleSize),
    fontProseSize: projectFontSize(prefs.fontProseSize),
    logoKey: projectLogoKey(prefs.logoKey),
    logoType: projectLogoType(prefs.logoType),
    logoDarkKey: projectLogoKey(prefs.logoDarkKey),
    logoDarkType: projectLogoType(prefs.logoDarkType),
    purpose:
      typeof prefs.purpose === 'string' && prefs.purpose.length > 0 ? prefs.purpose : undefined,
    purposeArchetype:
      typeof prefs.purposeArchetype === 'string' && prefs.purposeArchetype.length > 0
        ? prefs.purposeArchetype
        : undefined,
    onboardedAt:
      typeof prefs.onboardedAt === 'string' && prefs.onboardedAt.length > 0
        ? prefs.onboardedAt
        : undefined,
    onboardingStep:
      typeof prefs.onboardingStep === 'string' && prefs.onboardingStep.length > 0
        ? prefs.onboardingStep
        : undefined,
    onboardingModels: projectOnboardingModels(prefs.onboardingModels),
    toolsmithRequireApproval: prefs.toolsmithRequireApproval === true,
    heartbeatEgressGate: prefs.heartbeatEgressGate === true,
    // Default ON: only an explicit `false` disables (matches isStreamThoughtsEnabled).
    streamThoughts: prefs.streamThoughts !== false,
    thoughtTrailMode: prefs.thoughtTrailMode === 'replace' ? 'replace' : 'list',
    persistThoughts: prefs.persistThoughts !== false,
    // Clamp defensively — jsonb can hold anything an older/hand write put there.
    // Unset/non-positive ⇒ undefined (no thinking); resolveThinkingBudget also
    // gates on the switch.
    thinkingBudget: projectThinkingBudget(prefs.thinkingBudget),
    // Default OFF: only an explicit `true` exposes the remote MCP connector.
    remoteMcpEnabled: prefs.remoteMcpEnabled === true,
    // Default OFF: team members can't read the owner's email/journal unless
    // explicitly opted in.
    teamPrivateReads: prefs.teamPrivateReads === true,
    teamHubAppId: projectTeamHubAppId(prefs.teamHubAppId),
    teamHubTags: projectTeamHubTags(prefs.teamHubTags),
    lastReconciledVersion:
      typeof prefs.lastReconciledVersion === 'string' && prefs.lastReconciledVersion.length > 0
        ? prefs.lastReconciledVersion
        : undefined,
  };
}

/**
 * Record the channel an inbound turn arrived on as the user's reminder
 * destination, so proactive delivery follows the surface they last used. Only
 * reminder-capable channels stick: 'telegram' and 'mobile'. 'web' (browser) and
 * any other channel are ignored — a browser can't receive an out-of-band push,
 * so using it must not steal the reminder target away from the phone.
 *
 * Best-effort and idempotent: the write is gated to only fire when the value
 * actually changes (no per-turn churn), and upserts so a brand-new user's first
 * message still lands. Callers invoke it fire-and-forget (`void`) — a failure
 * here must never break the turn.
 */
export async function noteInboundChannel(
  userId: string,
  channel: ConversationChannel,
): Promise<void> {
  if (!isReminderChannel(channel)) return;
  const merge = JSON.stringify({ reminderChannel: channel });
  try {
    await db
      .insert(profiles)
      .values({
        userId,
        preferences: { ...DEFAULT_PREFERENCES, reminderChannel: channel } as unknown as Record<
          string,
          unknown
        >,
      })
      .onConflictDoUpdate({
        target: profiles.userId,
        set: {
          preferences: sql`${profiles.preferences} || ${merge}::jsonb`,
          updatedAt: new Date(),
        },
        // Skip the write when it's already this channel — avoids bumping
        // updatedAt on every turn from the same surface.
        setWhere: sql`coalesce(${profiles.preferences}->>'reminderChannel', '') <> ${channel}`,
      });
  } catch (err) {
    console.error('[profile] noteInboundChannel failed:', err instanceof Error ? err.message : err);
  }
}

/** Persist new preferences. Merges into the existing jsonb so future
 *  keys aren't wiped by an older-client write. Validates tz + locale
 *  before touching the DB so a typo doesn't store and then break
 *  date formatting downstream. */
export async function updateProfilePreferences(
  userId: string,
  patch: Partial<ProfilePreferences>,
): Promise<ProfilePreferences> {
  if (patch.timezone != null && !isValidTimezone(patch.timezone)) {
    throw new Error(
      `'${patch.timezone}' is not a recognised IANA timezone. Try e.g. 'Africa/Johannesburg' or 'UTC'.`,
    );
  }
  if (patch.locale != null && !isValidLocale(patch.locale)) {
    throw new Error(
      `'${patch.locale}' is not a recognised BCP-47 locale. Try e.g. 'en-GB' or 'en-US'.`,
    );
  }
  if (patch.reminderChannel != null && !isReminderChannel(patch.reminderChannel)) {
    throw new Error(
      `'${patch.reminderChannel}' is not a valid reminder channel ('telegram' | 'mobile').`,
    );
  }
  // '' is the deliberate "clear designation" write (projects to undefined on
  // read); anything else must be a UUID so garbage never lands in the row.
  if (
    patch.teamHubAppId != null &&
    patch.teamHubAppId !== '' &&
    projectTeamHubAppId(patch.teamHubAppId) === undefined
  ) {
    throw new Error(`'${patch.teamHubAppId}' is not a valid app id (expected a UUID).`);
  }
  if (patch.teamHubTags != null) {
    if (!Array.isArray(patch.teamHubTags) || patch.teamHubTags.some((t) => typeof t !== 'string')) {
      throw new Error(`teamHubTags must be an array of tag strings.`);
    }
    // Store the canonical form; [] is the deliberate "clear curation" write
    // (projects to undefined on read).
    patch = { ...patch, teamHubTags: projectTeamHubTags(patch.teamHubTags) ?? [] };
  }

  const merge = JSON.stringify(patch);
  const [row] = await db
    .insert(profiles)
    .values({
      userId,
      preferences: { ...DEFAULT_PREFERENCES, ...patch } as unknown as Record<string, unknown>,
    })
    .onConflictDoUpdate({
      target: profiles.userId,
      set: {
        preferences: sql`${profiles.preferences} || ${merge}::jsonb`,
        updatedAt: new Date(),
      },
    })
    .returning({ preferences: profiles.preferences });
  const merged = (row?.preferences ?? {}) as Partial<ProfilePreferences>;
  return {
    timezone: merged.timezone ?? DEFAULT_PREFERENCES.timezone,
    lastAutoTimezone: merged.lastAutoTimezone || undefined,
    locale: merged.locale ?? DEFAULT_PREFERENCES.locale,
    avatarStyle: projectAvatarStyle(merged.avatarStyle),
    avatarTint: projectAvatarTint(merged.avatarTint),
    backgrounds: projectBackgrounds(merged.backgrounds),
    neatBackground: projectNeatBackground(merged.neatBackground),
    defaultMode: projectDefaultMode(merged.defaultMode),
    shareNeat: merged.shareNeat !== false,
    avatarSeed: merged.avatarSeed || undefined,
    avatarParts: projectAvatarParts(merged.avatarParts),
    avatarPhotoKey: projectLogoKey(merged.avatarPhotoKey),
    avatarPhotoType: projectAvatarPhotoType(merged.avatarPhotoType),
    reminderAgentSlug: merged.reminderAgentSlug || undefined,
    reminderChannel: isReminderChannel(merged.reminderChannel) ? merged.reminderChannel : undefined,
    displayName: merged.displayName || undefined,
    siteName: projectSiteName(merged.siteName),
    peerName: projectPeerName(merged.peerName),
    houseStyle: projectHouseStyle(merged.houseStyle),
    colorTheme: projectColorTheme(merged.colorTheme),
    fontLogo: projectFontKey(merged.fontLogo),
    fontTitle: projectFontKey(merged.fontTitle),
    fontUi: projectFontKey(merged.fontUi),
    fontProse: projectFontKey(merged.fontProse),
    fontSize: projectFontSize(merged.fontSize),
    fontLogoSize: projectFontSize(merged.fontLogoSize),
    fontTitleSize: projectFontSize(merged.fontTitleSize),
    fontProseSize: projectFontSize(merged.fontProseSize),
    logoKey: projectLogoKey(merged.logoKey),
    logoType: projectLogoType(merged.logoType),
    logoDarkKey: projectLogoKey(merged.logoDarkKey),
    logoDarkType: projectLogoType(merged.logoDarkType),
    purpose: merged.purpose || undefined,
    purposeArchetype: merged.purposeArchetype || undefined,
    onboardedAt: merged.onboardedAt || undefined,
    onboardingStep: merged.onboardingStep || undefined,
    onboardingModels: projectOnboardingModels(merged.onboardingModels),
    toolsmithRequireApproval: merged.toolsmithRequireApproval === true,
    heartbeatEgressGate: merged.heartbeatEgressGate === true,
    streamThoughts: merged.streamThoughts !== false,
    thoughtTrailMode: merged.thoughtTrailMode === 'replace' ? 'replace' : 'list',
    persistThoughts: merged.persistThoughts !== false,
    thinkingBudget: projectThinkingBudget(merged.thinkingBudget),
    remoteMcpEnabled: merged.remoteMcpEnabled === true,
    teamPrivateReads: merged.teamPrivateReads === true,
    teamHubAppId: projectTeamHubAppId(merged.teamHubAppId),
    teamHubTags: projectTeamHubTags(merged.teamHubTags),
    lastReconciledVersion: merged.lastReconciledVersion || undefined,
  };
}

/**
 * ── Brain-level vs personal preferences ──────────────────────────────────────
 *
 * Preference rows are keyed by user, but not every preference describes a
 * USER. These describe the BRAIN — its identity, its brand, its mission — and
 * every surface that renders them (the public /api/appearance first-paint
 * stamp, /s shares, /print, /team, and every agent's identity block) resolves
 * them from the ANCHOR owner's row, because a brain has exactly one of each.
 *
 * Mantle is multi-trusted-admin by design: a handful of peers, no privilege
 * tiers. So these are SHARED, not owned — any signed-in user reads and writes
 * the same record, and the change is visible to everyone immediately. Before
 * this split a second user's edits landed in their own row, which nothing
 * brand-facing read: themes diverged from the first-paint stamp, site names
 * showed only in that user's own header, and an uploaded logo produced a
 * BROKEN IMAGE (the version came from their row, the bytes from the anchor's).
 *
 * Everything NOT listed here stays personal — timezone, locale, avatar,
 * reminder routing, thinking/streaming prefs — because those describe how one
 * person works, and two admins should differ freely.
 */
export const BRAIN_PREFERENCE_KEYS = [
  'siteName',
  'peerName',
  // How this BRAIN writes, not how one login works — so two admins can't
  // hold contradictory house styles while one agent set serves both.
  'houseStyle',
  'colorTheme',
  'fontLogo',
  'fontTitle',
  'fontUi',
  'fontProse',
  'fontSize',
  'fontLogoSize',
  'fontTitleSize',
  'fontProseSize',
  // The avatar STYLE is branding, like the theme and the fonts: it sets the
  // visual language every generated avatar in the brain is drawn in, so it
  // cannot be one admin's private choice. `avatarSeed` stays personal — that
  // is what still makes each person's avatar theirs.
  'avatarStyle',
  'avatarTint',
  // Same argument as avatarStyle: which surfaces carry a generated background
  // is the brain's look, not one admin's preference.
  'backgrounds',
  'neatBackground',
  // The share reader's default mode is the public face of the brand, exactly
  // like the theme it applies to — and so is whether its background paints
  // at all.
  'defaultMode',
  'shareNeat',
  'logoKey',
  'logoType',
  'logoDarkKey',
  'logoDarkType',
  'purpose',
  'purposeArchetype',
  // Onboarding is the BRAIN's, not a login's: a brain is set up once. Keying
  // it per login sent every additional login through the first-run wizard on
  // a fully provisioned brain — and finishing it would have provisioned a
  // SECOND agent set under that login's id (a parallel half-brain).
  'onboardedAt',
  'onboardingStep',
  'onboardingModels',
] as const satisfies ReadonlyArray<keyof ProfilePreferences>;

type BrainPreferenceKey = (typeof BRAIN_PREFERENCE_KEYS)[number];

function isBrainKey(k: string): k is BrainPreferenceKey {
  return (BRAIN_PREFERENCE_KEYS as readonly string[]).includes(k);
}

/**
 * Which row holds the brain-level preferences. The anchor owner's — the same
 * row /api/appearance and every share surface already read. Falls back to
 * `userId` when there's no anchor to resolve (fresh install) or the lookup
 * throws (corrupt multi-user state): degrading to per-user is strictly better
 * than failing a settings save.
 */
async function brandRowId(userId: string): Promise<string> {
  try {
    return (await resolveSingleOwnerId()) ?? userId;
  } catch {
    return userId;
  }
}

/**
 * Read preferences AS ONE USER SEES THEM: brain-level fields from the anchor
 * row, personal fields from their own. On a single-user brain (the default)
 * this is exactly `loadProfilePreferences`, one query.
 *
 * Use this for the owner-facing settings/shell surfaces. Background callers
 * that already operate on the anchor's tree (agents, workers, /s, /team) keep
 * calling `loadProfilePreferences(ownerId)` — same row, no extra work.
 */
export async function loadPreferencesFor(userId: string): Promise<ProfilePreferences> {
  const brandId = await brandRowId(userId);
  if (brandId === userId) return loadProfilePreferences(userId);
  const [own, brand] = await Promise.all([
    loadProfilePreferences(userId),
    loadProfilePreferences(brandId),
  ]);
  const merged = { ...own };
  for (const k of BRAIN_PREFERENCE_KEYS) {
    (merged as Record<string, unknown>)[k] = brand[k];
  }
  return merged;
}

/**
 * Save preferences from one user's edit: brain-level fields land on the anchor
 * row (shared — every admin edits the same brand), personal fields on their
 * own. Returns the same merged view `loadPreferencesFor` produces, so a form
 * can render straight from the response.
 */
export async function savePreferencesFor(
  userId: string,
  patch: Partial<ProfilePreferences>,
): Promise<ProfilePreferences> {
  const brandId = await brandRowId(userId);
  if (brandId === userId) return updateProfilePreferences(userId, patch);

  const brandPatch: Partial<ProfilePreferences> = {};
  const ownPatch: Partial<ProfilePreferences> = {};
  for (const [k, v] of Object.entries(patch)) {
    const target = isBrainKey(k) ? brandPatch : ownPatch;
    (target as Record<string, unknown>)[k] = v;
  }
  // Personal write first: it carries the validated timezone/locale, so a bad
  // value throws before the shared brand row is touched.
  const own = Object.keys(ownPatch).length
    ? await updateProfilePreferences(userId, ownPatch)
    : await loadProfilePreferences(userId);
  const brand = Object.keys(brandPatch).length
    ? await updateProfilePreferences(brandId, brandPatch)
    : await loadProfilePreferences(brandId);
  const merged = { ...own };
  for (const k of BRAIN_PREFERENCE_KEYS) {
    (merged as Record<string, unknown>)[k] = brand[k];
  }
  return merged;
}

/** Format a Date in the user's timezone + locale. Cached per-locale
 *  formatter would be a follow-up optimization; the runtime cost of
 *  constructing one per call is small enough not to bother today. */
export function formatInProfile(
  date: Date,
  prefs: ProfilePreferences,
  opts?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(prefs.locale, {
    timeZone: prefs.timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
    ...opts,
  }).format(date);
}

/** Build the one-line time context string injected into Saskia's
 *  system prompt. Goes ahead of the persona/skills so she has it
 *  available to resolve relative time references. */
export function buildTimeContextLine(prefs: ProfilePreferences, now = new Date()): string {
  // Two pieces of information we want her to have:
  //   1. Current time in the user's timezone (so "today", "tomorrow",
  //      "this Friday" resolve correctly).
  //   2. ISO instant in UTC (so when she calls event_create the
  //      startsAt field can be derived without ambiguity).
  const local = new Intl.DateTimeFormat(prefs.locale, {
    timeZone: prefs.timezone,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(now);
  return (
    `Current time: ${local} (${prefs.timezone}). ` +
    `UTC instant: ${now.toISOString()}. ` +
    `User locale: ${prefs.locale}. ` +
    `When scheduling events, convert the user's natural-language ` +
    `time references to UTC ISO 8601 before calling event_create.`
  );
}
