import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { deletePeer, setOutboundToken, setPeerAccess, setPeerEnabled } from '@mantle/content';
import { firstIssue } from '@/lib/zod-issue';
import {
  PEER_OWNER_ONLY,
  PeerAccessBody,
  peerBoundToOwner,
  peerChangeNeedsOwner,
  resolvePeerActsAs,
} from '@/lib/peer-access';

const PatchBody = z
  .object({
    enabled: z.boolean().optional(),
    outboundToken: z.string().min(1).max(8192).optional(),
  })
  .extend(PeerAccessBody.shape);

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const { actsAs, writeEnabled, allowedRiskyTools } = parsed.data;
  // Checked before anything changes: a brain that acts as the owner is the
  // owner's to bind, arm and keep armed (W6b fix round 3, M-1).
  if (
    !user.actor.isOwner &&
    peerChangeNeedsOwner(
      { actsAs, writeEnabled, allowedRiskyTools },
      await peerBoundToOwner(user.id, id),
    )
  ) {
    return NextResponse.json({ error: PEER_OWNER_ONLY }, { status: 403 });
  }
  let touched = false;
  if (parsed.data.enabled !== undefined) {
    const ok = await setPeerEnabled(user.id, id, parsed.data.enabled);
    if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
    touched = true;
  }
  if (parsed.data.outboundToken !== undefined) {
    const ok = await setOutboundToken(user.id, id, parsed.data.outboundToken);
    if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
    touched = true;
  }
  if (actsAs !== undefined || writeEnabled !== undefined || allowedRiskyTools !== undefined) {
    const bound = actsAs === undefined ? undefined : await resolvePeerActsAs(user.id, actsAs);
    if (bound && 'error' in bound) {
      return NextResponse.json({ error: bound.error }, { status: 400 });
    }
    const row = await setPeerAccess(user.id, id, {
      ...(bound !== undefined ? { actsAs: bound } : {}),
      ...(writeEnabled !== undefined ? { writeEnabled } : {}),
      ...(allowedRiskyTools !== undefined ? { allowedRiskyTools } : {}),
      // The owner binding a peer made before its maker was recorded.
      ...(actsAs === 'owner' && user.actor.isOwner ? { adoptBy: user.actor.id } : {}),
    });
    if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
    touched = true;
  }
  if (!touched) return NextResponse.json({ error: 'nothing to update' }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const ok = await deletePeer(user.id, id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
