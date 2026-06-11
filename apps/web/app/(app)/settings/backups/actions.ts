'use server';

/**
 * Backup settings server actions — the mutation surface for
 * /settings/backups. Engine + persistence live in @mantle/content
 * (packages/content/src/backup.ts) so the events worker shares the
 * exact config/runner; these wrappers only scope to the auth'd user.
 */

import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/lib/auth';
import {
  normalizeBackupConfig,
  runBackup,
  saveBackupConfig,
  type BackupStatus,
} from '@mantle/content';

export async function saveBackupSettingsAction(formData: FormData): Promise<void> {
  const user = await requireOwner();
  const cfg = normalizeBackupConfig({
    enabled: formData.get('enabled') === 'on',
    frequency: String(formData.get('frequency') ?? 'daily'),
    hour: Number(formData.get('hour')),
    keep: Number(formData.get('keep')),
    location: String(formData.get('location') ?? '').trim(),
  });
  await saveBackupConfig(user.id, cfg);
  revalidatePath('/settings/backups');
}

export async function runBackupNowAction(): Promise<BackupStatus> {
  const user = await requireOwner();
  const status = await runBackup(user.id, 'manual');
  revalidatePath('/settings/backups');
  return status;
}
