import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { ToolsClient } from './tools-client';

/**
 * Tools settings — client data-fetching (Phase 2 · Task 4), following the
 * /settings/skills template. The page is data-free (auth gate only); the tool
 * list and the two policy toggles are fetched in the client with TanStack Query
 * (`/api/tools`, `/api/tools/settings`).
 */
export default async function ToolsPage() {
  await requireOwner();
  return (
    <>
      <SetPageTitle title="Tools" />
      <ToolsClient />
    </>
  );
}
