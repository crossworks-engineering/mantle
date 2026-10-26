import { anyLoginCaller } from '@/lib/auth';
import { z } from 'zod';
import { confirmParam, grantsRoute, patchGrant, removeGrant } from '@/lib/grants';
import { wsBody } from '@/lib/workspaces';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  PATCH: {
    class: 'self',
    scope: null,
    open: 'any',
    item: {
      none: "a grant change: its rule asks two workspaces (the item's home and the grant's), no one right of the item; the grants panel's definers decide it",
    },
  },
  DELETE: {
    class: 'self',
    scope: null,
    open: 'any',
    item: {
      none: "a grant change: its rule asks two workspaces (the item's home and the grant's), no one right of the item; the grants panel's definers decide it",
    },
  },
});

const PatchBody = z.object({ write: z.boolean(), confirm: z.boolean().optional() });

type Params = { params: Promise<{ nodeId: string; wsId: string }> };

/** The Write switch of one grant. */
export async function PATCH(req: Request, ctx: Params) {
  const login = anyLoginCaller();
  const { nodeId, wsId } = await ctx.params;
  return grantsRoute(login, async (caller) =>
    patchGrant(caller, nodeId, wsId, await wsBody(req, PatchBody)),
  );
}

/** "Remove from this workspace" (a folder-derived row: "Removed here"). */
export async function DELETE(req: Request, ctx: Params) {
  const login = anyLoginCaller();
  const { nodeId, wsId } = await ctx.params;
  return grantsRoute(login, (caller) => removeGrant(caller, nodeId, wsId, confirmParam(req)));
}
