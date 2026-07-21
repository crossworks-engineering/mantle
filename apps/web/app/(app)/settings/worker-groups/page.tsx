import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { WorkerGroupsClient } from './worker-groups-client';

/**
 * Worker groups settings — manage the agent_groups panels (docs/runs.md). A
 * worker group is a named set of worker agents; a run step with `group:<slug>`
 * fans out into one attempt per member plus a panel audit. Data-free page (auth
 * gate only, the /settings/tool-groups template); the groups + the enabled
 * worker agents are fetched in the client via `/api/settings/worker-groups`.
 */
export default async function WorkerGroupsPage() {
  await requireOwner();
  return (
    <>
      <SetPageTitle title="Worker groups" />
      <WorkerGroupsClient />
    </>
  );
}
