import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { ToolGroupsClient } from './tool-groups-client';

/**
 * Tool groups settings — client data-fetching (Phase 2 · Task 4), per the
 * /settings/skills template. Data-free page (auth gate only); the groups (with
 * their agent grants) and the available-tools list are fetched in the client
 * with TanStack Query (`/api/tool-groups`, `/api/tools`).
 */
export default async function ToolGroupsPage() {
  await requireOwner();
  return (
    <>
      <SetPageTitle title="Tool groups" />
      <ToolGroupsClient />
    </>
  );
}
