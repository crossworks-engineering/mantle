'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  listAccountFolders as listAccountFoldersImpl,
  setIncludedFolders as setIncludedFoldersImpl,
} from '@mantle/email';
import { requireOwner } from '@/lib/auth';

export type { AccountFoldersResult } from '@mantle/email';

/** List the live folder tree for one IMAP account, plus its current scan
 *  config. Owner-gated wrapper over `@mantle/email` (also at
 *  `GET /api/email/accounts/[id]/folders`). */
export async function listAccountFolders(accountId: string) {
  const user = await requireOwner();
  return listAccountFoldersImpl(user.id, accountId);
}

/** Persist the explicit folder allow-list for an account and kick an
 *  immediate rescan. Zero folders selected clears the list back to NULL
 *  (revert to "scan all non-excluded"). Owner-scoped; form-action shaped. */
export async function setIncludedFolders(formData: FormData): Promise<void> {
  const user = await requireOwner();
  const accountId = String(formData.get('accountId') ?? '');
  if (!accountId) return;

  const folders = formData.getAll('folders').map(String);
  await setIncludedFoldersImpl(user.id, accountId, folders);

  revalidatePath('/settings/accounts');
  revalidatePath('/inbox');
  // Land on the plain accounts list — NOT the folders view. The folders pane
  // does a live IMAP probe on every render; re-rendering it post-save re-probes
  // (slow/flaky, and contends with the rescan we just enqueued), so the form
  // appears to "blank" even though the save above already committed. Redirect
  // to a probe-free view sidesteps the re-probe. (redirect() throws
  // NEXT_REDIRECT, so it must sit outside any try/catch.)
  redirect('/settings/accounts');
}
