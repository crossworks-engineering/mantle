import { requireOwner } from '@/lib/auth';
import { listPeers } from '@mantle/content';
import { SetPageTitle } from '@/components/layout/page-title';
import { PeersClient } from './peers-client';

export default async function PeersSettingsPage() {
  const user = await requireOwner();
  const peers = await listPeers(user.id);
  return (
    <>
      <SetPageTitle title="Peers" />
      <PeersClient initialPeers={peers} />
    </>
  );
}
