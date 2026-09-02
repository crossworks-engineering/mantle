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

import { eq, sql } from 'drizzle-orm';
import { db, profiles, resolveSingleOwnerId, type ConversationChannel } from '@mantle/db';

/** Resolve the live-streaming preference to a definite boolean — ON unless the
 *  user explicitly turned it off. Use this everywhere instead of reading the
 *  optional field directly, so "unset" reliably means on. */
export function isStreamThoughtsEnabled(
  prefs: Pick<ProfilePreferences, 'streamThoughts'>,
): boolean {
  return prefs.streamThoughts !== false;
}

/** Resolve the trail display mode to a definite value — 'list' unless explicitly
 *  set to 'replace'. */
export function resolveThoughtTrailMode(
  prefs: Pick<ProfilePreferences, 'thoughtTrailMode'>,
): ThoughtTrailMode {
  return prefs.thoughtTrailMode === 'replace' ? 'replace' : 'list';
}

/** Whether the thought trail is persisted onto the finished message — ON unless
 *  the user explicitly turned it off. */
export function isPersistThoughtsEnabled(
  prefs: Pick<ProfilePreferences, 'persistThoughts'>,
): boolean {
  return prefs.persistThoughts !== false;
}

/** Builtin read tools that reach the owner's PRIVATE corpus (email + journal).
 *  The Team Chat responder holds these via the `team-read` group, but they only
 *  actually reach the model when the owner has opted in (`teamPrivateReads`).
 *  Stripped from a team turn's tool set otherwise — see run-team-turn.ts. */
export const TEAM_PRIVATE_READ_SLUGS: readonly string[] = [
  'email_list',
  'email_get',
  'journal_list',
  'journal_get',
];

/** Whether the external Team Chat responder may read the owner's private corpus
 *  (email + journal) for a team member. **Defaults OFF** — an explicit opt-in,
 *  since it exposes the owner's personal correspondence and journal to an
 *  external member. Non-private brain-knowledge reads are always allowed. */
export function isTeamPrivateReadsEnabled(
  prefs: Pick<ProfilePreferences, 'teamPrivateReads'>,
): boolean {
  return prefs.teamPrivateReads === true;
}

/** Project a stored `thinkingBudget` jsonb value to the typed field — a positive
 *  integer, or undefined for unset/garbage/non-positive. Shared by BOTH the read
 *  (`loadProfilePreferences`) and return (`updateProfilePreferences`) projections
 *  so the two can't drift — that drift is exactly what originally dropped the
 *  field on read and left the feature silently dead. */
export function projectThinkingBudget(raw: unknown): number | undefined {
  return typeof raw === 'number' && raw > 0 ? Math.floor(raw) : undefined;
}

/** Cap on a stored site name — generous for a wordmark; the header truncates
 *  visually anyway, this just keeps garbage-length strings out of the row. */
export const SITE_NAME_MAX = 40;

/** Project a stored `siteName` jsonb value — trimmed, non-empty, capped at
 *  {@link SITE_NAME_MAX} chars, or undefined for unset/blank/garbage (⇒ the UI
 *  falls back to the Mantle wordmark). Shared by BOTH the read and write
 *  projections so they can't drift (the projectThinkingBudget lesson). */
export function projectSiteName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim().slice(0, SITE_NAME_MAX);
  return trimmed.length > 0 ? trimmed : undefined;
}

export const PEER_NAME_MAX = 40;

/** Project a stored `peerName` — the header-centre federation label. Same
 *  contract as projectSiteName: trimmed, capped, empty ⇒ undefined (unset). */
export function projectPeerName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim().slice(0, PEER_NAME_MAX);
  return trimmed.length > 0 ? trimmed : undefined;
}

export const HOUSE_STYLE_MAX = 2000;

/** Project a stored `houseStyle` — the owner's writing conventions, injected
 *  into every composed system prompt. Trimmed, capped at {@link
 *  HOUSE_STYLE_MAX} chars, empty ⇒ undefined (no block emitted).
 *
 *  The cap is a prompt-budget guard, not a validation: this text rides in the
 *  cached prefix of EVERY turn on every agent, so an accidental paste of a
 *  whole style guide would tax each one. 2000 chars is ~500 tokens, which is
 *  room for a dozen real rules. Same read+write sharing contract as the other
 *  projectors. */
