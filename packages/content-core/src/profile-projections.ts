/**
 * @mantle/content-core · profile projections
 *
 * The PURE half of profile preferences: whitelist projections for every jsonb
 * field, the size caps, the thinking-budget/effort resolvers and the Intl-based
 * validators. No database, no I/O — read and write MUST share these, or a field
 * gets silently dropped on read (BRAIN_PREFERENCE_KEYS exists because two real
 * bugs came from the wrong frame; see brain-preferences.test.ts).
 *
 * Moved out of @mantle/content on 2026-09-02 (audit, tier 3) so the settings UI
 * can project a value without pulling @mantle/db — and `postgres` — into the
 * browser bundle. content-core keeps its ZERO-runtime-dependency rule: the only
 * import here is `import type` from @mantle/client-types, which the compiler
 * erases entirely, and the one UUID regex is inlined rather than reaching for
 * @mantle/std (runtime code, and this file needs five characters of it).
 *
 * @mantle/content re-exports every name below, so nothing downstream moved.
 */

import type {
  OnboardingModelChoices,
  ProfilePreferences,
  ReminderChannel,
  ThoughtTrailMode,
} from '@mantle/client-types';

import { thinkingEffortForBudget, type ThinkingEffort } from './thinking-tiers';

export type { OnboardingModelChoices, ProfilePreferences, ReminderChannel, ThoughtTrailMode };

/** Inlined from @mantle/std: content-core takes no runtime dependencies. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
