import { anyLoginCaller } from '@/lib/auth';
import { archivePreview, wsRoute } from '@/lib/workspaces';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'self', scope: null, open: 'any' },
});

/** What archiving would do: items homed here (they block it) and items only
 *  shared here (they lose that share). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = anyLoginCaller();
  const { id } = await ctx.params;
  return wsRoute(login, (caller) => archivePreview(caller, id));
}
