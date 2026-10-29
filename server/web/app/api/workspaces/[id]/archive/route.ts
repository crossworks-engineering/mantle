import { anyLoginCaller } from '@/lib/auth';
import { archiveWorkspace, wsRoute } from '@/lib/workspaces';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: 'a workspace, not an item: its definers decide by the workspace seats' },
  },
});

/** Archive a workspace. Refused while it is any item's home, and for the
 *  Admin workspace. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = anyLoginCaller();
  const { id } = await ctx.params;
  return wsRoute(login, (caller) => archiveWorkspace(caller, id));
}
