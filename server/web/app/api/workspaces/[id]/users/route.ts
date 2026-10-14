import { loginCaller } from '@/lib/auth';
import { z } from 'zod';
import { addUser, wsBody, wsRoute } from '@/lib/workspaces';

const AddBody = z.object({ loginId: z.string().uuid(), moderator: z.boolean().optional() });

/** Add a user (a Moderator, or an Admin user for another person). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = loginCaller();
  const { id } = await ctx.params;
  return wsRoute(login, async (caller) => addUser(caller, id, await wsBody(req, AddBody)));
}
