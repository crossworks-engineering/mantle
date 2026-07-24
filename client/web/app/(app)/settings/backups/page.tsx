import { SetPageTitle } from '@/components/layout/page-title';
import { BackupsClient } from './backups-client';

/**
 * /settings/backups — scheduled local DB backups.
 *
 * The app dumps Postgres (`pg_dump -Fc`) on the configured schedule into a
 * local directory and rotates old dumps. Getting that directory OFFSITE is
 * deliberately the operator's job (rsync/rclone/restic/Syncthing — point it
 * at the directory); Mantle's job ends at producing verified, rotated dumps.
 * Engine + scheduler: packages/content/src/backup.ts (the events worker
 * hosts the tick). Data-free: BackupsClient fetches GET /api/backups and
 * mutates via POST /api/backups + /api/backups/run. See docs/backups.md.
 */
export default async function BackupsPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6 px-6 py-8">
      <SetPageTitle title="Backups" />
      <BackupsClient />
    </div>
  );
}
