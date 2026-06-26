'use server';

import { revalidatePath } from 'next/cache';
import {
  addContactFromSender as addContactFromSenderImpl,
  recentUnknownSenders as recentUnknownSendersImpl,
  type AddSenderResult,
  type RecentUnknownResult,
} from '@mantle/email';
import { requireOwner } from '@/lib/auth';

export type { UnknownSender, RecentUnknownResult, AddSenderResult } from '@mantle/email';

/**
 * Live-discover senders who recently emailed the user but aren't yet in their
 * contacts. Thin owner-gated wrapper over the `@mantle/email` implementation
 * (also exposed at `GET /api/email/discover`).
 */
export async function recentUnknownSenders(opts?: {
  sinceDays?: number;
  limit?: number;
}): Promise<RecentUnknownResult> {
  const user = await requireOwner();
  return recentUnknownSendersImpl(user.id, opts);
}

/**
 * Promote a discovered sender to a contact + trigger their 90-day backfill.
 * Revalidates the discover/inbox views on success.
 */
export async function addContactFromSender(
  address: string,
  displayName?: string,
): Promise<AddSenderResult> {
  const user = await requireOwner();
  const result = await addContactFromSenderImpl(user.id, address, displayName);
  if (result.ok) {
    revalidatePath('/settings/discover');
    revalidatePath('/inbox');
  }
  return result;
}
