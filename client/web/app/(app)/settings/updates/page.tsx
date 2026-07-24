import { SetPageTitle } from '@/components/layout/page-title';
import { UpdatesClient } from './updates-client';

/**
 * "Updates" — in-app update for the dockerized stack (docs/self-hosting.md).
 * The page DETECTS (GitHub releases vs the running build) and REQUESTS; the
 * updater sidecar executes `docker compose pull && up -d` and reports back
 * over the shared signal volume. Data-free: UpdatesClient loads its initial
 * bundle from GET /api/updates, polls /api/updates/status, and triggers
 * check/request via POST /api/updates/check and /api/updates/request.
 */
export default async function UpdatesPage() {
  return (
    <>
      <SetPageTitle title="Updates" />
      <UpdatesClient />
    </>
  );
}
