import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { rotateInboundToken } from '@mantle/content';
import { PEER_OWNER_ONLY, peerBoundToOwner, peerChangeNeedsOwner } from '@/lib/peer-access';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'connectors',
    item: { none: 'manages the connectors area: the Admin step checks it' },
  },
});

/** Mint a fresh inbound token for this peer. Returns the plaintext ONCE — the
 *  old token stops working immediately, so the peer must be re-issued this. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  // A new token for a peer that acts as the owner is an owner credential:
  // the owner's to mint.
  if (
    !user.actor.isOwner &&
    peerChangeNeedsOwner({ rotate: true }, await peerBoundToOwner(user.id, id))
  ) {
    return NextResponse.json({ error: PEER_OWNER_ONLY }, { status: 403 });
  }
  // Checked again in the write: the owner may bind it in between.
  const guard = !user.actor.isOwner;
  const token = await rotateInboundToken(user.id, id, guard ? { unlessBoundTo: user.id } : {});
  if (!token) {
    if (guard && (await peerBoundToOwner(user.id, id))) {
      return NextResponse.json({ error: PEER_OWNER_ONLY }, { status: 403 });
    }
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ inboundToken: token });
}
