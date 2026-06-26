'use server';

import { revalidatePath } from 'next/cache';
import { setReadStatus, setStarred } from '@mantle/email';
import { requireOwner } from '@/lib/auth';

/**
 * Flip the read state on one email. Owner-scoping lives in `setReadStatus`
 * (account-id subquery) so a stolen email UUID can't change another user's
 * mail. `revalidatePath('/inbox')` re-renders the list with the new weight.
 */
export async function setEmailReadStatus(formData: FormData) {
  const user = await requireOwner();
  const emailId = String(formData.get('emailId') ?? '');
  if (!emailId) return;
  await setReadStatus(user.id, emailId, formData.get('read') === '1');
  revalidatePath('/inbox');
}

/**
 * Flip the starred flag on one email. Local-only (Mantle does not write back
 * to the IMAP server). Owner-scoped exactly like `setEmailReadStatus`.
 */
export async function setEmailStarred(formData: FormData) {
  const user = await requireOwner();
  const emailId = String(formData.get('emailId') ?? '');
  if (!emailId) return;
  await setStarred(user.id, emailId, formData.get('starred') === '1');
  revalidatePath('/inbox');
}
