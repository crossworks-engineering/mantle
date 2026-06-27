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
});

export async function PUT(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input.' }, { status: 400 });
  }
  const { timezone, locale, avatarStyle, avatarSeed, reminderAgentSlug, reminderChannel } =
    parsed.data;
  const tz = (timezone ?? '').trim();
  const loc = (locale ?? '').trim();
  if (!tz && !loc) {
    return NextResponse.json(
      { error: 'Set timezone or locale (or both) before saving.' },
      { status: 400 },
    );
  }
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
    });
    return NextResponse.json({ preferences });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
