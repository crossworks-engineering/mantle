import { anyLoginCaller } from '@/lib/auth';
import { archiveWorkspace, wsRoute } from '@/lib/workspaces';

/** Archive a workspace. Refused while it is any item's home, for the Admin
 *  workspace, and for the workspaces the level bridge keeps (until W5b). */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = anyLoginCaller();
  const { id } = await ctx.params;
  return wsRoute(login, (caller) => archiveWorkspace(caller, id));
}
