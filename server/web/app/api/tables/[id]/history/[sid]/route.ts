/**
 * DELETE /api/tables/[id]/history/[sid] — delete one entry of a table's
 * history and its copy of the data (apps first-class plan, Phase 4). The
 * table itself is not touched. Owner only; 404 when it is not there.
 */
import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { deleteTableSnapshot } from '@mantle/content/table-snapshots';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The [id] is a uuid: any other names nothing, the one 404 before the
 *  handler (lib/route-params.ts). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  DELETE: {
    class: 'content',
    item: { param: 'id', need: 'edit' },
  },
});

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string; sid: string }> }) {
  const user = ownerCaller();
  const { id, sid } = await ctx.params;
  const gone = await deleteTableSnapshot(user.id, id, sid);
  if (!gone) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
