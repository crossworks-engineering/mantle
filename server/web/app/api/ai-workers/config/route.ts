import { NextResponse } from '@/server/http-compat';
import { nativeDocumentProviders } from '@mantle/voice';
import type { AiWorkerConfig } from '@mantle/client-types';
import { getOwnerOr401 } from '@/lib/auth';
import { getTailnetPeerNames } from '@/lib/tailscale';

/** Static-ish bits the worker form needs but can't compute client-side:
 *  which providers have a native-PDF adapter, and the online tailnet peers. */
export async function GET() {
  const gate = await getOwnerOr401();
  if (gate instanceof Response) return gate;
  const tailnetPeers = await getTailnetPeerNames();
  const body: AiWorkerConfig = {
    nativeDocProviders: nativeDocumentProviders() as string[],
    tailnetPeers,
  };
  return NextResponse.json(body);
}