export function projectHouseStyle(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim().slice(0, HOUSE_STYLE_MAX);
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Project a stored `logoKey` — must be the exact content-addressed shape
 *  @mantle/storage's contentKey emits, so a hand-edited row can never point
 *  the public logo route at an arbitrary object. Same read+write sharing
 *  contract as the other projectors. */
export function projectLogoKey(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  return /^attachments\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(raw) ? raw : undefined;
}

/** The image types the logo upload accepts — svg for crisp brand marks, the
 *  three raster staples for everyone else. The serve route replays ONLY a
 *  projected value, so an unlisted type can never reach a Content-Type. */
export const LOGO_TYPES = ['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp'] as const;

export function projectLogoType(raw: unknown): string | undefined {
  return typeof raw === 'string' && (LOGO_TYPES as readonly string[]).includes(raw)
    ? raw
    : undefined;
}

/** Cache-busting logo version for clients — the first 8 hex of the sha in
 *  the content-addressed key. null when no logo is set. */
export function logoVersion(logoKey: string | undefined): string | null {
  const projected = projectLogoKey(logoKey);
  return projected ? projected.slice(-64).slice(0, 8) : null;
}

/** The raster types the profile PHOTO accepts. A photo is never an SVG —
 *  that alone removes the logo route's whole active-content problem class.
 *  Same replay contract as LOGO_TYPES: the serve route emits only a
 *  projected value, so an unlisted type can never reach a Content-Type. */
export const AVATAR_PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export function projectAvatarPhotoType(raw: unknown): string | undefined {
  return typeof raw === 'string' && (AVATAR_PHOTO_TYPES as readonly string[]).includes(raw)
    ? raw
    : undefined;
}

/** Project a stored `colorTheme` jsonb value — a slug-shaped theme id, or
 *  undefined for unset/garbage (⇒ the default theme). The theme LIST lives in
 *  the web app (server/web/lib/themes.ts); the server stores any well-formed id
 *  and the client falls back to the default for ids it doesn't know, so a
 *  theme added or removed in the UI never strands the stored preference. */
export function projectColorTheme(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(t) ? t : undefined;
}

/** Project a stored font key (`fontLogo` / `fontTitle`) — a slug-shaped display
 *  font id, or undefined for unset/garbage. Same lenient contract as
 *  projectColorTheme: the font LIST lives in the web app, so the server only
 *  shape-checks and the client resolves unknown keys to the default. */
export function projectFontKey(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(t) ? t : undefined;
}

/** Project a stored `avatarStyle` — a slug-shaped avatar style id, or undefined
 *  for unset/garbage. Same lenient contract as projectColorTheme: the style
 *  REGISTRY lives in the web layer (@mantle/web-ui/avatar), so the server only
 *  shape-checks. That is deliberate — it also lets the legacy boring-avatars
 *  ids ('beam', 'marble', …) survive storage untouched and be translated to a
 *  shipped style on read, so no stored avatar had to be migrated. */
export function projectAvatarStyle(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(t) ? t : undefined;
}

/** Project stored avatar-builder choices: component → pinned variant | null
 *  ("hide"). Shape-checked only, same contract as projectAvatarStyle — which
 *  components a style actually has is web-layer knowledge, and stale entries
 *  are dropped at RENDER time so a style switch never invalidates a row.
 *  Empty/garbage → undefined (= seed only). Names follow DiceBear's camelCase
 *  identifier pattern; the entry cap is a storage guard. */
const AVATAR_PART_NAME = /^[a-z][a-zA-Z0-9]{0,63}$/;
export function projectAvatarParts(raw: unknown): Record<string, string | null> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!AVATAR_PART_NAME.test(k)) continue;
    if (v === null) out[k] = null;
    else if (typeof v === 'string' && AVATAR_PART_NAME.test(v)) out[k] = v;
    if (Object.keys(out).length >= 64) break;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Project a stored `backgrounds` map, `area=style` pairs, comma separated.
 *
 * Shape-checked only, exactly like projectAvatarStyle and for the same reason:
 * the AREA and STYLE registries both live in the web layer
 * (@mantle/web-ui/backgrounds), and duplicating either here would create two
 * lists to keep in step. Unknown areas and unknown styles are dropped on READ
 * by `decodeBackgrounds`, so a value that survives storage can still never
 * reach the document unvalidated.
 *
 * The cap is a storage guard, not a semantic one: a handful of areas exist, and
 * an unbounded string on a preferences row is somebody else's outage.
 */
