/**
 * Per-user preferences — timezone + locale, persisted on
 * profiles.preferences.
 *
 * Lives in @mantle/content so both apps/web (settings page +
 * formatters) and apps/agent (system-prompt time context) can read
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
import { db, profiles, type ConversationChannel } from '@mantle/db';

/** Transports that can deliver a reminder out-of-band. A browser ('web') can't
 *  receive a push, so it never becomes a reminder target. */
export type ReminderChannel = 'telegram' | 'mobile';

export type ProfilePreferences = {
  /** IANA timezone, e.g. 'Africa/Johannesburg'. UTC when not set. */
  timezone: string;
  /** The last zone the auto-from-location hook DERIVED (not necessarily the one
   *  in `timezone`, if the user manually overrode since). Used purely for
   *  hysteresis: the hook only acts when the freshly-derived zone differs from
   *  this, so it won't fight a manual change or re-switch every turn at the same
   *  place. See auto-timezone.ts. */
  lastAutoTimezone?: string;
  /** BCP-47 locale, e.g. 'en-GB'. Drives date/number/currency
   *  formatting. Falls back to en-GB to match the legacy pinned
   *  format-datetime behaviour, so existing UI doesn't shift for
   *  users who haven't visited /settings/profile yet. */
  locale: string;
  /** Avatar style id (boring-avatars; see apps/web/lib/avatar). Undefined →
   *  the UI falls back to an initials avatar. */
  avatarStyle?: string;
  /** Seed for the avatar; the UI defaults it to the user id when unset so an
   *  avatar still renders. */
  avatarSeed?: string;
  /** Slug of the responder agent whose Telegram bot delivers event reminders.
   *  Unset → the reminder worker falls back to the most-recently-active allowed
   *  DM (whichever bot you last messaged). Set it to pin reminders to one
   *  persona, e.g. 'telegram-default' (Saskia), so they don't come from
   *  whichever bot happened to be most recent. */
  reminderAgentSlug?: string;
  /** Where event reminders are delivered: 'telegram' (a bot DM) or 'mobile' (a
   *  push to the companion app). Auto-tracked — it follows the last channel the
   *  user actually messaged on (see noteInboundChannel), and can be set manually
   *  from the profile; a manual choice holds until the next message on the other
   *  channel supersedes it. Unset ⇒ the reminder worker defaults to 'telegram'
   *  (backward-compatible). See docs/reminder-delivery-routing.md. */
  reminderChannel?: ReminderChannel;
  /** What the user likes to be called (captured during onboarding). Cosmetic —
   *  the assistant's real knowledge of the user comes from the Journal identity
   *  block; this is for greetings/UI. */
  displayName?: string;
  /** Custom site name rendered as the header wordmark in place of "mantle" —
   *  a per-box label (e.g. 'Refinery') so anyone with several brains can see at
   *  a glance which one they're on. Cosmetic only; unset ⇒ the Mantle wordmark.
   *  Read via projectSiteName, never raw. */
  siteName?: string;
  /** The UI colour-theme id (the header theme toggler / random shuffle). The
   *  DB copy is the source of truth so the choice follows the owner across
   *  browsers and brands member-facing surfaces (/s, /team) — localStorage
   *  stays only as the before-paint fast path. Unset ⇒ the default theme.
   *  Read via projectColorTheme, never raw. */
  colorTheme?: string;
  /** Free-text "what this brain is for" — captured at onboarding, editable in
   *  Settings → Profile. Injected as the "# Purpose of this brain" section of the
   *  always-on identity block (identity-context.ts), so every agent knows the
   *  brain's mission. */
  purpose?: string;
  /** The brain's speciality archetype key (see onboarding-questions.ts
   *  PURPOSE_ARCHETYPES — 'personal' | 'analytics' | 'research' | 'robotics' |
   *  'team' | 'custom'). Descriptive for now; the seam a later phase can branch
   *  default provisioning on. */
  purposeArchetype?: string;
  /** ISO instant onboarding was completed. Unset ⇒ the onboarding wizard runs
   *  on next login; the (app) shell redirects there. Set ⇒ shell renders normally. */
  onboardedAt?: string;
  /** Resume marker for the onboarding wizard — the key of the furthest step the
   *  user has reached. Lets a refreshed/re-entered wizard pick up where it left off. */
  onboardingStep?: string;
  /** Model choices captured by the onboarding "Models" step — the operator
   *  overlay `provisionDefaults()` applies on top of the manifest seed (the
   *  assistant's chat model + the indexing workers' fast model). When
   *  `route: 'azure'`, those rows are pinned to an Azure OpenAI endpoint via
   *  the `custom` provider (key stored under service `custom`). */
  onboardingModels?: OnboardingModelChoices;
  /** Slug of the agent the `/pages` editor "Assist" panel delegates to. Unset →
   *  the route falls back to the default `pages` specialist. Configured on the
   *  /pages surface itself (the Assist panel agent picker), not a global setting. */
  pagesAssistAgentSlug?: string;
  /** Slug of the agent the `/tables` editor "Assist" panel delegates to. Unset →
   *  the route falls back to the default `tables` (Ledger) specialist. Configured
   *  on the /tables surface itself (the Assist panel agent picker). */
  tablesAssistAgentSlug?: string;
  /** Slug of the agent the `/apps` editor "Assist" panel delegates to. Unset →
   *  the default `appsmith` specialist. Configured on the /apps surface. */
  appsAssistAgentSlug?: string;
  /** Slug of the agent the API Console (/dev-tools) "Assist" panel delegates
   *  to. Unset → the default `toolsmith` specialist. */
  devToolsAssistAgentSlug?: string;
  /** When true, tools an AGENT authors (via Toolsmith / api_tool_create) start
   *  confirm-gated: every call parks for operator approval until the operator
   *  clears "requires confirm" for that tool in Settings → Tools. Defaults
   *  OFF — a simple single-owner brain trusts itself; turn it ON if you grant
   *  tool-authoring to an agent that reads untrusted content (email/web), so an
   *  injected agent can't stand up a silent exfiltration endpoint. Independent
   *  of the always-on guards (self-grant block, no-lower-via-update, SSRF). */
  toolsmithRequireApproval?: boolean;
  /** APP_VERSION the boot-time manifest reconcile last synced this brain to.
   *  The reconcile (apps/web instrumentation → reconcileManifestOnBoot) runs once
   *  per version on a deployed/updated instance, so a self-hoster who only pulls a
   *  new image still gets new tools/skills/group-membership without running seed
   *  scripts. Equal to APP_VERSION ⇒ already reconciled, skip. */
  lastReconciledVersion?: string;
  /** When true, outbound/egress tools (email_send, web_fetch, web_search)
   *  fired during an UNATTENDED heartbeat run park for operator approval
   *  instead of executing inline. Only tools that reach OUT are gated — the
   *  heartbeat's own surface reply (the final Telegram message) is not a tool
   *  and still goes through. Defaults OFF: most heartbeats are trusted
   *  routines. Turn it ON for an agent that reads untrusted content on a
   *  timer, so an injected instruction can't silently email or fetch on your
   *  behalf while you're away. Pairs with the interactive Telegram approval
   *  card so a parked egress call can be cleared from a phone. */
  heartbeatEgressGate?: boolean;
  /** Show the live "thinking" trail + stream the reply token-by-token in the
   *  /assistant chat (and the companion). **Defaults ON** (undefined → on); set
   *  false to fall back to a static thinking bubble + the reply appearing whole
   *  on completion. This is the per-brain runtime control for live turn
   *  streaming; the `MANTLE_TURN_STREAMING` env var is a deploy-level override
   *  (env off wins). Read by the web turn route (202 vs blocking + the SSE gate)
   *  via `isStreamThoughtsEnabled`. */
  streamThoughts?: boolean;
  /** How the LIVE thinking trail renders during a turn: 'list' stacks completed
   *  actions above the active line (default); 'replace' shows only the current
   *  action, each one replacing the last (compact, single line). The frozen
   *  record view (after the turn) is unaffected. */
  thoughtTrailMode?: ThoughtTrailMode;
  /** Persist the thought trail onto the finished message so it survives a page
   *  refresh — reconstructed from the turn's tool actions and stored on the
   *  durable row, so it reloads on web AND the companion. **Defaults ON**; set
   *  false to keep it ephemeral (in-memory only; clears on reload). See
   *  `isPersistThoughtsEnabled`. */
  persistThoughts?: boolean;
  /** Per-user thinking budget in tokens. Real model reasoning is requested only
   *  when the live-thinking switch is ON (`streamThoughts`) AND this is > 0;
   *  0 / unset = no thinking. Maps to the provider's knob in the adapters
   *  (Anthropic adaptive, OpenRouter `reasoning.max_tokens`, Gemini
   *  `thinkingConfig`, Copilot `reasoning_effort`). This is the per-user
   *  replacement for the old per-box `MANTLE_THINKING_BUDGET` env gate. Resolve
   *  via `resolveThinkingBudget` — never read raw, so the switch gate always
   *  applies. **Defaults unset (off).** */
  thinkingBudget?: number;
  /** Whether this box exposes its remote MCP connector (the OAuth-gated
   *  `/api/mcp` endpoint addable as a claude.ai custom connector). **Defaults
   *  OFF** — it's an explicit opt-in because it puts the tool surface on the
   *  public internet (behind OAuth). When off, `/api/mcp` + the OAuth
   *  authorize/register endpoints 404, so no new client can connect and existing
   *  tokens stop working. Flip it in Settings → MCP. */
  remoteMcpEnabled?: boolean;
  /** Whether the external Team Chat responder may read the owner's PRIVATE
   *  corpus — email + journal — on a team member's behalf. **Defaults OFF**:
   *  team members always get brain-wide knowledge reads (search, files, notes,
   *  pages, tables, tasks, contacts, app data), but the owner's personal email
   *  history and journal stay off-limits unless this is explicitly turned on.
   *  Enforced at the team turn's tool resolution (`isTeamPrivateReadsEnabled`
   *  strips `email_*`/`journal_*` when off), independent of the `team-read`
   *  group grant, so the switch can't be bypassed by a manifest change. Flip it
   *  from the Team admin surface. */
  teamPrivateReads?: boolean;
  /** Node id of the mini-app designated as this brain's TEAM HUB. When set (and
   *  the app has a green published build + an active team-mode share), the /team
   *  shell renders that app full-bleed in place of the built-in hub body; the
   *  built-in hub remains the fallback for every other state. Resolve via
   *  `resolveTeamHubApp` (team-hub.ts), never raw — designation is only honoured
   *  when the whole chain (pref → app → build → share) is intact. Read via
   *  projectTeamHubAppId, never raw. */
  teamHubAppId?: string;
  /** Tags the owner curates as Dashboard sections on the /team overview: each
   *  tag renders a section of up to 5 team-visible shared pages carrying it
   *  (newest-updated first, title + summary + /s link). Order here = section
   *  order. The share stays the single source of truth for WHAT is visible —
   *  this pref only chooses which tag groupings get pinned. Unset/empty ⇒ no
   *  curated sections. Read via projectTeamHubTags, never raw. */
  teamHubTags?: string[];
};

