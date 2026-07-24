/**
 * GET/PUT /api/profile/reminder-channel — where event reminders are delivered:
 * 'telegram' (a bot DM) or 'mobile' (a push to the companion app). Backs the
 * "Reminder delivery" control in the app; the web form uses the server action
 * instead. Persists to profiles.preferences.reminderChannel.
 *
 * The value auto-follows the last surface the user messaged on (noteInboundChannel),
 * so GET reports the current effective channel and PUT sets a manual override that
 * holds until the next message on the other channel supersedes it. Unset ⇒
 * 'telegram' (the reminder worker's default). See docs/reminder-delivery-routing.md.
 *
 * Owner-gated with a JSON 401 (not a redirect) so the mobile bearer client gets a
 * clean error, matching /api/push/*.
 */

import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { loadProfilePreferences, updateProfilePreferences } from '@mantle/content';

export async function GET() {
  const owner = await getOwnerOr401();
  if (owner instanceof NextResponse) return owner;
  const prefs = await loadProfilePreferences(owner.id);
  return NextResponse.json({ reminderChannel: prefs.reminderChannel ?? 'telegram' });
}

const Body = z.object({ reminderChannel: z.enum(['telegram', 'mobile']) });

export async function PUT(req: Request) {
  const owner = await getOwnerOr401();
  if (owner instanceof NextResponse) return owner;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  }
  const prefs = await updateProfilePreferences(owner.id, {
    reminderChannel: parsed.data.reminderChannel,
  });
  return NextResponse.json({ ok: true, reminderChannel: prefs.reminderChannel ?? 'telegram' });
}
