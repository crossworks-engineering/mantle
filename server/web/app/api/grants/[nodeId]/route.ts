import { z } from 'zod';
import { addGrant, getGrants, grantsRoute } from '@/lib/grants';
import { wsBody } from '@/lib/workspaces';

const AddBody = z.object({
  wsId: z.string().uuid(),
  write: z.boolean().optional(),
  confirm: z.boolean().optional(),
});

/** The Grant Access panel of an item or a folder (W5b2). */
export async function GET(_req: Request, ctx: { params: Promise<{ nodeId: string }> }) {
  const { nodeId } = await ctx.params;
  return grantsRoute((caller) => getGrants(caller, nodeId));
}

/** Add a grant ("Add workspace"). */
export async function POST(req: Request, ctx: { params: Promise<{ nodeId: string }> }) {
  const { nodeId } = await ctx.params;
  return grantsRoute(async (caller) => addGrant(caller, nodeId, await wsBody(req, AddBody)));
}
