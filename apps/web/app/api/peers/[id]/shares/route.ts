import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { grantPeerShare, listPeerShares, revokePeerShare } from '@mantle/content';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await ctx.params;
  return NextResponse.json({ shares: await listPeerShares(user.id, id) });
}

const NodeBody = z.object({ nodeId: z.string().uuid() });

/** Grant this peer read access to a node. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await ctx.params;
  const parsed = NodeBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'nodeId (uuid) required' }, { status: 400 });
  }
  const row = await grantPeerShare(user.id, id, parsed.data.nodeId);
  if (!row) return NextResponse.json({ error: 'peer or node not found' }, { status: 404 });
  return NextResponse.json({ share: row }, { status: 201 });
}

/** Revoke this peer's access to a node. nodeId in the query string. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await ctx.params;
  const nodeId = new URL(req.url).searchParams.get('nodeId') ?? '';
  if (!nodeId) return NextResponse.json({ error: 'nodeId required' }, { status: 400 });
  const ok = await revokePeerShare(user.id, id, nodeId);
  if (!ok) return NextResponse.json({ error: 'grant not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
