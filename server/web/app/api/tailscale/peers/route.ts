import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { getTailnetPeerNames } from '@/lib/tailscale';

/**
 * Online tailnet peer MagicDNS names — feeds the per-route base-URL datalist on
 * the agents form (and mirrors what `/api/ai-workers/config` exposes for the
 * worker form). Owner-gated; returns `[]` when the tailnet profile is down so
 * the form degrades to a free-text host field rather than erroring.
 */
export async function GET() {
  const gate = await getOwnerOr401();
  if (gate instanceof Response) return gate;
  const peers = await getTailnetPeerNames();
  return NextResponse.json({ peers });
}
