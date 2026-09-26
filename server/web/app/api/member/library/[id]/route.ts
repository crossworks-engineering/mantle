import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { withViewer } from '@mantle/db';
import { getLibraryItem } from '@mantle/content';
import { getMemberOr401 } from '@/lib/auth';

const Params = z.object({ id: z.string().uuid() });

/**
 * GET /api/member/library/:id : one item a MEMBER may read, with its body
 * (a page's published doc, a note's text, a table's committed grid, a file's
 * metadata). Read at the team level: an item above it is a plain 404, the
 * same answer as an id that does not exist.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const params = Params.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const item = await withViewer('team', () => getLibraryItem(member.anchorId, params.data.id));
  if (!item) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  return NextResponse.json({ item });
}
