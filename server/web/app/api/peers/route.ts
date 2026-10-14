import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { createPeer, listPeers, setPeerAccess } from '@mantle/content';
import {
  PEER_OWNER_ONLY,
  PeerAccessBody,
  peerChangeNeedsOwner,
  resolvePeerActsAs,
} from '@/lib/peer-access';
import { readBody } from '@/lib/read-body';

export async function GET() {
  const user = ownerCaller();
  return NextResponse.json({ peers: await listPeers(user.id) });
}

const CreateBody = z
  .object({
    displayName: z.string().min(1).max(200),
    baseUrl: z.string().min(1).max(500),
    // Optional: without it the peer is created 'pending' (inbound token minted
    // + revealed so the pairing can start; outbound disabled until provided).
    outboundToken: z.string().max(8192).optional(),
    description: z.string().max(2000).optional(),
  })
  .extend(PeerAccessBody.shape);

export async function POST(req: Request) {
  const user = ownerCaller();
  const body = await readBody(req, CreateBody);
  const { actsAs, writeEnabled, allowedRiskyTools, ...input } = body;
  // A brain that acts as the owner, or one with risky owner tools, is the
  // owner's to link (W6b fix round 3, M-1).
  if (!user.actor.isOwner && peerChangeNeedsOwner({ actsAs, allowedRiskyTools })) {
    return NextResponse.json({ error: PEER_OWNER_ONLY }, { status: 403 });
  }
  const bound = actsAs ? await resolvePeerActsAs(user.id, actsAs) : null;
  if (bound && 'error' in bound) return NextResponse.json({ error: bound.error }, { status: 400 });
  try {
    // `inboundToken` is the plaintext to hand the peer — surfaced ONCE here.
    const created = await createPeer(user.id, { ...input, createdBy: user.actor.id });
    let peer = created.peer;
    if (bound) {
      peer =
        (
          await setPeerAccess(user.id, peer.id, {
            actsAs: bound,
            ...(writeEnabled !== undefined ? { writeEnabled } : {}),
            ...(allowedRiskyTools !== undefined ? { allowedRiskyTools } : {}),
          })
        )?.peer ?? peer;
    }
    return NextResponse.json({ peer, inboundToken: created.inboundToken }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
