import { anyLoginCaller } from '@/lib/auth';
import { z } from 'zod';
import { grantEmbeds, grantsRoute } from '@/lib/grants';
import { wsBody } from '@/lib/workspaces';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: 'not decided yet: the write names an item no check reads' },
  },
});

const Body = z.object({
  wsIds: z.array(z.string().uuid()).min(1).max(50),
  confirm: z.boolean().optional(),
});

/** "Grant these too": the item's embeds, granted to its workspaces. */
export async function POST(req: Request, ctx: { params: Promise<{ nodeId: string }> }) {
  const login = anyLoginCaller();
  const { nodeId } = await ctx.params;
  return grantsRoute(login, async (caller) => grantEmbeds(caller, nodeId, await wsBody(req, Body)));
}
