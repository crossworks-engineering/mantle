import { confirmParam, grantsRoute, restoreGrant } from '@/lib/grants';

/** Take "Removed here" away: the folder's grant reaches the item again. */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ nodeId: string; wsId: string }> },
) {
  const { nodeId, wsId } = await ctx.params;
  return grantsRoute((caller) => restoreGrant(caller, nodeId, wsId, confirmParam(req)));
}
