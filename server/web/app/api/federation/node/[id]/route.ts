import { NextResponse } from '@/server/http-compat';
import { getNodeForPeer } from '@mantle/content';
import { startTrace, step } from '@mantle/tracing';
import { authenticatePeer } from '@/lib/federation-auth';

/**
 * Fetch one granted node's full content for a peer. 404 when the node isn't
 * actively granted to this peer — indistinguishable from not-found, so a peer
 * can't probe for nodes it wasn't given. Traced as a `federation_request`.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const peer = await authenticatePeer(req);
  if (!peer) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;

  const node = await startTrace(
    {
      kind: 'federation_request',
      ownerId: peer.ownerId,
      subjectId: peer.id,
      subjectKind: 'mantle_peer',
      data: { surface: 'federation', op: 'node', peer: peer.displayName, node_id: id },
    },
    async () =>
      step({ name: 'get_node_for_peer', kind: 'db_read', input: { nodeId: id } }, async (h) => {
        const row = await getNodeForPeer(peer.id, id);
        h.setMeta({ found: !!row });
        return row;
      }),
  );

  if (!node) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ node });
}
