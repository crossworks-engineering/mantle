import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { deletePeer, setOutboundToken, setPeerAccess, setPeerEnabled } from '@mantle/content';
import {
  PEER_OWNER_ONLY,
  PeerAccessBody,
  peerBoundToOwner,
  peerChangeNeedsOwner,
  resolvePeerActsAs,
} from '@/lib/peer-access';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  PATCH: {
    class: 'area',
    area: 'connectors',
    item: { none: 'manages the connectors area: the Admin step checks it' },
  },
  DELETE: {
    class: 'area',
    area: 'connectors',
    item: { none: 'manages the connectors area: the Admin step checks it' },
  },
});

const PatchBody = z
  .object({
    enabled: z.boolean().optional(),
    // Trimmed before the length check: a blank token is refused here, before
    // the access write commits, not inside setOutboundToken.
    outboundToken: z.string().trim().min(1).max(8192).optional(),
  })
  .extend(PeerAccessBody.shape);

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const input = await readBody(req, PatchBody);
  const { actsAs, writeEnabled, allowedRiskyTools } = input;
  const change = { actsAs, writeEnabled, allowedRiskyTools };
  // Checked before anything changes: a brain that acts as the owner is the
  // owner's to bind, arm and keep armed.
  if (!user.actor.isOwner && peerChangeNeedsOwner(change, await peerBoundToOwner(user.id, id))) {
    return NextResponse.json({ error: PEER_OWNER_ONLY }, { status: 403 });
  }
  // The check above read the peer before the write: the owner may bind it
  // in between. A change the owner alone makes on a peer bound to it lands
  // only while it is still not bound, in the write itself.
  const guard = !user.actor.isOwner && peerChangeNeedsOwner(change, true);
  let touched = false;
  let inboundToken: string | null = null;
  // The guarded write goes first: a refusal, or a bad
  // login to bind, then answers before anything else in the body is written.
  if (actsAs !== undefined || writeEnabled !== undefined || allowedRiskyTools !== undefined) {
    const bound = actsAs === undefined ? undefined : await resolvePeerActsAs(user.id, actsAs);
    if (bound && 'error' in bound) {
      return NextResponse.json({ error: bound.error }, { status: 400 });
    }
    const res = await setPeerAccess(user.id, id, {
      ...(bound !== undefined ? { actsAs: bound } : {}),
      ...(writeEnabled !== undefined ? { writeEnabled } : {}),
      ...(allowedRiskyTools !== undefined ? { allowedRiskyTools } : {}),
      // The owner binding a peer to itself becomes its maker; one moving
      // into that binding, or one someone else made, is re-keyed in the same
      // write.
      ...(actsAs === 'owner' && user.actor.isOwner ? { adoptBy: user.actor.id } : {}),
      ...(guard ? { unlessBoundTo: user.id } : {}),
    });
    if (!res) {
      if (guard && (await peerBoundToOwner(user.id, id))) {
        return NextResponse.json({ error: PEER_OWNER_ONLY }, { status: 403 });
      }
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    inboundToken = res.inboundToken;
    touched = true;
  }
  if (input.enabled !== undefined) {
    const ok = await setPeerEnabled(user.id, id, input.enabled);
    if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
    touched = true;
  }
  if (input.outboundToken !== undefined) {
    const ok = await setOutboundToken(user.id, id, input.outboundToken);
    if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
    touched = true;
  }
  if (!touched) return NextResponse.json({ error: 'nothing to update' }, { status: 400 });
  // A new inbound token is shown here once: the peer must be re-issued it.
  return NextResponse.json(inboundToken ? { ok: true, inboundToken } : { ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const ok = await deletePeer(user.id, id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
