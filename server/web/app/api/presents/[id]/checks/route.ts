/**
 * GET /api/presents/[id]/checks: the image check overview of a traced P&ID
 * canvas (DWG bones phase 6 v2), for the panel the app shows beside the
 * canvas, outside its frame. Read only, no spend.
 *
 * Read in the caller's scope: a canvas the caller does not read is a 404,
 * as every present route answers. The brain reads the canvas's data block
 * once (size first, one linear scan) and, when it is a pid drawing that
 * names its source (circuit_trace's `trace`), the latest sealed answers in
 * those drawing tables' Checks tabs that the caller reads (@mantle/tools
 * present-checks). Crops are returned as Files ids, never as bytes: the
 * viewer opens them with their own rights. `traced: false` is a canvas
 * with nothing to show (the panel stays hidden).
 */
import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { presentChecksOverview } from '@mantle/tools/present-checks';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  GET: { class: 'content', open: 'owner', limits: { rateLimit: ['presentChecks'] } },
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const checks = await presentChecksOverview(user.id, id);
  if (!checks) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ checks });
}
