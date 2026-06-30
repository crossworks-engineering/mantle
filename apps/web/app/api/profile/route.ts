/**
 * GET/PUT /api/profile — the operator's own preferences for the
 * /settings/profile form. Holistic counterpart to the concern-specific
 * /api/profile/reminder-channel and /api/profile/assist-agent routes.
 *
 * GET returns the current preferences, the reminder-capable agent list (the
 * "reminders from" picker), the default-fallback prefs (placeholder text), and
 * the owner id (avatar fallback seed) — everything the form needs, so it
 * carries no SSR props. PUT mirrors the old updatePreferencesAction.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import {
  DEFAULT_PREFERENCES,
  isPurposeArchetype,
  isReminderChannel,
  loadProfilePreferences,
  updateProfilePreferences,
} from '@mantle/content';
import { listReminderCapableAgents } from '@/lib/agents';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const [preferences, reminderAgents] = await Promise.all([
    loadProfilePreferences(user.id),
    listReminderCapableAgents(user.id),
  ]);
  return NextResponse.json({
    preferences,
    reminderAgents,
    fallback: DEFAULT_PREFERENCES,
    userId: user.id,
  });
}

const Body = z.object({
  timezone: z.string().max(120).optional(),
  locale: z.string().max(64).optional(),
  // Always present (possibly empty = clear to the initials fallback).
  avatarStyle: z.string().max(64).optional(),
  avatarSeed: z.string().max(200).optional(),
  // Empty = "most recent chat" (unset).
  reminderAgentSlug: z.string().max(120).optional(),
  reminderChannel: z.string().max(32).optional(),
  // The brain's purpose + speciality archetype (editable post-onboarding).
  purpose: z.string().max(2000).optional(),
  purposeArchetype: z.string().max(64).optional(),
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
    reminderAgentSlug,
    reminderChannel,
    purpose,
    purposeArchetype,
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
    const preferences = await updateProfilePreferences(user.id, {
      ...(tz ? { timezone: tz } : {}),
      ...(loc ? { locale: loc } : {}),
      avatarStyle: (avatarStyle ?? '').trim(),
      avatarSeed: (avatarSeed ?? '').trim(),
      reminderAgentSlug: (reminderAgentSlug ?? '').trim(),
      ...(isReminderChannel((reminderChannel ?? '').trim())
        ? { reminderChannel: (reminderChannel ?? '').trim() as 'telegram' | 'mobile' }
        : {}),
      // purpose is sent on every save (empty = cleared); archetype only sticks
      // when it's a known key.
      ...(purpose !== undefined ? { purpose: purposeTrimmed.slice(0, 600) } : {}),
      ...(isPurposeArchetype(archetype) ? { purposeArchetype: archetype } : {}),
      ...(streamThoughts !== undefined ? { streamThoughts } : {}),
      ...(thoughtTrailMode !== undefined ? { thoughtTrailMode } : {}),
      ...(persistThoughts !== undefined ? { persistThoughts } : {}),
      ...(thinkingBudget !== undefined ? { thinkingBudget } : {}),
    });
    return NextResponse.json({ preferences });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
