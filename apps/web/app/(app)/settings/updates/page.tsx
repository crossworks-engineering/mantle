import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { checkForUpdate, readUpdaterStatus, updaterAvailable } from '@/lib/updates';
import { GIT_SHA, BUILD_TIME, APP_VERSION } from '@/lib/version';
import { UpdatesClient } from './updates-client';

/**
 * "Updates" — in-app update for the dockerized stack (docs/self-hosting.md).
 * The page DETECTS (GitHub releases vs the running build) and REQUESTS; the
 * updater sidecar executes `docker compose pull && up -d` and reports back
 * over the shared signal volume. Deployments without the sidecar (dev, the
 * build-on-VPS runbook without MANTLE_STACK_DIR) still get the version check
 * plus CLI instructions.
 */
export default async function UpdatesPage() {
  await requireOwner();
  const [check, available, status] = await Promise.all([
    checkForUpdate(false),
    updaterAvailable(),
    readUpdaterStatus(),
  ]);
  return (
    <>
      <SetPageTitle title="Updates" />
      <UpdatesClient
        initialCheck={check}
        updaterAvailable={available}
        initialStatus={status}
        build={{ version: APP_VERSION, sha: GIT_SHA, time: BUILD_TIME }}
      />
    </>
  );
}
