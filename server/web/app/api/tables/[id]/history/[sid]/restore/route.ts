/**
 * POST /api/tables/[id]/history/[sid]/restore — put a history entry back
 * into the table's DRAFT (apps first-class plan, Phase 4), and commit it at
 * once with `commit: true`. Body: { discardDraft?, commit? }. 409 when an
 * unpublished draft is in the way (`reason: 'draft'`), for an app table, or
 * when the entry's file is gone. Owner only; 404 when not there.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { commitTable } from '@/lib/tables';
import { restoreTableSnapshot } from '@mantle/content/table-snapshots';
import { readBody } from '@/lib/read-body';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The [id] is a uuid: any other names nothing, the one 404 before the
 *  handler (lib/route-params.ts). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: {
    class: 'content',
    item: { param: 'id', need: 'edit' },
  },
});

const Body = z.object({
  discardDraft: z.boolean().optional(),
  commit: z.boolean().optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string; sid: string }> }) {
  const user = ownerCaller();
  const { id, sid } = await ctx.params;
  const body = await readBody(req, Body);
  // A draft in the way (TableRestoreDraftError, reason 'draft'), a refused
  // entry (TableSnapshotRefusedError) and an app table (AppBoundTableError)
  // answer 409 by the one table (A10 part 2).
  const res = await restoreTableSnapshot(user.id, id, sid, {
    discardDraft: body.discardDraft === true,
  });
  if (!res) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (body.commit) {
    await commitTable(user.id, id, undefined, {
      actor: 'owner',
      note: `replaced by restoring v${res.restored.seq}`,
    });
  }
  return NextResponse.json({ restored: res.restored, committed: body.commit === true });
}
