import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { NetworkClient } from './network-client';

/**
 * "Local network (Tailscale)" — connect Mantle to a box you own (home GPU, LAN
 * server) behind NAT, reachable by MagicDNS name. Data-free: NetworkClient
 * fetches connection state + the stored-key summary from GET /api/network and
 * drives save/activate/deactivate/clear via /api/network/*.
 */
export default async function NetworkPage() {
  await requireOwner();
  return (
    <>
      <SetPageTitle title="Local network" />
      <NetworkClient />
    </>
  );
}
