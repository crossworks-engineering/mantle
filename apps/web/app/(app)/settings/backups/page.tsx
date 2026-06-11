import { requireOwner } from '@/lib/auth';
import {
  listBackups,
  loadBackupConfig,
  loadBackupStatus,
  loadProfilePreferences,
  resolveBackupDir,
} from '@mantle/content';
import { SetPageTitle } from '@/components/layout/page-title';
import { BackupsClient } from './backups-client';
import { runBackupNowAction, saveBackupSettingsAction } from './actions';

/**
 * /settings/backups — scheduled local DB backups.
 *
 * The app dumps Postgres (`pg_dump -Fc`) on the configured schedule into a
 * local directory and rotates old dumps. Getting that directory OFFSITE is
 * deliberately the operator's job (rsync/rclone/restic/Syncthing — point it
 * at the directory); Mantle's job ends at producing verified, rotated dumps.
 * Engine + scheduler: packages/content/src/backup.ts (the events worker
 * hosts the tick). See docs/backups.md.
 */
export default async function BackupsPage() {
  const user = await requireOwner();
  const [cfg, status, prefs] = await Promise.all([
    loadBackupConfig(user.id),
    loadBackupStatus(user.id),
    loadProfilePreferences(user.id),
  ]);
  const dumps = await listBackups(cfg);
  const resolvedDir = resolveBackupDir(cfg);

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-6 py-8">
      <SetPageTitle title="Backups" />
      <BackupsClient
        config={cfg}
        status={status}
        dumps={dumps}
        resolvedDir={resolvedDir}
        timezone={prefs.timezone}
        saveAction={saveBackupSettingsAction}
        runNowAction={runBackupNowAction}
      />
    </div>
  );
}
