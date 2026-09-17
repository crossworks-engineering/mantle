/**
 * GET/PUT /api/profile — the preferences behind the /settings/profile form.
 * Holistic counterpart to the concern-specific /api/profile/reminder-channel
 * route.
 *
 * GET returns the current preferences, the reminder-capable agent list (the
 * "reminders from" picker), the default-fallback prefs (placeholder text), and
 * the user id (avatar fallback seed) — everything the form needs, so it
 * carries no SSR props.
 *
 * Reads/writes go through loadPreferencesFor/savePreferencesFor, which split
 * BRAIN-level fields (site name, peer name, purpose — see
 * BRAIN_PREFERENCE_KEYS) onto the shared anchor row from PERSONAL ones
 * (timezone, locale, avatar, reminders, thinking prefs) on the caller's own.
 * Mantle is multi-trusted-admin: any signed-in user edits the one brand, and
 * everyone sees it — no privilege tier, no per-user brand divergence.
 */

import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { AvatarPartsSchema } from '@/lib/avatar-schema';
import {
  DEFAULT_PREFERENCES,
  isPurposeArchetype,
  isReminderChannel,
  loadPreferencesFor,
  savePreferencesFor,
  SITE_NAME_MAX,
  PEER_NAME_MAX,
  HOUSE_STYLE_MAX,
} from '@mantle/content';
import { listReminderCapableAgents } from '@/lib/agents';
import { errorMessage } from '@mantle/std';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  // Personal preferences are the ACTOR's own (per-login avatar/photo/timezone);
  // loadPreferencesFor routes the brain-level keys to the anchor row either
  // way. Agents stay owner-scoped (they belong to the brain, not a login).
  const [preferences, reminderAgents] = await Promise.all([
    loadPreferencesFor(user.actor.id),
    listReminderCapableAgents(user.id),
  ]);
  return NextResponse.json({
    preferences,
    reminderAgents,
    fallback: DEFAULT_PREFERENCES,
    // The avatar fallback seed — per-login, like the avatar it seeds.
    userId: user.actor.id,
  });
}

const Body = z.object({
  timezone: z.string().max(120).optional(),
  locale: z.string().max(64).optional(),
  // The avatar SEED is this user's own (empty = clear to the initials
  // fallback). The STYLE is brain-level and belongs to Settings → Appearance
  // (PUT /api/profile/avatar-style) — it is accepted here only for older
  // clients, and OMITTING it must leave the brain's style alone rather than
  // clear it, which is why it is spread conditionally below.
  avatarStyle: z.string().max(64).optional(),
  avatarSeed: z.string().max(200).optional(),
  // Avatar-builder choices for THIS user's avatar (component → variant | null).
  // Applied only when SENT (an older client must not clear a saved build);
  // send {} to clear — it projects to unset. Shape is re-checked in
  // projectAvatarParts, so this only bounds the payload.
  avatarParts: AvatarPartsSchema.optional(),
  // Empty = "most recent chat" (unset).
  reminderAgentSlug: z.string().max(120).optional(),
  reminderChannel: z.string().max(32).optional(),
  // The brain's purpose + speciality archetype (editable post-onboarding).
  purpose: z.string().max(2000).optional(),
  purposeArchetype: z.string().max(64).optional(),
  // Custom header wordmark (empty = clear back to "mantle").
  siteName: z.string().max(120).optional(),
  // Header-centre peer name (empty = clear = no centre label).
  peerName: z.string().max(120).optional(),
  // The owner's writing conventions, injected into every composed system
  // prompt (empty = clear = no House style block at all).
  houseStyle: z.string().max(4000).optional(),
  // Live turn streaming (thinking trail + token typing). Default on.
  streamThoughts: z.boolean().optional(),
  // Live trail display mode + whether the trail persists across refresh.
  thoughtTrailMode: z.enum(['list', 'replace']).optional(),
  persistThoughts: z.boolean().optional(),
  // Per-user thinking budget (tokens). 0 = off. Gated alongside streamThoughts
  // by resolveThinkingBudget, then clamped vs the agent's max_tokens at turn
  // time. Ceiling kept comfortably above the UI's High tier but below any
  // agent's max_tokens so a direct PUT can't persist a guaranteed-400 value.
  thinkingBudget: z.number().int().min(0).max(24000).optional(),
});

export async function PUT(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input.' }, { status: 400 });
  }
  const {
    timezone,
    locale,
    avatarStyle,
    avatarSeed,
    avatarParts,
    reminderAgentSlug,
    reminderChannel,
    purpose,
    purposeArchetype,
    siteName,
    peerName,
    houseStyle,
    streamThoughts,
    thoughtTrailMode,
    persistThoughts,
    thinkingBudget,
  } = parsed.data;
  const tz = (timezone ?? '').trim();
  const loc = (locale ?? '').trim();
  if (!tz && !loc) {
    return NextResponse.json(
      { error: 'Set timezone or locale (or both) before saving.' },
      { status: 400 },
    );
  }
  const purposeTrimmed = (purpose ?? '').trim();
  const archetype = (purposeArchetype ?? '').trim();
  try {
    // The ACTOR's id: personal keys land on this login's own row, brain keys
    // (siteName, houseStyle, purpose…) are routed to the anchor by the split
    // in savePreferencesFor — this is what makes avatars per-login.
    const preferences = await savePreferencesFor(user.actor.id, {
      ...(tz ? { timezone: tz } : {}),
      ...(loc ? { locale: loc } : {}),
      ...(avatarStyle !== undefined ? { avatarStyle: avatarStyle.trim() } : {}),
      // Applied only when SENT, like avatarParts: an omitted key must leave
      // the stored seed alone (a stale tab saving its timezone used to wipe
      // the seed another tab had just rolled). '' — sent — is still the
      // explicit clear (back to initials).
      ...(avatarSeed !== undefined ? { avatarSeed: avatarSeed.trim() } : {}),
      ...(avatarParts !== undefined ? { avatarParts } : {}),
      reminderAgentSlug: (reminderAgentSlug ?? '').trim(),
      ...(isReminderChannel((reminderChannel ?? '').trim())
        ? { reminderChannel: (reminderChannel ?? '').trim() as 'telegram' | 'mobile' }
        : {}),
      // purpose is sent on every save (empty = cleared); archetype only sticks
      // when it's a known key.
      ...(purpose !== undefined ? { purpose: purposeTrimmed.slice(0, 600) } : {}),
      ...(isPurposeArchetype(archetype) ? { purposeArchetype: archetype } : {}),
      // Sent on every save; empty stores '' which projects to unset (= "mantle").
      ...(siteName !== undefined ? { siteName: siteName.trim().slice(0, SITE_NAME_MAX) } : {}),
      // Same pattern: empty clears the header-centre peer label.
      ...(peerName !== undefined ? { peerName: peerName.trim().slice(0, PEER_NAME_MAX) } : {}),
      // Same pattern again: empty stores '' which projects to unset, so the
      // House style block disappears from every prompt rather than lingering.
      ...(houseStyle !== undefined
        ? { houseStyle: houseStyle.trim().slice(0, HOUSE_STYLE_MAX) }
        : {}),
      ...(streamThoughts !== undefined ? { streamThoughts } : {}),
      ...(thoughtTrailMode !== undefined ? { thoughtTrailMode } : {}),
      ...(persistThoughts !== undefined ? { persistThoughts } : {}),
      ...(thinkingBudget !== undefined ? { thinkingBudget } : {}),
    });
    return NextResponse.json({ preferences });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 400 });
  }
}
