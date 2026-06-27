import { NextResponse } from 'next/server';
import { z } from 'zod';
import { addIcsFeed, listCalendarAccounts } from '@mantle/calendar';
import type { CalendarAccountDTO } from '@mantle/client-types';
import { getOwnerOr401 } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** Subscribed calendar feeds for /settings/calendar. Maps each row to the wire
 *  DTO — the sealed `feedUrlEnc` credential / `ownerId` / `syncState` never reach
 *  the browser, and the `CalendarAccountDTO` annotation makes drift a type error. */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const accounts: CalendarAccountDTO[] = (await listCalendarAccounts(user.id)).map((a) => ({
    id: a.id,
    provider: a.provider,
    displayName: a.displayName,
    color: a.color,
    enabled: a.enabled,
    lastEventCount: a.lastEventCount,
    lastSyncAt: a.lastSyncAt?.toISOString() ?? null,
    lastSyncError: a.lastSyncError,
  }));
  return NextResponse.json({ accounts });
}

const FeedSchema = z.object({
  displayName: z.string().min(1, 'Name is required').max(120),
  url: z
    .string()
    .trim()
    .refine((u) => /^(https?|webcal):\/\//i.test(u), 'Must be an http(s) or webcal iCal URL'),
});

/** Subscribe to an iCalendar feed (Google secret iCal, Outlook published URL,
 *  Apple, CalDAV…). First sync runs within ~2 minutes. */
export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = FeedSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input' },
      { status: 400 },
    );
  }
  await addIcsFeed(user.id, { displayName: parsed.data.displayName, url: parsed.data.url });
  return NextResponse.json({ ok: true });
}
