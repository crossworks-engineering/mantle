/**
 * POST /api/apps/[id]/snapshots/[sid]/restore `{ mode, discardDraft? }` —
 * restore an app from an entry on its history (apps snapshots, Phase 2).
 * `mode`: 'code' (into the draft), 'data' (the live database) or 'full'
 * (both, the code live). A snapshot of the current state is taken first; its
 * id comes back as `undo`. A code restore leaves the app's tools alone:
 * `declaredTools` names the restored code's when they differ (not granted). 409 when the entry holds no data for a data
 * restore, or a draft would be replaced without `discardDraft`. Owner only.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { firstIssue } from '@/lib/zod-issue';
import { AppRestoreDraftError } from '@mantle/content';
import { AppSnapshotRefusedError, restoreAppSnapshot } from '@mantle/content/app-snapshots';

const Body = z.object({
  mode: z.enum(['code', 'data', 'full']),
  discardDraft: z.boolean().optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string; sid: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id, sid } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  try {
    const result = await restoreAppSnapshot(user.id, id, sid, {
      mode: parsed.data.mode,
      discardDraft: parsed.data.discardDraft === true,
      actor: 'owner',
    });
    if (!result) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({
      restored: result.restored,
      undo: result.undo,
      code: result.code,
      mode: result.mode,
      declaredTools: result.declaredTools,
    });
  } catch (err) {
    if (err instanceof AppRestoreDraftError) {
      return NextResponse.json({ error: err.message, reason: 'draft' }, { status: 409 });
    }
    if (err instanceof AppSnapshotRefusedError) {
      return NextResponse.json({ error: err.message, reason: 'no-data' }, { status: 409 });
    }
    throw err;
  }
}
