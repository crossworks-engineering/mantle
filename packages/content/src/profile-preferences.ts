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

// The PURE projections live in @mantle/content-core/profile-projections so
// the settings UI can use them without dragging @mantle/db into the browser
// bundle. Re-exported wholesale, so every name is importable from here too.
export * from '@mantle/content-core/profile-projections';

import {
  DEFAULT_PREFERENCES,
  isReminderChannel,
  isValidLocale,
  isValidTimezone,
  projectAppNav,
  projectAppOpens,
  projectAppPins,
  projectAvatarParts,
  projectAvatarPhotoType,
  projectAvatarTint,
  projectBackgrounds,
  projectDefaultMode,
  projectFontKey,
  projectFontSize,
  projectGrantedGroups,
  projectHomeDesk,
  projectHomeDeskVersion,
  projectHouseStyle,
  projectLogoKey,
  projectLogoType,
  projectNavFavorites,
  projectOnboardingModels,
  projectPeerName,
  projectSiteName,
  projectTeamHubAppId,
  projectTeamHubTags,
  projectThinkingBudget,
  readAvatarStyle,
  readColorTheme,
  readNeatBackground,
  type ProfilePreferences,
} from '@mantle/content-core/profile-projections';

import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { HomeDesk } from '@mantle/client-types';
import { InputError } from '@mantle/std';
import { APP_OPENS_MAX } from '@mantle/client-types/app-nav';
import { profileFlag } from '@mantle/client-types/profile-flags';
import {
  currentWorkspaceScope,
  db,
  onFullSystemRoute,
  pgErrorCode,
  profiles,
  readTransaction,
  resolveSingleOwnerId,
  type ConversationChannel,
} from '@mantle/db';

/** A write of a profile row: on the full route when it runs on a narrow
 *  system exit (viewer.ts FULL_ROUTE_SPOTS 'profile-row'). */
export function profileWrite<T>(fn: () => Promise<T>): Promise<T> {
  return onFullSystemRoute('profile-row', fn);
}

/** Read prefs jsonb and project to typed shape. Missing keys fall
 *  back to DEFAULT_PREFERENCES. Auto-creates the profile row on
 *  first access. */
export async function loadProfilePreferences(userId: string): Promise<ProfilePreferences> {
  // A profile row is its own login's, the brain's (the anchor's: time
  // zone, site name, house style) or, in a scope that holds Admin, any
  // login's: the workspace role's own-login rule (0266) shows exactly those,
  // so every read is in the caller's scope (the Admin assistant answering
  // another Admin user reads the anchor's row there).
  const [row] = await db
    .select({ preferences: profiles.preferences })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);
  if (!row) {
    // First time we've touched this user — insert with defaults so
    // future updates have a row to UPDATE. Best-effort; if another
    // request races us we'll just see the conflict and move on.
    // Safe inside a caller's transaction (a member's app change runs in
    // one): a caught error there would otherwise abort the
    // whole transaction. A personal space's id is no login (a foreign key
    // error), and a conflict does nothing.
    // In its own savepoint (a transaction of its own outside one): a failed
    // insert rolls back only itself and is caught here.
    try {
      await profileWrite(() =>
        db.transaction(async (tx) => {
          await tx
            .insert(profiles)
            .values({
              userId,
              preferences: DEFAULT_PREFERENCES as unknown as Record<string, unknown>,
            })
            .onConflictDoNothing();
        }),
      );
    } catch {
      // not a login (a space's id), or a race: defaults as before
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
    avatarStyle: readAvatarStyle(prefs.avatarStyle),
    avatarTint: projectAvatarTint(prefs.avatarTint),
    backgrounds: projectBackgrounds(prefs.backgrounds),
    neatBackground: readNeatBackground(prefs.neatBackground),
    defaultMode: projectDefaultMode(prefs.defaultMode),
    // The profile booleans read their defaults from PROFILE_FLAGS.
    shareNeat: profileFlag(prefs, 'shareNeat'),
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
    colorTheme: readColorTheme(prefs.colorTheme),
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
    toolsmithRequireApproval: profileFlag(prefs, 'toolsmithRequireApproval'),
    heartbeatEgressGate: profileFlag(prefs, 'heartbeatEgressGate'),
    streamThoughts: profileFlag(prefs, 'streamThoughts'),
    thoughtTrailMode: prefs.thoughtTrailMode === 'replace' ? 'replace' : 'list',
    persistThoughts: profileFlag(prefs, 'persistThoughts'),
    // Clamp defensively — jsonb can hold anything an older/hand write put there.
    // Unset/non-positive ⇒ undefined (no thinking); resolveThinkingBudget also
    // gates on the switch.
    thinkingBudget: projectThinkingBudget(prefs.thinkingBudget),
    remoteMcpEnabled: profileFlag(prefs, 'remoteMcpEnabled'),
    teamPrivateReads: profileFlag(prefs, 'teamPrivateReads'),
    teamHubAppId: projectTeamHubAppId(prefs.teamHubAppId),
    clientSigninSenderId: projectTeamHubAppId(prefs.clientSigninSenderId),
    teamHubTags: projectTeamHubTags(prefs.teamHubTags),
    appNav: projectAppNav(prefs.appNav),
    appPins: projectAppPins(prefs.appPins),
    navFavorites: projectNavFavorites(prefs.navFavorites),
    appOpens: projectAppOpens(prefs.appOpens),
    lastReconciledVersion:
      typeof prefs.lastReconciledVersion === 'string' && prefs.lastReconciledVersion.length > 0
        ? prefs.lastReconciledVersion
        : undefined,
    contentKindGroupsGranted: projectGrantedGroups(prefs.contentKindGroupsGranted),
    workspaceDelegationGranted: projectGrantedGroups(prefs.workspaceDelegationGranted),
  };
}

