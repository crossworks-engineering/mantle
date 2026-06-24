'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { addIcsFeed, deleteCalendarAccount, setCalendarEnabled } from '@mantle/calendar';
import { requireOwner } from '@/lib/auth';

const FeedSchema = z.object({
  displayName: z.string().min(1, 'Name is required').max(120),
  url: z
    .string()
    .trim()
    .refine((u) => /^(https?|webcal):\/\//i.test(u), 'Must be an http(s) or webcal iCal URL'),
});

export type AddFeedResult = { ok: true } | { ok: false; error: string };

/** Subscribe to an iCalendar feed (Google secret iCal, Outlook published URL,
 *  Apple, CalDAV…). First sync runs within ~2 minutes. */
export async function addIcsFeedAction(
  _prev: AddFeedResult | undefined,
  formData: FormData,
): Promise<AddFeedResult> {
  const user = await requireOwner();
  const parsed = FeedSchema.safeParse({
    displayName: formData.get('displayName') ?? '',
    url: formData.get('url') ?? '',
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  }
  await addIcsFeed(user.id, { displayName: parsed.data.displayName, url: parsed.data.url });
  revalidatePath('/settings/calendar');
  return { ok: true };
}

export async function toggleCalendarAction(id: string, enabled: boolean): Promise<void> {
  const user = await requireOwner();
  await setCalendarEnabled(user.id, id, enabled);
  revalidatePath('/settings/calendar');
}

export async function deleteCalendarAction(formData: FormData): Promise<void> {
  const user = await requireOwner();
  const id = String(formData.get('id') ?? '');
  if (id) await deleteCalendarAccount(user.id, id);
  revalidatePath('/settings/calendar');
}
