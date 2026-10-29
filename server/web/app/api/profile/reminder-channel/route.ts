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
 * clean error, matching /api/push/*. The value is the brain's row (owner.id),
 * so a PUT is the brain owner's or an Admin user's with the settings area
 * (brandSettingsRefusal):
 * an Admin user without it gets the 403, not the database's refusal.
 */

import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { loadProfilePreferences, updateProfilePreferences } from '@mantle/content';
import { readJson } from '@/lib/read-body';
import { brandSettingsRefusal } from '@/lib/brand-gate';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'self' },
  PUT: { class: 'self', item: { none: "the login's own things, not an item" } },
});

export async function GET() {
  const owner = ownerCaller();
  const prefs = await loadProfilePreferences(owner.id);
  return NextResponse.json({ reminderChannel: prefs.reminderChannel ?? 'telegram' });
}

const Body = z.object({ reminderChannel: z.enum(['telegram', 'mobile']) });

export async function PUT(req: Request) {
  const owner = ownerCaller();
  const refused = await brandSettingsRefusal(owner, "The brain's reminder delivery");
  if (refused) return refused;
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  }
  const prefs = await updateProfilePreferences(owner.id, {
    reminderChannel: parsed.data.reminderChannel,
  });
  return NextResponse.json({ ok: true, reminderChannel: prefs.reminderChannel ?? 'telegram' });
}
