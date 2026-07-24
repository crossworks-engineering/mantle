import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import {
  grantPeerShare,
  grantPeerTypeShare,
  listPeerShares,
  listPeerTypeShares,
  peerShareableTypeCounts,
  revokePeerShare,
  revokePeerTypeShare,
  PEER_SHAREABLE_TYPES,
} from '@mantle/content';

/**
 * A peer's grants, both kinds: `shares` (explicit per-node), `typeShares`
 * (standing per-category — every node of that type, INCLUDING future ones),
 * plus `typeCounts` (how many nodes each shareable category holds) for the
 * category-toggle rows.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const [shares, typeShares, typeCounts] = await Promise.all([
    listPeerShares(user.id, id),
    listPeerTypeShares(user.id, id),
    peerShareableTypeCounts(user.id),
  ]);
  return NextResponse.json({ shares, typeShares, typeCounts });
}

const GrantBody = z.union([
  z.object({ nodeId: z.string().uuid() }),
  z.object({ nodeType: z.enum(PEER_SHAREABLE_TYPES) }),
]);

/** Grant this peer read access to a node, or to a whole category (`nodeType`). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const parsed = GrantBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'nodeId (uuid) or nodeType (shareable category) required' },
      { status: 400 },
    );
  }
  if ('nodeType' in parsed.data) {
    const row = await grantPeerTypeShare(user.id, id, parsed.data.nodeType);
    if (!row) return NextResponse.json({ error: 'peer not found' }, { status: 404 });
    return NextResponse.json({ typeShare: row }, { status: 201 });
  }
  const row = await grantPeerShare(user.id, id, parsed.data.nodeId);
  if (!row) return NextResponse.json({ error: 'peer or node not found' }, { status: 404 });
  return NextResponse.json({ share: row }, { status: 201 });
}

/** Revoke a grant: `?nodeId=` (per-node) or `?nodeType=` (category). */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const params = new URL(req.url).searchParams;
  const nodeType = params.get('nodeType');
  if (nodeType) {
    const ok = await revokePeerTypeShare(user.id, id, nodeType);
    if (!ok) return NextResponse.json({ error: 'grant not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  }
  const nodeId = params.get('nodeId') ?? '';
  if (!nodeId) return NextResponse.json({ error: 'nodeId or nodeType required' }, { status: 400 });
  const ok = await revokePeerShare(user.id, id, nodeId);
  if (!ok) return NextResponse.json({ error: 'grant not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
