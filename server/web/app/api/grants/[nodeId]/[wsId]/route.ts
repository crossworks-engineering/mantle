import { z } from 'zod';
import { confirmParam, grantsRoute, patchGrant, removeGrant } from '@/lib/grants';
import { wsBody } from '@/lib/workspaces';

const PatchBody = z.object({ write: z.boolean(), confirm: z.boolean().optional() });

type Params = { params: Promise<{ nodeId: string; wsId: string }> };

/** The Write switch of one grant. */
export async function PATCH(req: Request, ctx: Params) {
  const { nodeId, wsId } = await ctx.params;
  return grantsRoute(async (caller) =>
    patchGrant(caller, nodeId, wsId, await wsBody(req, PatchBody)),
  );
}

/** "Remove from this workspace" (a folder-derived row: "Removed here"). */
export async function DELETE(req: Request, ctx: Params) {
  const { nodeId, wsId } = await ctx.params;
  return grantsRoute((caller) => removeGrant(caller, nodeId, wsId, confirmParam(req)));
}