/** Live thinking-trail display modes. */
export type ThoughtTrailMode = 'list' | 'replace';

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

/** Project a stored `colorTheme` jsonb value — a slug-shaped theme id, or
 *  undefined for unset/garbage (⇒ the default theme). The theme LIST lives in
 *  the web app (apps/web/lib/themes.ts); the server stores any well-formed id
 *  and the client falls back to the default for ids it doesn't know, so a
 *  theme added or removed in the UI never strands the stored preference. */
export function projectColorTheme(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(t) ? t : undefined;
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

/** The onboarding "Models" step's stored choices. Kept as one object so the
 *  projection can't half-apply; every field optional so partial saves survive. */
export interface OnboardingModelChoices {
  /** OpenRouter slug for the assistant/persona agent (e.g. `anthropic/claude-sonnet-4.6`). */
  assistantModel?: string;
  /** OpenRouter slug for the indexing workers (e.g. `google/gemini-3.1-flash-lite`). */
  workerModel?: string;
  /** Where the models run: OpenRouter (default) or an Azure OpenAI endpoint. */
  route?: 'openrouter' | 'azure';
  /** Azure OpenAI base URL (the OpenAI-compatible v1 endpoint), when route=azure. */
  azureBaseUrl?: string;
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
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(trimmed)
    ? trimmed
    : undefined;
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
    avatarStyle:
      typeof prefs.avatarStyle === 'string' && prefs.avatarStyle.length > 0
        ? prefs.avatarStyle
        : undefined,
    avatarSeed:
      typeof prefs.avatarSeed === 'string' && prefs.avatarSeed.length > 0
        ? prefs.avatarSeed
        : undefined,
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
    colorTheme: projectColorTheme(prefs.colorTheme),
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
    pagesAssistAgentSlug:
      typeof prefs.pagesAssistAgentSlug === 'string' && prefs.pagesAssistAgentSlug.length > 0
        ? prefs.pagesAssistAgentSlug
        : undefined,
    tablesAssistAgentSlug:
      typeof prefs.tablesAssistAgentSlug === 'string' && prefs.tablesAssistAgentSlug.length > 0
        ? prefs.tablesAssistAgentSlug
        : undefined,
    appsAssistAgentSlug:
      typeof prefs.appsAssistAgentSlug === 'string' && prefs.appsAssistAgentSlug.length > 0
        ? prefs.appsAssistAgentSlug
        : undefined,
    devToolsAssistAgentSlug:
      typeof prefs.devToolsAssistAgentSlug === 'string' && prefs.devToolsAssistAgentSlug.length > 0
        ? prefs.devToolsAssistAgentSlug
        : undefined,
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
    avatarStyle: merged.avatarStyle || undefined,
    avatarSeed: merged.avatarSeed || undefined,
    reminderAgentSlug: merged.reminderAgentSlug || undefined,
    reminderChannel: isReminderChannel(merged.reminderChannel) ? merged.reminderChannel : undefined,
    displayName: merged.displayName || undefined,
    siteName: projectSiteName(merged.siteName),
    colorTheme: projectColorTheme(merged.colorTheme),
    purpose: merged.purpose || undefined,
    purposeArchetype: merged.purposeArchetype || undefined,
    onboardedAt: merged.onboardedAt || undefined,
    onboardingStep: merged.onboardingStep || undefined,
    onboardingModels: projectOnboardingModels(merged.onboardingModels),
    pagesAssistAgentSlug: merged.pagesAssistAgentSlug || undefined,
    tablesAssistAgentSlug: merged.tablesAssistAgentSlug || undefined,
    appsAssistAgentSlug: merged.appsAssistAgentSlug || undefined,
    devToolsAssistAgentSlug: merged.devToolsAssistAgentSlug || undefined,
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
