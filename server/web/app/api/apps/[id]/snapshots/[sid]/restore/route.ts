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
import { ownerCaller } from '@/lib/auth';
import { restoreAppSnapshot } from '@mantle/content/app-snapshots';
import { readBody } from '@/lib/read-body';

const Body = z.object({
  mode: z.enum(['code', 'data', 'full']),
  discardDraft: z.boolean().optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string; sid: string }> }) {
  const user = ownerCaller();
  const { id, sid } = await ctx.params;
  const body = await readBody(req, Body);
  // The code is the app's Moderators' (apps' code columns need manage, D4):
  // restoreAppSnapshot asks it for a restore of the code (code, full)
  // before anything is written, on this route and on the tool alike (F4 fix
  // round 3, M3; the gate asks edit, a data restore's own). Its refusal is
  // the edit check's (404, or 403 item-workspace).
  // AppRestoreDraftError (reason 'draft') and AppSnapshotRefusedError
  // (reason 'no-data') answer 409 by the one table (A10 part 2).
  const result = await restoreAppSnapshot(user.id, id, sid, {
    mode: body.mode,
    discardDraft: body.discardDraft === true,
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
}