export const BACKGROUNDS_MAX = 200;

export function projectBackgrounds(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim().toLowerCase();
  if (!t) return undefined;
  if (t.length > BACKGROUNDS_MAX) return undefined;
  return /^[a-z0-9-]+=[a-z0-9-]+(,[a-z0-9-]+=[a-z0-9-]+)*$/.test(t) ? t : undefined;
}

/**
 * Project a stored `neatBackground` — the whole-surface animated gradient's
 * spec, compact JSON `{v:1, seed, tone, speed}`.
 *
 * Shape-checked only, the projectBackgrounds contract: colours and the full
 * shader parameter derivation live in the web layer
 * (@mantle/web-ui/neat-background), and the client decodes defensively again
 * on read, so a value that survives storage still never reaches WebGL
 * unvalidated. The cap is a storage guard — a canonical spec is ~60 chars.
 */
export const NEAT_BACKGROUND_MAX = 200;

export function projectNeatBackground(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  if (!t || t.length > NEAT_BACKGROUND_MAX) return undefined;
  try {
    const o = JSON.parse(t) as Record<string, unknown>;
    if (!o || typeof o !== 'object' || o.v !== 1) return undefined;
    if (typeof o.seed !== 'number' || !Number.isInteger(o.seed) || o.seed < 0) return undefined;
    if (o.tone !== 'auto' && o.tone !== 'darker' && o.tone !== 'lighter') return undefined;
    if (typeof o.speed !== 'number' || !Number.isFinite(o.speed) || o.speed < 0) return undefined;
    return t;
  } catch {
    return undefined;
  }
}

/** Project a stored `defaultMode` — the brain's default light/dark mode for
 *  surfaces without a visitor choice (the public /s share reader). A closed
 *  set like avatarTint, validated by value: there is no registry to fall back
 *  through, and an unknown value would flip a public page's entire palette.
 *  Anything else ⇒ unset ⇒ 'light' (the share surface's historical look). */
export function projectDefaultMode(raw: unknown): 'light' | 'dark' | 'system' | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim().toLowerCase();
  return t === 'light' || t === 'dark' || t === 'system' ? t : undefined;
}

/** Project a stored font size (the interface scale and the three local ones).
 *  A closed set like avatarTint, validated by value: an unknown size would
 *  rescale the entire interface and there is no registry to fall back through.
 *  Anything else ⇒ unset ⇒ 'medium'. */
export function projectFontSize(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim().toLowerCase();
  return t === 'xsmall' || t === 'small' || t === 'medium' || t === 'large' ? t : undefined;
}

/** Project a stored `avatarTint`. Unlike the style this IS a closed set, so it
 *  is validated by value: an unknown tint would change how every avatar in the
 *  brain looks, and there is no registry in the web layer to fall back through.
 *  Anything else stores as unset ⇒ the default ('mixed'). */
export function projectAvatarTint(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim().toLowerCase();
  return t === 'native' || t === 'mixed' || t === 'theme' ? t : undefined;
}

/** Effective per-turn thinking budget in tokens — gated by BOTH the live-thinking
 *  switch (`streamThoughts`) AND a positive `thinkingBudget`. Returns 0 when
 *  either is missing, so real reasoning is requested only when the user has
 *  explicitly opted into both. This is the gate that replaced the per-box
 *  `MANTLE_THINKING_BUDGET` env var. NOTE: the magnitude is further clamped at
 *  turn time against the agent's `max_tokens` (see tool-loop.ts) so a budget
 *  ≥ max_tokens can't 400 the reasoning providers. */
export function resolveThinkingBudget(
  prefs: Pick<ProfilePreferences, 'streamThoughts' | 'thinkingBudget'>,
): number {
  if (!isStreamThoughtsEnabled(prefs)) return 0;
  return projectThinkingBudget(prefs.thinkingBudget) ?? 0;
}

