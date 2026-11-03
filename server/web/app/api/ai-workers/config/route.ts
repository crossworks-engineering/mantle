import { NextResponse } from '@/server/http-compat';
import { nativeDocumentProviders } from '@mantle/voice';
import type { AiWorkerConfig } from '@mantle/client-types';
import { loadDeciderLastFailure } from '@mantle/content';
import { ownerCaller } from '@/lib/auth';
import { getTailnetPeerNames } from '@/lib/tailscale';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
});

/** Bits the worker form needs but can't compute client-side: which
 *  providers have a native-PDF adapter, the online tailnet peers, and the
 *  decider's last failure (its worker screen shows it). */
export async function GET() {
  const user = ownerCaller();
  const [tailnetPeers, deciderLastFailure] = await Promise.all([
    getTailnetPeerNames(),
    loadDeciderLastFailure(user.id),
  ]);
  const body: AiWorkerConfig = {
    nativeDocProviders: nativeDocumentProviders() as string[],
    tailnetPeers,
    deciderLastFailure,
  };
  return NextResponse.json(body);
}
