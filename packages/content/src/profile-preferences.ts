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
   *  the assistant's real knowledge of the user comes from the Life Log identity
   *  block; this is for greetings/UI. */
  displayName?: string;
  /** ISO instant onboarding was completed. Unset ⇒ the onboarding wizard runs
   *  on next login; the (app) shell redirects there. Set ⇒ shell renders normally. */
  onboardedAt?: string;
  /** Resume marker for the onboarding wizard — the key of the furthest step the
   *  user has reached. Lets a refreshed/re-entered wizard pick up where it left off. */
  onboardingStep?: string;
  /** Slug of the agent the `/pages` editor "Assist" panel delegates to. Unset →
   *  the route falls back to the default `pages` specialist. Configured on the
   *  /pages surface itself (the Assist panel agent picker), not a global setting. */
  pagesAssistAgentSlug?: string;
  /** Slug of the agent the `/tables` editor "Assist" panel delegates to. Unset →
   *  the route falls back to the default `tables` (Ledger) specialist. Configured
   *  on the /tables surface itself (the Assist panel agent picker). */
  tablesAssistAgentSlug?: string;
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
};

export const DEFAULT_PREFERENCES: ProfilePreferences = {
  timezone: 'UTC',
  locale: 'en-GB',
};

/** Read prefs jsonb and project to typed shape. Missing keys fall
 *  back to DEFAULT_PREFERENCES. Auto-creates the profile row on
 *  first access. */
export async function loadProfilePreferences(
  userId: string,
): Promise<ProfilePreferences> {
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
    reminderChannel: isReminderChannel(prefs.reminderChannel)
      ? prefs.reminderChannel
      : undefined,
    displayName:
      typeof prefs.displayName === 'string' && prefs.displayName.length > 0
        ? prefs.displayName
        : undefined,
    onboardedAt:
      typeof prefs.onboardedAt === 'string' && prefs.onboardedAt.length > 0
        ? prefs.onboardedAt
        : undefined,
    onboardingStep:
      typeof prefs.onboardingStep === 'string' && prefs.onboardingStep.length > 0
        ? prefs.onboardingStep
        : undefined,
    pagesAssistAgentSlug:
      typeof prefs.pagesAssistAgentSlug === 'string' && prefs.pagesAssistAgentSlug.length > 0
        ? prefs.pagesAssistAgentSlug
        : undefined,
    tablesAssistAgentSlug:
      typeof prefs.tablesAssistAgentSlug === 'string' && prefs.tablesAssistAgentSlug.length > 0
        ? prefs.tablesAssistAgentSlug
        : undefined,
    devToolsAssistAgentSlug:
      typeof prefs.devToolsAssistAgentSlug === 'string' && prefs.devToolsAssistAgentSlug.length > 0
        ? prefs.devToolsAssistAgentSlug
        : undefined,
    toolsmithRequireApproval: prefs.toolsmithRequireApproval === true,
    heartbeatEgressGate: prefs.heartbeatEgressGate === true,
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
    console.error(
      '[profile] noteInboundChannel failed:',
      err instanceof Error ? err.message : err,
    );
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
    throw new Error(`'${patch.reminderChannel}' is not a valid reminder channel ('telegram' | 'mobile').`);
  }

  const merge = JSON.stringify(patch);
  const [row] = await db
    .insert(profiles)
    .values({
      userId,
      preferences: { ...DEFAULT_PREFERENCES, ...patch } as unknown as Record<
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
    onboardedAt: merged.onboardedAt || undefined,
    onboardingStep: merged.onboardingStep || undefined,
    pagesAssistAgentSlug: merged.pagesAssistAgentSlug || undefined,
    tablesAssistAgentSlug: merged.tablesAssistAgentSlug || undefined,
    devToolsAssistAgentSlug: merged.devToolsAssistAgentSlug || undefined,
    toolsmithRequireApproval: merged.toolsmithRequireApproval === true,
    heartbeatEgressGate: merged.heartbeatEgressGate === true,
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
