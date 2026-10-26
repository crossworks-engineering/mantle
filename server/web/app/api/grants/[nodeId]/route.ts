import { anyLoginCaller } from '@/lib/auth';
import { z } from 'zod';
import { addGrant, getGrants, grantsRoute } from '@/lib/grants';
import { wsBody } from '@/lib/workspaces';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'self', scope: null, open: 'any' },
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

const AddBody = z.object({
  wsId: z.string().uuid(),
  write: z.boolean().optional(),
  confirm: z.boolean().optional(),
});

/** The Grant Access panel of an item or a folder (W5b2). */
export async function GET(_req: Request, ctx: { params: Promise<{ nodeId: string }> }) {
  const login = anyLoginCaller();
  const { nodeId } = await ctx.params;
  return grantsRoute(login, (caller) => getGrants(caller, nodeId));
}

/** Add a grant ("Add workspace"). */
export async function POST(req: Request, ctx: { params: Promise<{ nodeId: string }> }) {
  const login = anyLoginCaller();
  const { nodeId } = await ctx.params;
  return grantsRoute(login, async (caller) => addGrant(caller, nodeId, await wsBody(req, AddBody)));
}
