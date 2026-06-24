'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  clearConfig,
  deleteAccount,
  discoverForAccount,
  saveConfig,
  setDriveEnabled,
  setMailEnabled,
} from '@mantle/microsoft';
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

const ConfigSchema = z.object({
  clientId: z.string().min(1, 'Client ID is required'),
  // Blank on edit = keep the stored secret.
  clientSecret: z.string().optional(),
  tenant: z.string().min(1).default('common'),
  redirectUri: z.string().url('Redirect URI must be an absolute URL'),
});

export type MsConfigResult = { ok: true } | { ok: false; error: string };

/** Save (or override) the brain's Azure AD app config from the UI. */
export async function saveMsConfig(
  _prev: MsConfigResult | undefined,
  formData: FormData,
): Promise<MsConfigResult> {
  const user = await requireOwner();
  const parsed = ConfigSchema.safeParse({
    clientId: formData.get('clientId') ?? '',
    clientSecret: formData.get('clientSecret') || undefined,
    tenant: formData.get('tenant') || 'common',
    redirectUri: formData.get('redirectUri') ?? '',
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  }
  const saved = await saveConfig(user.id, parsed.data);
  if (!saved) {
    return { ok: false, error: 'Client secret is required the first time you save.' };
  }
  revalidatePath('/settings/microsoft');
  return { ok: true };
}

/** Remove the UI config, reverting to environment variables (if any). */
export async function clearMsConfig(): Promise<void> {
  const user = await requireOwner();
  await clearConfig(user.id);
  revalidatePath('/settings/microsoft');
}

/** Re-enumerate an account's drives (OneDrive + followed SharePoint libraries). */
export async function discoverDrivesAction(formData: FormData): Promise<void> {
  const user = await requireOwner();
  const accountId = String(formData.get('accountId') ?? '');
  if (accountId) await discoverForAccount(user.id, accountId);
  revalidatePath('/settings/microsoft');
}

/** Enable/disable a single drive for sync. */
export async function toggleDriveAction(driveDbId: string, enabled: boolean): Promise<void> {
  const user = await requireOwner();
  await setDriveEnabled(user.id, driveDbId, enabled);
  revalidatePath('/settings/microsoft');
}

/** Enable/disable Outlook mail sync for an account. */
export async function toggleMailAction(msAccountId: string, enabled: boolean): Promise<void> {
  const user = await requireOwner();
  await setMailEnabled(user.id, msAccountId, enabled);
  revalidatePath('/settings/microsoft');
}
