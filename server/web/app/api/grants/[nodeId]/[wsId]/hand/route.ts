import { anyLoginCaller } from '@/lib/auth';
import { grantsRoute, handGrant } from '@/lib/grants';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'self',
    scope: null,
    open: 'any',
    item: {
      none: "a grant change: its rule asks two workspaces (the item's home and the grant's), no one right of the item; the grants panel's definers decide it",
      param: 'nodeId',
    },
  },
});

/** "Change here": a folder-derived grant becomes one set on the item. */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ nodeId: string; wsId: string }> },
) {
  const login = anyLoginCaller();
  const { nodeId, wsId } = await ctx.params;
  return grantsRoute(login, (caller) => handGrant(caller, nodeId, wsId));
}
