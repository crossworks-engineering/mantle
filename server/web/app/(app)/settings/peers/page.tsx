import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { PeersClient } from './peers-client';

/**
 * Peers: data-free. PeersClient fetches the list from GET /api/peers and
 * mutates via the /api/peers/** routes (create, PATCH, rotate, shares, delete).
 */
export default async function PeersSettingsPage() {
  await requireOwner();
  return (
    <>
      <SetPageTitle title="Peers" />
      <PeersClient />
    </>
  );
}
