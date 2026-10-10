import { grantsRoute, handGrant } from '@/lib/grants';

/** "Change here": a folder-derived grant becomes one set on the item. */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ nodeId: string; wsId: string }> },
) {
  const { nodeId, wsId } = await ctx.params;
  return grantsRoute((caller) => handGrant(caller, nodeId, wsId));
}
