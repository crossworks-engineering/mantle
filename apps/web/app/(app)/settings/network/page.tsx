import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { getTailnetStatus } from '@/lib/tailscale';
import { getTailscaleConfig } from '@/lib/tailscale-config';
import { NetworkClient } from './network-client';

/**
 * "Local network (Tailscale)" — connect Mantle to a box you own (home GPU, LAN
 * server) that's behind NAT, so chat/vision routes can reach it by MagicDNS
 * name. The auth key lives in the environment (TS_AUTHKEY) and the optional
 * `tailnet` compose profile brings the sidecar up — this page is the operator's
 * window into that: connection state, this node, and the reachable peers (whose
 * names you drop into a route's Base URL on the Agents / AI workers pages).
 */
export default async function NetworkPage() {
  const owner = await requireOwner();
  const [status, config] = await Promise.all([getTailnetStatus(), getTailscaleConfig(owner.id)]);
  return (
    <>
      <SetPageTitle title="Local network" />
      <NetworkClient status={status} config={config} />
    </>
  );
}
