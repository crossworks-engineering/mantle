/**
 * /api/apps/[id]/build — bundle the app's draft source with esbuild and stage
 * the artifact for preview. Returns esbuild errors/warnings verbatim so the
 * editor (and the user) can see what failed. A failed build keeps the last good
 * preview.
 */
import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { buildAndStageApp } from '@mantle/tools';
import { assertItemRight } from '@mantle/db';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The ids are uuids: any other names nothing, the params gateway's one
 *  404 before the handler (lib/route-params.ts). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: {
    class: 'content',
    open: 'owner',
    item: { param: 'id', need: 'manage' },
  },
});

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  // The caller's edit of the app first: an app the scope does not read is
  // the mapper's 404, as an id no row has; one it may not edit the 403
  // item-workspace (a read-only copy's words); before anything is read,
  // built or staged.
  await assertItemRight(id, 'edit');
  const outcome = await buildAndStageApp(user.id, id);
  if (!outcome) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  return NextResponse.json(outcome);
}
