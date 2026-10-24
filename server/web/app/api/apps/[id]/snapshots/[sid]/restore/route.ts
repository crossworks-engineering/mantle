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
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The ids are uuids: any other names nothing, the params gateway's one
 *  404 before the handler (lib/route-params.ts; the item gate answered it
 *  until the pre-check removal part 2). */
export const routeParams = { id: 'uuid', sid: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: {
    class: 'content',
    item: { none: 'not decided yet: the write names an item no check reads' },
  },
});

const Body = z.object({
  mode: z.enum(['code', 'data', 'full']),
  discardDraft: z.boolean().optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string; sid: string }> }) {
  const user = ownerCaller();
  const { id, sid } = await ctx.params;
  const body = await readBody(req, Body);
  // The caller's right of the app (pre-check removal parts 2 and 3, asked
  // once since the R0 integration): restoreAppSnapshot asks it first,
  // before the entry is read and before anything is built, staged or
  // written, on this route and on the tool alike: manage for a restore of
  // the code (code, full; apps' code columns are the Moderators', D4), edit
  // for the data alone. An app the scope does not read is the mapper's 404,
  // as an id no row has; one it may not change the 403 item-workspace.
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
