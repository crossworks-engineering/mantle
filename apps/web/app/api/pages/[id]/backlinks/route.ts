import { NextResponse } from 'next/server';
import { requireOwner } from '@/lib/auth';
import { listBacklinks } from '@/lib/pages';

/** Nodes that reference this page (inbound @-mention edges). Read-only — the
 *  extractor is the sole edge writer. Owner-scoped via the join in the lib. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await ctx.params;
  const backlinks = await listBacklinks(user.id, id);
  return NextResponse.json({ backlinks });
}
