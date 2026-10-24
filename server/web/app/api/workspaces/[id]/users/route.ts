import { anyLoginCaller } from '@/lib/auth';
import { z } from 'zod';
import { addUser, wsBody, wsRoute } from '@/lib/workspaces';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: 'not decided yet: the write names an item no check reads' },
  },
});

const AddBody = z.object({ loginId: z.string().uuid(), moderator: z.boolean().optional() });

/** Add a user (a Moderator, or an Admin user for another person). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = anyLoginCaller();
  const { id } = await ctx.params;
  return wsRoute(login, async (caller) => addUser(caller, id, await wsBody(req, AddBody)));
}