/**
 * Whether the current scope may write profile row `userId`: profiles'
 * write rule (0302, 'own-login'), the one SQL function its policies call
 * (mantle_profile_writable): the scope's own
 * login's row, or the brain's row when the scope holds the Settings area.
 * System work (no workspace scope) may. The turn's own bookkeeping (the
 * reminder channel, the automatic time zone) asks it first and skips the
 * write a member's or an Admin user's turn without Settings would have
 * refused, so no refusal is logged per turn.
 *
 * A read transaction: inside an open transaction it is a savepoint of it,
 * so a failure here cannot abort the caller's transaction. A refusal
 * (42501: the function not granted, a database before 0302) reads as no;
 * any other error is thrown.
 */
export async function profileRowWritable(userId: string): Promise<boolean> {
  if (!currentWorkspaceScope()) return true;
  try {
    const rows = (await readTransaction((tx) =>
      tx.execute(sql`select "public"."mantle_profile_writable"(${userId}::uuid) as ok`),
    )) as unknown as { ok: boolean | null }[];
    return rows[0]?.ok === true;
  } catch (err) {
    if (pgErrorCode(err) === '42501') return false;
    throw err;
  }
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
    // A scope that may not write the row skips it (a member's turn, an Admin
    // user's without Settings): the database would refuse it every turn.
    // Inside the try: the caller does not wait for this (fire and forget).
    if (!(await profileRowWritable(userId))) return;
    await profileWrite(() =>
      db
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
        }),
    );
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
    throw new InputError(
      `'${patch.timezone}' is not a recognised IANA timezone. Try e.g. 'Africa/Johannesburg' or 'UTC'.`,
    );
  }
  if (patch.locale != null && !isValidLocale(patch.locale)) {
    throw new InputError(
      `'${patch.locale}' is not a recognised BCP-47 locale. Try e.g. 'en-GB' or 'en-US'.`,
    );
  }
  if (patch.reminderChannel != null && !isReminderChannel(patch.reminderChannel)) {
    throw new InputError(
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
    throw new InputError(`'${patch.teamHubAppId}' is not a valid app id (expected a UUID).`);
  }
  // The client sign-in sender (C2b): an email account id, or '' for none.
  if (
    patch.clientSigninSenderId != null &&
    patch.clientSigninSenderId !== '' &&
    projectTeamHubAppId(patch.clientSigninSenderId) === undefined
  ) {
    throw new InputError(
      `'${patch.clientSigninSenderId}' is not a valid email account id (expected a UUID).`,
    );
  }
  if (patch.teamHubTags != null) {
    if (!Array.isArray(patch.teamHubTags) || patch.teamHubTags.some((t) => typeof t !== 'string')) {
      throw new InputError(`teamHubTags must be an array of tag strings.`);
    }
    // Store the canonical form; [] is the deliberate "clear curation" write
    // (projects to undefined on read).
    patch = { ...patch, teamHubTags: projectTeamHubTags(patch.teamHubTags) ?? [] };
  }

  // Never through a patch: the Desk and its version (saveHomeDeskIfVersion
  // only, compare-and-set), and appNav (the apps tree's now, read once to
  // migrate: tree/apps-nav.ts).
  for (const k of [...HOME_DESK_KEYS, 'appNav']) {
    if ((patch as Record<string, unknown>)[k] !== undefined) {
      throw new Error(`${k} is not written by a preference patch.`);
    }
  }
  // Canonical forms; [] is the deliberate "clear" write for both lists.
  if (patch.appPins !== undefined) {
    patch = { ...patch, appPins: projectAppPins(patch.appPins) ?? [] };
  }
  if (patch.navFavorites !== undefined) {
    patch = { ...patch, navFavorites: projectNavFavorites(patch.navFavorites) ?? [] };
  }

  const merge = JSON.stringify(patch);
  const [row] = await profileWrite(() =>
    db
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
      .returning({ preferences: profiles.preferences }),
  );
  const merged = (row?.preferences ?? {}) as Partial<ProfilePreferences>;
  return {
    timezone: merged.timezone ?? DEFAULT_PREFERENCES.timezone,
    lastAutoTimezone: merged.lastAutoTimezone || undefined,
    locale: merged.locale ?? DEFAULT_PREFERENCES.locale,
    avatarStyle: readAvatarStyle(merged.avatarStyle),
    avatarTint: projectAvatarTint(merged.avatarTint),
    backgrounds: projectBackgrounds(merged.backgrounds),
    neatBackground: readNeatBackground(merged.neatBackground),
    defaultMode: projectDefaultMode(merged.defaultMode),
    shareNeat: profileFlag(merged, 'shareNeat'),
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
    colorTheme: readColorTheme(merged.colorTheme),
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
    toolsmithRequireApproval: profileFlag(merged, 'toolsmithRequireApproval'),
    heartbeatEgressGate: profileFlag(merged, 'heartbeatEgressGate'),
    streamThoughts: profileFlag(merged, 'streamThoughts'),
    thoughtTrailMode: merged.thoughtTrailMode === 'replace' ? 'replace' : 'list',
    persistThoughts: profileFlag(merged, 'persistThoughts'),
    thinkingBudget: projectThinkingBudget(merged.thinkingBudget),
    remoteMcpEnabled: profileFlag(merged, 'remoteMcpEnabled'),
    teamPrivateReads: profileFlag(merged, 'teamPrivateReads'),
    teamHubAppId: projectTeamHubAppId(merged.teamHubAppId),
    clientSigninSenderId: projectTeamHubAppId(merged.clientSigninSenderId),
    teamHubTags: projectTeamHubTags(merged.teamHubTags),
    appNav: projectAppNav(merged.appNav),
    appPins: projectAppPins(merged.appPins),
    navFavorites: projectNavFavorites(merged.navFavorites),
    appOpens: projectAppOpens(merged.appOpens),
    lastReconciledVersion: merged.lastReconciledVersion || undefined,
    contentKindGroupsGranted: projectGrantedGroups(merged.contentKindGroupsGranted),
    workspaceDelegationGranted: projectGrantedGroups(merged.workspaceDelegationGranted),
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
  // How the brain's apps are organised: one shared tree, so a team sees the
  // same folders on every device. Pins and open counts stay personal.
  'appNav',
  // Where client sign-in codes are mailed from (client logins C2b): one
  // sender for the brain, whichever admin chose it.
  'clientSigninSenderId',
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
export async function brandRowId(userId: string): Promise<string> {
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

// ── Concurrency-safe writes ────────────────────────────────────────────────
//
// `savePreferencesFor` merges a patch blindly (`preferences || patch`): the
// last write wins, which is right for a theme or a timezone. Two kinds of
// value need more, and both live here so feature code never hand-writes SQL
// against the preferences column: the Desk (compare-and-set on a version)
// and per-id counters (one atomic bump).

/** Where the login's Desk lives on its own profile row: the desk, and the
 *  version beside it (the count of saves that landed). */
const HOME_DESK_KEYS = ['homeDesk', 'homeDeskVersion'] as const;

export type HomeDeskSaveResult =
  | { ok: true; homeDesk: HomeDesk; version: number }
  | { ok: false; homeDesk: HomeDesk | null; version: number };

/**
 * The login's Desk and its version, read from its own profile row in the
 * caller's scope (the profile read rule shows a login its own row). The
 * read is loose (projectHomeDesk): a stored desk is never lost to a
 * stricter rule. `homeDesk` null and `version` 0 until one is saved.
 */
export async function loadHomeDesk(
  loginId: string,
): Promise<{ homeDesk: HomeDesk | null; version: number }> {
  const [row] = await db
    .select({
      desk: sql<unknown>`${profiles.preferences}->'homeDesk'`,
      version: sql<unknown>`${profiles.preferences}->'homeDeskVersion'`,
    })
    .from(profiles)
    .where(eq(profiles.userId, loginId))
    .limit(1);
  return {
    homeDesk: projectHomeDesk(row?.desk) ?? null,
    version: projectHomeDeskVersion(row?.version),
  };
}

/**
 * The stored desk version as the read projects it (projectHomeDeskVersion),
 * in SQL: a whole number from 0 up to the largest safe integer, else 0. So a
 * version that is not one (a string, a fraction, a negative) counts as 0 on
 * the save as on the read, and a save from the version GET answered lands.
 * The CASE casts only a JSON number. 9007199254740991 is
 * Number.MAX_SAFE_INTEGER.
 */
function storedHomeDeskVersion(): SQL {
  const v = sql`(${profiles.preferences}->'homeDeskVersion')`;
  const n = sql`(${v})::numeric`;
  return sql`(case when jsonb_typeof(${v}) <> 'number' then 0::numeric
    when ${n} >= 0 and ${n} = trunc(${n}) and ${n} <= 9007199254740991
    then ${n} else 0::numeric end)`;
}

/**
 * Replace the login's Desk, compare-and-set: one conditional UPDATE of its
 * own profile row, so of two saves sent with the same version exactly one
 * lands. It lands, the version going to `version + 1`, only while the
 * stored version still equals `version` (one that is unset or not a whole
 * number counts as 0, as on the read); otherwise nothing is written and the
 * stored desk and version come back, the other device's save. Personal: the login's own row, in the caller's
 * scope, where the profile write rule (mantle_profile_writable) holds a
 * login to its own row. The caller validates `homeDesk`
 * (validateHomeDeskWrite).
 */
export async function saveHomeDeskIfVersion(
  loginId: string,
  homeDesk: HomeDesk,
  version: number,
): Promise<HomeDeskSaveResult> {
  const next = version + 1;
  // Materialise the row so the conditional UPDATE has one to match.
  await loadProfilePreferences(loginId);
  const patch = JSON.stringify({ homeDesk, homeDeskVersion: next });
  const landed = await profileWrite(() =>
    db
      .update(profiles)
      .set({ preferences: sql`${profiles.preferences} || ${patch}::jsonb`, updatedAt: new Date() })
      .where(and(eq(profiles.userId, loginId), sql`${storedHomeDeskVersion()} = ${version}`))
      .returning({ userId: profiles.userId }),
  );
  if (landed.length > 0) return { ok: true, homeDesk, version: next };
  return { ok: false, ...(await loadHomeDesk(loginId)) };
}

/**
 * Per-id counters (`{ [id]: { n, at } }`), bumped far more often than they are
 * read. Each names its cap and its read projection; the map is trimmed to the
 * cap in batches once it grows `slack` past it, not on every bump.
 */
const COUNTER_PREFERENCES = {
  appOpens: { max: APP_OPENS_MAX, slack: 50, project: projectAppOpens },
} as const;
export type CounterPreferenceKey = keyof typeof COUNTER_PREFERENCES;

/**
 * Add one to counter `id` under `key` and stamp it now. One atomic jsonb
 * update, so concurrent bumps (two tabs, two devices) all count, which a
 * read-modify-write through savePreferencesFor would not. Personal rows only:
 * a counter describes one login's use.
 */
export async function bumpPreferenceCounter(
  userId: string,
  key: CounterPreferenceKey,
  id: string,
): Promise<void> {
  const spec = COUNTER_PREFERENCES[key];
  await loadProfilePreferences(userId);
  const at = new Date().toISOString();
  const map = sql`coalesce(${profiles.preferences}->${key}, '{}'::jsonb)`;
  await profileWrite(async () => {
    const [row] = await db
      .update(profiles)
      .set({
        preferences: sql`jsonb_set(
        ${profiles.preferences},
        ARRAY[${key}]::text[],
        ${map} || jsonb_build_object(
          ${id}::text,
          jsonb_build_object(
            'n', coalesce((${map}->${id}::text->>'n')::int, 0) + 1,
            'at', ${at}::text
          )
        )
      )`,
      })
      .where(eq(profiles.userId, userId))
      .returning({ map: sql<unknown>`${profiles.preferences}->${key}` });
    const stored = row?.map;
    if (
      stored &&
      typeof stored === 'object' &&
      Object.keys(stored).length > spec.max + spec.slack
    ) {
      const trimmed = JSON.stringify(spec.project(stored) ?? {});
      await db
        .update(profiles)
        .set({
          preferences: sql`jsonb_set(${profiles.preferences}, ARRAY[${key}]::text[], ${trimmed}::jsonb)`,
        })
        .where(eq(profiles.userId, userId));
    }
  });
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
