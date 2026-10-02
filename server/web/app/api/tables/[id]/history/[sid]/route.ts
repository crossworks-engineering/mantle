/**
 * DELETE /api/tables/[id]/history/[sid] — delete one entry of a table's
 * history and its copy of the data (apps first-class plan, Phase 4). The
 * table itself is not touched. Owner only; 404 when it is not there.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { deleteTableSnapshot } from '@mantle/content/table-snapshots';

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string; sid: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id, sid } = await ctx.params;
  const gone = await deleteTableSnapshot(user.id, id, sid);
  if (!gone) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
