/**
 * POST /api/tables/[id]/history/[sid]/restore — put a history entry back
 * into the table's DRAFT (apps first-class plan, Phase 4), and commit it at
 * once with `commit: true`. Body: { discardDraft?, commit? }. 409 when an
 * unpublished draft is in the way (`reason: 'draft'`), for an app table, or
 * when the entry's file is gone. Owner only; 404 when not there.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { firstIssue } from '@/lib/zod-issue';
import { AppBoundTableError } from '@mantle/content';
import { commitTable } from '@/lib/tables';
import {
  TableRestoreDraftError,
  TableSnapshotRefusedError,
  restoreTableSnapshot,
} from '@mantle/content/table-snapshots';

const Body = z.object({
  discardDraft: z.boolean().optional(),
  commit: z.boolean().optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string; sid: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id, sid } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  try {
    const res = await restoreTableSnapshot(user.id, id, sid, {
      discardDraft: parsed.data.discardDraft === true,
    });
    if (!res) return NextResponse.json({ error: 'not found' }, { status: 404 });
    if (parsed.data.commit) {
      await commitTable(user.id, id, undefined, {
        actor: 'owner',
        note: `replaced by restoring v${res.restored.seq}`,
      });
    }
    return NextResponse.json({ restored: res.restored, committed: parsed.data.commit === true });
  } catch (err) {
    if (err instanceof TableRestoreDraftError) {
      return NextResponse.json({ error: err.message, reason: 'draft' }, { status: 409 });
    }
    if (err instanceof TableSnapshotRefusedError || err instanceof AppBoundTableError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
