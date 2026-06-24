'use server';

import { revalidatePath } from 'next/cache';
import { deleteAccount } from '@mantle/microsoft';
import { requireOwner } from '@/lib/auth';

/** Disconnect a connected Microsoft account (owner-scoped). Drops the sealed
 *  tokens + row; once M1 adds item tables their FK cascade removes ingested
 *  provenance too. */
export async function disconnectMsAccount(formData: FormData): Promise<void> {
  const user = await requireOwner();
  const accountId = String(formData.get('accountId') ?? '');
  if (accountId) await deleteAccount(user.id, accountId);
  revalidatePath('/settings/microsoft');
}