// The tier vocabulary lives in a leaf module with no imports so the settings UI
// can use the values without pulling @mantle/db into the browser bundle.
// Re-exported here so server-side callers keep importing from one place.
export {
  THINKING_EFFORTS,
  THINKING_TIERS,
  thinkingEffortForBudget,
  type ThinkingEffort,
} from './thinking-tiers';
// Also imported (not just re-exported) because resolveThinkingEffort below uses them.
import { thinkingEffortForBudget, type ThinkingEffort } from './thinking-tiers';
import type { ProfilePreferences } from '@mantle/client-types';
import type {
  ReminderChannel,
  ThoughtTrailMode,
  OnboardingModelChoices,
} from '@mantle/client-types';
import { UUID_RE } from '@mantle/std';

export type { ReminderChannel, ThoughtTrailMode, OnboardingModelChoices };
export type { ProfilePreferences };

/** Effective per-turn thinking EFFORT — the control that actually reaches the
 *  providers today. Same double gate as {@link resolveThinkingBudget} (the
 *  live-thinking switch AND a positive budget); undefined means "don't ask for
 *  reasoning", which adapters render by omitting the field entirely. */
export function resolveThinkingEffort(
  prefs: Pick<ProfilePreferences, 'streamThoughts' | 'thinkingBudget'>,
): ThinkingEffort | undefined {
  return thinkingEffortForBudget(resolveThinkingBudget(prefs));
}

/** Whitelist projection for {@link OnboardingModelChoices} — same contract as
 *  projectThinkingBudget: read and write MUST share this, or the field gets
 *  silently dropped on read. */
export function projectOnboardingModels(raw: unknown): OnboardingModelChoices | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);
  const out: OnboardingModelChoices = {
    assistantModel: str(o.assistantModel),
    workerModel: str(o.workerModel),
    route: o.route === 'azure' ? 'azure' : o.route === 'openrouter' ? 'openrouter' : undefined,
    azureBaseUrl: str(o.azureBaseUrl),
  };
  return out.assistantModel || out.workerModel || out.route ? out : undefined;
}

/** Project a stored `teamHubAppId` jsonb value — a canonical UUID string, or
 *  undefined for unset/garbage (⇒ built-in hub). Shared by BOTH the read and
 *  write projections so they can't drift (the projectThinkingBudget lesson). */
export function projectTeamHubAppId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim().toLowerCase();
  return UUID_RE.test(trimmed) ? trimmed : undefined;
}

/** Cap on curated Dashboard tag sections — enough for a rich overview, small
 *  enough that the member Dashboard stays a dashboard and the section fan-out
 *  stays a handful of cheap indexed queries. */
export const TEAM_HUB_TAGS_MAX = 8;

/** Per-tag length cap — matches the /api/pages tag schema (max 40 chars) so a
 *  stored curation tag can always have been a real node tag. */
export const TEAM_HUB_TAG_MAX_LEN = 40;

/** Project a stored `teamHubTags` jsonb value — an ordered list of trimmed,
 *  lowercased, deduped, non-empty tag strings capped at
 *  {@link TEAM_HUB_TAGS_MAX} entries, or undefined for unset/empty/garbage
 *  (⇒ no curated sections). Lowercased because node tags are matched with
 *  `= ANY(nodes.tags)` — pages dedupe tags case-insensitively on save, so the
 *  lowercase form is the canonical one. Shared by BOTH the read and write
 *  projections so they can't drift (the projectThinkingBudget lesson). */
export function projectTeamHubTags(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const t = v.trim().toLowerCase().slice(0, TEAM_HUB_TAG_MAX_LEN);
    if (t.length === 0 || out.includes(t)) continue;
    out.push(t);
    if (out.length >= TEAM_HUB_TAGS_MAX) break;
  }
  return out.length > 0 ? out : undefined;
}

export const DEFAULT_PREFERENCES: ProfilePreferences = {
  timezone: 'UTC',
  locale: 'en-GB',
};

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

/** IANA tz validation via Intl.DateTimeFormat — the runtime throws
 *  on unknown ids, so we use that as a 600KB-tz-database-free check. */
export function isValidTimezone(tz: string): boolean {
  if (!tz || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** BCP-47 locale validation via Intl.Locale. */
export function isValidLocale(loc: string): boolean {
  if (!loc || loc.length === 0) return false;
  try {
    new Intl.Locale(loc);
    return true;
  } catch {
    return false;
  }
}

/** Narrow an unknown value to a deliverable ReminderChannel. */
export function isReminderChannel(v: unknown): v is ReminderChannel {
  return v === 'telegram' || v === 'mobile';
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
